import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { assistantHash } from "./assistant-conversation.mjs";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireEvidence(condition, message) {
  // Do not include raw requests, context packs or assertion actual/expected
  // objects in errors that client harnesses may publish in HTML reports.
  if (!condition) throw new Error(`Assistant conversation verification failed: ${message}`);
}
function indexRecords(records, size, key, name) {
  requireEvidence(Array.isArray(records) && records.length === size, `Expected exactly ${size} ${name}`);
  requireEvidence(records.every((record) => record && nonempty(record[key])), `${name} require nonempty identities`);
  const index = new Map(records.map((record) => [record[key], record]));
  requireEvidence(index.size === size, `${name} identities must be unique`);
  return index;
}

/** Read-only final outcome verification for an isolated, top-level room.
 * All records are production REST DTOs; receipts/failure receipts are the raw
 * private files from assistant-conversation.mjs. contextHashes are independent
 * reads of each actual context_pack.md, collected before the next run replaces
 * it, with its header run identity checked by the driver. livePids is the final
 * owned-process observation, not a request for this function to inspect/kill PIDs.
 * The driver must separately observe UI actions, retry identity stability,
 * waiting recovery, failed-state timing, a live hold, and no later redispatch.
 */
export function verifyAssistantConversationResults({ fixture, turns, messages, runs, usages, receipts, failedOnceReceipts, contextHashes, livePids }) {
  for (const field of ["project_id", "room_id", "user_id", "agent_instance_id", "computer_id", "workspace_root", "runtime_id"]) {
    requireEvidence(nonempty(fixture?.[field]), `Fixture ${field} is required`);
  }
  requireEvidence(isAbsolute(fixture.workspace_root) && (fixture.thread_root_id ?? null) === null, "Fixture requires an absolute canonical workspace and top-level room");
  const modes = ["first", "second", "hold"];
  requireEvidence(modes.every((mode) => nonempty(fixture.requests?.[mode]) && fixture.requests[mode] === fixture.requests[mode].trim())
    && new Set(modes.map((mode) => fixture.requests[mode])).size === 3, "Three distinct, exact trimmed requests are required");
  const turnIndex = indexRecords(turns, 3, "id", "logical turns");
  const runIndex = indexRecords(runs, 4, "id", "runs");
  const receiptIndex = indexRecords(receipts, 4, "run_id", "startup receipts");
  const usageIndex = indexRecords(usages, 4, "run_id", "usage responses");
  const contextIndex = indexRecords(contextHashes, 4, "run_id", "independent context hashes");
  for (const index of [receiptIndex, usageIndex, contextIndex]) {
    requireEvidence([...index.keys()].every((id) => runIndex.has(id)), "Receipts, usage and context observations must identify exactly the four server runs");
  }
  requireEvidence(receipts.every(({ pid }) => Number.isSafeInteger(pid) && pid > 0) && new Set(receipts.map(({ pid }) => pid)).size === 4,
    "Four unique actual startup PIDs are required");
  requireEvidence(Array.isArray(livePids) && livePids.length === 0, "No owned process may remain live after cancellation");
  requireEvidence(Array.isArray(messages) && messages.every((message) => message && message.room_id === fixture.room_id && message.thread_root_id === null),
    "All supplied messages must belong to the isolated top-level room");
  // Run-event messages are expected, but no extra human/agent/system text is.
  const text = messages.filter((message) => message.kind === "text");
  indexRecords(text, 5, "id", "text messages");
  requireEvidence(text.every((message) => Number.isSafeInteger(message.sequence) && message.sequence > 0)
    && new Set(text.map((message) => message.sequence)).size === 5, "Text messages require unique server sequence positions");
  const ordered = [...text].sort((a, b) => a.sequence - b.sequence);
  const requests = [ordered[0], ordered[2], ordered[4]], answers = [ordered[1], ordered[3]];
  const selectedTurns = requests.map((request, index) => {
    requireEvidence(request.actor_type === "user" && request.actor_id === fixture.user_id && request.body === fixture.requests[modes[index]]
      && request.run_id === null, "The three ordered user messages must exactly match the UI requests and user");
    const matches = turns.filter((turn) => turn.user_message_id === request.id);
    requireEvidence(matches.length === 1, "Each original request message must identify exactly one logical turn");
    const turn = matches[0];
    requireEvidence(turn.room_id === fixture.room_id && turn.thread_root_id === null && nonempty(turn.task_id)
      && request.task_id === turn.task_id && request.payload?.assistant_turn_id === turn.id && request.payload?.intent === "assistant",
    "Request, turn, task and conversation scope must agree");
    requireEvidence(turn.status === (index < 2 ? "completed" : "cancelled"), "Final turns must be completed, completed and cancelled");
    return turn;
  });
  requireEvidence(new Set(selectedTurns.map(({ id }) => id)).size === turnIndex.size, "The three requests must retain distinct logical turn identities");
  for (const [index, answer] of answers.entries()) {
    const turn = selectedTurns[index];
    requireEvidence(answer.actor_type === "agent" && answer.actor_id === fixture.agent_instance_id
      && turn.response_message_id === answer.id && answer.task_id === turn.task_id && answer.run_id === turn.run_id
      && answer.payload?.run_id === turn.run_id && answer.payload?.assistant_turn_id === turn.id && answer.payload?.intent === "assistant",
    "Each persisted answer must belong to its completed turn, run and selected agent instance");
  }
  requireEvidence(selectedTurns[2].response_message_id === null, "The cancelled hold must have no response message");
  requireEvidence(/^First answer marker: ASSISTANT_[A-F0-9]{32}$/.test(answers[0].body), "First answer must contain the child's generated marker");
  requireEvidence(answers[1].body === `Follow-up used the actual earlier answer: ${answers[0].body}`, "Follow-up must use the actual first answer");

  const attempts = [
    { mode: "first", attempt: 1, turn: selectedTurns[0], request: requests[0], answer: answers[0], history: [], behavior: "emit_answer", status: "completed" },
    { mode: "second", attempt: 1, turn: selectedTurns[1], request: requests[1], answer: null, history: ordered.slice(0, 2), behavior: "fail_before_retry", status: "failed" },
    { mode: "second", attempt: 2, turn: selectedTurns[1], request: requests[1], answer: answers[1], history: ordered.slice(0, 2), behavior: "emit_answer", status: "completed" },
    { mode: "hold", attempt: 1, turn: selectedTurns[2], request: requests[2], answer: null, history: ordered.slice(0, 4), behavior: "hold_until_cancel", status: "cancelled" },
  ];
  const verified = attempts.map(({ mode, attempt, turn, request, answer, history, behavior, status }) => {
    const candidates = receipts.filter((receipt) => receipt.mode === mode && receipt.attempt === attempt);
    requireEvidence(candidates.length === 1, "Startup receipts must contain first, failed second, retried second and held attempts exactly once");
    const receipt = candidates[0], run = runIndex.get(receipt.run_id);
    requireEvidence(receipt.turn_id === turn.id && receipt.task_id === turn.task_id && receipt.project_id === fixture.project_id
      && receipt.room_id === fixture.room_id && receipt.thread_root_id === null && receipt.behavior === behavior
      && receipt.workspace_root === fixture.workspace_root && receipt.usage_source === "deterministic_fixture", "Actual startup must match its logical request and execution scope");
    requireEvidence(!Object.hasOwn(receipt, "computer_id") && !Object.hasOwn(receipt, "agent_instance_id"), "Startup receipts must not invent current computer or instance context");
    requireEvidence(run.status === status && run.task_id === turn.task_id && run.computer_id === fixture.computer_id
      && run.agent_instance_id === fixture.agent_instance_id && run.runtime_id === fixture.runtime_id && run.workspace_root === fixture.workspace_root,
    "Server run must match the expected terminal status, computer, instance, runtime and workspace");
    if (status !== "failed") requireEvidence(turn.run_id === run.id, "Final turn must retain the actual completed or cancelled run");
    else requireEvidence(turn.run_id !== run.id, "Retry must replace the failed run without replacing its logical turn");
    requireEvidence(receipt.current_request_sha256 === assistantHash(request.body), "Current request hash must match the linked server user message");
    const expectedHistory = history.map((message) => ({ id: message.id, role: message.actor_type === "user" ? "user" : "assistant",
      actor_id: message.actor_id, body_sha256: assistantHash(message.body) }));
    requireEvidence(receipt.history_truncated === false && isDeepStrictEqual(receipt.messages, expectedHistory),
      "Context must contain exactly the preceding messages, roles, actors and body hashes in order");
    requireEvidence(receipt.answer_sha256 === (answer ? assistantHash(answer.body) : null), "Startup answer hash must match only the actual persisted answer");
    const context = contextIndex.get(run.id);
    requireEvidence(digest(receipt.context_sha256) && digest(context.sha256) && receipt.context_sha256 === context.sha256,
      "Whole context hash must match the independently observed file for that run");
    const { usage } = usageIndex.get(run.id);
    if (status === "completed") {
      requireEvidence(usage && usage.run_id === run.id
        && usage.provider_session_id === `assistant-fixture:${mode}:${receipt.pid}:${run.id}:${turn.id}`,
      "Completed usage must identify the actual CLI process, run and turn");
      requireEvidence(usage.input_tokens === 100 + history.length && usage.output_tokens === 50 && usage.cached_input_tokens === 0
        && usage.cost_usd === null && usage.currency === null, "Only actual deterministic fixture counters may be reported; provider cost remains unknown");
    } else requireEvidence(usage === null, "Failed and cancelled attempts must not invent successful usage or cost");
    return { mode, attempt, run_id: run.id, turn_id: turn.id, task_id: turn.task_id, pid: receipt.pid, status,
      computer_id: run.computer_id, agent_instance_id: run.agent_instance_id, runtime_id: run.runtime_id,
      current_request_sha256: receipt.current_request_sha256, context_sha256: receipt.context_sha256,
      history_message_ids: history.map(({ id }) => id), answer_message_id: answer?.id ?? null, answer_sha256: receipt.answer_sha256,
      usage: usage === null ? null : { source: "deterministic_fixture", provider_session_id: usage.provider_session_id,
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cached_input_tokens: usage.cached_input_tokens, cost_usd: null, currency: null } };
  });
  requireEvidence(new Set(verified.map(({ run_id }) => run_id)).size === 4, "Four distinct runs must account for all four startups");
  requireEvidence(new Set(verified.map(({ context_sha256 }) => context_sha256)).size === 4, "Each actual run must have its own header-bound context file");
  requireEvidence(Array.isArray(failedOnceReceipts) && failedOnceReceipts.length === 1, "Exactly one fail-once receipt is required");
  requireEvidence(isDeepStrictEqual(failedOnceReceipts[0], {
    turn_id: selectedTurns[1].id, task_id: selectedTurns[1].task_id, project_id: fixture.project_id, room_id: fixture.room_id,
    thread_root_id: null, current_request_sha256: assistantHash(requests[1].body), initial_run_id: verified[1].run_id,
  }), "Fail-once receipt must bind the original failed run to the same retried logical request");

  return { passed: true,
    scope: "Final production records and deterministic CLI receipts for one isolated top-level conversation; no external model or real provider cost claim",
    driver_observations_required: ["UI send/Retry/Cancel actions and request identity before/after retry", "Waiting recovered automatically without duplicate dispatch",
      "Failed state remained unchanged for at least 3.1 seconds", "Held process was live before UI cancellation", "No redispatch for at least 3.1 seconds after cancellation"],
    project_id: fixture.project_id, room_id: fixture.room_id, user_id: fixture.user_id,
    counters: { logical_turns: 3, runs: 4, completed_runs: 2, failed_runs: 1, cancelled_runs: 1, user_messages: 3,
      agent_messages: 2, startup_receipts: 4, unique_processes: 4, context_files_verified: 4, fail_once_receipts: 1, observed_live_owned_processes: 0 },
    turns: selectedTurns.map((turn, index) => ({ mode: modes[index], turn_id: turn.id, task_id: turn.task_id,
      user_message_id: turn.user_message_id, response_message_id: turn.response_message_id, run_id: turn.run_id, status: turn.status })),
    message_ids: ordered.map(({ id }) => id), attempts: verified };
}
