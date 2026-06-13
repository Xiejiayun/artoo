#!/usr/bin/env node
// Deterministic stand-in for a real coding-agent CLI, used to exercise the
// ProcessAdapter without depending on the real `codex` binary. Prints scripted
// stdout/stderr, writes a patch artifact into the workspace, then exits.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const workspace = getArg("--workspace");
const shouldFail = args.includes("--fail");
const lines = (getArg("--lines") ?? "reading context||applying changes||done").split("||");

for (const line of lines) {
  console.log(`mock-agent: ${line}`);
}
console.error("mock-agent: sample warning");

if (workspace) {
  writeFileSync(
    join(workspace, "changes.patch"),
    "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"
  );
}

process.exit(shouldFail ? 1 : 0);
