// Harness settings: the scan project's `harness.options`, plus the port the engine's
// conformance suite (or the operator) allocated.
//
// The engine reads nothing in `options` and substitutes nothing into it. The one
// placeholder convention the ecosystem shares is `{{port}}`: the harness replaces it from
// `AFZ_PORT`, and refuses loudly when the placeholder is present and the variable is
// unset, because guessing a port would fuzz some other process on the machine.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/// An unusable scan project or document. `discover` answers `-32000` with this message
/// verbatim: a failed discovery is a scan error the operator sees, not a finding against
/// a target.
export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecError";
  }
}

export function loadOptions({ configPath, root }) {
  const path = configPath ?? process.env.AFZ_CONFIG ?? null;
  let project;
  try {
    project = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SpecError(`cannot read the scan project ${path}: ${cause.message}; harness.options must configure the openapi harness`);
  }
  const options = project?.harness?.options;
  if (!isRecord(options)) {
    throw new SpecError("harness.options is missing: set baseUrl and openapi in the scan project's harness block");
  }
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") {
    throw new SpecError("harness.options.baseUrl is missing: the harness needs the service URL to fuzz");
  }
  if (typeof options.openapi !== "string" || options.openapi === "") {
    throw new SpecError("harness.options.openapi is missing: name the OpenAPI 3 JSON document to read");
  }
  const port = process.env.AFZ_PORT ?? "";
  return {
    openapi: options.openapi,
    openapiPath: documentPath(options.openapi, root),
    baseUrl: substitutePort(options.baseUrl, port, "harness.options.baseUrl"),
    headers: substituteHeaderPorts(options.headers ?? {}, port),
    allowMutating: strings(options.allowMutating),
    destructive: strings(options.destructive),
    requestsPerSecond: Number.isFinite(options.requestsPerSecond) ? options.requestsPerSecond : 0,
    maxResponseBytes: Number.isFinite(options.maxResponseBytes) && options.maxResponseBytes > 0 ? options.maxResponseBytes : 1048576,
  };
}

function documentPath(openapi, root) {
  if (/^https?:\/\//.test(openapi)) return openapi;
  return isAbsolute(openapi) ? openapi : resolve(root ?? ".", openapi);
}

function substitutePort(text, port, key) {
  if (!text.includes("{{port}}")) return text;
  if (port === "") {
    throw new SpecError(`${key} contains {{port}} but the AFZ_PORT environment variable is unset: the engine's conformance suite sets it, and a manual run must export it`);
  }
  return text.replaceAll("{{port}}", port);
}

function substituteHeaderPorts(headers, port) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = substitutePort(String(value), port, `harness.options.headers.${name}`);
  }
  return out;
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// A `destructive` or `allowMutating` entry is `"POST"`, `"POST /v1/tokens"`, or
// `"POST /v1/*"`; the trailing `*` is a prefix match on the uppercase `METHOD /path`
// string the target is named by.
export function matchesPolicy(policies, operationName) {
  return policies.some((policy) => {
    if (policy.endsWith("*")) return operationName.startsWith(policy.slice(0, -1));
    return operationName === policy;
  });
}
