#!/usr/bin/env node
// The openapi plugin: one JSON-RPC 2.0 object per line on stdin, one per line on
// stdout, and real HTTP calls to the service the scan project points at.
//
// Three rules shape every line of this file:
//
//   1. stdout is the protocol channel. Around every handler the plugin redirects
//      `process.stdout.write` to stderr. The service has its own process and its own
//      stdout, so this guard costs nothing and keeps the promise even when someone
//      points `baseUrl` at an in-process stub.
//   2. `invoke` never answers with an RPC error. A 5xx, a dead socket, and a call that
//      outlived its deadline are all outcomes the engine can file, count, and
//      deduplicate; silence and error frames are not.
//   3. The deadline is cut on the plugin's side. `AbortSignal.timeout` stops the fetch
//      at `deadlineMs` and the plugin answers `failed` via `deadline-cut` before the
//      engine's own timeout kills the process.
//
// Requests are handled one at a time, in order; the engine reads each response before
// the next request, and the loop makes that ordering a fact of the code.

import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { ERROR_CODES, JSONRPC_VERSION, PROTOCOL_VERSION, failure, success } from "./protocol.mjs";
import { SpecError, loadOptions } from "./config.mjs";
import { loadDocument } from "./spec.mjs";
import { discover } from "./discover.mjs";
import { MaterializeError, buildRequest, requestLine, responseToValueTree } from "./request.mjs";
import { classifyResponse, deadlineCut, materializationBlocked, transportFailure, unknownTarget } from "./classify.mjs";
import { renderReproducer } from "./repro.mjs";

const OUT = process.stdout;
const realWrite = OUT.write.bind(OUT);
const writeLine = (frame) => realWrite(`${JSON.stringify(frame)}\n`);

class InvalidRequest extends Error {}
class MethodNotFound extends Error {
  constructor(method) {
    super(`method not found: ${method}`);
  }
}

// Per connection: the options and document this connection read, and the registry its
// discovery produced. The suite's worker connection discovers again on its own process,
// so an invoke never needs a handshake or a discover it missed.
let options = null;
let documentName = null;
const registry = new Map();
let lastRequestAt = 0;

const HANDLERS = {
  handshake: () => ({
    protocolVersion: PROTOCOL_VERSION,
    name: "openapi",
    version: "0.1.0",
    targetClass: "runtime",
    capabilities: ["reproducer", "sideEffects", "concurrent", "readiness"],
    languages: ["openapi"],
    discoverRequiresExecution: false,
  }),

  async discover(params) {
    // The lifecycle handoff: the engine starts the service on a kernel-chosen port
    // and names it in AFZ_PORT; `{{port}}` in `options.baseUrl` is the only place it
    // is read. An empty value is as unset as a missing one.
    const port = process.env.AFZ_PORT === undefined || process.env.AFZ_PORT === "" ? undefined : process.env.AFZ_PORT;
    options = loadOptions({ configPath: params.configPath ?? null, root: params.root ?? "", port });
    const document = await loadDocument(options.openapiPath);
    documentName = options.openapi;
    const found = discover({ document, options });
    registry.clear();
    for (const [id, internal] of found.registry) registry.set(id, internal);
    return { targets: found.targets, skipped: found.skipped };
  },

  prepare(params) {
    const target = registry.get(params.targetId);
    if (target === undefined) return { ok: false, reason: "discovery-error" };
    // The summary is the request line without header values, which can carry
    // credentials. A call that cannot be built yet still prepares: the outcome, not
    // the answer here, is where a bad value reports.
    let summary = target.name;
    try {
      summary = requestLine(buildRequest({ target, values: params.values ?? [], options }));
    } catch {
      // keep the operation name
    }
    return { ok: true, materialized: { handle: `http:${params.targetId}`, summary } };
  },

  async invoke(params) {
    const started = performance.now();
    const elapsed = () => performance.now() - started;

    const target = registry.get(params.targetId);
    if (target === undefined) return { ...unknownTarget(params.targetId), durationMs: elapsed() };

    let request;
    try {
      request = buildRequest({ target, values: params.values, options });
    } catch (cause) {
      if (!(cause instanceof MaterializeError)) throw cause;
      return { ...materializationBlocked(cause), durationMs: elapsed() };
    }

    await rateLimit();
    let response;
    let text = "";
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(params.deadlineMs),
      });
      text = await response.text();
    } catch (cause) {
      const cut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      return cut
        ? { ...deadlineCut({ method: request.method, url: request.url, deadlineMs: params.deadlineMs }), durationMs: elapsed() }
        : { ...transportFailure({ method: request.method, url: request.url, cause }), durationMs: elapsed() };
    }

    const outcome = classifyResponse({
      method: target.origin.http.method,
      path: target.origin.http.path,
      status: response.status,
      text,
      contentType: response.headers.get("content-type"),
      maxResponseBytes: options.maxResponseBytes,
      toValueTree: responseToValueTree,
    });
    return { ...outcome, durationMs: elapsed() };
  },

  reproducer(params) {
    const target = registry.get(params.targetId);
    if (target === undefined) throw new InvalidRequest(`no target ${params.targetId} in this connection's discovery`);
    const request = buildRequest({ target, values: params.values ?? [], options });
    return {
      extension: "sh",
      script: renderReproducer({ request, operationName: target.name, documentName }),
    };
  },

  // Readiness proves reachability and dialogue, never health: any HTTP answer — 404,
  // 401, even a 500 on every route — shows the service parses requests and answers
  // them, and a scan against it is meaningful. Only a transport-level failure is
  // not-ready, because every invocation would then fail the same way. HEAD is the
  // cheap probe; a server that hangs up on HEAD still gets its GET.
  async ready() {
    if (options === null) throw new InvalidRequest("ready before discover: this connection has no baseUrl to probe");
    const probe = new URL("/", options.baseUrl).href;
    const signal = AbortSignal.timeout(2000);
    for (const method of ["HEAD", "GET"]) {
      try {
        await fetch(probe, { method, redirect: "manual", signal });
        return { ready: true };
      } catch (cause) {
        if (signal.aborted) return { ready: false, detail: `no HTTP response from ${probe} within 2000 ms` };
        if (method === "GET") {
          const reason = cause?.cause?.message ?? cause?.message ?? "fetch failed";
          return { ready: false, detail: `no HTTP response from ${probe}: ${reason}` };
        }
      }
    }
  },
};

