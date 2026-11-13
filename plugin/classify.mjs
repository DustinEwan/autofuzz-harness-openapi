// HTTP responses to the three outcomes.
//
// For a live service the status code is the classification channel:
//
//   - 2xx/3xx is `ok`, with the JSON body described as a value when it is small enough;
//   - 4xx is `rejected` via `reject-class`: the service examined the input and said no
//     through the channel its document declares;
//   - 5xx is `failed` via `http-5xx`: the service tried to accept the input and broke,
//     and a stack in the body becomes fault frames;
//   - a transport failure is `failed` via `transport`, and one dead service folds into
//     one finding because the engine deduplicates findings on class, message, and top
//     frame - the message names the code and the URL, never the input.
//
// `invoke` never answers with an RPC error: an outcome the engine can file, count, and
// deduplicate is always worth more than a dead connection.

export const VIA_REJECT_CLASS = "reject-class";
export const VIA_HTTP_5XX = "http-5xx";
export const VIA_TRANSPORT = "transport";
export const VIA_DEADLINE_CUT = "deadline-cut";
export const VIA_MATERIALIZATION_BLOCKED = "materialization-blocked";
export const VIA_DISCOVERY_ERROR = "discovery-error";

const BODY_QUOTE = 200;

export function classifyResponse({ method, path, status, text, contentType, maxResponseBytes, toValueTree }) {
  const quote = text.slice(0, BODY_QUOTE);
  if (status < 400) {
    const value = contentType !== null && contentType.includes("json") ? toValueTree(text, maxResponseBytes) : null;
    return { kind: "ok", value };
  }
  if (status < 500) {
    return { kind: "rejected", via: VIA_REJECT_CLASS, detail: `${status} ${method} ${path}: ${quote}` };
  }
  return {
    kind: "failed",
    via: VIA_HTTP_5XX,
    fault: { class: `HTTP ${status}`, message: quote, frames: parseFrames(text) },
  };
}

export function transportFailure({ method, url, cause }) {
  // undici wraps the socket error: TypeError("fetch failed") with the real code one
  // level down in `cause`. The code is what distinguishes the failure on the report.
  const code = cause?.code ?? cause?.cause?.code ?? "FetchError";
  return {
    kind: "failed",
    via: VIA_TRANSPORT,
    fault: { class: code, message: `${code} ${method} ${url}`, frames: [] },
  };
}

export function deadlineCut({ method, url, deadlineMs }) {
  return {
    kind: "failed",
    via: VIA_DEADLINE_CUT,
    fault: { class: "TimeoutError", message: `${method} ${url} did not answer within ${deadlineMs} ms`, frames: [] },
  };
}

export function materializationBlocked(cause) {
  return {
    kind: "failed",
    via: VIA_MATERIALIZATION_BLOCKED,
    fault: { class: "MaterializeError", message: String(cause.message ?? cause), frames: [] },
  };
}

export function unknownTarget(targetId) {
  return {
    kind: "failed",
    via: VIA_DISCOVERY_ERROR,
    fault: { class: "UnknownTarget", message: `this process never discovered a target ${targetId}`, frames: [] },
  };
}

// A 5xx body names its source in whichever dialect the service writes: a V8 frame
// `at fn (/abs/file.mjs:12:5)`, a bare `file:12:5`, or a Python line
// `File "app.py", line 42`. Neither pattern matching nor the language is the point -
// the frames are triage help, and no frames beats a fabricated one.
export function parseFrames(body) {
  const frames = [];
  for (const line of body.split("\n")) {
    const js = line.match(/(?:at\s+\S*\s+)?([^\s()]+):(\d+):(\d+)/);
    if (js !== null) {
      frames.push({ file: js[1], line: Number(js[2]), column: Number(js[3]) });
      continue;
    }
    const py = line.match(/File "([^"]+)", line (\d+)/);
    if (py !== null) frames.push({ file: py[1], line: Number(py[2]) });
  }
  return frames;
}
