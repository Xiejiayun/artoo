import { agentInstances, appendEvent, assistantTurns, autonomousReviews, computers, goalAutomations, goals, messages, runs, tasks } from "@artoo/db";
import { AutonomousTeamSchema, canTransitionTask, GoalBudgetsSchema, ID_PREFIXES, IndependentReviewVerdictSchema, type TaskStatus, type AdditiveDesignRevisionRequestV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { resolveAutomationWorkspace } from "./automation-workspace.js";
import { scheduleTask } from "./scheduler.js";
import { inspectRunVerification, readRunVerificationEvidence, type RunVerificationEvidence } from "./verification-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";
import { transitionTask } from "./transition-service.js";
import { canSuggestDesignRevision, designRevisionDigest } from "./product-design-revision-guard.js";

type Automation = typeof goalAutomations.$inferSelect;
type Review = typeof autonomousReviews.$inferSelect;
export type IndependentReviewResult = {
  status: "pending" | "accepted" | "changes_requested" | "failed";
  reason: string;
  review?: Review;
  reviewerRunId?: string;
  reviewerEvidenceId?: string;
  designRevisionRequest?: AdditiveDesignRevisionRequestV1;
  responseBinding?: { turn_id: string; response_message_id: string; response_digest: string };
  /** Set only after the reviewer independently passed the exact-source node checks. */
  failure?: "invalid_verdict";
};

/** Re-qualify source, reviewer identity, response and node receipt on every acceptance. */
export async function inspectIndependentReview(ctx: ServerContext, tx: DrizzleDb, subject: typeof runs.$inferSelect,
  evidence: RunVerificationEvidence): Promise<IndependentReviewResult> {
  const [review] = await tx.select().from(autonomousReviews).where(and(eq(autonomousReviews.organizationId, ctx.organizationId), eq(autonomousReviews.subjectRunId, subject.id)));
  if (!review) return { status: "pending", reason: "Independent review has not started" };
  const source = await readRunVerificationEvidence(ctx, tx, subject.id);
  if (!source || source.id !== evidence.id || source.payload.outcome !== "passed" || !isDeepStrictEqual(source.payload, evidence.payload)) {
    return { status: "failed", reason: "Independent review source evidence is no longer qualified", review };
  }
  if ((await unconfirmedDisconnectRunIds(ctx, tx, { taskId: review.reviewTaskId })).length) return { status: "pending", reason: "Waiting for independent review process exit", review };
  if (review.evidenceId !== evidence.id || review.subjectDigest !== evidence.payload.subject_digest) return { status: "failed", reason: "Independent review source binding changed", review };
  const [turn] = await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, review.turnId), eq(assistantTurns.organizationId, ctx.organizationId)));
  if (!turn || turn.taskId !== review.reviewTaskId || turn.agentInstanceId !== review.reviewerInstanceId) return { status: "failed", reason: "Independent review turn binding changed", review };
  if (["queued", "waiting", "running"].includes(turn.status)) return { status: "pending", reason: turn.error ?? "Independent reviewer is inspecting the verified workspace", review };
  if (turn.status !== "completed" || !turn.runId || !turn.responseMessageId) return { status: "failed", reason: turn.error ?? "Independent reviewer did not complete with a response", review };
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, turn.runId), eq(runs.organizationId, ctx.organizationId)));
  if (!run || run.status !== "completed" || run.taskId !== review.reviewTaskId || run.agentInstanceId !== review.reviewerInstanceId
    || run.agentInstanceId === subject.agentInstanceId || run.computerId !== subject.computerId || run.workspaceRoot !== subject.workspaceRoot) {
    return { status: "failed", reason: "Independent reviewer execution is not bound to the reviewed workspace", review };
  }
  const [writer] = await tx.select().from(agentInstances).where(eq(agentInstances.id, subject.agentInstanceId));
  const [reviewer] = await tx.select().from(agentInstances).where(eq(agentInstances.id, run.agentInstanceId));
  if (!writer || !reviewer || writer.agentId === reviewer.agentId) return { status: "failed", reason: "The author cannot independently review its own work", review };
  const measured = await inspectRunVerification(ctx, tx, run);
  if (!measured.passed || !measured.evidence || measured.evidence.payload.subject_digest !== review.subjectDigest
    || measured.evidence.payload.profile_digest !== evidence.payload.profile_digest) {
    return { status: "failed", reason: `Independent review source verification failed: ${measured.reason}`, review };
  }
  if (!isDeepStrictEqual([...measured.evidence.payload.required_files].sort((a, b) => a.path.localeCompare(b.path)),
    [...evidence.payload.required_files].sort((a, b) => a.path.localeCompare(b.path)))) {
    return { status: "failed", reason: "The verified required-file inventory changed during independent review", review };
  }
  if (!isDeepStrictEqual(measured.evidence.payload.measurement_plan, source.payload.measurement_plan)) {
    return { status: "failed", reason: "Independent measurement-plan summary differs from the verified source", review };
  }
  const [response] = await tx.select().from(messages).where(and(eq(messages.id, turn.responseMessageId), eq(messages.organizationId, ctx.organizationId)));
  if (!response || response.runId !== run.id || response.actorType !== "agent" || response.actorId !== review.reviewerInstanceId) {
    return { status: "failed", reason: "Independent review response is not from its bound execution", review };
  }
  let verdict;
  try { verdict = IndependentReviewVerdictSchema.parse(JSON.parse(response.body)); }
  catch (error) { return { status: "failed", failure: "invalid_verdict", reason: `Reviewer must return one valid structured verdict: ${error instanceof Error ? error.message.slice(0, 2000) : "Invalid response"}`,
    review, reviewerRunId: run.id, reviewerEvidenceId: measured.evidence.id }; }
  if (verdict.reviewed_run_id !== subject.id || verdict.verification_evidence_id !== evidence.id || verdict.subject_digest !== review.subjectDigest) {
    return { status: "failed", reason: "Reviewer verdict refers to a different source or execution", review };
  }
  return { status: verdict.outcome, reason: `${verdict.summary}${verdict.findings.length ? `\n${verdict.findings.map((item) => `${item.severity}: ${item.file ? `${item.file}: ` : ""}${item.description}`).join("\n")}` : ""}`,
    review, reviewerRunId: run.id, reviewerEvidenceId: measured.evidence.id,
    ...(verdict.design_revision_request ? { designRevisionRequest: verdict.design_revision_request } : {}),
    responseBinding: { turn_id: turn.id, response_message_id: response.id, response_digest: designRevisionDigest(response.body) } };
}

