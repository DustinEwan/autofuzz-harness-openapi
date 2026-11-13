// Reproducer rendering: a standalone `curl` script that replays one call.
//
// The script is the artifact a human runs when the engine files a finding, so it names
// the operation, the document it came from, and the exact request - and it exits
// non-zero on a 5xx, so "the finding reproduced" is an exit code, not a judgment call.
// The `reproducer` request carries no fault context, so the script always says what to
// do when the call hangs: that is what a deadline finding looks like from here.

export function renderReproducer({ request, operationName, documentName }) {
  const header = [
    "#!/bin/sh",
    "# Reproducer rendered by the openapi harness.",
    `# Operation: ${operationName}`,
    `# Document: ${documentName}`,
    "# If this request hangs, the operation likely outlives the harness deadline: stop it with Ctrl-C.",
  ].join("\n");

  const command = [`curl -sS --fail-with-body -X ${request.method} ${shellQuote(request.url)}`];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    command.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.body !== undefined) command.push(`--data-binary ${shellQuote(request.body)}`);
  return `${header}\n${command.join(" \\\n")}\n`;
}

function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}
