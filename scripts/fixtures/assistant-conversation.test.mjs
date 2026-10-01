import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ASSISTANT_FIXTURE_FAILURE_EXIT, ASSISTANT_FIXTURE_HOLD_TIMEOUT_EXIT, assistantFailureReceiptPath, assistantHash, assistantStartupReceiptPath } from "./assistant-conversation.mjs";

// These are real temporary CLI subprocesses, not UI/worker/server E2E. Killing
// the owned hold child below verifies fixture behavior only; the client E2E
// must instead cancel through UI and confirm the actual worker process exits.
const executable = fileURLToPath(new URL("./assistant-conversation.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-assistant-fixture-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace"), receipts = join(directory, "receipts");
  mkdirSync(workspace); mkdirSync(receipts);
  const fixture = { project_id: "unit-project", room_id: "unit-room", user_id: "unit-user", agent_instance_id: "unit-agent",
    workspace_root: workspace, receipts_directory: receipts, thread_root_id: null,
    requests: { first: "First direct request", second: "Follow up on the actual earlier answer", hold: "Wait until I cancel this request" }, forbidden_message_ids: ["foreign-thread-message"] };
  return { directory, workspace, receipts, fixture, contextPath: join(workspace, "context_pack.md"), configurationPath: join(directory, "fixture.json") };
}
function packFor(state, mode, history = [], turnId = `turn-${mode}`) {
  return { task: { id: "unit-task", title: "Conversation task", description: "A direct assistant request", acceptance_criteria: ["Answer the request"] },
    project: { id: state.fixture.project_id, name: "Unit project", default_workspace: null }, workspace: { root: state.workspace, file_scope: [] },
    policy: { filesystem_write_scope: [state.workspace], requires_approval: ["git.push", "external.post"] },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    conversation: { room_id: state.fixture.room_id, thread_root_id: null, turn_id: turnId, current_request: state.fixture.requests[mode], messages: history, history_truncated: false } };
}
function prepare(state, pack, runId, header = `# Context Pack unit-context\ntask: ${pack.task.id}\nrun: ${runId}`) {
  // A rendered description containing a run-like line is not the actual header.
  writeFileSync(state.contextPath, `${header}\n\n## Task\nrun: misleading-description-run\n\n## Raw Payload\n${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(state.configurationPath, JSON.stringify(state.fixture));
}
function execute(state, pack, runId, options = {}) {
  prepare(state, pack, runId, options.header);
  return spawnSync(process.execPath, [options.executable ?? executable, state.contextPath, state.configurationPath], {
    cwd: options.cwd ?? state.workspace, env: {}, encoding: "utf8", timeout: 10_000,
  });
}
const frames = (output) => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const readReceipt = (state, runId) => JSON.parse(readFileSync(assistantStartupReceiptPath(state.receipts, runId), "utf8"));
function message(state, id, role, body) { return { id, role, body, actor_id: role === "user" ? state.fixture.user_id : state.fixture.agent_instance_id }; }
function first(state) {
  const runId = "run-first", pack = packFor(state, "first"), child = execute(state, pack, runId);
  assert.equal(child.status, 0, child.stderr);
  const output = frames(child.stdout), answer = output.find((frame) => frame.type === "item.completed").item.text;
  assert.match(answer, /^First answer marker: ASSISTANT_[A-F0-9]{32}$/);
  return { child, pack, runId, answer, history: [message(state, "request-first", "user", state.fixture.requests.first), message(state, "answer-first", "assistant", answer)] };
}
function twoAnswers(state) {
  const initial = first(state), secondPack = packFor(state, "second", initial.history);
  const failed = execute(state, secondPack, "run-second-failed");
  assert.equal(failed.status, ASSISTANT_FIXTURE_FAILURE_EXIT, failed.stderr);
  const retried = execute(state, secondPack, "run-second-retried");
  assert.equal(retried.status, 0, retried.stderr);
  const answer = frames(retried.stdout).find((frame) => frame.type === "item.completed").item.text;
  return { initial, failed, retried, answer,
    history: [...initial.history, message(state, "request-second", "user", state.fixture.requests.second), message(state, "answer-second", "assistant", answer)] };
}
async function hold(t, state, history, runId = "run-hold") {
  prepare(state, packFor(state, "hold", history), runId);
  const child = spawn(process.execPath, [executable, state.contextPath, state.configurationPath], { cwd: state.workspace, env: {}, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  const deadline = Date.now() + 5000;
  while (!existsSync(assistantStartupReceiptPath(state.receipts, runId)) && Date.now() < deadline) {
    assert.equal(child.exitCode, null, stderr); await delay(10);
  }
  assert.ok(existsSync(assistantStartupReceiptPath(state.receipts, runId)), "Hold must publish its actual startup receipt");
  return { child, closed, output: () => frames(stdout), receipt: readReceipt(state, runId) };
}

test("three logical requests make four real child launches and only two answers, with failed-turn retry and cancellable hold", async (t) => {
  const state = setup(t), result = twoAnswers(state);
  assert.equal(result.answer, `Follow-up used the actual earlier answer: ${result.initial.answer}`);
  assert.ok(!readFileSync(state.configurationPath, "utf8").includes(result.initial.answer), "The first child, not fixture configuration, supplies the marker");
  const firstFrames = frames(result.initial.child.stdout), failedFrames = frames(result.failed.stdout), retriedFrames = frames(result.retried.stdout);
  assert.deepEqual(firstFrames.map((frame) => frame.type), ["thread.started", "item.completed", "turn.completed"]);
  assert.deepEqual(failedFrames.map((frame) => frame.type), ["thread.started", "turn.failed"]);
  for (const [output, historyCount] of [[firstFrames, 0], [retriedFrames, 2]]) {
    assert.deepEqual(output.at(-1).usage, { input_tokens: 100 + historyCount, output_tokens: 50, cached_input_tokens: 0, usage_source: "deterministic_fixture" });
    assert.ok(!("cost_usd" in output.at(-1).usage));
  }
  const failedReceipt = readReceipt(state, "run-second-failed"), retryReceipt = readReceipt(state, "run-second-retried");
  assert.equal(readReceipt(state, "run-first").workspace_root, realpathSync(state.workspace));
  assert.equal(failedReceipt.pid, result.failed.pid); assert.equal(retryReceipt.pid, result.retried.pid);
  assert.equal(failedReceipt.turn_id, retryReceipt.turn_id); assert.notEqual(failedReceipt.run_id, retryReceipt.run_id);
  assert.equal(failedReceipt.attempt, 1); assert.equal(retryReceipt.attempt, 2);
  assert.equal(failedReceipt.answer_sha256, null); assert.equal(retryReceipt.answer_sha256, assistantHash(result.answer));
  assert.deepEqual(retryReceipt.messages, result.initial.history.map(({ id, role, actor_id, body }) => ({ id, role, actor_id, body_sha256: assistantHash(body) })));
  const held = await hold(t, state, result.history);
  assert.equal(held.receipt.pid, held.child.pid); assert.equal(held.receipt.behavior, "hold_until_cancel");
  await delay(50); assert.equal(held.child.exitCode, null); assert.equal(held.child.signalCode, null);
  held.child.kill("SIGTERM");
  const terminal = await held.closed;
  assert.equal(terminal.signal, "SIGTERM");
  assert.deepEqual(held.output().map((frame) => frame.type), ["thread.started"]);
  const startupFiles = readdirSync(state.receipts).filter((name) => name.startsWith("run-"));
  assert.equal(startupFiles.length, 4);
  const receipts = startupFiles.map((name) => JSON.parse(readFileSync(join(state.receipts, name), "utf8")));
  assert.equal(new Set(receipts.map((receipt) => receipt.turn_id)).size, 3);
  assert.equal(receipts.filter((receipt) => receipt.answer_sha256 !== null).length, 2);
  assert.ok(receipts.every((receipt) => receipt.usage_source === "deterministic_fixture"));
  assert.ok(receipts.every((receipt) => !("computer_id" in receipt) && !("agent_instance_id" in receipt)), "Receipts must not claim context fields that the production adapter does not supply");
  assert.deepEqual(readdirSync(state.workspace), ["context_pack.md"]);
});

test("first markers are freshly generated in independent processes", (t) => {
  const one = first(setup(t)), two = first(setup(t));
  assert.notEqual(one.answer, two.answer);
});

test("failure state is scoped to the logical turn and cannot silently accept different retry content", (t) => {
  const state = setup(t), initial = first(state);
  assert.equal(execute(state, packFor(state, "second", initial.history), "failed-one").status, ASSISTANT_FIXTURE_FAILURE_EXIT);
  assert.equal(execute(state, packFor(state, "second", initial.history, "another-turn"), "failed-two").status, ASSISTANT_FIXTURE_FAILURE_EXIT);
  const failurePath = assistantFailureReceiptPath(state.receipts, "turn-second"), before = readFileSync(failurePath, "utf8");
  state.fixture.requests.second = "A different request with the same turn ID";
  const changed = execute(state, packFor(state, "second", initial.history), "different-request");
  assert.equal(changed.status, 1); assert.equal(changed.stdout, "");
  assert.equal(readFileSync(failurePath, "utf8"), before);
  assert.equal(existsSync(assistantStartupReceiptPath(state.receipts, "different-request")), false);
});

test("replaying the same run cannot overwrite a receipt or produce a second answer", (t) => {
  const state = setup(t), initial = first(state), path = assistantStartupReceiptPath(state.receipts, initial.runId), before = readFileSync(path, "utf8");
  const replay = execute(state, initial.pack, initial.runId);
  assert.equal(replay.status, 1); assert.equal(replay.stdout, ""); assert.equal(readFileSync(path, "utf8"), before);
});

// Fault injection is isolated to a disposable CLI subprocess. Pause an actual
// write after one byte to expose the old final-path race deterministically;
// the product publisher has no test callbacks or configurable filesystem.
function publicationProbe(state, kind) {
  const directory = join(state.directory, `publication-${kind}`); mkdirSync(directory);
  const loader = join(directory, "probe.mjs");
  writeFileSync(loader, `import fs from "node:fs";
import {join} from "node:path";
import {syncBuiltinESMExports} from "node:module";
const directory = ${JSON.stringify(directory)}, kind = ${JSON.stringify(kind)};
const write = fs.writeFileSync, link = fs.linkSync;
if (kind === "collision") fs.linkSync = (source, destination) => {
  write(destination, JSON.stringify({winner:"competing publication"}), {mode:0o600,flag:"wx"});
  return link(source, destination);
};
else fs.writeFileSync = (file, data, options) => {
  let value; try { value = JSON.parse(String(data)); } catch { return write(file, data, options); }
  const stage = value.initial_run_id ? "failure" : value.run_id && value.pid ? "startup" : null;
  if (!stage) return write(file, data, options);
  const bytes = Buffer.from(data);
  write(file, bytes.subarray(0, 1), options);
  if (kind === "write-failure") { const error = new Error("Injected partial-write failure"); error.code = "EIO"; throw error; }
  write(join(directory, "entered-" + stage), "ready");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(join(directory, "release-" + stage))) {
    if (Date.now() > deadline) throw new Error("Publication probe timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return write(file, bytes.subarray(1), typeof file === "number" ? options : {...options,flag:"a"});
};
syncBuiltinESMExports();`);
  return { directory, args: ["--import", pathToFileURL(loader).href, executable, state.contextPath, state.configurationPath] };
}
const temporaryReceiptNames = (state) => readdirSync(state.receipts).filter((name) => /^\.assistant-receipt-[a-f0-9]{32}\.tmp$/.test(name));

test("startup and fail-once final paths expose only complete JSON after private writes finish", async (t) => {
  const state = setup(t);
  async function publish(mode, runId, history, stages) {
    prepare(state, packFor(state, mode, history), runId);
    const probe = publicationProbe(state, mode);
    const child = spawn(process.execPath, probe.args, { cwd: state.workspace, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (status, signal) => resolve({ status, signal })); });
    try {
      for (const stage of stages) {
        const deadline = Date.now() + 5000, entered = join(probe.directory, `entered-${stage}`);
        while (!existsSync(entered) && Date.now() < deadline) { assert.equal(child.exitCode, null, stderr); await delay(10); }
        assert.ok(existsSync(entered), "The actual CLI must reach the intentionally partial write");
        const finalPath = stage === "failure" ? assistantFailureReceiptPath(state.receipts, "turn-second") : assistantStartupReceiptPath(state.receipts, runId);
        assert.equal(existsSync(finalPath), false, "A partially written receipt must never occupy its final path");
        const temporary = temporaryReceiptNames(state); assert.equal(temporary.length, 1);
        const privatePath = join(state.receipts, temporary[0]);
        assert.throws(() => JSON.parse(readFileSync(privatePath, "utf8")), SyntaxError);
        if (process.platform !== "win32") assert.equal(statSync(privatePath).mode & 0o777, 0o600);
        writeFileSync(join(probe.directory, `release-${stage}`), "continue");
      }
      const result = await closed;
      assert.equal(result.status, mode === "first" ? 0 : ASSISTANT_FIXTURE_FAILURE_EXIT, stderr);
      assert.equal(readReceipt(state, runId).run_id, runId);
      assert.deepEqual(temporaryReceiptNames(state), []);
      if (process.platform !== "win32") assert.equal(statSync(assistantStartupReceiptPath(state.receipts, runId)).mode & 0o777, 0o600);
      return frames(stdout);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }
  const output = await publish("first", "atomic-first", [], ["startup"]);
  const answer = output.find((frame) => frame.type === "item.completed").item.text;
  const history = [message(state, "request-first", "user", state.fixture.requests.first), message(state, "answer-first", "assistant", answer)];
  await publish("second", "atomic-failed", history, ["failure", "startup"]);
  const failurePath = assistantFailureReceiptPath(state.receipts, "turn-second"), before = readFileSync(failurePath, "utf8");
  assert.equal(JSON.parse(before).initial_run_id, "atomic-failed");
  if (process.platform !== "win32") assert.equal(statSync(failurePath).mode & 0o777, 0o600);
  const retry = execute(state, packFor(state, "second", history), "atomic-retry");
  assert.equal(retry.status, 0, retry.stderr); assert.equal(readReceipt(state, "atomic-retry").attempt, 2);
  assert.equal(readFileSync(failurePath, "utf8"), before, "EEXIST must preserve the first failed attempt exactly");
  assert.deepEqual(temporaryReceiptNames(state), [], "The retry's EEXIST publication must also remove its private temporary file");
});

test("an actual partial write failure leaves no final receipt or temporary file", (t) => {
  const state = setup(t); prepare(state, packFor(state, "first"), "write-failed");
  const probe = publicationProbe(state, "write-failure");
  const child = spawnSync(process.execPath, probe.args, { cwd: state.workspace, env: {}, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.deepEqual(readdirSync(state.receipts), []);
});

test("a final-name collision after the initial check cannot overwrite the winner and cleans its temporary file", (t) => {
  const state = setup(t); prepare(state, packFor(state, "first"), "collision-run");
  const probe = publicationProbe(state, "collision");
  const child = spawnSync(process.execPath, probe.args, { cwd: state.workspace, env: {}, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.deepEqual(readReceipt(state, "collision-run"), { winner: "competing publication" });
  assert.deepEqual(temporaryReceiptNames(state), []);
});

test("normal direct execution grants are recorded unchanged without writing work files", (t) => {
  for (const scope of [[], ["src"], ["src/new-directory", "docs"]]) {
    const state = setup(t), pack = packFor(state, "first"); pack.policy.filesystem_write_scope = scope;
    const child = execute(state, pack, "scoped-run"); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(readReceipt(state, "scoped-run").filesystem_write_scope, scope);
    assert.deepEqual(readReceipt(state, "scoped-run").requires_approval, pack.policy.requires_approval);
    assert.deepEqual(readdirSync(state.workspace), ["context_pack.md"]);
  }
});

test("an uncancelled hold times out as a failure without publishing an answer or successful usage", (t) => {
  const state = setup(t), { history } = twoAnswers(state); state.fixture.hold_timeout_ms = 25;
  const child = execute(state, packFor(state, "hold", history), "timed-out-hold");
  assert.equal(child.status, ASSISTANT_FIXTURE_HOLD_TIMEOUT_EXIT);
  assert.deepEqual(frames(child.stdout).map((frame) => frame.type), ["thread.started", "turn.failed"]);
  assert.equal(readReceipt(state, "timed-out-hold").answer_sha256, null);
});

test("the exported async entrypoint works in an imported Mac-style CLI wrapper", (t) => {
  const state = setup(t), wrapper = join(state.directory, "wrapper.mjs");
  writeFileSync(wrapper, `import {runAssistantConversationFixture} from ${JSON.stringify(new URL("./assistant-conversation.mjs", import.meta.url).href)}; await runAssistantConversationFixture({contextPath:process.argv[2],configurationPath:process.argv[3]});`);
  const child = execute(state, packFor(state, "first"), "wrapper-run", { executable: wrapper });
  assert.equal(child.status, 0, child.stderr); assert.equal(readReceipt(state, "wrapper-run").pid, child.pid);
});

for (const [name, mutate, options] of [
  ["coordinator discussion mode", (_state, pack) => { pack.policy.execution_mode = "discussion"; }],
  ["a malformed execution grant", (_state, pack) => { pack.policy.filesystem_write_scope = [null]; }],
  ["a different project", (_state, pack) => { pack.project.id = "other-project"; }],
  ["a different room", (_state, pack) => { pack.conversation.room_id = "other-room"; }],
  ["an unrelated thread", (_state, pack) => { pack.conversation.thread_root_id = "other-thread"; }],
  ["a relative context workspace", (_state, pack) => { pack.workspace.root = "."; }],
  ["a different execution directory", () => {}, (state) => ({ cwd: state.directory })],
  ["workspace-local private receipts", (state) => { state.fixture.receipts_directory = state.workspace; }],
  ["truncated history", (_state, pack) => { pack.conversation.history_truncated = true; }],
  ["an unknown current request", (_state, pack) => { pack.conversation.current_request = "Not the UI fixture request"; }],
  ["the current request leaking into history", (state, pack) => { pack.conversation.messages.push(message(state, "current-request", "user", state.fixture.requests.first)); }],
  ["a missing run header", () => {}, () => ({ header: "# Context Pack unit-context\ntask: unit-task" })],
  ["a mismatched task header", () => {}, () => ({ header: "# Context Pack unit-context\ntask: another-task\nrun: invalid-run" })],
  ["two run headers", () => {}, () => ({ header: "# Context Pack unit-context\ntask: unit-task\nrun: invalid-run\nrun: another-run" })],
]) test(`context validation rejects ${name} before startup or output`, (t) => {
  const state = setup(t), pack = packFor(state, "first"); mutate(state, pack);
  const child = execute(state, pack, "invalid-run", options?.(state));
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.deepEqual(readdirSync(state.receipts), []);
});

for (const [name, mutate] of [
  ["a missing first answer", (history) => { history.pop(); }],
  ["a wrong prior-answer actor", (history) => { history[1].actor_id = "another-instance"; }],
  ["a wrong prior user", (history) => { history[0].actor_id = "another-user"; }],
  ["duplicate message identities", (history) => { history[1].id = history[0].id; }],
  ["a forbidden cross-thread message", (history) => { history[1].id = "foreign-thread-message"; }],
  ["future user content", (history) => { history.push({ id: "future", role: "user", actor_id: "unit-user", body: "Wait until I cancel this request" }); }],
  ["reordered history", (history) => { history.reverse(); }],
]) test(`follow-up rejects ${name} without consuming its fail-once attempt`, (t) => {
  const state = setup(t), initial = first(state), history = structuredClone(initial.history); mutate(history);
  const child = execute(state, packFor(state, "second", history), "invalid-followup");
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.equal(existsSync(assistantFailureReceiptPath(state.receipts, "turn-second")), false);
  assert.equal(existsSync(assistantStartupReceiptPath(state.receipts, "invalid-followup")), false);
});
