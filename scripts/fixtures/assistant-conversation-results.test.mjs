import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ASSISTANT_FIXTURE_FAILURE_EXIT, assistantFailureReceiptPath, assistantHash, assistantStartupReceiptPath } from "./assistant-conversation.mjs";
import { verifyAssistantConversationResults } from "./assistant-conversation-results.mjs";

// Actual CLI subprocess outputs/receipts + explicit server DTO fixtures. This
// focused regression is not a production server, worker, native or Mac UI E2E.
async function observedScenario(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "artoo-assistant-results-")));
  const workspace = join(directory, "workspace"), receiptsDirectory = join(directory, "receipts");
  mkdirSync(workspace); mkdirSync(receiptsDirectory);
  let held, heldClosed;
  t.after(async () => {
    if (held && held.exitCode === null && held.signalCode === null) held.kill("SIGKILL");
    await heldClosed;
    rmSync(directory, { recursive: true, force: true });
  });
  const fixture = { project_id: "unit-project", room_id: "unit-room", user_id: "unit-user", agent_instance_id: "unit-instance",
    computer_id: "unit-computer", runtime_id: "unit-codex", workspace_root: workspace, receipts_directory: receiptsDirectory,
    requests: { first: "First exact direct request", second: "Use the actual earlier answer", hold: "Hold this request until cancellation" } };
  const configurationPath = join(directory, "configuration.json"), contextPath = join(workspace, "context_pack.md");
  writeFileSync(configurationPath, JSON.stringify(fixture), { mode: 0o600 });
  const executable = fileURLToPath(new URL("./assistant-conversation.mjs", import.meta.url));
  const contextHashes = [], receipts = [], usages = [], runs = [];
  const frames = (stdout) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  function prepare(mode, runId, history) {
    const pack = { task: { id: "unit-task" }, project: { id: fixture.project_id }, workspace: { root: workspace },
      policy: { filesystem_write_scope: [workspace], requires_approval: ["git.push", "external.post"] },
      conversation: { room_id: fixture.room_id, thread_root_id: null, turn_id: `turn-${mode}`, current_request: fixture.requests[mode], messages: history, history_truncated: false } };
    writeFileSync(contextPath, `# Context Pack context-${runId}\ntask: unit-task\nrun: ${runId}\n\n## Raw Payload\n${JSON.stringify(pack, null, 2)}\n`);
    // Independently read the file, not the hash written later by the child.
    const bytes = readFileSync(contextPath);
    assert.ok(bytes.toString("utf8").split("\n\n", 1)[0].includes(`\nrun: ${runId}`));
    contextHashes.push({ run_id: runId, sha256: assistantHash(bytes) });
  }
  const serverRun = (runId, status) => ({ id: runId, task_id: "unit-task", computer_id: fixture.computer_id,
    agent_instance_id: fixture.agent_instance_id, runtime_id: fixture.runtime_id, workspace_root: workspace, status });
  function execute(mode, runId, history) {
    prepare(mode, runId, history);
    const child = spawnSync(process.execPath, [executable, contextPath, configurationPath], { cwd: workspace, env: {}, encoding: "utf8", timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.status, runId === "run-second-failed" ? ASSISTANT_FIXTURE_FAILURE_EXIT : 0, child.stderr);
    const receipt = JSON.parse(readFileSync(assistantStartupReceiptPath(receiptsDirectory, runId), "utf8"));
    assert.equal(receipt.pid, child.pid);
    receipts.push(receipt); runs.push(serverRun(runId, child.status === 0 ? "completed" : "failed"));
    const output = frames(child.stdout), completed = output.find(({ type }) => type === "turn.completed");
    usages.push({ run_id: runId, usage: completed ? { run_id: runId, ...completed.usage,
      provider_session_id: output.find(({ type }) => type === "thread.started").thread_id, cost_usd: null, currency: null } : null });
    return output.find(({ type }) => type === "item.completed")?.item.text;
  }
  const historyMessage = (id, role, body) => ({ id, role, body, actor_id: role === "user" ? fixture.user_id : fixture.agent_instance_id });
  const first = execute("first", "run-first", []);
  const history = [historyMessage("request-first", "user", fixture.requests.first), historyMessage("answer-first", "assistant", first)];
  assert.equal(execute("second", "run-second-failed", history), undefined);
  const second = execute("second", "run-second-retried", history);
  history.push(historyMessage("request-second", "user", fixture.requests.second), historyMessage("answer-second", "assistant", second));
  prepare("hold", "run-hold", history);
  held = spawn(process.execPath, [executable, contextPath, configurationPath], { cwd: workspace, env: {}, stdio: ["ignore", "pipe", "pipe"] });
  let holdOutput = "";
  held.stdout.on("data", (chunk) => { holdOutput += chunk; }); held.stderr.resume();
  heldClosed = new Promise((resolve, reject) => { held.once("error", reject); held.once("close", (code, signal) => resolve({ code, signal })); });
  let heldReceipt;
  const deadline = Date.now() + 5000;
  while (!heldReceipt && Date.now() < deadline) {
    try { heldReceipt = JSON.parse(readFileSync(assistantStartupReceiptPath(receiptsDirectory, "run-hold"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (!heldReceipt) await delay(10);
  }
  assert.ok(heldReceipt); assert.equal(heldReceipt.pid, held.pid); process.kill(held.pid, 0);
  held.kill("SIGTERM"); assert.equal((await heldClosed).signal, "SIGTERM");
  assert.ok(frames(holdOutput).every(({ type }) => type === "thread.started"));
  receipts.push(heldReceipt); runs.push(serverRun("run-hold", "cancelled")); usages.push({ run_id: "run-hold", usage: null });
  const turns = ["first", "second", "hold"].map((mode) => ({ id: `turn-${mode}`, room_id: fixture.room_id, thread_root_id: null,
    task_id: "unit-task", user_message_id: `request-${mode}`, response_message_id: mode === "hold" ? null : `answer-${mode}`,
    run_id: mode === "first" ? "run-first" : mode === "second" ? "run-second-retried" : "run-hold", status: mode === "hold" ? "cancelled" : "completed" }));
  const messages = [...history, historyMessage("request-hold", "user", fixture.requests.hold)].map((item, index) => {
    const mode = index < 2 ? "first" : index < 4 ? "second" : "hold", turn = turns.find(({ id }) => id === `turn-${mode}`);
    const runId = item.role === "assistant" ? turn.run_id : null;
    return { id: item.id, sequence: 10 + index * 10, kind: "text", actor_type: item.role === "assistant" ? "agent" : "user",
      actor_id: item.actor_id, body: item.body, room_id: fixture.room_id, thread_root_id: null, task_id: "unit-task", run_id: runId,
      payload: { assistant_turn_id: turn.id, intent: "assistant", ...(runId ? { run_id: runId } : {}) } };
  });
  messages.push({ id: "event", sequence: 11, kind: "run_event", room_id: fixture.room_id, thread_root_id: null, body: "Run started" });
  const livePids = receipts.filter(({ pid }) => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
  }).map(({ pid }) => pid);
  return { fixture, turns, messages, runs, usages, receipts, contextHashes, livePids,
    failedOnceReceipts: [JSON.parse(readFileSync(assistantFailureReceiptPath(receiptsDirectory, "turn-second"), "utf8"))] };
}

test("actual four-process receipts bind exact final outcomes; mutations cannot manufacture a passing workflow", async (t) => {
  const evidence = await observedScenario(t), before = structuredClone(evidence);
  const result = verifyAssistantConversationResults(evidence);
  assert.equal(result.passed, true);
  assert.deepEqual(result.counters, { logical_turns: 3, runs: 4, completed_runs: 2, failed_runs: 1, cancelled_runs: 1,
    user_messages: 3, agent_messages: 2, startup_receipts: 4, unique_processes: 4, context_files_verified: 4, fail_once_receipts: 1, observed_live_owned_processes: 0 });
  assert.deepEqual(result.attempts.map(({ history_message_ids }) => history_message_ids), [[], ["request-first", "answer-first"], ["request-first", "answer-first"], ["request-first", "answer-first", "request-second", "answer-second"]]);
  assert.match(result.scope, /no external model/); assert.equal(result.driver_observations_required.length, 5);
  assert.equal(result.driver_observations_required.some((observation) => /relaunch/i.test(observation)), false,
    "Client-specific relaunch/draft coverage is declared by its driver, not imposed on every final-outcome report");
  assert.equal(JSON.stringify(result).includes(evidence.messages[1].body), false, "Report exposes verified identities/hashes, not full answers");
  assert.deepEqual(evidence, before);

  for (const [name, mutate, expected] of [
    ["missing logical request", (value) => value.turns.pop(), /3 logical turns/],
    ["missing failed attempt", (value) => value.runs.splice(1, 1), /4 runs/],
    ["extra text answer after cancellation", (value) => value.messages.push({ ...value.messages[1], id: "invented-answer", sequence: 70 }), /5 text messages/],
    ["another room", (value) => { value.messages[0].room_id = "another-room"; }, /isolated top-level room/],
    ["a thread instead of the top-level scenario", (value) => { value.messages[0].thread_root_id = "thread"; }, /isolated top-level room/],
    ["another user", (value) => { value.messages[0].actor_id = "another-user"; }, /UI requests and user/],
    ["altered UI request body", (value) => { value.messages[2].body += " altered"; }, /UI requests and user/],
    ["replacement request ID on the existing turn", (value) => { value.turns[1].user_message_id = "new-request"; }, /exactly one logical turn/],
    ["another answer actor", (value) => { value.messages[1].actor_id = "another-agent"; }, /selected agent instance/],
    ["answer linked to the failed run", (value) => { value.messages[3].payload.run_id = "run-second-failed"; }, /persisted answer/],
    ["a response on the cancelled turn", (value) => { value.turns[2].response_message_id = "answer-second"; }, /no response message/],
    ["a different earlier marker in the follow-up", (value) => { value.messages[3].body = "Follow-up used the actual earlier answer: First answer marker: ASSISTANT_" + "0".repeat(32); }, /actual first answer/],
    ["another computer", (value) => { value.runs[0].computer_id = "another-computer"; }, /Server run/],
    ["another instance", (value) => { value.runs[0].agent_instance_id = "another-instance"; }, /Server run/],
    ["another runtime", (value) => { value.runs[0].runtime_id = "another-runtime"; }, /Server run/],
    ["another workspace", (value) => { value.runs[0].workspace_root += "-other"; }, /Server run/],
    ["failed hold instead of cancellation", (value) => { value.runs[3].status = "failed"; }, /Server run/],
    ["duplicate receipt PID", (value) => { value.receipts[1].pid = value.receipts[0].pid; }, /unique actual startup PIDs/],
    ["invented current computer context", (value) => { value.receipts[0].computer_id = value.fixture.computer_id; }, /must not invent/],
    ["reordered actual context", (value) => value.receipts[2].messages.reverse(), /preceding messages/],
    ["changed prior-message hash", (value) => { value.receipts[2].messages[1].body_sha256 = assistantHash("different answer"); }, /preceding messages/],
    ["future/current request in prior history", (value) => value.receipts[1].messages.push({ id: "request-second", role: "user", actor_id: value.fixture.user_id, body_sha256: assistantHash(value.fixture.requests.second) }), /preceding messages/],
    ["wrong prior actor", (value) => { value.receipts[3].messages[1].actor_id = "another-agent"; }, /preceding messages/],
    ["truncated context", (value) => { value.receipts[0].history_truncated = true; }, /preceding messages/],
    ["wrong current-request hash", (value) => { value.receipts[0].current_request_sha256 = assistantHash("changed"); }, /Current request hash/],
    ["wrong independently observed full-pack hash", (value) => { value.contextHashes[1].sha256 = assistantHash("another pack"); }, /Whole context hash/],
    ["wrong startup answer hash", (value) => { value.receipts[2].answer_sha256 = assistantHash("replacement"); }, /Startup answer hash/],
    ["a different failed-once turn", (value) => { value.failedOnceReceipts[0].turn_id = "another-turn"; }, /Fail-once receipt/],
    ["failed-once state pointing to retry", (value) => { value.failedOnceReceipts[0].initial_run_id = "run-second-retried"; }, /Fail-once receipt/],
    ["missing fail-once receipt", (value) => { value.failedOnceReceipts = []; }, /one fail-once receipt/],
    ["provider session pointing to another PID", (value) => { value.usages[0].usage.provider_session_id = "assistant-fixture:first:1:run-first:turn-first"; }, /actual CLI process/],
    ["invented external cost", (value) => { value.usages[0].usage.cost_usd = 0; }, /provider cost remains unknown/],
    ["invented failed usage", (value) => { value.usages[1].usage = { input_tokens: 0 }; }, /must not invent successful usage/],
    ["omitted failed usage response instead of observed null", (value) => { delete value.usages[1].usage; }, /must not invent successful usage/],
    ["another startup turn identity", (value) => { value.receipts[2].turn_id = "replacement-turn"; }, /Actual startup/],
    ["missing independent context observation", (value) => value.contextHashes.pop(), /4 independent context hashes/],
    ["a remaining owned child", (value) => value.livePids.push(value.receipts[3].pid), /No owned process/],
  ]) await t.test(`rejects ${name}`, () => {
    const input = structuredClone(evidence); mutate(input);
    assert.throws(() => verifyAssistantConversationResults(input), (error) => {
      assert.match(error.message, expected); assert.equal(error.message.includes(evidence.messages[1].body), false);
      return true;
    });
  });
});
