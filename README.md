# autofuzz harness: openapi

A runtime harness for OpenAPI 3 services. It reads an OpenAPI JSON document, lowers each operation's parameters and request body to the generator's vocabulary, calls the running service over HTTP, and classifies each response as `ok`, `rejected`, or `failed` over the plugin protocol (`afz/1`). It conforms to the same suite the code-instrumenting harnesses pass: nine of the template's twelve properties are realized against the fixture service, and three are declared not-applicable for reasons stated in the manifest.

Host runtime: Node 24 or newer, standard library only. The plugin installs no dependencies and has none, so there is nothing to build and nothing to audit.

## Install

```sh
afz install-harness https://github.com/DustinEwan/autofuzz-harness-openapi.git
```

Install drives the conformance suite against `plugin/server.mjs` before it records anything; a plugin that violates any rule is not recorded. The suite starts the fixture service itself, on a port the plugin only learns through `AFZ_PORT`. `afz harnesses` lists what the registry holds.

A scan project names the harness, points at the document, and starts the service:

```json
{
  "harness": {
    "name": "openapi",
    "options": {
      "openapi": "openapi.json",
      "baseUrl": "http://127.0.0.1:{{port}}"
    }
  },
  "lifecycle": { "launch": ["docker", "compose", "up"], "health": "http://127.0.0.1:{{port}}/health" }
}
```

`{{port}}` is replaced by the value the engine exports as `AFZ_PORT` when it starts the service from `lifecycle.launch`; a `baseUrl` containing `{{port}}` without that environment is a plugin error that names both. If your service is already running, drop the lifecycle block and write a concrete `baseUrl`.

## Options

| key | meaning |
|---|---|
| `openapi` | the document to fuzz, a file in the scan project or a URL; required |
| `baseUrl` | where the service answers; `{{port}}` is filled from `AFZ_PORT` |
| `allowMutating` | operations whose non-read methods may be called: exact `"POST /path"` entries or trailing-`*` prefixes; everything else mutating is skipped `excluded` at discovery |
| `destructive` | operations skipped `excluded` even when `allowMutating` lists them |
| `headers` | header values sent on every request, such as an auth token |
| `requestsPerSecond` | minimum spacing between calls; 0 (default) sends no faster than the scan asks |
| `maxResponseBytes` | bodies larger than this answer `ok` with no value, so a download does not become generator input; default 1 MiB |

## Author

Edit, then validate — there are no dependencies to fetch:

```sh
afz validate-harness
```

`afz validate-harness` with no argument validates the repository it is run in: it renders the conformance project with this repository's own emitter, drives the suite, and reports rule by rule. It never touches an install or a registry.

Run the unit tests and the wire-vocabulary contract tests:

```sh
AFZ_DOCS=/path/to/autofuzz/docs node --test
```

`AFZ_DOCS` points at an engine checkout; `test/contract.test.mjs` reads `docs/schema/`, `docs/architecture.md`, and `docs/harness-authoring.md` from it. The default is the sibling checkout `../autofuzz/docs`; CI sets the variable explicitly. `test/openapi.test.mjs` needs no engine: it starts the fixture service on a kernel-chosen port and drives the plugin over the real pipe.

## afz-harness.json

| key | meaning |
|---|---|
| `command` | the plugin argv; an element that names an existing file is resolved against this root |
| `conformance.emitter` | a program run as `<argv…> --out <dir>` that renders the whole conformance scan project — document, service, `autofuzz.json`, and `afz-conformance-manifest.json` — into the directory it is given; that rendered project is the only project validation ever drives |
| `conformance.deadlineMs` | the per-invocation deadline the suite passes; this harness sets 1500 so the 10-second `/slow` route always outlives it |

This manifest carries no `install` and no `build`, because the plugin has no dependencies and Node runs its source as written. The emitter is a standalone program: `conformance/emit.mjs` imports `node:fs`, `node:crypto`, `node:path`, and `node:url` only.

## The conformance project

`conformance/emit.mjs` copies the petstore package from `test-targets/petstore` — one deliberate defect per template property, each one named in a comment — bakes a fresh nonce into the service and the manifest, and writes the manifest that pairs each property with its operation. The project `test/openapi.test.mjs` drives and the project the suite validates are the same files, so the two judges cannot drift from each other by drifting from the fixture.

`conformance/validate.mjs` is the project's own fixture validator: it reads the rendered document and service source with the standard library only — never the plugin, never the emitter — and the suite requires its verdicts to agree with the plugin's.

Three properties are declared not-applicable, and CI asserts these are the only such lines: a 5xx from a service names the service's source file and never the document discovery read the operation from; the harness observes no per-call edges inside a service it does not instrument; and the target's stdout lives in another process, so the protocol channel cannot be polluted by target output.

The two properties template v1 grew by are realized as well. `GET /artifact` answers an opaque download: the harness reads every response body as text and describes only a parsed JSON document, so the payload has no value form and the call answers `ok` with none. `GET /export/{job}` declares a path placeholder no parameter of the operation fills, so discovery accepts its signature on the declared parameters, `prepare` reports that one operation unbuildable with reason `discovery-error`, and every sibling still prepares.

## The contract

`docs/harness-authoring.md` in the engine repository, <https://github.com/DustinEwan/autofuzz>, states the plugin contract this harness implements. The two rules that decide the shape of `plugin/server.mjs` are in that document and restated at the top of the file: stdout is the protocol channel, and a call that outlives its deadline must answer before the engine cuts the process — this harness cuts its own fetch with `AbortSignal.timeout` and answers `failed` via `deadline-cut`.