/** Preserve every previous review turn/run while atomically consuming one shared retry. */
async function retryIndependentVerdict(ctx: ServerContext, tx: DrizzleDb, automation: Automation,
  failed: IndependentReviewResult & { review: Review }): Promise<IndependentReviewResult> {
  if (!ctx.automationActor || ctx.actorUserId !== automation.actorUserId || failed.failure !== "invalid_verdict") {
    throw AppError.permissionDenied("Only the goal runner can repair an independently verified review response");
  }
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  if (!goal || goal.status !== "running" || goal.currentPlanId !== automation.planId) throw AppError.conflict("Independent review repair is paused or its plan changed");
  const budgets = GoalBudgetsSchema.parse(goal.budgets);
  if (budgets.max_retries !== null && goal.retryCount >= budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
  const [prior] = await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, failed.review.turnId), eq(assistantTurns.organizationId, ctx.organizationId)));
  const [auxiliary] = await tx.select().from(tasks).where(and(eq(tasks.id, failed.review.reviewTaskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!prior || prior.status !== "completed" || prior.runId !== failed.reviewerRunId || !auxiliary || auxiliary.status !== "review") {
    throw AppError.conflict("Independent review changed before its response could be repaired");
  }
  const attempt = goal.retryCount + 1, now = ctx.clock.nowIso(), turnId = ctx.idGen.generate("turn"), messageId = ctx.idGen.generate(ID_PREFIXES.message);
  const feedback = `Your prior review output could not be parsed: ${failed.reason}\nThe node verified that the reviewed source is unchanged. Repair your response format and return the complete JSON verdict for the SAME source/run/evidence. Reinspect files if needed; do not modify product files. Preserve any genuine findings instead of accepting merely to fix formatting.\n\n${auxiliary.description}`;
  await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId, roomId: prior.roomId, threadRootId: prior.threadRootId,
    taskId: auxiliary.id, actorType: "system", actorId: "goal_runner", kind: "text", body: feedback,
    payload: { independent_review_id: failed.review.id, review_repair_attempt: attempt, previous_turn_id: prior.id,
      previous_run_id: prior.runId, subject_run_id: failed.review.subjectRunId, verification_evidence_id: failed.review.evidenceId }, createdAt: now });
  if (prior.threadRootId) await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, prior.threadRootId));
  await tx.insert(assistantTurns).values({ id: turnId, organizationId: ctx.organizationId, roomId: prior.roomId, threadRootId: prior.threadRootId,
    taskId: auxiliary.id, actorUserId: automation.actorUserId, clientRequestId: `${failed.review.id}_repair_${attempt}`,
    agentInstanceId: failed.review.reviewerInstanceId, aiDataSharingConsentId: automation.consentId, aiDataSharingPolicyVersion: automation.policyVersion,
    userMessageId: messageId, status: "queued", createdAt: now, updatedAt: now });
  const [review] = await tx.update(autonomousReviews).set({ turnId, status: "pending", error: failed.reason, verdict: null, updatedAt: now })
    .where(and(eq(autonomousReviews.id, failed.review.id), eq(autonomousReviews.turnId, prior.id))).returning();
  if (!review) throw AppError.conflict("Independent review was already repaired");
  await tx.update(goals).set({ retryCount: attempt, updatedAt: now }).where(eq(goals.id, goal.id));
  await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "system", actorId: "goal_runner", correlationId: review.id,
    goalId: goal.id, projectId: auxiliary.projectId, roomId: auxiliary.roomId, taskId: auxiliary.id,
    payload: { message_id: messageId, kind: "text", independent_review_id: review.id, review_repair_attempt: attempt,
      previous_turn_id: prior.id, previous_run_id: prior.runId, previous_review_evidence_id: failed.reviewerEvidenceId,
      subject_run_id: review.subjectRunId, verification_evidence_id: review.evidenceId } }));
  return { status: "pending", reason: "Independent reviewer is repairing its response against the same verified source", review };
}

