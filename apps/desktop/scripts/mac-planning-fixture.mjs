import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const planningHash = (value) => createHash("sha256").update(value).digest("hex");
export const planningReceiptPath = (fixture, turnId) => join(fixture.context_receipts_directory, `${planningHash(turnId)}.json`);

export function planningAnswers(fixture) {
  return [
    `Planner proposes ${fixture.task_1_title}, followed by ${fixture.task_2_title}.`,
    `Reviewer checked ${fixture.planner_instance_id}'s proposal: verification must follow implementation and retain the acceptance criteria.`,
    JSON.stringify({ rationale: "The reviewer confirmed the dependency and observable acceptance criteria.", task_specs: [
      { title: fixture.task_1_title, description: "Implementation proposed by the planner", acceptance_criteria: [fixture.task_1_criterion],
        dependencies: [], required_capabilities: ["code.read"], expected_artifacts: [{ type: "patch", description: "Reviewed implementation" }] },
      { title: fixture.task_2_title, description: "Independent verification requested by the reviewer", acceptance_criteria: [fixture.task_2_criterion],
        dependencies: [{ ref: "0", type: "blocks" }], required_capabilities: ["code.read"], expected_artifacts: [{ type: "test_report", description: "Contract verification results" }] },
    ] }),
  ];
}

// Called only by the temporary CLI selected in the installed Mac's Settings.
// It emits provider-shaped stdout; the real process adapter and authenticated
// worker own all run/message/usage state changes. No network or database writes.
export function runMacPlanningFixture({ contextPath, configurationPath, emit = (line) => console.log(line) }) {
  const source = readFileSync(contextPath, "utf8"), marker = "## Raw Payload\n";
  assert.ok(source.includes(marker), "The worker must provide its full context pack");
  const pack = JSON.parse(source.slice(source.indexOf(marker) + marker.length));
  const runIds = [...source.split("\n\n", 1)[0].matchAll(/^run: (.+)$/gm)].map((match) => match[1]);
  assert.equal(runIds.length, 1);
  const fixture = JSON.parse(readFileSync(configurationPath, "utf8"));
  assert.equal(pack.policy.execution_mode, "discussion");
  assert.deepEqual(pack.policy.filesystem_write_scope, []);
  assert.equal(pack.project.id, fixture.project_id);
  assert.equal(pack.conversation.room_id, fixture.goal_room_id);
  assert.ok(pack.conversation.thread_root_id);
  assert.equal(realpathSync(process.cwd()), realpathSync(fixture.workspace));
  assert.equal(realpathSync(pack.workspace.root), realpathSync(fixture.workspace));
  assert.ok(pack.conversation.messages.some((message) => message.id === pack.conversation.thread_root_id));
  assert.equal(pack.conversation.history_truncated, false);
  const roles = ["planner", "reviewer"].filter((role) => pack.conversation.current_request.includes(`Your agent instance is ${fixture[`${role}_instance_id`]};`));
  assert.equal(roles.length, 1, "The instruction must identify one configured participant");
  const role = roles[0], synthesis = pack.conversation.current_request.includes("Synthesize the discussion");
  const index = synthesis ? 2 : role === "planner" ? 0 : 1;
  if (synthesis) assert.equal(role, "planner");
  const answers = planningAnswers(fixture);
  const previous = pack.conversation.messages.filter((message) => message.role === "assistant");
  assert.deepEqual(previous.map((message) => message.body), answers.slice(0, index), "Each contribution must receive its actual earlier answers");
  writeFileSync(planningReceiptPath(fixture, pack.conversation.turn_id), JSON.stringify({
    role, pid: process.pid, run_id: runIds[0], turn_id: pack.conversation.turn_id, task_id: pack.task.id, project_id: pack.project.id,
    room_id: pack.conversation.room_id, thread_root_id: pack.conversation.thread_root_id,
    history_truncated: pack.conversation.history_truncated, current_request_sha256: planningHash(pack.conversation.current_request),
    messages: pack.conversation.messages.map((message) => ({ id: message.id, role: message.role, actor_id: message.actor_id, body_sha256: planningHash(message.body) })),
  }), { flag: "wx", mode: 0o600 });
  emit(JSON.stringify({ type: "thread.started", thread_id: `mac-planning-fixture:${role}:${process.pid}:${pack.conversation.turn_id}` }));
  emit(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answers[index] } }));
  emit(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 + index, output_tokens: 50, cached_input_tokens: 0 } }));
}

