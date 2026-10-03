import { isDeepStrictEqual } from "node:util";
import { CORRECTION_IGNORED_FILE, correctionHash, correctionIgnoredBytes, correctionImplementation, correctionModes, correctionPatch } from "./execution-correction.mjs";
import { gitWorktreePath } from "./git-worktree-evidence.mjs";

const requireEvidence = (condition, message) => {
  if (!condition) throw new Error(`Execution correction verification failed: ${message}`);
};
const equal = (actual, expected, message) => requireEvidence(isDeepStrictEqual(actual, expected), message);
const ids = (rows) => rows.map((row) => row.id).sort();
const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const lifecycleTypes = ["run.started", "run.completed", "run.failed", "run.cancelled", "run.reconciled"];
const retainedEvents = (value) => value.bundle.events.filter((event) => event.type === "run.workspace.retained").sort((a, b) => a.position - b.position);
const stageContracts = {
  initial: ["review", 1, 0, 1], changes_requested: ["ready", 1, 1, 1],
  failed: ["blocked", 2, 1, 1], retried: ["ready", 2, 1, 1],
  corrected: ["review", 3, 1, 2], changes_requested_again: ["ready", 3, 2, 2],
  holding: ["running", 4, 2, 2], keep_running_before: ["running", 4, 2, 2],
  keep_running_after: ["running", 4, 2, 2], stopped: ["cancelled", 4, 2, 2],
  stopped_stable: ["cancelled", 4, 2, 2],
};
export const correctionCheckpoints = Object.keys(stageContracts);

