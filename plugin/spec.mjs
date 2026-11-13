// The OpenAPI document: load, `$ref` resolution, and JSON Schema to TypeNode.
//
// The lowering mirrors what the Python harness emits for the same shapes, so the
// engine's generator sees one vocabulary no matter which harness produced the tree.
// Anything the generator cannot draw a value from is `unlowerable`, and discovery turns
// that into a skip that names the blocking component - never into a guessed type.

import { readFileSync } from "node:fs";
import { SpecError } from "./config.mjs";

const STRING_FORMATS = new Set(["email", "uuid", "date-time", "hostname", "ipv4", "uri"]);

/// A document the harness refuses to read. The message names the file and the fix.
export async function loadDocument(path) {
  let text;
  if (/^https?:\/\//.test(path)) {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new SpecError(`${path} answered ${response.status}; harness.options.openapi must name a readable OpenAPI 3 JSON document`);
      text = await response.text();
    } catch (cause) {
      if (cause instanceof SpecError) throw cause;
      throw new SpecError(`cannot fetch ${path}: ${cause.message}; harness.options.openapi must name a readable OpenAPI 3 JSON document`);
    }
  } else {
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      throw new SpecError(`cannot read ${path}: ${cause.message}; harness.options.openapi must name a readable OpenAPI 3 JSON document`);
    }
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new SpecError(`${path} is not JSON: ${cause.message}; harness.options.openapi must name an OpenAPI 3 JSON document`);
  }
  if (document?.swagger === "2.0") {
    throw new SpecError("Swagger 2.0 is not supported: convert the document to OpenAPI 3 and point harness.options.openapi at the result");
  }
  if (typeof document?.openapi !== "string" || !document.openapi.startsWith("3.")) {
    throw new SpecError(`${path} is not an OpenAPI 3 document (its openapi member is ${JSON.stringify(document?.openapi ?? null)}); harness.options.openapi must name an OpenAPI 3 JSON document`);
  }
  return document;
}

/// Lower one schema to a TypeNode, or return `{ blockedBy }` naming what stops the
/// generator. `name` is the component name when the schema came from a `$ref`, so the
/// blocker names the thing a human can go and define. `stack` carries the component
/// names being lowered, so a self-referential schema emits a `ref` node instead of
/// recursing forever.
export function lowerSchema(schema, document, { name = null, stack = [] } = {}) {
  if (!isRecord(schema)) return { blockedBy: name ?? "schema" };
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, document);
    const componentName = schema.$ref.split("/").pop();
    if (target === null) return { blockedBy: componentName };
    if (stack.includes(componentName)) return { node: { kind: "ref", name: componentName } };
    return lowerSchema(target, document, { name: componentName, stack });
  }

  if (Array.isArray(schema.enum)) return { node: { kind: "literal", values: schema.enum } };
  if ("const" in schema) return { node: { kind: "literal", values: [schema.const] } };

  const members = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (members !== null) {
    const lowered = [];
    for (const member of members) {
      const result = lowerSchema(member, document, { stack });
      if (result.blockedBy !== undefined) return result;
      lowered.push(result.node);
    }
    const node = { kind: "composite", composite: "union", members: lowered };
    const discriminant = schema.discriminator?.propertyName;
    if (typeof discriminant === "string") node.discriminant = discriminant;
    return withNullable(node, schema);
  }
  if (Array.isArray(schema.allOf)) {
    const lowered = [];
    for (const member of schema.allOf) {
      const result = lowerSchema(member, document, { stack });
      if (result.blockedBy !== undefined) return result;
      lowered.push(result.node);
    }
    return { node: { kind: "composite", composite: "intersection", members: lowered } };
  }

  switch (schema.type) {
    case "string":
      return lowerString(schema, name);
    case "integer":
    case "number":
      return lowerNumber(schema);
    case "boolean":
      return withNullable({ kind: "scalar", scalar: "boolean" }, schema);
    case "array": {
      if (!isRecord(schema.items)) return { blockedBy: name ?? "items" };
      const element = lowerSchema(schema.items, document, { stack });
      if (element.blockedBy !== undefined) return element;
      const node = { kind: "collection", collection: "array", type: element.node };
      const length = lengthBounds(schema);
      if (length !== undefined) node.length = length;
      return withNullable(node, schema);
    }
    case "object":
      return lowerObject(schema, document, { name, stack });
    default:
      // A schema with no `type` says nothing the generator can draw from.
      return { blockedBy: name ?? "schema" };
  }
}

