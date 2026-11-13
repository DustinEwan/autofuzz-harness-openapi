// The openapi plugin's own suite: a real service on a kernel-chosen port, a real plugin
// child process, and the real pipe between them.
//
// Every assertion reads an observed response: discovery's inventory, the outcome of a
// driven call, the exit code of the rendered `curl` script run against the live service.
// The port is never written down - the service binds port 0, prints what it got, and
// the plugin only ever learns it through `AFZ_PORT`, which is the same handoff the
// conformance suite performs.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../plugin/protocol.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const petstore = join(packageRoot, "test-targets", "petstore");
const configPath = join(petstore, "autofuzz.json");

/// Start the fixture service on port 0 and resolve with the port it bound.
function startService(t) {
  const child = spawn(process.execPath, [join(petstore, "service", "server.mjs"), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  t.after(() => child.kill());
  return new Promise((settle) => {
    createInterface({ input: child.stdout }).once("line", (line) => settle({ child, port: Number(line.split(" ")[1]) }));
  });
}

function startPlugin(t, { port, config }) {
  const child = spawn(process.execPath, [join(packageRoot, "plugin", "server.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, AFZ_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("error", () => {});
  child.stderr.resume();
  t.after(() => {
    child.stdin.end();
    child.kill();
  });

  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    const settle = pending.get(frame.id);
    if (settle !== undefined) {
      pending.delete(frame.id);
      settle(frame);
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((settle) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, settle);
      const request = { jsonrpc: "2.0", id, method };
      if (params !== undefined) request.params = params;
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  return { child, call };
}

async function started(t, { config = configPath } = {}) {
  const service = await startService(t);
  const plugin = startPlugin(t, { port: service.port, config });
  const frame = await plugin.call("discover", { root: petstore, include: null, exclude: null, configPath: config });
  assert.equal(frame.error, undefined, JSON.stringify(frame.error));
  const byName = new Map(frame.result.targets.map((target) => [target.name, target]));
  const skippedByName = new Map(frame.result.skipped.map((entry) => [entry.name, entry]));
  return { service, plugin, byName, skippedByName };
}

const invoke = (plugin, targetId, values, deadlineMs = 5000) =>
  plugin.call("invoke", { invocationId: 1, targetId, values, deadlineMs, collectCoverage: false });

test("handshake declares a runtime harness", async (t) => {
  const plugin = startPlugin(t, { port: 1 });
  const { result } = await plugin.call("handshake");
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(result.name, "openapi");
  assert.equal(result.targetClass, "runtime");
  assert.deepEqual(result.capabilities, ["reproducer", "sideEffects", "concurrent"]);
  assert.deepEqual(result.languages, ["openapi"]);
  assert.equal(result.discoverRequiresExecution, false);
});

test("discovery lists six operations and skips three with reasons", async (t) => {
  const { byName, skippedByName } = await started(t);
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["GET /boom", "GET /health", "GET /nonce", "GET /ready", "GET /slow", "POST /discount"],
  );
  assert.deepEqual([...skippedByName.keys()].sort(), ["GET /internal", "POST /accounts/{handle}", "POST /upload"]);

  const discount = byName.get("POST /discount");
  assert.deepEqual(discount.origin, { file: "openapi.json", http: { method: "POST", path: "/discount" } });
  assert.deepEqual(discount.parameters.map((parameter) => [parameter.name, parameter.required]), [["body", true]]);
  assert.equal(discount.effects.mutatesState, true);
  assert.equal(byName.get("GET /health").effects.mutatesState, false);

  assert.equal(skippedByName.get("GET /internal").reason, "not-public");
  assert.equal(skippedByName.get("POST /upload").reason, "unsupported-signature");
  const blocked = skippedByName.get("POST /accounts/{handle}");
  assert.equal(blocked.reason, "unconstructible-parameter");
  assert.deepEqual(blocked.blockedBy, { type: "Handle", path: "handle" });
  assert.equal(blocked.materialization, "opaque");
});

test("ids are stable across processes", async (t) => {
  const first = await started(t);
  const second = await started(t);
  for (const name of first.byName.keys()) {
    assert.equal(first.byName.get(name).id, second.byName.get(name).id, `${name} got a different id in a second process`);
  }
});

test("a 422 answers rejected via reject-class", async (t) => {
  const { plugin, byName } = await started(t);
  const body = { node: "object", provenance: "user", fields: [["amount", { node: "number", value: -5 }]] };
  const { result } = await invoke(plugin, byName.get("POST /discount").id, [body]);
  assert.equal(result.kind, "rejected");
  assert.equal(result.via, "reject-class");
  assert.match(result.detail, /^422 POST \/discount/);
});

test("a 200 with a JSON body answers ok with the body described", async (t) => {
  const { plugin, byName } = await started(t);
  const { result } = await invoke(plugin, byName.get("GET /nonce").id, []);
  assert.equal(result.kind, "ok");
  assert.equal(result.value.node, "object");
});

test("a 500 answers failed via http-5xx with frames naming the service", async (t) => {
  const { plugin, byName } = await started(t);
  const { result } = await invoke(plugin, byName.get("GET /boom").id, []);
  assert.equal(result.kind, "failed");
  assert.equal(result.via, "http-5xx");
  assert.equal(result.fault.class, "HTTP 500");
  assert.match(result.fault.message, /ledger line missing/);
  assert.ok(result.fault.frames.some((frame) => frame.file.includes("server.mjs")), `no frame names the service: ${JSON.stringify(result.fault.frames)}`);
});

test("a call past its deadline cuts itself and still answers", async (t) => {
  const { plugin, byName } = await started(t);
  const startedAt = Date.now();
  const { result } = await invoke(plugin, byName.get("GET /slow").id, [], 250);
  const waited = Date.now() - startedAt;
  assert.equal(result.kind, "failed");
  assert.equal(result.via, "deadline-cut");
  assert.equal(result.fault.class, "TimeoutError");
  assert.ok(waited < 5000, `the plugin waited ${waited} ms for a 250 ms deadline`);
});

test("a dead service folds into one transport failure class", async (t) => {
  const { plugin, byName, service } = await started(t);
  service.child.kill();
  await new Promise((settle) => service.child.once("close", settle));
  const { result } = await invoke(plugin, byName.get("GET /health").id, []);
  assert.equal(result.kind, "failed");
  assert.equal(result.via, "transport");
  assert.match(result.fault.class, /ECONNREFUSED|ECONNRESET|FetchError/);
  assert.match(result.fault.message, /GET http:\/\/127\.0\.0\.1/);
});

test("an id this process never discovered answers UnknownTarget", async (t) => {
  const { plugin } = await started(t);
  const { result } = await invoke(plugin, "afz:t:000000000000", []);
  assert.equal(result.kind, "failed");
  assert.equal(result.via, "discovery-error");
  assert.equal(result.fault.class, "UnknownTarget");
});

test("a mutating operation absent from allowMutating is skipped excluded", async (t) => {
  const config = { project: "petstore", harness: { name: "openapi", options: { baseUrl: "http://127.0.0.1:{{port}}", openapi: join(petstore, "openapi.json") } } };
  const dir = mkdtempSync(join(tmpdir(), "afz-policy-"));
  const path = join(dir, "autofuzz.json");
  writeFileSync(path, JSON.stringify(config));
  const { skippedByName, byName } = await started(t, { config: path });
  assert.equal(byName.has("POST /discount"), false);
  assert.equal(skippedByName.get("POST /discount").reason, "excluded");
  assert.match(skippedByName.get("POST /discount").detail, /allowMutating/);
});

test("{{port}} without AFZ_PORT refuses with both names in the message", async (t) => {
  const service = await startService(t);
  void service;
  const child = spawn(process.execPath, [join(packageRoot, "plugin", "server.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, AFZ_PORT: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  t.after(() => {
    child.stdin.end();
    child.kill();
  });
  const reply = new Promise((settle) => createInterface({ input: child.stdout }).once("line", (line) => settle(JSON.parse(line))));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: { root: petstore, configPath } })}\n`);
  const frame = await reply;
  assert.equal(frame.error.code, -32000);
  assert.match(frame.error.message, /\{\{port\}\}/);
  assert.match(frame.error.message, /AFZ_PORT/);
});

test("the rendered curl script replays the 500 against the live service", async (t) => {
  const { service, plugin, byName } = await started(t);
  const frame = await plugin.call("reproducer", { targetId: byName.get("GET /boom").id, values: [] });
  assert.equal(frame.error, undefined, JSON.stringify(frame.error));
  assert.equal(frame.result.extension, "sh");
  assert.match(frame.result.script, /openapi\.json/);
  assert.match(frame.result.script, /curl/);

  const dir = mkdtempSync(join(tmpdir(), "afz-repro-"));
  const script = join(dir, "repro.sh");
  writeFileSync(script, frame.result.script);
  const replay = await new Promise((settle) => {
    const child = spawn("sh", [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => settle({ code, stdout }));
  });
  assert.notEqual(replay.code, 0, "the rendered reproducer exited clean; --fail-with-body must fail on the 500");
  assert.match(replay.stdout, /ledger line missing/);
  void service;
});
