// Test-only CLI for the real process adapter. It never calls an API or changes
// server records: answers and failures travel through provider-shaped stdout,
// and a hold ends only when the worker kills the process (or a failure timeout).
// Usage: node assistant-conversation.mjs <context-pack-path> <configuration-path>
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const assistantHash = (value) => createHash("sha256").update(value).digest("hex");
export const assistantStartupReceiptPath = (directory, runId) => join(directory, `run-${assistantHash(runId)}.json`);
export const assistantFailureReceiptPath = (directory, turnId) => join(directory, `turn-${assistantHash(turnId)}-failed-once.json`);
export const ASSISTANT_FIXTURE_FAILURE_EXIT = 42;
export const ASSISTANT_FIXTURE_HOLD_TIMEOUT_EXIT = 43;
const firstAnswerPattern = /^First answer marker: ASSISTANT_[A-F0-9]{32}$/;
const followupAnswer = (first) => `Follow-up used the actual earlier answer: ${first}`;

function publishExclusiveJSON(path, value) {
  // Harnesses provide a private receipt directory/ancestor. Readers ignore
  // this exact temporary-name shape; the final name appears only when complete.
  const temporary = join(dirname(path), `.assistant-receipt-${randomBytes(16).toString("hex")}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
    // Unlike rename, link cannot overwrite a competing/existing receipt. Keep
    // EEXIST intact for fail-once retry handling and duplicate-run rejection.
    linkSync(temporary, path);
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
}

function nonempty(value, field) {
  assert.ok(typeof value === "string" && value.trim().length > 0, `${field} must be a nonempty string`);
  return value;
}

function readContext(contextPath, configurationPath) {
  const context = readFileSync(contextPath), source = context.toString("utf8"), marker = "## Raw Payload\n";
  assert.ok(source.includes(marker), "The process adapter must provide a complete context pack");
  const pack = JSON.parse(source.slice(source.indexOf(marker) + marker.length));
  const header = source.split("\n\n", 1)[0];
  const runIds = [...header.matchAll(/^run: (.+)$/gm)].map((match) => match[1]);
  const taskIds = [...header.matchAll(/^task: (.+)$/gm)].map((match) => match[1]);
  assert.equal(runIds.length, 1, "Only the actual header may identify the run");
  assert.equal(taskIds.length, 1, "The context header must identify one task");
  const runId = nonempty(runIds[0], "run ID");
  assert.equal(taskIds[0], nonempty(pack.task.id, "task ID"));
  const fixture = JSON.parse(readFileSync(configurationPath, "utf8"));
  for (const field of ["project_id", "room_id", "user_id", "agent_instance_id", "workspace_root", "receipts_directory"]) nonempty(fixture[field], field);
  for (const field of ["workspace_root", "receipts_directory"]) assert.ok(isAbsolute(fixture[field]), `${field} must be absolute`);
  const workspace = realpathSync(fixture.workspace_root), receipts = realpathSync(fixture.receipts_directory);
  const receiptRelative = relative(workspace, receipts);
  assert.ok(receiptRelative === ".." || receiptRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(receiptRelative), "Private receipts must stay outside the execution workspace");
  assert.equal(realpathSync(process.cwd()), workspace, "The child must run in the configured workspace");
  assert.ok(isAbsolute(pack.workspace.root), "The context workspace must be absolute");
  assert.equal(realpathSync(pack.workspace.root), workspace);
  assert.equal(pack.project.id, fixture.project_id);
  assert.equal(pack.policy.execution_mode, undefined, "Direct requests must not use a coordinator discussion context");
  // Direct assistant runs retain normal execution grants, unlike discussion
  // contexts. Record their actual scope; do not demand empty or broader grants
  // just because this fixture chooses not to modify project files.
  assert.ok(Array.isArray(pack.policy.filesystem_write_scope)
    && pack.policy.filesystem_write_scope.every((scope) => typeof scope === "string" && scope.trim().length > 0));
  assert.ok(Array.isArray(pack.policy.requires_approval)
    && pack.policy.requires_approval.every((action) => typeof action === "string" && action.trim().length > 0));
  const conversation = pack.conversation;
  assert.ok(conversation && Array.isArray(conversation.messages));
  assert.equal(conversation.room_id, fixture.room_id);
  assert.equal(fixture.thread_root_id ?? null, null, "This fixture covers an isolated top-level direct conversation");
  assert.equal(conversation.thread_root_id ?? null, null, "Another thread must not enter the direct conversation");
  assert.equal(conversation.history_truncated, false);
  nonempty(conversation.turn_id, "turn ID");
  const modes = ["first", "second", "hold"];
  for (const mode of modes) {
    nonempty(fixture.requests?.[mode], `${mode} request`);
    assert.equal(fixture.requests[mode], fixture.requests[mode].trim(), "Fixture requests must match the clients' trimmed submissions");
  }
  assert.equal(new Set(modes.map((mode) => fixture.requests[mode])).size, 3);
  const mode = modes.find((candidate) => fixture.requests[candidate] === conversation.current_request);
  assert.ok(mode, "The child must receive one of the three exact UI-authored requests");
  const history = conversation.messages;
  assert.equal(history.length, mode === "first" ? 0 : mode === "second" ? 2 : 4, "Current, future or unrelated messages must not enter prior history");
  const forbiddenIds = fixture.forbidden_message_ids ?? [];
  assert.ok(Array.isArray(forbiddenIds) && forbiddenIds.every((id) => typeof id === "string"));
  const ids = new Set();
  for (const [index, message] of history.entries()) {
    nonempty(message.id, "history message ID"); nonempty(message.body, "history message body");
    assert.ok(!ids.has(message.id) && !forbiddenIds.includes(message.id), "History IDs must be unique and belong to this conversation");
    ids.add(message.id);
    assert.equal(message.role, index % 2 === 0 ? "user" : "assistant");
    assert.equal(message.actor_id, index % 2 === 0 ? fixture.user_id : fixture.agent_instance_id);
  }
  if (history.length) {
    assert.equal(history[0].body, fixture.requests.first);
    assert.match(history[1].body, firstAnswerPattern, "The follow-up must read the first child's marker from the actual earlier answer");
  }
  if (mode === "hold") {
    assert.equal(history[2].body, fixture.requests.second);
    assert.equal(history[3].body, followupAnswer(history[1].body), "Hold must retain both actual earlier answers in order");
  }
  const holdTimeout = fixture.hold_timeout_ms ?? 180_000;
  assert.ok(Number.isSafeInteger(holdTimeout) && holdTimeout >= 25 && holdTimeout <= 300_000, "Hold timeout must be bounded");
  return { fixture, pack, conversation, history, workspace, receipts, runId, mode, holdTimeout, contextHash: assistantHash(context) };
}

/** Importable by the temporary Mac CLI. Every invocation belongs to one child
 * process; await it and do not fall through to the ordinary artifact branch.
 * Receipt config has no credentials. Current computer/instance identity is not
 * in the production context pack: client harnesses must verify it from run APIs.
 */
export async function runAssistantConversationFixture({ contextPath, configurationPath }) {
  const state = readContext(contextPath, configurationPath);
  const { fixture, pack, conversation, history, workspace, receipts, runId, mode, holdTimeout, contextHash } = state;
  const receiptPath = assistantStartupReceiptPath(receipts, runId);
  assert.equal(existsSync(receiptPath), false, "A repeated run must not overwrite its observed startup");
  let attempt = 1, failOnce = false;
  if (mode === "second") {
    const identity = { turn_id: conversation.turn_id, task_id: pack.task.id, project_id: pack.project.id, room_id: conversation.room_id,
      thread_root_id: null, current_request_sha256: assistantHash(conversation.current_request) };
    const failurePath = assistantFailureReceiptPath(receipts, conversation.turn_id);
    try {
      publishExclusiveJSON(failurePath, { ...identity, initial_run_id: runId });
      failOnce = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const { initial_run_id: initialRun, ...recorded } = JSON.parse(readFileSync(failurePath, "utf8"));
      assert.deepEqual(recorded, identity, "Fail-once state must belong to the exact retried logical request");
      nonempty(initialRun, "failed run ID"); assert.notEqual(initialRun, runId, "Retry must create a different actual run");
      attempt = 2;
    }
  }
  const answer = mode === "first" ? `First answer marker: ASSISTANT_${randomBytes(16).toString("hex").toUpperCase()}`
    : mode === "second" && !failOnce ? followupAnswer(history[1].body) : null;
  // Startup is observation, not a successful-run claim. The harness must bind
  // these IDs/hashes to persisted API answers and terminal run/turn states.
  publishExclusiveJSON(receiptPath, {
    pid: process.pid, run_id: runId, turn_id: conversation.turn_id, task_id: pack.task.id, project_id: pack.project.id,
    room_id: conversation.room_id, thread_root_id: null, workspace_root: workspace, mode, attempt,
    behavior: failOnce ? "fail_before_retry" : mode === "hold" ? "hold_until_cancel" : "emit_answer",
    filesystem_write_scope: pack.policy.filesystem_write_scope,
    requires_approval: pack.policy.requires_approval,
    context_sha256: contextHash, current_request_sha256: assistantHash(conversation.current_request), history_truncated: false,
    messages: history.map((message) => ({ id: message.id, role: message.role, actor_id: message.actor_id, body_sha256: assistantHash(message.body) })),
    answer_sha256: answer === null ? null : assistantHash(answer), usage_source: "deterministic_fixture",
  });
  const emit = (event) => console.log(JSON.stringify(event));
  emit({ type: "thread.started", thread_id: `assistant-fixture:${mode}:${process.pid}:${runId}:${conversation.turn_id}` });
  if (failOnce) {
    emit({ type: "turn.failed", error: { message: "Intentional direct-agent fixture failure; use the client Retry action" } });
    process.exitCode = ASSISTANT_FIXTURE_FAILURE_EXIT;
    return;
  }
  if (mode === "hold") {
    // Default SIGTERM/SIGKILL handling is deliberate: only actual worker
    // cancellation terminates a successful hold scenario. Timeout is failure.
    await new Promise((resolveHold) => setTimeout(resolveHold, holdTimeout));
    emit({ type: "turn.failed", error: { message: "Direct-agent fixture was not cancelled before its hold timeout" } });
    process.exitCode = ASSISTANT_FIXTURE_HOLD_TIMEOUT_EXIT;
    return;
  }
  emit({ type: "item.completed", item: { type: "agent_message", text: answer } });
  emit({ type: "turn.completed", usage: { input_tokens: 100 + history.length, output_tokens: 50, cached_input_tokens: 0, usage_source: "deterministic_fixture" } });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 4, "Expected context-pack and fixture-configuration paths");
    await runAssistantConversationFixture({ contextPath: process.argv[2], configurationPath: process.argv[3] });
  } catch (error) {
    // Fixed diagnostics avoid copying full context or configuration into logs.
    console.error(`Assistant conversation fixture rejected its context (${error?.name === "AssertionError" ? "assertion" : "input"})`);
    process.exitCode = 1;
  }
}
