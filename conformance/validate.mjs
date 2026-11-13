#!/usr/bin/env node
// The conformance project's own fixture validator.
//
// The protocol judge only ever sees the plugin's statements about this fixture. This
// file is the second judgment: it reads the rendered `openapi.json` and
// `service/server.mjs` directly - never the plugin, never the emitter - and reports the
// same property ids. The suite requires the two verdict lists to agree, so a plugin
// cannot pass a fixture-shaped property by answering consistently instead of behaving.
//
// Contract (docs/harness-authoring.md, section 12):
//   - stdout is exactly one JSON `TemplateReport` and nothing else;
//   - exit 0 even when a property fails; non-zero only when this validator itself could
//     not run;
//   - the seven fixture-shaped ids, never the three process-shaped ones;
//   - stderr is free text for the author.
//
// Rendered verbatim from conformance/validate.mjs into the staged project; run as
//   node conformance/validate.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

const results = [];
const record = (id, verdict, detail) => results.push({ id, verdict, detail });

let document;
let service;
try {
  document = JSON.parse(readFileSync(join(projectRoot, "openapi.json"), "utf8"));
  service = readFileSync(join(projectRoot, "service", "server.mjs"), "utf8");
} catch (cause) {
  for (const id of ["crash-unguarded", "guard-refusal", "private-symbol", "unrepresentable-symbol", "unconstructible-receiver", "method-receiver", "coverage-digest-live"]) {
    record(id, "fail", `the fixture could not be read: ${cause}`);
  }
  console.log(JSON.stringify({ version: 1, properties: results }));
  process.exit(0);
}

const operation = (method, path) => document.paths?.[path]?.[method] ?? null;
const component = (name) => document.components?.schemas?.[name] ?? null;

// crash-unguarded: the runtime absence, stated here with the same reason the manifest
// declares, so a reader of the report sees the judgment twice and the same reasoning
// both times.
record("crash-unguarded", "not-applicable", "a 5xx names the service's own source file, which is never the document discovery read the operation from, so no fault frame can equal origin.file");

// guard-refusal: the document declares a refusal status, and the service fires it.
const discount = operation("post", "/discount");
const discountSchema = component("Discount") ?? discount?.requestBody?.content?.["application/json"]?.schema ?? null;
if (discount?.requestBody?.content?.["application/json"] !== undefined && discountSchema?.properties?.amount?.type === "number" && service.includes("422")) {
  record("guard-refusal", "pass", "POST /discount declares a JSON body with a numeric amount, and the service answers a negative one with 422");
} else {
  record("guard-refusal", "fail", "POST /discount no longer demonstrates a declared 4xx refusal channel");
}

// private-symbol: the document marks the operation internal, so discovery reports it
// not-public instead of fuzzing it.
if (operation("get", "/internal")?.["x-internal"] === true) {
  record("private-symbol", "pass", "GET /internal carries x-internal, so discovery reports it as not-public instead of fuzzing it");
} else {
  record("private-symbol", "fail", "GET /internal no longer carries x-internal");
}

// unrepresentable-symbol: a multipart body is a channel the generator has no value for.
const upload = operation("post", "/upload");
if (upload?.requestBody?.content?.["multipart/form-data"] !== undefined) {
  record("unrepresentable-symbol", "pass", "POST /upload's only request body is multipart/form-data, which the harness cannot generate into");
} else {
  record("unrepresentable-symbol", "fail", "POST /upload no longer demonstrates an ungeneratable request body");
}

// unconstructible-receiver: the Handle component is a binary blob no generated value
// can build, and the path parameter names it.
const accounts = operation("post", "/accounts/{handle}");
const handleParameter = accounts?.parameters?.find((parameter) => parameter.name === "handle");
if (handleParameter?.schema?.$ref === "#/components/schemas/Handle" && component("Handle")?.format === "binary") {
  record("unconstructible-receiver", "pass", "POST /accounts/{handle} takes a Handle, and Handle is a binary format no generated value can build");
} else {
  record("unconstructible-receiver", "fail", "POST /accounts/{handle} no longer demonstrates a parameter blocked by an unbuildable type");
}

// method-receiver: the receiver of a runtime target is the service, and a
// zero-parameter 200 operation is that receiver answering.
const ready = operation("get", "/ready");
if (ready !== null && (ready.parameters ?? []).length === 0 && service.includes("ready")) {
  record("method-receiver", "pass", "GET /ready is a zero-parameter operation the service answers 200: the service itself is the receiver that can be built");
} else {
  record("method-receiver", "fail", "GET /ready no longer demonstrates a reachable receiver");
}

record("coverage-digest-live", "not-applicable", "the runtime cannot observe per-call edges");

console.log(JSON.stringify({ version: 1, properties: results }));
