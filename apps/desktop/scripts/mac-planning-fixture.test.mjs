import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { planningAnswers, planningReceiptPath, verifyMacPlanningTurns } from "./mac-planning-fixture.mjs";

// Unit subprocess fixtures only. These records never enter an Artoo server or
// an E2E report and make no installed-app or real-model verification claim.
const moduleUrl = new URL("./mac-planning-fixture.mjs", import.meta.url).href;
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-mac-planning-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace"), receipts = join(directory, "receipts");
  mkdirSync(workspace); mkdirSync(receipts);
  const fixture = { workspace, context_receipts_directory: receipts, project_id: "unit-project", goal_id: "unit-goal",
    goal_room_id: "unit-room", computer_id: "unit-computer", planner_instance_id: "unit-planner", reviewer_instance_id: "unit-reviewer",
    task_1_title: "Unit implementation", task_2_title: "Unit verification", task_1_criterion: "Unit contract", task_2_criterion: "Unit dependent verification" };
  const configurationPath = join(directory, "fixture.json"), contextPath = join(workspace, "context_pack.md");
  writeFileSync(configurationPath, JSON.stringify(fixture));
  const root = { id: "unit-root", actor_type: "user", actor_id: "unit-owner", kind: "text", body: "Unit planning objective" };
  const ledger = { fixture, discussion: { id: "unit-discussion", goal_id: fixture.goal_id, room_id: fixture.goal_room_id,
    thread_root_id: root.id, status: "ready", current_step: 3, total_steps: 3 }, root, turns: [], messages: [], runs: [], usages: [], receipts: [] };
  return { directory, workspace, configurationPath, contextPath, fixture, ledger };
}

function contextFor(state, index) {
  const { fixture, ledger } = state, instanceId = fixture[index === 1 ? "reviewer_instance_id" : "planner_instance_id"];
  const request = `Your agent instance is ${instanceId}; ${index === 2 ? "Synthesize the discussion" : `Discuss step ${index}`}`;
  return { task: { id: "unit-task" }, project: { id: fixture.project_id }, workspace: { root: fixture.workspace },
    policy: { execution_mode: "discussion", filesystem_write_scope: [] },
    conversation: { room_id: fixture.goal_room_id, thread_root_id: ledger.root.id, turn_id: `unit-turn-${index}`, current_request: request, history_truncated: false,
      messages: [ledger.root, ...ledger.messages.filter((message) => message.actor_type === "agent")].map((message) => ({
        id: message.id, role: message.actor_type === "agent" ? "assistant" : "user", actor_id: message.actor_id, body: message.body,
      })) } };
}

function execute(state, pack, program) {
  writeFileSync(state.contextPath, `# Unit context\ntask: unit-task\nrun: unit-run-${state.ledger.turns.length}\n\n## Raw Payload\n${JSON.stringify(pack)}`);
  const args = program ? [program] : ["--input-type=module", "--eval", `import {runMacPlanningFixture} from ${JSON.stringify(moduleUrl)}; runMacPlanningFixture({contextPath:${JSON.stringify(state.contextPath)},configurationPath:${JSON.stringify(state.configurationPath)}});`];
  return spawnSync(process.execPath, args, { cwd: state.workspace, encoding: "utf8", timeout: 10_000, env: { ...process.env, ARTOO_CODEX_PROVIDER_KEY: "unit-credential" } });
}

function recordStep(state, index, program) {
  const pack = contextFor(state, index), result = execute(state, pack, program);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(output.map((event) => event.type), ["thread.started", "item.completed", "turn.completed"]);
  const { ledger, fixture } = state, turnId = pack.conversation.turn_id, role = index === 1 ? "reviewer" : "planner";
  const instruction = { id: `unit-instruction-${index}`, actor_type: "system", actor_id: "discussion-coordinator", kind: "text",
    thread_root_id: ledger.root.id, body: pack.conversation.current_request,
    payload: { intent: "discussion", discussion_id: ledger.discussion.id, assistant_turn_id: turnId, discussion_step: index } };
  const answer = { id: `unit-answer-${index}`, actor_type: "agent", actor_id: fixture[`${role}_instance_id`], kind: "text", thread_root_id: ledger.root.id, body: output[1].item.text };
  const run = { id: `unit-run-${index}`, task_id: "unit-task", status: "completed", runtime_id: "codex", computer_id: fixture.computer_id, agent_instance_id: answer.actor_id };
  ledger.messages.push(instruction, answer); ledger.runs.push(run);
  ledger.turns.push({ id: turnId, room_id: fixture.goal_room_id, task_id: "unit-task", thread_root_id: ledger.root.id, status: "completed",
    user_message_id: instruction.id, response_message_id: answer.id, run_id: run.id });
  ledger.usages.push({ ...output[2].usage, provider_session_id: output[0].thread_id, cost_usd: null });
  ledger.receipts.push(JSON.parse(readFileSync(planningReceiptPath(fixture, turnId), "utf8")));
  return result;
}

function complete(t) {
  const state = setup(t);
  for (let index = 0; index < 3; index++) recordStep(state, index);
  return state;
}