async function dispatch(method, params) {
  const handler = HANDLERS[method];
  if (handler === undefined) throw new MethodNotFound(method);
  return handler(params ?? {});
}

// `requestsPerSecond` caps this plugin process; the engine's worker count multiplies
// the cap, which is why the README states the rate as per process.
async function rateLimit() {
  const rps = options?.requestsPerSecond ?? 0;
  if (rps <= 0) return;
  const interval = 1000 / rps;
  const wait = lastRequestAt + interval - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + interval);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function handleLine(raw) {
  const text = raw.trim();
  if (text === "") return;

  let request;
  try {
    request = JSON.parse(text);
  } catch {
    writeLine(failure(null, ERROR_CODES.parse, "parse error: the line is not one JSON object"));
    return;
  }

  const id = request?.id ?? null;
  if (typeof request !== "object" || request === null || request.jsonrpc !== JSONRPC_VERSION || typeof request.method !== "string") {
    writeLine(failure(id, ERROR_CODES.invalid_request, "invalid request: expected a JSON-RPC 2.0 call with a method"));
    return;
  }

  const channel = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    process.stderr.write(chunk);
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  let result;
  let error;
  try {
    result = await dispatch(request.method, request.params);
  } catch (cause) {
    error = cause;
  } finally {
    process.stdout.write = channel;
  }

  if (error instanceof MethodNotFound) writeLine(failure(id, ERROR_CODES.method_not_found, error.message));
  else if (error instanceof InvalidRequest) writeLine(failure(id, ERROR_CODES.invalid_request, `invalid request: ${error.message}`));
  // A failed discovery is a scan error the operator sees, and its message is already
  // the sentence that names the key or the file: pass it through untouched.
  else if (error instanceof SpecError) writeLine(failure(id, ERROR_CODES.plugin, error.message));
  else if (error !== undefined) writeLine(failure(id, ERROR_CODES.plugin, `${error.name}: ${error.message}`));
  else writeLine(success(id, result));
}

async function main() {
  OUT.on("error", (error) => process.stderr.write(`stdout write failed: ${error.message}\n`));
  process.stderr.on("error", () => {});

  for await (const line of createInterface({ input: process.stdin })) {
    await handleLine(line);
  }
  process.exit(0);
}

main();
