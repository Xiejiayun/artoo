#!/usr/bin/env node
// Explicit local test double for the Codex/Claude JSONL contracts. This fixture
// never contacts a provider; the installed daemon still launches a real process.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const runtime = args[0] === "exec" ? "codex" : args[0] === "-p" ? "claude-code" : undefined;
assert.ok(runtime, "Controlled fixture requires the ordinary runtime command");
const nonce = process.env.ARTOO_NPM_SMOKE_NONCE;
assert.match(nonce ?? "", /^[a-f0-9-]{36}$/);
const parent = realpathSync(process.env.ARTOO_NPM_SMOKE_WORKSPACE_ROOT);
const workspace = realpathSync(process.cwd()), local = relative(parent, workspace);
assert.ok(local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`), "Fixture workspace escaped the isolated smoke root");
const contextPath = join(workspace, "context_pack.md");
if (runtime === "codex") {
  assert.ok(args.includes("--json"));
  assert.equal(realpathSync(resolve(args[args.indexOf("-C") + 1])), workspace);
} else {
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
}
assert.ok(args.some(value => value.includes(contextPath)), "The preset must pass the materialized task context");
const context = readFileSync(contextPath, "utf8"), heading = "\n## Raw Payload\n";
assert.ok(context.includes(heading));
const payload = JSON.parse(context.slice(context.indexOf(heading) + heading.length));
const request = JSON.parse(payload.task.description);
assert.equal(request.fixture, "artoo.npm-controlled-cli.v1");
assert.equal(request.runtime, runtime); assert.equal(request.nonce, nonce);
assert.ok(["success", "failure"].includes(request.outcome));
const marker = `ARTOO_NPM_FIXTURE:${runtime}:${request.outcome}:${nonce}`;
const record = { fixture: request.fixture, runtime, outcome: request.outcome, marker, taskId: payload.task.id,
  pid: process.pid, parentPid: process.ppid, platform: process.platform, arch: process.arch, modelInvoked: false };
writeFileSync(join(workspace, "fixture-start.json"), `${JSON.stringify(record)}\n`, { flag: "wx" });
// This is explicitly self-reported process exit evidence. The smoke separately
// checks the daemon's committed terminal event and that this PID no longer lives.
process.once("exit", code => writeFileSync(join(workspace, "fixture-exit.json"),
  `${JSON.stringify({ ...record, exitCode: code })}\n`, { flag: "wx" }));
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ fixture: request.fixture, phase: "started", marker });
if (runtime === "codex") emit({ type: "thread.started", thread_id: `fixture-${nonce}` });
if (request.outcome === "failure") {
  const reason = `Controlled fixture failure: ${marker}`;
  if (runtime === "codex") emit({ type: "turn.failed", error: { message: reason } });
  else emit({ type: "result", subtype: "error_fixture", is_error: true, result: reason });
  process.exitCode = 23;
} else {
  writeFileSync(join(workspace, "fixture-output.txt"), `${marker}\n`, { flag: "wx" });
  writeFileSync(join(workspace, "changes.patch"), "diff --git a/fixture-output.txt b/fixture-output.txt\n"
    + "new file mode 100644\n--- /dev/null\n+++ b/fixture-output.txt\n@@ -0,0 +1 @@\n"
    + `+${marker}\n`, { flag: "wx" });
  if (runtime === "codex") {
    emit({ type: "item.completed", item: { type: "agent_message", text: marker } });
    emit({ type: "turn.completed" });
  } else emit({ type: "result", subtype: "success", result: marker, session_id: `fixture-${nonce}` });
}
