// Deterministic subprocess used only by the native UI acceptance harness.
// It reads the real scheduler's context pack and emits provider-shaped JSONL;
// no model service is contacted and no project files are changed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const [contextPath, configurationPath, role] = process.argv.slice(2);
const source = readFileSync(contextPath, "utf8");
const marker = "## Raw Payload\n";
assert.ok(source.includes(marker), "The process adapter must provide a complete context pack");
const pack = JSON.parse(source.slice(source.indexOf(marker) + marker.length));
const fixture = JSON.parse(readFileSync(configurationPath, "utf8"));
assert.ok(["planner", "reviewer"].includes(role));
assert.equal(pack.policy.execution_mode, "discussion");
assert.deepEqual(pack.policy.filesystem_write_scope, []);
assert.equal(pack.project.id, fixture.project_id);
assert.equal(pack.conversation.room_id, fixture.goal_room_id);
assert.ok(pack.conversation.thread_root_id, "Planning must use its own thread");
assert.ok(pack.conversation.messages.some((message) => message.id === pack.conversation.thread_root_id), "Planning context must contain its actual thread root");
assert.ok(pack.conversation.messages.every((message) => !fixture.unrelated_message_ids.includes(message.id)), "Another thread's user messages must not enter the discussion context");
assert.ok(pack.conversation.current_request.includes(`Your agent instance is ${fixture[`${role}_instance_id`]};`));
const previous = pack.conversation.messages.filter((message) => message.role === "assistant");
const synthesis = pack.conversation.current_request.includes("Synthesize the discussion");
const plannerAnswer = `Planner proposes ${fixture.task_1_title}, followed by ${fixture.task_2_title}.`;
const reviewerAnswer = `Reviewer checked ${fixture.planner_instance_id}'s proposal: the verification task must depend on implementation and retain both acceptance criteria.`;
let answer;
if (synthesis) {
  assert.equal(role, "planner");
  assert.deepEqual(previous.map((message) => message.body), [plannerAnswer, reviewerAnswer], "Synthesis must receive both actual earlier answers");
  answer = JSON.stringify({ rationale: "The reviewer confirmed the dependency and observable acceptance criteria.", task_specs: [
    { title: fixture.task_1_title, description: "Implementation proposed by the planner", acceptance_criteria: [fixture.task_1_criterion],
      required_capabilities: ["code.read"], expected_artifacts: [{ type: "patch", description: "Reviewed implementation" }] },
    { title: fixture.task_2_title, description: "Independent verification requested by the reviewer", acceptance_criteria: [fixture.task_2_criterion], dependencies: [{ ref: "0", type: "blocks" }],
      required_capabilities: ["code.read"], expected_artifacts: [{ type: "test_report", description: "Contract verification results" }] },
  ] });
} else if (role === "planner") {
  assert.equal(previous.length, 0, "The first contribution must not inherit another discussion");
  answer = plannerAnswer;
} else {
  assert.deepEqual(previous.map((message) => message.body), [plannerAnswer], "Reviewer must receive the actual planner answer");
  answer = reviewerAnswer;
}
// Ephemeral evidence lives beside the private fixture configuration, never in
// a project workspace. The harness checks these observed IDs/hashes against
// production API records after the UI has finished the workflow.
writeFileSync(join(fixture.context_receipts_directory, `${sha256(pack.conversation.turn_id)}.json`), JSON.stringify({
  role, pid: process.pid, turn_id: pack.conversation.turn_id, task_id: pack.task.id, project_id: pack.project.id,
  room_id: pack.conversation.room_id, thread_root_id: pack.conversation.thread_root_id,
  history_truncated: pack.conversation.history_truncated, current_request_sha256: sha256(pack.conversation.current_request),
  messages: pack.conversation.messages.map((message) => ({ id: message.id, role: message.role, actor_id: message.actor_id, body_sha256: sha256(message.body) })),
}), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ type: "thread.started", thread_id: `ios-ui-fixture:${role}:${process.pid}:${pack.conversation.turn_id}` }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 + previous.length, output_tokens: 50, cached_input_tokens: 0 } }));
