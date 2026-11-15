#!/usr/bin/env node
// Render the conformance fixture project for the openapi harness.
//
// `afz validate-harness` and `afz-xtask check-harness` validate a plugin against the
// template (`crates/afz-conformance/template/v1.json`): twelve semantic properties stated
// as wire-level expectations. This emitter copies the petstore package from
// `test-targets/petstore` - the document, the service, and the scan project are the
// same files `test/openapi.test.mjs` drives - bakes a fresh nonce into the service and
// the manifest, and writes `afz-conformance-manifest.json` naming the operation behind
// each property. The suite, not this file, decides pass/fail.
//
// Usage:
//   node conformance/emit.mjs --out /tmp/conformance-openapi
//
// The nonce is the point of the render: the suite starts the service on a port nobody
// knew in advance, the plugin learns that port from `AFZ_PORT`, and the lifecycle probe
// must bring the nonce back. A plugin that fakes discovery from a table cannot.
//
// Three properties are declared not-applicable, and the CI gate asserts these are the
// only such lines for this harness: a 5xx names the service's source and never the
// document, the harness observes no per-call edges inside a service it does not
// instrument, and the target's stdout lives in another process.
//
// The two properties v1 grew by are both realized here. `GET /artifact` answers an opaque
// download the harness cannot describe as a value, and the call still answers ok;
// `GET /export/{job}` declares a path template no parameter of the operation fills, so
// discovery accepts its signature, prepare reports the operation unbuildable, and every
// sibling still prepares.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const petstore = join(packageRoot, "test-targets", "petstore");

const value = (node) => ({ ...node, provenance: "user" });
const number = (n) => value({ node: "number", value: n });
const object = (fields) => value({ node: "object", fields: fields.map(([name, node]) => [name, node]) });

function manifest(nonce) {
  return {
    templateVersion: 1,
    properties: {
      "crash-unguarded": {
        notApplicable:
          "a 5xx names the service's own source file, which is never the document discovery read the operation from, so no fault frame can equal origin.file; the harness still reports every 5xx as failed",
      },
      "guard-refusal": { symbol: "POST /discount", input: [object([["amount", number(-5)]])] },
      "private-symbol": { symbol: "GET /internal" },
      "unrepresentable-symbol": { symbol: "POST /upload" },
      "unconstructible-receiver": { symbol: "POST /accounts/{handle}", blockedByType: "Handle" },
      "method-receiver": { symbol: "GET /ready", input: [] },
      "coverage-digest-live": {
        notApplicable: "the runtime cannot observe per-call edges",
      },
      "stdout-purity": {
        notApplicable:
          "target code runs in the service process, whose stdout the suite closes; the plugin's own stdout is never written by the target",
      },
      "reproducer-script": { symbol: "GET /boom", input: [] },
      "deadline-sleep": { symbol: "GET /slow", input: [] },
      "opaque-return": { symbol: "GET /artifact", input: [] },
      "unbuildable-symbol": { symbol: "GET /export/{job}", input: [] },
    },
    lifecycle: {
      launch: ["node", "service/server.mjs", "--port", "{{port}}"],
      health: "http://127.0.0.1:{{port}}/health",
      teardown: [],
      nonce,
      probe: "GET /nonce",
    },
    // The project judges its own fixture: the validator reads the rendered document and
    // service source with no plugin and no emitter in the path.
    validator: ["node", "conformance/validate.mjs"],
  };
}

function emit(out) {
  const nonce = `afz-nonce-${randomBytes(3).toString("hex")}`;
  mkdirSync(join(out, "service"), { recursive: true });
  mkdirSync(join(out, "conformance"), { recursive: true });
  copyFileSync(join(petstore, "openapi.json"), join(out, "openapi.json"));
  copyFileSync(join(petstore, "autofuzz.json"), join(out, "autofuzz.json"));
  const service = readFileSync(join(petstore, "service", "server.mjs"), "utf8").replaceAll("afz-nonce-local", nonce);
  writeFileSync(join(out, "service", "server.mjs"), service);
  copyFileSync(join(packageRoot, "conformance", "validate.mjs"), join(out, "conformance", "validate.mjs"));
  writeFileSync(join(out, "afz-conformance-manifest.json"), `${JSON.stringify(manifest(nonce), null, 2)}\n`);
}

const flag = process.argv.indexOf("--out");
if (flag === -1 || process.argv[flag + 1] === undefined) {
  console.error("usage: emit.mjs --out DIR");
  process.exit(2);
}
emit(process.argv[flag + 1]);
console.log(process.argv[flag + 1]);