/** Caller holds the goal automation lock; intent, auxiliary task and turn commit atomically. */
export async function ensureIndependentReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation,
  task: typeof tasks.$inferSelect, subject: typeof runs.$inferSelect, evidence: RunVerificationEvidence): Promise<IndependentReviewResult> {
  const current = await inspectIndependentReview(ctx, tx, subject, evidence);
  if (current.review) {
    if (current.failure === "invalid_verdict" && current.review.status === "pending") {
      return retryIndependentVerdict(ctx, tx, automation, { ...current, review: current.review });
    }
    if (current.status !== "pending" && current.review.status !== current.status) {
      await tx.update(autonomousReviews).set({ status: current.status, error: current.status === "failed" ? current.reason : null,
        verdict: { outcome: current.status, reason: current.reason, reviewer_run_id: current.reviewerRunId, reviewer_evidence_id: current.reviewerEvidenceId,
          ...(current.designRevisionRequest ? { design_revision_request: current.designRevisionRequest } : {}),
          ...(current.responseBinding ? { response_binding: current.responseBinding } : {}) },
        updatedAt: ctx.clock.nowIso() }).where(eq(autonomousReviews.id, current.review.id));
      const [auxiliary] = await tx.select().from(tasks).where(eq(tasks.id, current.review.reviewTaskId));
      const trigger = current.status === "failed" ? "cancel" : "accept";
      if (auxiliary && canTransitionTask(auxiliary.status as TaskStatus, trigger)) {
        await transitionTask(tx, ctx, { taskId: auxiliary.id, from: auxiliary.status as TaskStatus, trigger, now: ctx.clock.nowIso(),
          events: (to) => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: current.review!.id,
            goalId: automation.goalId, projectId: task.projectId, taskId: auxiliary.id, roomId: auxiliary.roomId,
            payload: { status: to, independent_review_id: current.review!.id, outcome: current.status } })] });
      }
    }
    return current;
  }
  const team = AutonomousTeamSchema.parse(automation.team);
  const [goal] = await tx.select().from(goals).where(eq(goals.id, automation.goalId));
  const [writer] = await tx.select().from(agentInstances).where(eq(agentInstances.id, subject.agentInstanceId));
  if (!goal?.roomId || !writer || !evidence.payload.subject_digest) throw AppError.conflict("Independent review needs a room and verified source");
  const choices = await scheduleTask(tx, ctx, ["code.read", "code.review"], { mode: "auto", projectId: task.projectId, branchBacked: false });
  let reviewer: string | undefined;
  for (const candidate of choices.candidates) {
    if (!team.reviewer_instance_ids.includes(candidate.agent_instance_id) || candidate.agent_id === writer.agentId || candidate.runtime === "mock"
      || candidate.computer_id !== subject.computerId) continue;
    const [instance] = await tx.select().from(agentInstances).where(eq(agentInstances.id, candidate.agent_instance_id));
    const [computer] = await tx.select().from(computers).where(eq(computers.id, candidate.computer_id));
    if (instance?.workspaceRoot && computer && resolveAutomationWorkspace(ctx, computer, automation.verificationProfileId,
      task.projectId, instance.workspaceRoot) === subject.workspaceRoot) {
      reviewer = instance.id; break;
    }
  }
  if (!reviewer) throw AppError.conflict("Waiting for a distinct, available team reviewer in the verified workspace");
  const id = ctx.idGen.generate("peer_review"), reviewTaskId = ctx.idGen.generate(ID_PREFIXES.task), turnId = ctx.idGen.generate("turn"), rootId = ctx.idGen.generate(ID_PREFIXES.message), now = ctx.clock.nowIso();
  const binding = { version: 1, reviewed_run_id: subject.id, verification_evidence_id: evidence.id, subject_digest: evidence.payload.subject_digest };
  const basePrompt = `Independently review the current workspace for the following completed task. The author was ${subject.agentInstanceId}; you are ${reviewer}. Read source, tests and actual deliverables; do not rely on the author's summary. Inspect correctness, requirement coverage, security, regressions and missing tests. This is read-only: do not modify files, run commands with side effects, or access the network. The node verifies the exact source before and after your execution. Measured execution scope, when available, is in review_subject.verification.checks[].observation. Start with those bound check outcomes, measured scope, case entries and viewport outcomes. Distinguish actual cases, viewports and assertions from planned cases and author claims, and review coverage of every acceptance criterion. Inspect relevant raw traces and screenshots through the read-only evidence tool for concrete semantic, visual, failure or coverage questions, following its integrity and pagination requirements for each selected reference. Do not enumerate every trace by default or claim visual inspection of unseen screenshots. Missing observations mean execution scope is unknown; never infer that all planned tests ran. Workspace images or model claims are not node evidence. Observations describe execution and do not by themselves establish requirement coverage. Reusing an accepted prototype or cases does not replace measurement of the current exact source, required final verification or this independent review.\n\nGoal: ${goal.objective}\nTask: ${task.title}\n${task.description}\nAcceptance criteria:\n${(task.acceptanceCriteria as string[]).map((criterion) => `- ${criterion}`).join("\n")}\n\nReturn ONLY one JSON object with these exact binding fields: ${JSON.stringify(binding)}, plus outcome (accepted or changes_requested), summary (nonempty string), and findings (array of {severity: blocking|nonblocking, description: string, file?: string}). Reject any blocking finding; accepted means no blocking findings. Cite concrete source locations and needed fixes. Never claim tests were run by you; the trusted node will rerun its acceptance program.`;
  const revisionGuidance = await canSuggestDesignRevision(ctx, tx, subject);
  const prompt = basePrompt + (revisionGuidance ? "\n\nFor implementation-stage coverage defects only, a changes_requested verdict may additionally include design_revision_request: {version:1,kind:'add-validation-cases',reason:string,requirement_criteria:[{requirement_id:string,criterion_index:number}]}. Request only additional browser cases for existing accepted workspace criteria. This is a request to the trusted orchestrator, not permission to change accepted inputs; keep concrete blocking findings. Design revisions must preserve every old case and every non-case field and undergo fresh complete measurement and independent review." : "") + (evidence.payload.measurement_plan
    ? "\n\nThe source node's measurement_plan attests only declared-mapping-feasibility. Compare the original user requirements and exact accepted criterion text with the declared mapping and configured limits, then inspect actual design cases, source, UI paths, final traces/screenshots and storage-fault observations where required. Structurally feasible declarations do not prove semantic coverage or execution. Treat omitted explicit requirements, weakened assertions and unsupported stronger claims as blocking findings. Your node independently recomputes the summary for the same research and source; an accepted verdict still requires your substantive review."
    : "") + (evidence.payload.measurement_plan?.version === 2
      ? "\n\nPublication criteria are deliberately pending at stage acceptance. Inspect the exact release_capabilities contract and the node's pending_release summary. Accepting this stage does not assert publication occurred: the configured trusted executor runs only after final validation and independent review. Reject any arbitrary functional or workflow requirement disguised as the canonical publication claim. Every must requirement must trace to the original request or a necessary condition, not an unnecessary unsupported stronger condition invented by an agent. Preserve genuine user requirements as unmet when unavailable. Do not invent missing credentials or an additional external.post approval for the already selected executor. Its configured point-in-time HTTP measurements do not prove actual-endpoint interaction, persistent availability or broader deployment semantics."
      : "");
  await tx.insert(tasks).values({ id: reviewTaskId, organizationId: ctx.organizationId, projectId: task.projectId, roomId: goal.roomId,
    title: `Independent review: ${task.title}`.slice(0, 300), description: prompt, status: "backlog", priority: task.priority,
    requiredCapabilities: ["code.read", "code.review"], acceptanceCriteria: ["Inspect the exact verified source and return a bound independent review verdict"],
    createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
  await tx.insert(messages).values({ id: rootId, organizationId: ctx.organizationId, roomId: goal.roomId, taskId: reviewTaskId,
    actorType: "system", actorId: "goal_runner", kind: "text", body: prompt, payload: { independent_review_id: id }, createdAt: now });
  await tx.insert(assistantTurns).values({ id: turnId, organizationId: ctx.organizationId, roomId: goal.roomId, taskId: reviewTaskId,
    threadRootId: rootId, actorUserId: automation.actorUserId, clientRequestId: id, agentInstanceId: reviewer,
    aiDataSharingConsentId: automation.consentId, aiDataSharingPolicyVersion: automation.policyVersion, userMessageId: rootId,
    status: "queued", createdAt: now, updatedAt: now });
  const [review] = await tx.insert(autonomousReviews).values({ id, organizationId: ctx.organizationId, goalId: goal.id, taskId: task.id,
    subjectRunId: subject.id, evidenceId: evidence.id, subjectDigest: evidence.payload.subject_digest, reviewerInstanceId: reviewer,
    reviewTaskId, turnId, status: "pending", createdAt: now, updatedAt: now }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: goal.id, projectId: task.projectId, roomId: goal.roomId, taskId: task.id,
    payload: { message_id: rootId, kind: "text", independent_review_id: id, reviewed_run_id: subject.id, reviewer_instance_id: reviewer } }));
  return { status: "pending", reason: "Independent reviewer queued against the verified source", review };
}
