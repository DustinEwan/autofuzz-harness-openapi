// ValueTree arguments to an HTTP request, and a JSON response back to a ValueTree.
//
// `invoke` sends fresh values every call, so the request is rebuilt from the values
// every time: path parameters fill the template, query and cookie and header parameters
// go where OpenAPI says they go, and a JSON body is serialized. A value the ValueTree
// vocabulary carries but a URL cannot (a Map, a function stub) is a materialization
// refusal, not a silent `String(map)`.
//
// An operation whose own path template cannot be filled is a different failure: no value
// can build that request, so it raises `BuildError` and `prepare` reports the operation
// unbuildable rather than preparing a call that could never be sent.

export class MaterializeError extends Error {}

/// The operation itself cannot be turned into a request, whatever the values say.
export class BuildError extends Error {}

export function materialize(node) {
  switch (node.node) {
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "boolean":
    case "string":
    case "literal":
      return node.value;
    case "number":
      if (node.value === "naN") return Number.NaN;
      if (node.value === "infinity") return Number.POSITIVE_INFINITY;
      if (node.value === "negativeInfinity") return Number.NEGATIVE_INFINITY;
      return node.value;
    case "bigInt":
      try {
        return BigInt(node.value);
      } catch {
        throw new MaterializeError(`${node.value} is not an integer literal`);
      }
    case "array":
    case "tuple":
    case "stream":
      return node.items.map(materialize);
    case "set":
      return new Set(node.items.map(materialize));
    case "map":
      return new Map(node.entries.map(([key, value]) => [materialize(key), materialize(value)]));
    case "object": {
      const built = {};
      for (const [key, value] of node.fields) built[key] = materialize(value);
      return built;
    }
    case "buffer":
      return Uint8Array.from(node.bytes);
    case "function":
      return stub(node.behavior);
    case "opaque":
      throw new MaterializeError(`an opaque value of type ${node.ty} has no JavaScript value to build`);
    default:
      throw new MaterializeError(`unknown value node ${node.node}`);
  }
}

function stub(behavior) {
  if (behavior === "throw") {
    return () => {
      throw new Error("the stub callable's behavior is throw");
    };
  }
  if (behavior === "captureArguments") {
    return (...args) => args;
  }
  return (first) => first;
}

/// Build `{ method, url, headers, body }` from the target's recorded shape and this
/// call's values, taken by position: the parameters discovery listed, body last.
export function buildRequest({ target, values, options }) {
  let method = target.origin.http.method;
  let path = target.origin.http.path;
  const headers = { ...options.headers };
  const query = [];
  const cookies = [];
  let body;

  const parameters = [...target.locations];

  // A path placeholder the operation declares no parameter for can never be filled, by
  // this call's values or any other. The defect is in the document, not in the arguments,
  // so it is a `BuildError` rather than a `MaterializeError`.
  for (const [placeholder, name] of path.matchAll(/\{([^{}]*)\}/gu)) {
    if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
      throw new BuildError(`${method} ${path} carries the path placeholder ${placeholder}, which no parameter of the operation fills`);
    }
  }

  for (let i = 0; i < parameters.length; i += 1) {
    const parameter = parameters[i];
    // The engine may send more values than the operation has parameters (the
    // conformance suite's schema probe does); extras change nothing.
    if (i >= values.length) break;
    const value = materialize(values[i]);
    if (parameter.name === "body" && parameter.in === "body") {
      body = JSON.stringify(jsonSafe(value));
      headers["content-type"] ??= "application/json";
      continue;
    }
    switch (parameter.in) {
      case "path":
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(pathSegment(value)));
        break;
      case "query":
        query.push(`${encodeURIComponent(parameter.name)}=${encodeURIComponent(queryValue(value))}`);
        break;
      case "header":
        headers[parameter.name.toLowerCase()] = String(headerValue(value));
        break;
      case "cookie":
        cookies.push(`${parameter.name}=${encodeURIComponent(String(value))}`);
        break;
      default:
        throw new MaterializeError(`parameter ${parameter.name} has location ${parameter.in}, which the harness does not place`);
    }
  }

  let url = `${options.baseUrl}${path}`;
  if (query.length > 0) url += `?${query.join("&")}`;
  if (cookies.length > 0) headers.cookie = [...(headers.cookie ? [headers.cookie] : []), ...cookies].join("; ");
  if (body !== undefined) headers.accept ??= "application/json";
  return { method, url, headers, body };
}

/// The same request line the `prepare` summary reports: everything but the header
/// values, which can carry credentials.
export function requestLine({ method, url }) {
  return `${method} ${url}`;
}

function pathSegment(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(jsonSafe(value));
}

function queryValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(jsonSafe(value));
}

function headerValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  throw new MaterializeError(`a header value must be a scalar, not ${typeof value}`);
}

// Values the fetch layer can serialize: Maps become objects, Sets become arrays,
// functions and typed arrays have no JSON spelling and refuse.
function jsonSafe(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value) out[String(key)] = jsonSafe(item);
    return out;
  }
  if (value instanceof Set) return [...value].map(jsonSafe);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") throw new MaterializeError("a function value has no JSON body to send");
  if (value instanceof Uint8Array) throw new MaterializeError("a binary value has no JSON body to send; the document should mark it unsupported");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item);
    return out;
  }
  return value;
}

/// A JSON response body to a ValueTree, or `null` when the body is not describable.
export function responseToValueTree(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return toValueTree(parsed);
}

function toValueTree(value) {
  if (value === null) return { node: "null" };
  if (typeof value === "boolean" || typeof value === "string") return { node: typeof value, value };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { node: "number", value: "naN" };
    if (value === Number.POSITIVE_INFINITY) return { node: "number", value: "infinity" };
    if (value === Number.NEGATIVE_INFINITY) return { node: "number", value: "negativeInfinity" };
    return { node: "number", value };
  }
  if (Array.isArray(value)) {
    const items = value.map(toValueTree);
    return items.some((item) => item === null) ? null : { node: "array", items };
  }
  const fields = Object.entries(value).map(([key, item]) => [key, toValueTree(item)]);
  return fields.some(([, item]) => item === null) ? null : { node: "object", fields };
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