/** Pure verification over records fetched through read-only production APIs
 * and private receipts written by the actual child processes. */
export function verifyMacPlanningTurns({ fixture, discussion, turns, root, messages, runs, usages, receipts }) {
  assert.equal(discussion.goal_id, fixture.goal_id);
  assert.equal(discussion.room_id, fixture.goal_room_id);
  assert.equal(discussion.status, "ready");
  assert.equal(discussion.current_step, 3); assert.equal(discussion.total_steps, 3);
  assert.equal(turns.length, 3); assert.equal(receipts.length, 3);
  for (const key of ["id", "run_id", "user_message_id", "response_message_id"]) assert.equal(new Set(turns.map((turn) => turn[key])).size, 3, `Each contribution must have a distinct ${key}`);
  assert.equal(root.id, discussion.thread_root_id);
  const byId = new Map([root, ...messages].map((message) => [message.id, message]));
  assert.equal(messages.filter((message) => message.actor_type === "agent" && message.kind === "text").length, 3);
  assert.equal(messages.filter((message) => message.actor_type === "system" && message.actor_id === "discussion-coordinator" && message.kind === "text").length, 3);
  const history = [root.id], sessions = new Set(), result = [];
  for (const [index, turn] of turns.entries()) {
    const role = index === 1 ? "reviewer" : "planner", instanceId = fixture[`${role}_instance_id`];
    assert.equal(turn.status, "completed"); assert.equal(turn.room_id, discussion.room_id);
    assert.equal(turn.thread_root_id, discussion.thread_root_id);
    const request = byId.get(turn.user_message_id), answer = byId.get(turn.response_message_id);
    assert.ok(request && answer);
    assert.equal(request.actor_type, "system"); assert.equal(request.actor_id, "discussion-coordinator");
    assert.equal(request.kind, "text"); assert.equal(request.thread_root_id, discussion.thread_root_id);
    assert.equal(request.payload.intent, "discussion"); assert.equal(request.payload.discussion_id, discussion.id);
    assert.equal(request.payload.assistant_turn_id, turn.id); assert.equal(request.payload.discussion_step, index);
    assert.equal(answer.actor_type, "agent"); assert.equal(answer.actor_id, instanceId);
    assert.equal(answer.thread_root_id, discussion.thread_root_id); assert.equal(answer.body, planningAnswers(fixture)[index]);
    const run = runs.find((run) => run.id === turn.run_id), usage = usages[index], receipt = receipts[index];
    assert.ok(run); assert.equal(run.status, "completed"); assert.equal(run.runtime_id, "codex");
    assert.equal(run.task_id, turn.task_id);
    assert.equal(run.computer_id, fixture.computer_id); assert.equal(run.agent_instance_id, instanceId);
    assert.equal(receipt.role, role); assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
    assert.equal(receipt.run_id, run.id); assert.equal(receipt.turn_id, turn.id); assert.equal(receipt.task_id, turn.task_id);
    assert.equal(receipt.project_id, fixture.project_id); assert.equal(receipt.room_id, discussion.room_id);
    assert.equal(receipt.thread_root_id, discussion.thread_root_id); assert.equal(receipt.history_truncated, false);
    assert.equal(receipt.current_request_sha256, planningHash(request.body));
    assert.deepEqual(receipt.messages, history.map((id) => {
      const message = byId.get(id); assert.ok(message);
      return { id, role: message.actor_type === "agent" ? "assistant" : "user", actor_id: message.actor_id, body_sha256: planningHash(message.body) };
    }), "Receipt must contain exactly the thread root and preceding actual answers");
    assert.equal(usage.provider_session_id, `mac-planning-fixture:${role}:${receipt.pid}:${turn.id}`);
    assert.equal(usage.input_tokens, 100 + index); assert.equal(usage.output_tokens, 50); assert.equal(usage.cost_usd, null);
    sessions.add(usage.provider_session_id);
    result.push({ turn_id: turn.id, run_id: run.id, agent_instance_id: instanceId, response_message_id: answer.id,
      usage_source: "deterministic_fixture",
      instruction_message_id: request.id, receipt_pid: receipt.pid, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      context_message_ids: receipt.messages.map((message) => message.id), answer_sha256: planningHash(answer.body) });
    history.push(answer.id);
  }
  assert.equal(sessions.size, 3);
  return result;
}
