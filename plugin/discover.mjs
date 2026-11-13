// Operations to targets and skips. Nothing here calls the service: discovery reads the
// document, exactly as `discoverRequiresExecution: false` promises.
//
// The skip rules run in this order and no other, because the reason the engine reports
// must be the reason the harness stopped:
//
//   1. `destructive` matches, or a mutating method the `allowMutating` list does not
//      name: `excluded` - the operator's policy is heard first;
//   2. `x-internal` on the operation or path item: `not-public`;
//   3. a `multipart/form-data` body or a binary schema in the body: `unsupported-signature`;
//   4. a parameter or body schema the lowering cannot build: `unconstructible-parameter`,
//      naming the blocking component.
//
// The wire descriptor keeps no OpenAPI locations, so discovery also hands the server a
// registry: target id to the parameter locations `invoke` needs to place values.

import { createHash } from "node:crypto";
import { matchesPolicy } from "./config.mjs";
import { lowerSchema } from "./spec.mjs";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
// Methods that cannot change service state, so the policy never holds them back.
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

export function discover({ document, options }) {
  const targets = [];
  const skipped = [];
  const registry = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      examine({ document, options, path, method: method.toUpperCase(), operation, item }, targets, skipped, registry);
    }
  }
  targets.sort((a, b) => (a.name < b.name ? -1 : 1));
  skipped.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { targets, skipped, registry };
}

function examine({ document, options, path, method, operation, item }, targets, skipped, registry) {
  const name = `${method} ${path}`;
  const parameters = collectParameters(item, operation);
  const body = collectBody(operation);
  const id = makeId(name, parameters, body);
  const skip = (entry) => skipped.push({ targetId: id, name, ...entry });

  if (matchesPolicy(options.destructive, name)) {
    skip({ reason: "excluded", detail: "listed in harness.options.destructive" });
    return;
  }
  if (!READ_ONLY.has(method) && !matchesPolicy(options.allowMutating, name)) {
    skip({ reason: "excluded", detail: `mutating method; add "${name}" to harness.options.allowMutating to fuzz it` });
    return;
  }
  if (operation["x-internal"] === true || item["x-internal"] === true) {
    skip({ reason: "not-public", detail: "x-internal" });
    return;
  }
  if (body !== null && body.unsupported !== undefined) {
    skip({ reason: "unsupported-signature", detail: body.unsupported });
    return;
  }

  const lowered = [];
  for (const parameter of parameters) {
    const result = lowerSchema(parameter.schema ?? {}, document);
    if (result.blockedBy !== undefined) {
      skip({
        reason: "unconstructible-parameter",
        detail: `parameter ${parameter.name} has type ${result.blockedBy}, which the harness cannot build`,
        materialization: "opaque",
        blockedBy: { type: result.blockedBy, path: parameter.name },
      });
      return;
    }
    lowered.push({ name: parameter.name, type: result.node, required: parameter.required === true });
  }
  if (body !== null) {
    const result = lowerSchema(body.schema ?? {}, document);
    if (result.blockedBy !== undefined) {
      skip({
        reason: "unconstructible-parameter",
        detail: `request body has type ${result.blockedBy}, which the harness cannot build`,
        materialization: "opaque",
        blockedBy: { type: result.blockedBy, path: "body" },
      });
      return;
    }
    lowered.push({ name: "body", type: result.node, required: body.required === true });
  }

  const origin = { file: options.openapi, http: { method, path } };
  targets.push({
    id,
    targetClass: "runtime",
    origin,
    name,
    parameters: lowered,
    returns: null,
    effects: {
      async: true,
      mutatesState: !READ_ONLY.has(method),
      streams: streamsResponse(operation),
    },
    materialization: "constructible",
  });
  const locations = parameters.map((parameter) => ({ name: parameter.name, in: parameter.in }));
  if (body !== null) locations.push({ name: "body", in: "body" });
  registry.set(id, { name, origin, locations });
}

// Path-item parameters first, then operation parameters: document order, as OpenAPI
// states the precedence.
function collectParameters(item, operation) {
  const declared = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  return declared
    .filter((parameter) => isRecord(parameter) && typeof parameter.name === "string" && typeof parameter.in === "string")
    .map((parameter) => ({ name: parameter.name, in: parameter.in, schema: parameter.schema, required: parameter.in === "path" || parameter.required === true }));
}

// The harness speaks JSON bodies. A body with no JSON media type is either a channel the
// generator has no value for (multipart, binary) or one the document does not describe.
function collectBody(operation) {
  const body = operation.requestBody;
  if (!isRecord(body)) return null;
  const content = isRecord(body.content) ? body.content : {};
  const mediaTypes = Object.keys(content);
  if (mediaTypes.includes("multipart/form-data")) {
    return { unsupported: "multipart/form-data request body: the generator has no file to put in it" };
  }
  const jsonType = mediaTypes.find((type) => type === "application/json" || type.endsWith("+json"));
  if (jsonType === undefined) {
    return { unsupported: mediaTypes.length === 0 ? "requestBody with no content media types" : `${mediaTypes[0]} request body: the harness sends application/json` };
  }
  const schema = content[jsonType]?.schema;
  if (isRecord(schema) && (schema.format === "binary" || schema.contentEncoding !== undefined)) {
    return { unsupported: `${schema.format ?? schema.contentEncoding} request body: the generator has no file to put in it` };
  }
  return { schema, required: body.required === true };
}

const streamsResponse = (operation) =>
  isRecord(operation.responses) && Object.keys(operation.responses).some((code) => isRecord(operation.responses[code]?.content) && "text/event-stream" in operation.responses[code].content);

// The id is a content hash of the operation name and its parameter shapes, so the same
// operation in the same document keeps the same id across processes and runs.
function makeId(name, parameters, body) {
  const signature = JSON.stringify({ parameters, body: body?.schema ?? null });
  const digest = createHash("sha256").update(`${name}\u0000${signature}`).digest("hex");
  return `afz:t:${digest.slice(0, 12)}`;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