test("three CLI contributions read actual earlier answers and write only private receipts", (t) => {
  const { fixture, ledger, workspace } = complete(t);
  assert.deepEqual(ledger.messages.filter((message) => message.actor_type === "agent").map((message) => message.body), planningAnswers(fixture));
  assert.deepEqual(readdirSync(workspace), ["context_pack.md"]);
  assert.equal(readdirSync(fixture.context_receipts_directory).length, 3);
  const verified = verifyMacPlanningTurns(ledger);
  assert.equal(verified.length, 3);
  assert.ok(verified.every((turn) => turn.usage_source === "deterministic_fixture"),
    "Synthetic counters must remain distinguishable from measured provider usage in retained evidence");
  assert.deepEqual(verified[2].context_message_ids, [ledger.root.id, "unit-answer-0", "unit-answer-1"]);
});

for (const [name, mutate] of [
  ["a write-enabled context", (pack) => { pack.policy.filesystem_write_scope = [pack.workspace.root]; }],
  ["an unrelated project", (pack) => { pack.project.id = "another-project"; }],
  ["a participant absent from the registered pair", (pack) => { pack.conversation.current_request = "Your agent instance is another-agent; Discuss"; }],
  ["missing prior-answer context", (pack) => { pack.conversation.current_request = "Your agent instance is unit-reviewer; Discuss"; }],
]) test(`CLI rejects ${name} without publishing an answer or receipt`, (t) => {
  const state = setup(t), pack = contextFor(state, 0); mutate(pack);
  const result = execute(state, pack);
  assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
  assert.deepEqual(readdirSync(state.fixture.context_receipts_directory), []);
});

for (const [name, mutate] of [
  ["a different execution computer", (data) => { data.runs[0].computer_id = "other-computer"; }],
  ["a run belonging to a different task", (data) => { data.runs[0].task_id = "other-task"; }],
  ["two turns reusing one execution run", (data) => { data.turns[2].run_id = data.turns[0].run_id; }],
  ["a coordinator instruction detached from its turn", (data) => { data.messages[0].payload.assistant_turn_id = "other-turn"; }],
  ["an answer attributed to the wrong instance", (data) => { data.messages[1].actor_id = "other-instance"; }],
  ["an omitted prior answer in the child receipt", (data) => { data.receipts[2].messages.pop(); }],
  ["usage not bound to the actual child receipt", (data) => { data.usages[0].provider_session_id = "invented-session"; }],
  ["real-model cost invented for a deterministic fixture", (data) => { data.usages[0].cost_usd = 0.01; }],
]) test(`read-only verifier rejects ${name}`, (t) => {
  const state = complete(t); mutate(state.ledger);
  assert.throws(() => verifyMacPlanningTurns(state.ledger));
});

// Exercise the exact embedded source expression without importing or invoking
// the packaged smoke (which would start a build). This catches nested-template
// escaping and proves both artifact branches retain their original outputs.
function embeddedProgram(state, isMac) {
  const desktopDir = fileURLToPath(new URL("../", import.meta.url));
  const source = readFileSync(new URL("./packaged-e2e-smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf("writeFileSync(fixtureEntry, `");
  const end = source.indexOf("\n`);", start) + "\n`);".length;
  assert.ok(start >= 0 && end > start);
  const fixtureEntry = join(state.directory, isMac ? "mac-inline.mjs" : "windows-inline.mjs");
  new Function("writeFileSync", "fixtureEntry", "fixtureKey", "isMac", "pathToFileURL", "join", "desktopDir", "planningConfigurationPath", "assistantConfigurationPath", "fixturePatch", source.slice(start, end))(
    writeFileSync, fixtureEntry, "unit-credential", isMac, pathToFileURL, join, desktopDir, state.configurationPath, join(state.directory, "unused-assistant.json"), "unit patch bytes\n");
  return fixtureEntry;
}

test("Mac embedded CLI delegates discussion to the fixture with correctly escaped context parsing", (t) => {
  const state = setup(t), program = embeddedProgram(state, true);
  for (let index = 0; index < 3; index++) recordStep(state, index, program);
  assert.equal(verifyMacPlanningTurns(state.ledger).length, 3);
  assert.equal(existsSync(join(state.workspace, "changes.patch")), false);
});

test("Mac and Windows embedded CLI retain the original artifact and credential diagnostic branch", (t) => {
  for (const isMac of [true, false]) {
    const state = setup(t), program = embeddedProgram(state, isMac), pack = contextFor(state, 0);
    delete pack.conversation;
    const result = execute(state, pack, program);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(state.workspace, "changes.patch"), "utf8"), "unit patch bytes\n");
    assert.equal(JSON.parse(readFileSync(join(state.workspace, "fixture-execution.json"), "utf8")).apiKeyConfigured, true);
    assert.match(result.stderr, /Diagnostic key: unit-credential/);
    assert.match(result.stdout, /Packaged Codex adapter fixture completed/);
    assert.deepEqual(readdirSync(state.fixture.context_receipts_directory), []);
  }
});
