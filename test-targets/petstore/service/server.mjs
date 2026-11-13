#!/usr/bin/env node
// The demo service behind the petstore document: one deliberate defect per conformance
// property, and nothing else. `conformance/emit.mjs` renders this exact file (with a
// fresh nonce) into the project the suite validates, so each comment below is a claim
// the two judges can check.
//
// Usage: node service/server.mjs --port 8731
// Port 0 asks the kernel for one; the bound number is printed on the `listening` line.

import { createServer } from "node:http";

// The conformance emitter replaces this nonce when it renders the fixture. The suite
// drives `GET /nonce` once and requires the value back: a plugin that fakes discovery
// from a table and never calls this service fails that probe.
const NONCE = "afz-nonce-local";

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const wanted = Number(flag("--port") ?? process.env.AFZ_PORT ?? 0);

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const routes = {
  // The health URL of the lifecycle block: any 2xx answers the suite's poll.
  "GET /health": () => ({ status: 200, type: "text/plain", body: "ok" }),

  // `method-receiver`: the receiver of a runtime target is the service itself, and a
  // 200 on a zero-parameter operation is the receiver answering.
  "GET /ready": () => ({ status: 200, type: "text/plain", body: "ready" }),

  // The lifecycle nonce echo.
  "GET /nonce": () => ({ status: 200, type: "application/json", body: JSON.stringify({ nonce: NONCE }) }),

  // `private-symbol` in the document (`x-internal`); the route exists so the service
  // stays honest about what the document describes, but discovery never sends here.
  "GET /internal": () => ({ status: 200, type: "text/plain", body: "internal only" }),

  // `guard-refusal`: a negative percentage is a refusal the document declares, and a
  // 4xx is the runtime channel for "I examined your input and said no".
  "POST /discount": async (request) => {
    const body = JSON.parse((await readBody(request)) || "{}");
    if (typeof body.amount !== "number" || Number.isNaN(body.amount)) {
      return { status: 422, type: "application/json", body: JSON.stringify({ error: "amount must be a number" }) };
    }
    if (body.amount < 0) {
      return { status: 422, type: "application/json", body: JSON.stringify({ error: `discount percentage must not be negative, got ${body.amount}` }) };
    }
    return { status: 200, type: "application/json", body: JSON.stringify({ total: body.amount }) };
  },

  // Never fuzzed: discovery refuses the multipart signature before an invoke exists.
  "POST /upload": () => ({ status: 400, type: "application/json", body: JSON.stringify({ error: "the harness refuses multipart bodies" }) }),

  // Never fuzzed: discovery skips the unbuildable Handle parameter.
  "POST /accounts/x": () => ({ status: 200, type: "application/json", body: JSON.stringify({ posted: true }) }),

  // The fault: the stack names this file. `crash-unguarded` is not-applicable for a
  // runtime harness precisely because this path is never the document discovery read
  // the operation from - but the harness must still report the 5xx as `failed`, and
  // the reproducer must still replay it.
  "GET /boom": () => ({ status: 500, type: "text/plain", body: `boom: ledger line missing\n${new Error("ledger line missing").stack}` }),

  // `deadline-sleep`: 10 seconds against the harness's 1500 ms deadline.
  "GET /slow": async () => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return { status: 200, type: "text/plain", body: "eventually" };
  },
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const handle = routes[`${request.method} ${path}`] ?? routes[`${request.method} ${path.replace(/[^/]+$/, "x")}`];
  if (handle === undefined) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  let result;
  try {
    result = await handle(request);
  } catch (cause) {
    result = { status: 500, type: "text/plain", body: `handler failed: ${cause.stack ?? cause}` };
  }
  response.writeHead(result.status, { "content-type": result.type });
  response.end(result.body);
});

server.listen(wanted, "127.0.0.1", () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