function lowerString(schema, name) {
  // A binary string is a file upload: no generated value can stand in for its bytes.
  // Named by the component when the schema arrived through a `$ref`, so the task
  // board names the document type an author has to change.
  if (schema.format === "binary" || schema.contentEncoding !== undefined) {
    return { blockedBy: name ?? schema.format ?? schema.contentEncoding ?? "binary" };
  }
  if (STRING_FORMATS.has(schema.format)) return withNullable({ kind: "stringFormat", format: schema.format }, schema);
  const node = { kind: "scalar", scalar: "string" };
  const length = lengthBounds(schema);
  if (length !== undefined) node.length = length;
  return withNullable(node, schema);
}

function lowerNumber(schema) {
  const node = { kind: "scalar", scalar: schema.type === "integer" ? "bigInt" : "number" };
  const bounds = {};
  if (schema.type === "integer") bounds.int = true;
  // NumberBounds carries inclusive `min`/`max` only. For an integer the exclusive bound
  // folds exactly onto the next whole number; for a float it cannot, so the inclusive
  // bound is the honest lower statement of what the document allows.
  if (schema.minimum !== undefined) bounds.min = schema.minimum;
  else if (schema.exclusiveMinimum !== undefined) bounds.min = schema.type === "integer" ? schema.exclusiveMinimum + 1 : schema.exclusiveMinimum;
  if (schema.maximum !== undefined) bounds.max = schema.maximum;
  else if (schema.exclusiveMaximum !== undefined) bounds.max = schema.type === "integer" ? schema.exclusiveMaximum - 1 : schema.exclusiveMaximum;
  if (Object.keys(bounds).length > 0) node.bounds = bounds;
  return withNullable(node, schema);
}

function lowerObject(schema, document, { name, stack }) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fieldNames = Object.keys(properties);
  if (fieldNames.length === 0) {
    // `additionalProperties: {schema}` with no named fields is a map of that schema.
    if (isRecord(schema.additionalProperties)) {
      const value = lowerSchema(schema.additionalProperties, document, { stack });
      if (value.blockedBy !== undefined) return value;
      return withNullable({ kind: "collection", collection: "map", key: { kind: "scalar", scalar: "string" }, type: value.node }, schema);
    }
    return { blockedBy: name ?? "schema" };
  }
  const fields = [];
  for (const field of fieldNames) {
    const lowered = lowerSchema(properties[field], document, { name: field, stack });
    if (lowered.blockedBy !== undefined) return lowered;
    fields.push({ name: field, type: lowered.node, required: required.has(field) });
  }
  const node = { kind: "object", fields };
  if (name !== null) {
    node.name = name;
    node.id = name;
  }
  return withNullable(node, schema);
}

// OpenAPI 3.0 spells optional `nullable: true`; 3.1 puts `null` in `type`.
function withNullable(node, schema) {
  const nulls = schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"));
  if (!nulls) return { node };
  return { node: { kind: "composite", composite: "union", members: [node, { kind: "scalar", scalar: "null" }] } };
}

function lengthBounds(schema) {
  if (schema.minLength === undefined && schema.maxLength === undefined) return undefined;
  const length = {};
  if (schema.minLength !== undefined) length.min = schema.minLength;
  if (schema.maxLength !== undefined) length.max = schema.maxLength;
  return length;
}

function resolveRef(ref, document) {
  if (!ref.startsWith("#/")) return null;
  let node = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node) || !(key in node)) return null;
    node = node[key];
  }
  return node;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