const stableEvidence = (observation) => ({
  task: observation.snapshot.task, runs: [...observation.snapshot.runs].sort((a, b) => a.id.localeCompare(b.id)),
  approvals: [...observation.snapshot.approvals].sort((a, b) => a.id.localeCompare(b.id)),
  reviews: observation.snapshot.reviews, artifacts: [...observation.snapshot.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
  receipts: observation.receipts, launches: observation.launches, exits: observation.exits,
  workspaces: observation.workspaces, live_pids: observation.live_pids,
  artifact_bytes: [...observation.artifact_bytes].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
  cancellation: observation.cancellation, base: observation.base,
  run_reads: byId(observation.run_reads), leases: byId(observation.leases),
  retention_events: retainedEvents(observation),
  lifecycle_events: observation.bundle.events.filter((event) => lifecycleTypes.includes(event.type)).sort((a, b) => a.position - b.position),
});

function verifyBase(value, fields, configuration, baseHead) {
  requireEvidence(value.base.head === baseHead && value.base.branch === configuration.base_branch && value.base.status === ""
    && value.base.implementation_sha256 === configuration.baseline_sha256
    && value.base.index_sha256 === configuration.baseline_index_sha256, "The disposable Git base HEAD/index/files must stay clean at every checkpoint");
  equal(value.base.tracked_files, configuration.baseline_files, "Every original tracked base file must retain its bytes");
  requireEvidence(configuration.baseline_files[".gitignore"] === correctionHash(`${CORRECTION_IGNORED_FILE}\n`), "The fixture base must actually ignore the unuploaded binary file");
  equal(value.base.work_files, { "unsaved.txt": null, [CORRECTION_IGNORED_FILE]: null, "changes.patch": null, "context_pack.md": null },
    "Execution work must never leak into the base repository");
  const expected = [{ root: gitWorktreePath(fields.base_repository), head: baseHead, branch: `refs/heads/${configuration.base_branch}` },
    ...value.snapshot.runs.map((run) => ({ root: gitWorktreePath(run.workspace_root), head: baseHead, branch: `refs/heads/${run.workspace_branch}` }))];
  expected.sort((a, b) => a.root.localeCompare(b.root));
  equal(value.base.registrations, expected, `Only the base and actually started run worktrees may be registered: ${JSON.stringify({ actual: value.base.registrations, expected })}`);
  equal(value.base.branches, expected.map((item) => item.branch).sort(), "Only the unchanged base and actual per-run branches may exist");
}

function verifyRetention(value, fields, run) {
  const events = value.bundle.events.filter((event) => event.run_id === run.id);
  const lifecycle = events.filter((event) => lifecycleTypes.includes(event.type));
  const started = lifecycle.filter((event) => event.type === "run.started");
  requireEvidence(started.length === 1, "Each actual child must own exactly one started lifecycle");
  const reports = events.filter((event) => event.type === "run.workspace.retained");
  if (run.status === "running") {
    requireEvidence(reports.length === 0 && run.workspace_retention == null && lifecycle.length === 1,
      "A still-running held process must not have fabricated terminal retention evidence");
    return;
  }
  requireEvidence(reports.length === 1, "Every terminal run needs exactly one typed node-owned retention record");
  const event = reports[0];
  requireEvidence(event.organization_id === value.snapshot.task.organization_id && event.task_id === value.snapshot.task.id
    && event.actor?.type === "system" && event.actor.id === fields.computer_id
    && typeof event.id === "string" && event.id.length > 0 && Number.isSafeInteger(event.sequence) && event.sequence >= 0
    && Number.isSafeInteger(event.position) && event.position > 0 && Number.isFinite(Date.parse(event.occurred_at)),
  "Typed retention must carry the real server event identity and owning worker provenance");
  equal(event.payload, { version: 1, workspace_root: run.workspace_root, workspace_branch: run.workspace_branch,
    outcome: run.status, reporter_computer_id: fields.computer_id }, "Typed retention must match the exact run worktree and actual outcome");
  equal(run.workspace_retention, { ...event.payload, event_id: event.id, position: event.position, sequence: event.sequence,
    reported_at: new Date(event.occurred_at).toISOString() }, "Run projection must equal its actual latest durable typed event");
  const terminalType = `run.${run.status}`;
  const terminal = lifecycle.filter((item) => item.type === terminalType);
  requireEvidence(terminal.length === 1, "Each terminal run must have exactly one canonical terminal lifecycle");
  const workerTerminal = lifecycle.filter((item) => Number.isSafeInteger(item.sequence)
    && (item.type === terminalType || (run.status === "cancelled" && item.type === "run.reconciled" && item.payload.observed_phase === "cancelled")));
  requireEvidence(workerTerminal.length === 1 && lifecycle.length === (run.status === "cancelled" && terminal[0] !== workerTerminal[0] ? 3 : 2),
    "Only the started and actual terminal/reconciled worker lifecycle may accompany retention");
  requireEvidence(event.sequence > started[0].sequence && event.position > started[0].position
    && event.sequence < workerTerminal[0].sequence && event.position < workerTerminal[0].position,
  "Accepted retention must precede the worker terminal lifecycle in sequence and durable position");
  // For cancellation, the HTTP control plane may settle run.cancelled first.
  // Only the later node terminal/reconciliation is ordered after its report.
  if (run.status !== "cancelled") requireEvidence(event.position < terminal[0].position,
    "Completed/failed retention must be durable before terminal execution is recorded");
}

/** Each state is verified against actual process receipts and server identities,
 * not list order or the most recent historical run. The delay comparisons use
 * a single parent's monotonic clock and an unchanged complete evidence set. */
export function verifyCorrectionCheckpoint({ name, observation: value, fields, previous, configuration, baseHead }) {
  const stage = stageContracts[name]; requireEvidence(stage, "Known checkpoint name required");
  requireEvidence(previous.length < correctionCheckpoints.length && correctionCheckpoints[previous.length] === name,
    "Checkpoint order must match the real user correction flow");
  const [status, runCount, reviewCount, artifactCount] = stage, snapshot = value.snapshot;
  requireEvidence(snapshot?.task.title === fields.task_title && snapshot.task.project_id === fields.project_id,
    "UI-created task must match this project and unique scenario");
  requireEvidence(snapshot.task.status === status, `${name} task status must be ${status}`);
  equal(snapshot.task.acceptance_criteria, [fields.criterion_1, fields.criterion_2], "Original task criteria must survive every action");
  equal(snapshot.task.required_capabilities, ["code.modify"], "Task must require the selected executor capability");
  requireEvidence(snapshot.runs.length === runCount && snapshot.reviews?.length === reviewCount
    && snapshot.artifacts.length === artifactCount, `${name} must have exact run, review and artifact counts`);
  requireEvidence(value.receipts.length === runCount && value.launches.length === runCount,
    "Every real launch must have exactly one startup receipt");
  requireEvidence(new Set(snapshot.runs.map((run) => run.id)).size === runCount
    && new Set(value.receipts.map((receipt) => receipt.run_id)).size === runCount
    && new Set(value.launches.map((launch) => launch.run_id)).size === runCount,
    "Duplicate launches or run identities are not allowed");
  requireEvidence(fields.instances.length === 4 && new Set(fields.instances.map((item) => item.root)).size === 4
    && new Set(fields.instances.map((item) => item.id)).size === 4 && value.workspaces.length === 4,
  "All four configured instances and workspace rows must remain distinct");
  requireEvidence(value.run_reads.length === runCount && new Set(value.run_reads.map((run) => run.id)).size === runCount,
    "Each exact run GET must be independently read once");
  equal(byId(value.run_reads), byId(snapshot.runs), "Task and exact-run GET projections must agree");
  equal(byId(value.bundle.runs), byId(snapshot.runs), "Audit and task snapshots must bind the same actual runs and projections");
  verifyBase(value, fields, configuration, baseHead);
  const stopped = name.startsWith("stopped"), held = runCount === 4 && !stopped;
  for (let index = 0; index < runCount; index++) {
    const receipts = value.receipts.filter((receipt) => receipt.slot === index + 1);
    requireEvidence(receipts.length === 1, "Each selected workspace must launch once in order");
    const receipt = receipts[0], run = snapshot.runs.find((run) => run.id === receipt.run_id), instance = fields.instances[index];
    requireEvidence(run && instance && receipt.mode === correctionModes[index] && receipt.task_id === snapshot.task.id,
      "Receipt must identify its real task, run and attempt");
    requireEvidence(run.status === ["completed", "failed", "completed", stopped ? "cancelled" : "running"][index],
      "Only the selected attempt's expected terminal/live status is allowed");
    requireEvidence(run.task_id === snapshot.task.id && run.computer_id === fields.computer_id
      && run.agent_instance_id === instance.id && run.runtime_id === fields.runtime_id
      && run.workspace_root === instance.root && run.workspace_branch === `artoo/run-${run.id}`,
    "UI assignment must select the exact paired instance and server-generated worktree branch");
    requireEvidence(receipt.workspace_root === instance.root && receipt.project_id === fields.project_id,
      "Actual child must execute in the correct task-owned workspace");
    const launch = value.launches.find((launch) => launch.run_id === run.id);
    requireEvidence(launch.pid === receipt.pid && launch.slot === receipt.slot
      && launch.workspace_root === instance.root && launch.task_id === snapshot.task.id,
    "Independent launch record must match startup receipt");
    const workspace = value.workspaces[index];
    requireEvidence(workspace?.root === instance.root && workspace.slot === index + 1 && workspace.exists === true,
      "Every started worktree must remain, including successful work");
    requireEvidence(workspace.branch === run.workspace_branch && workspace.head === baseHead
      && workspace.common_directory === configuration.git_common_directory
      && workspace.implementation_sha256 === receipt.implementation_sha256
      && workspace.unsaved_sha256 === receipt.unsaved_sha256 && workspace.context_sha256 === receipt.context_sha256
      && workspace.report_sha256 === receipt.artifact_sha256 && workspace.ignored_sha256 === receipt.ignored_sha256
      && workspace.ignored_size === receipt.ignored_size && workspace.ignored_by_git === true,
    "Actual modified, new, ignored, context and report files must remain unchanged in their original Git worktree");
    equal(workspace.registration, { root: gitWorktreePath(instance.root), head: baseHead, branch: `refs/heads/${run.workspace_branch}` },
      "The retained root must remain registered with its exact branch and baseline HEAD");
    const statusLines = [" M implementation.txt", "?? context_pack.md", "?? unsaved.txt", `!! ${CORRECTION_IGNORED_FILE}`,
      ...(receipt.artifact_sha256 === null ? [] : ["?? changes.patch"])].sort();
    requireEvidence(typeof workspace.status === "string", "Git status evidence is required");
    equal(workspace.status.split("\n").filter(Boolean).sort(), statusLines, "Git must independently show the modified, untracked and ignored file classes");
    verifyRetention(value, fields, run);
  }
  const expectedReports = held ? runCount - 1 : runCount;
  requireEvidence(retainedEvents(value).length === expectedReports, "Typed retention inventory cannot contain omitted, duplicate or unrelated records");
  requireEvidence(new Set(retainedEvents(value).map((event) => event.id)).size === expectedReports
    && new Set(retainedEvents(value).map((event) => event.position)).size === expectedReports,
  "Typed reports must retain unique real event identities and durable positions");
  for (let index = runCount; index < 4; index++) equal(value.workspaces[index], {
    root: fields.instances[index].root, slot: index + 1, exists: false, branch: null, head: null, common_directory: null,
    registration: null, status: null, ignored_by_git: null, implementation_sha256: null, unsaved_sha256: null,
    ignored_sha256: null, ignored_size: null, context_sha256: null, report_sha256: null,
  }, "Future workspaces must remain absent until their actual assignment");
  requireEvidence(value.live_pids.length === (held ? 1 : 0), "Only the fourth held child may still be alive");
  if (held) requireEvidence(value.live_pids[0] === value.receipts.find((receipt) => receipt.slot === 4).pid,
    "The held child PID must belong to the fourth actual run");
  requireEvidence(value.cancellation.errors.length === 0 && value.cancellation.attempts.length === (stopped ? 1 : 0),
    "Keep running must issue zero cancellation requests; confirm must issue exactly one");
  if (stopped) {
    const receipt = value.receipts.find((receipt) => receipt.slot === 4), attempt = value.cancellation.attempts[0];
    requireEvidence(attempt.run_id === receipt.run_id && attempt.status === 200 && attempt.response_finished
      && attempt.user_id === fields.user_id && attempt.device_id === fields.recipient_device_id
      && attempt.process_alive_on_response === false,
    "The one successful cancel must come from the actually paired client and target its captured run");
    // Production POSIX stop kills the owned process group with SIGKILL. A
    // graceful signal-handler receipt would be invented evidence for this
    // path. Use the passive response-time PID probe and preserved file hashes.
    requireEvidence(value.exits.length === 0 && attempt.exit_receipt_on_response === false,
      "Production forced termination must not fabricate a graceful-exit receipt");
    requireEvidence(value.leases.every((lease) => lease.status !== "held"), "Cancelled task must have no held file leases");
  } else requireEvidence(value.exits.length === 0, "No execution may receive a stop signal before the confirmation");
  const gates = snapshot.approvals.filter((approval) => approval.action === "execution.start");
  requireEvidence(gates.length === runCount && snapshot.approvals.length === runCount,
    "Each new assignment must consume its own fresh execution approval");
  for (let index = 0; index < runCount; index++) {
    const runId = value.receipts.find((receipt) => receipt.slot === index + 1).run_id;
    const matching = gates.filter((approval) => approval.run_id === runId);
    requireEvidence(matching.length === 1 && matching[0].status === "approved"
      && matching[0].summary === fields.approval_summaries[index], "Approval must be consumed only by its intended attempt");
  }
  for (let index = 0; index < reviewCount; index++) {
    const review = snapshot.reviews[index];
    requireEvidence(review.outcome === "changes_requested" && review.task_id === snapshot.task.id
      && review.actor.type === "user" && review.actor.id === fields.user_id && typeof review.actor_name === "string"
      && review.actor_name.length > 0 && review.comment === fields[`review_comment_${index + 1}`],
    "Durable history must retain the original human comment and real reviewer");
    const included = snapshot.artifacts.filter((artifact) => value.receipts.some((receipt) =>
      receipt.run_id === artifact.run_id && [1, ...(index === 1 ? [3] : [])].includes(receipt.slot)));
    equal([...(review.artifact_ids ?? [])].sort(), ids(included), "Review inventory must remain bound to the artifacts present at that decision");
  }
  if (previous.length) {
    const prior = previous[previous.length - 1].observation;
    requireEvidence(prior.snapshot.task.id === snapshot.task.id, "All corrections must retain the same task identity");
    for (const artifact of prior.snapshot.artifacts) equal(snapshot.artifacts.find((item) => item.id === artifact.id), artifact,
      "Existing uploaded artifacts must remain immutable across correction");
    for (const review of prior.snapshot.reviews) equal(snapshot.reviews.find((item) => item.event_id === review.event_id), review,
      "Reload/retry/correction must not rewrite historical feedback");
    for (const receipt of prior.receipts) equal(value.receipts.find((item) => item.run_id === receipt.run_id), receipt,
      "Existing process receipts must remain immutable");
    for (const event of retainedEvents(prior)) equal(retainedEvents(value).find((item) => item.id === event.id), event,
      "Previously accepted retention evidence must remain immutable across later attempts");
  }
  if (["keep_running_after", "stopped_stable"].includes(name)) {
    const prior = previous[previous.length - 1].observation;
    requireEvidence(value.started_ms - prior.finished_ms >= 3100, "Stable state must be observed for at least 3.1 seconds");
    equal(stableEvidence(value), stableEvidence(prior), "Dismissal or terminal cancellation must not change work, dispatch or process identity");
  }
  return true;
}

export function verifyCorrectionResults({ fields, configuration, baseHead, checkpoints, final }) {
  equal(checkpoints.map((checkpoint) => checkpoint.name), correctionCheckpoints, "Every required UI boundary must retain an observation");
  for (let index = 0; index < checkpoints.length; index++) verifyCorrectionCheckpoint({ ...checkpoints[index], fields, configuration, baseHead,
    previous: checkpoints.slice(0, index) });
  equal(stableEvidence(final), stableEvidence(checkpoints.at(-1).observation), "Final read must match the unchanged cancelled evidence");
  requireEvidence(final.base.head === baseHead && final.base.status === ""
    && final.base.implementation_sha256 === configuration.baseline_sha256, "The disposable Git base must stay byte-identical and clean");
  requireEvidence(final.contexts.length === 4 && final.usages.length === 4 && final.artifact_bytes.length === 2,
    "All run contexts, usage records and both authenticated artifact downloads must be verified");
  const snapshot = final.snapshot, reviews = snapshot.reviews;
  requireEvidence(reviews[0].position < reviews[1].position, "Reviews must retain real event ordering");
  const attempts = correctionModes.map((mode, index) => {
    const receipt = final.receipts.find((receipt) => receipt.slot === index + 1);
    const run = snapshot.runs.find((run) => run.id === receipt.run_id);
    const context = final.contexts.find((item) => item.run_id === receipt.run_id);
    requireEvidence(context && context.sha256 === receipt.context_sha256
      && typeof run.context_pack_id === "string" && context.header.split("\n")[0] === `# Context Pack ${run.context_pack_id}`
      && context.header.split("\n").filter((line) => line === `run: ${receipt.run_id}`).length === 1
      && context.header.split("\n").filter((line) => line === `task: ${snapshot.task.id}`).length === 1,
    "Whole original context must be header-bound to its actual run and task");
    const pack = context.pack, selected = reviews.slice(0, [0, 1, 1, 2][index]);
    requireEvidence(pack.task.id === snapshot.task.id && pack.task.title === fields.task_title
      && pack.project.id === fields.project_id && pack.workspace.root === fields.instances[index].root
      && pack.conversation === undefined && pack.policy.execution_mode === undefined,
    "Only this ordinary task and selected workspace may enter execution context");
    equal(pack.task.acceptance_criteria, configuration.acceptance_criteria, "Context must preserve original task criteria");
    equal(pack.policy.filesystem_write_scope, [fields.instances[index].root], "Run write policy must be isolated to its chosen workspace");
    const feedback = selected.map(({ event_id, position, task_id, actor, occurred_at, comment, artifact_ids }) =>
      ({ event_id, position, task_id, actor, occurred_at, comment, artifact_ids }));
    equal(pack.review_feedback?.entries ?? [], feedback, "The actual process must read exact durable feedback, identities, ordering and review inventory");
    equal(receipt.feedback, feedback.map((entry) => ({ ...entry, comment_sha256: correctionHash(entry.comment) })),
      "Process feedback receipts must derive from the exact production context");
    const implementation = correctionImplementation(pack, receipt.run_id, mode);
    requireEvidence(receipt.implementation_sha256 === correctionHash(implementation), "Implementation bytes must reflect real context feedback");
    const ignored = correctionIgnoredBytes(pack, receipt.run_id, mode, context.sha256);
    requireEvidence(receipt.ignored_sha256 === correctionHash(ignored) && receipt.ignored_size === ignored.length,
      "Ignored binary bytes must derive from the actual run and original context, not substituted receipt hashes");
    const usage = final.usages.find((item) => item.run_id === receipt.run_id)?.usage;
    if (index === 0 || index === 2) {
      requireEvidence(usage?.provider_session_id === `correction:${receipt.pid}:${receipt.run_id}`,
        "Completed usage must identify the actual deterministic CLI process");
      for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "cost_usd", "currency"])
        requireEvidence(usage[key] === null, "Deterministic evidence must not invent provider measurements");
      const artifact = snapshot.artifacts.find((item) => item.run_id === receipt.run_id);
      const bytes = final.artifact_bytes.find((item) => item.artifact_id === artifact?.id);
      requireEvidence(artifact && bytes && artifact.task_id === snapshot.task.id && artifact.metadata?.filename === "changes.patch"
        && artifact.checksum === `sha256:${receipt.artifact_sha256}` && artifact.metadata.size === bytes.size
        && bytes.sha256 === receipt.artifact_sha256 && bytes.source_report_sha256 === bytes.sha256
        && correctionHash(bytes.text) === bytes.sha256 && Buffer.byteLength(bytes.text) === bytes.size,
      "Downloaded artifact bytes and metadata must match their immutable originating report");
      equal(bytes.text, correctionPatch("Original implementation before human review.\n", implementation),
        "Each uploaded patch must contain the process-derived correction");
    } else {
      requireEvidence(usage === null, "Failed/cancelled attempts must not publish successful provider usage");
      requireEvidence(!snapshot.artifacts.some((artifact) => artifact.run_id === receipt.run_id)
        && receipt.artifact_sha256 === null, "Failed/cancelled work must not fabricate a completed artifact");
    }
    return { slot: index + 1, mode, run_id: receipt.run_id, pid: receipt.pid, workspace_root: receipt.workspace_root,
      context_sha256: receipt.context_sha256, feedback_event_ids: selected.map((review) => review.event_id),
      artifact_sha256: receipt.artifact_sha256, ignored_sha256: receipt.ignored_sha256, ignored_size: receipt.ignored_size,
      retention_event_id: run.workspace_retention.event_id, retained: true };
  });
  requireEvidence(new Set(final.receipts.map((receipt) => receipt.pid)).size === 4
    && new Set(final.contexts.map((context) => context.sha256)).size === 4
    && new Set(final.artifact_bytes.map((artifact) => artifact.sha256)).size === 2,
  "Four real processes/contexts and two different immutable artifact versions are required");
  const decisions = final.bundle.scheduler_decisions;
  requireEvidence(decisions.length === 4 && decisions.every((decision) => decision.mode === "manual")
    && new Set(decisions.map((decision) => decision.selected_agent_instance_id)).size === 4,
  "Each execution must follow a distinct manual UI assignment");
  for (const run of snapshot.runs) {
    const matching = decisions.filter((decision) => decision.id === run.scheduler_decision_id);
    requireEvidence(matching.length === 1 && matching[0].task_id === snapshot.task.id
      && matching[0].selected_computer_id === run.computer_id
      && matching[0].selected_agent_instance_id === run.agent_instance_id,
    "Each actual run must bind its original scheduler decision, task, computer and chosen instance");
  }
  return { passed: true, scope: "Observed four-run production-protocol and filesystem correction evidence; caller must establish client action origin separately; deterministic CLI, no live provider quality claim",
    task_id: snapshot.task.id, project_id: fields.project_id, task_status: snapshot.task.status,
    counts: { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2, retained_worktrees: 4, live_owned_processes: 0 },
    attempts, review_event_ids: reviews.map((review) => review.event_id), artifact_ids: ids(snapshot.artifacts),
    cancellation: final.cancellation, base: final.base,
    termination_evidence: "The original held PID was absent when the actual cancel HTTP response finished; forced process termination creates no graceful-exit receipt.",
    lease_scope: { declared_leases: final.leases.length, held_leases: final.leases.filter((lease) => lease.status === "held").length,
      note: "Default client assignment declares no write_paths; this scenario verifies no outstanding lease, not an exercised lease release." },
    checkpoints: checkpoints.map(({ name, observation }) => ({ name, observed_at: observation.observed_at,
      started_ms: observation.started_ms, finished_ms: observation.finished_ms })) };
}
