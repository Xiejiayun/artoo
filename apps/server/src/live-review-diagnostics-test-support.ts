import { assistantTurns, autonomousReviews, contextPacks, messages, runEvidence, runs } from "@artoo/db";
import { IndependentReviewVerdictSchema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const MAX_ATTEMPTS = 16, MAX_RESPONSE_BYTES = 256 * 1024, MAX_SUMMARY_CHARS = 2000;
const subject = alias(runs, "diagnostic_subject"), reviewer = alias(runs, "diagnostic_reviewer");
const sourceEvidence = alias(runEvidence, "diagnostic_source_evidence");
const peerEvidence = alias(runEvidence, "diagnostic_peer_evidence");

/** Reporting only. No service inspection, row locks, transitions or database writes. */
export async function readLiveReviewDiagnosticRows(db: Pick<DrizzleDb, "select">,
  scope: { organizationId: string; goalId: string }) {
  const rows = await db.select({
    reviewId: autonomousReviews.id, subjectTaskId: autonomousReviews.taskId,
    subjectRunId: autonomousReviews.subjectRunId, subjectEvidenceId: autonomousReviews.evidenceId,
    subjectDigest: autonomousReviews.subjectDigest, reviewerInstanceId: autonomousReviews.reviewerInstanceId,
    reviewTaskId: autonomousReviews.reviewTaskId, currentTurnId: autonomousReviews.turnId,
    reviewStatus: autonomousReviews.status,
    turnId: assistantTurns.id, turnPosition: assistantTurns.position, turnStatus: assistantTurns.status,
    turnRunId: assistantTurns.runId, responseMessageId: assistantTurns.responseMessageId,
    contextId: contextPacks.id, contextRunId: contextPacks.runId, contextTaskId: contextPacks.taskId,
    contextDigest: sql<string | null>`case when ${contextPacks.id} is not null then 'sha256:' || encode(sha256(convert_to(${contextPacks.payload}::text, 'UTF8')), 'hex') else null end`,
    contextSubjectVersion: sql<string | null>`${contextPacks.payload}->'review_subject'->>'version'`,
    contextVerificationVersion: sql<string | null>`${contextPacks.payload}->'review_subject'->'verification'->>'version'`,
    contextSubjectTaskId: sql<string | null>`${contextPacks.payload}->'review_subject'->>'task_id'`,
    contextSubjectRunId: sql<string | null>`${contextPacks.payload}->'review_subject'->>'run_id'`,
    contextEvidenceId: sql<string | null>`${contextPacks.payload}->'review_subject'->>'evidence_id'`,
    contextSubjectDigest: sql<string | null>`${contextPacks.payload}->'review_subject'->>'subject_digest'`,
    contextRequestId: sql<string | null>`${contextPacks.payload}->'review_subject'->'verification'->>'request_id'`,
    contextProfileId: sql<string | null>`${contextPacks.payload}->'review_subject'->'verification'->>'profile_id'`,
    contextProfileDigest: sql<string | null>`${contextPacks.payload}->'review_subject'->'verification'->>'profile_digest'`,
    sourceRunId: subject.id, sourceTaskId: subject.taskId, sourceRunStatus: subject.status, sourceInstanceId: subject.agentInstanceId,
    sourceComputerId: subject.computerId,
    sourceRequestId: sql<string | null>`${subject.verificationRequirement}->>'request_id'`,
    sourceProfileId: sql<string | null>`${subject.verificationRequirement}->>'profile_id'`,
    reviewerRunId: reviewer.id, reviewerRunStatus: reviewer.status, reviewerTaskId: reviewer.taskId,
    reviewerRunInstanceId: reviewer.agentInstanceId, reviewerComputerId: reviewer.computerId,
    reviewerRequestId: sql<string | null>`${reviewer.verificationRequirement}->>'request_id'`,
    reviewerProfileId: sql<string | null>`${reviewer.verificationRequirement}->>'profile_id'`,
    sameWorkspace: sql<boolean | null>`${subject.workspaceRoot} = ${reviewer.workspaceRoot}`,
    sourceEvidenceId: sourceEvidence.id, sourceEvidenceRunId: sourceEvidence.runId,
    sourceEvidenceRequestId: sourceEvidence.requestId,
    sourceEvidenceProfileId: sql<string | null>`${sourceEvidence.payload}->>'profile_id'`,
    sourceEvidenceDigest: sql<string | null>`${sourceEvidence.payload}->>'subject_digest'`,
    sourceProfileDigest: sql<string | null>`${sourceEvidence.payload}->>'profile_digest'`,
    sourceOutcome: sql<string | null>`${sourceEvidence.payload}->>'outcome'`,
    reviewerEvidenceId: peerEvidence.id, reviewerEvidenceRunId: peerEvidence.runId,
    reviewerEvidenceRequestId: peerEvidence.requestId,
    reviewerEvidenceProfileId: sql<string | null>`${peerEvidence.payload}->>'profile_id'`,
    reviewerEvidenceDigest: sql<string | null>`${peerEvidence.payload}->>'subject_digest'`,
    reviewerProfileDigest: sql<string | null>`${peerEvidence.payload}->>'profile_digest'`,
    reviewerOutcome: sql<string | null>`${peerEvidence.payload}->>'outcome'`,
    messageId: messages.id, messageRunId: messages.runId, messageTaskId: messages.taskId,
    messageActorType: messages.actorType, messageActorId: messages.actorId,
    responseBytes: sql<number | null>`octet_length(${messages.body})`,
    // Do not even retrieve an oversized response, or any raw run/CLI/tool log.
    responseBody: sql<string | null>`case when octet_length(${messages.body}) <= ${MAX_RESPONSE_BYTES} then ${messages.body} else null end`,
  }).from(autonomousReviews)
    // A retry updates currentTurnId. The unique review task still binds its previous turns.
    .leftJoin(assistantTurns, and(eq(assistantTurns.organizationId, scope.organizationId),
      eq(assistantTurns.taskId, autonomousReviews.reviewTaskId), eq(assistantTurns.agentInstanceId, autonomousReviews.reviewerInstanceId)))
    .leftJoin(reviewer, and(eq(reviewer.organizationId, scope.organizationId), eq(reviewer.id, assistantTurns.runId)))
    .leftJoin(contextPacks, and(eq(contextPacks.organizationId, scope.organizationId), eq(contextPacks.id, reviewer.contextPackId),
      eq(contextPacks.runId, reviewer.id), eq(contextPacks.taskId, reviewer.taskId)))
    // Historical evidence comes from that turn's persisted context, never today's review row.
    .leftJoin(subject, and(eq(subject.organizationId, scope.organizationId), eq(subject.id, sql`${contextPacks.payload}->'review_subject'->>'run_id'`)))
    .leftJoin(messages, and(eq(messages.organizationId, scope.organizationId), eq(messages.id, assistantTurns.responseMessageId)))
    .leftJoin(sourceEvidence, and(eq(sourceEvidence.organizationId, scope.organizationId), eq(sourceEvidence.id, sql`${contextPacks.payload}->'review_subject'->>'evidence_id'`)))
    .leftJoin(peerEvidence, and(eq(peerEvidence.organizationId, scope.organizationId), eq(peerEvidence.runId, reviewer.id),
      eq(peerEvidence.requestId, sql`${reviewer.verificationRequirement}->>'request_id'`)))
    .where(and(eq(autonomousReviews.organizationId, scope.organizationId), eq(autonomousReviews.goalId, scope.goalId)))
    .orderBy(sql`${assistantTurns.position} desc nulls last`, desc(autonomousReviews.updatedAt), desc(autonomousReviews.id))
    .limit(MAX_ATTEMPTS + 1);
  return { rows: rows.slice(0, MAX_ATTEMPTS), truncated: rows.length > MAX_ATTEMPTS };
}

export type LiveReviewDiagnosticRow = Awaited<ReturnType<typeof readLiveReviewDiagnosticRows>>["rows"][number];
type Redact = (value: string) => string;
const digest = (value: string | null) => value && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
const status = (value: string | null, allowed: readonly string[]) => value && allowed.includes(value) ? value : "unknown";

/** Parse a persisted final response, never the terminal wrapper in autonomousReviews.verdict. */
export function projectLiveReviewAttempt(row: LiveReviewDiagnosticRow, redact: Redact) {
  const id = (value: string | null) => value ? redact(value).slice(0, 128) : null;
  const responseBinding = !!row.turnId && row.turnStatus === "completed" && row.turnRunId === row.reviewerRunId
    && !!row.reviewerRunId && row.reviewerRunStatus === "completed" && row.reviewerTaskId === row.reviewTaskId
    && row.reviewerRunInstanceId === row.reviewerInstanceId && !!row.messageId && row.messageId === row.responseMessageId
    && row.messageRunId === row.reviewerRunId && row.messageTaskId === row.reviewTaskId
    && row.messageActorType === "agent" && row.messageActorId === row.reviewerInstanceId;
  const contextBinding = !!row.contextId && row.contextRunId === row.reviewerRunId && row.contextTaskId === row.reviewTaskId
    && digest(row.contextDigest) !== null && row.contextSubjectVersion === "1" && row.contextVerificationVersion === "1";
  const sourceBinding = contextBinding && !!row.sourceRunId && row.sourceRunId === row.contextSubjectRunId && row.sourceRunStatus === "completed"
    && row.sourceTaskId === row.contextSubjectTaskId
    && !!row.sourceRequestId && row.sourceEvidenceId === row.contextEvidenceId && row.sourceEvidenceRunId === row.contextSubjectRunId
    && row.sourceEvidenceRequestId === row.sourceRequestId && row.sourceRequestId === row.contextRequestId
    && !!row.sourceProfileId && row.sourceEvidenceProfileId === row.sourceProfileId && row.sourceProfileId === row.contextProfileId
    && digest(row.contextSubjectDigest) !== null && row.sourceEvidenceDigest === row.contextSubjectDigest
    && digest(row.sourceProfileDigest) !== null && row.sourceProfileDigest === row.contextProfileDigest && row.sourceOutcome === "passed";
  const peerBinding = !!row.reviewerEvidenceId && !!row.reviewerRunId && row.reviewerEvidenceRunId === row.reviewerRunId
    && !!row.reviewerRequestId && row.reviewerEvidenceRequestId === row.reviewerRequestId
    && !!row.reviewerProfileId && row.reviewerEvidenceProfileId === row.reviewerProfileId && row.reviewerProfileId === row.sourceProfileId
    && row.reviewerEvidenceDigest === row.contextSubjectDigest && digest(row.sourceProfileDigest) !== null
    && row.reviewerProfileDigest === row.sourceProfileDigest && row.reviewerOutcome === "passed"
    && row.sameWorkspace === true && row.reviewerComputerId === row.sourceComputerId && !!row.sourceComputerId
    && !!row.sourceInstanceId && row.sourceInstanceId !== row.reviewerInstanceId;
  let parseError: "no_response" | "response_binding_mismatch" | "response_too_large" | "invalid_json" | "invalid_schema" | null = null;
  let verdict: { schema: "IndependentReviewVerdict.v1"; outcome: "accepted" | "changes_requested"; summary: string;
    summary_truncated: boolean; finding_count: number; blocking_finding_count: number; recorded_source_matches: boolean } | null = null;
  if (!row.messageId) parseError = "no_response";
  else if (!responseBinding) parseError = "response_binding_mismatch";
  else if (row.responseBytes === null || row.responseBytes > MAX_RESPONSE_BYTES || row.responseBody === null
    || Buffer.byteLength(row.responseBody) > MAX_RESPONSE_BYTES) parseError = "response_too_large";
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(row.responseBody); }
    catch { parseError = "invalid_json"; }
    if (!parseError) {
      const result = IndependentReviewVerdictSchema.safeParse(parsed);
      // Parser errors can echo private input. Only emit this fixed classification.
      if (!result.success) parseError = "invalid_schema";
      else {
        const value = result.data, summary = redact(value.summary).slice(0, MAX_SUMMARY_CHARS);
        verdict = { schema: "IndependentReviewVerdict.v1", outcome: value.outcome, summary,
          summary_truncated: value.summary.length > MAX_SUMMARY_CHARS, finding_count: value.findings.length,
          blocking_finding_count: value.findings.filter(finding => finding.severity === "blocking").length,
          recorded_source_matches: contextBinding && value.reviewed_run_id === row.contextSubjectRunId && value.verification_evidence_id === row.contextEvidenceId
            && value.subject_digest === row.contextSubjectDigest };
      }
    }
  }
  return {
    review_id: id(row.reviewId), subject_task_id: id(row.subjectTaskId), subject_run_id: id(row.subjectRunId),
    subject_evidence_id: id(row.subjectEvidenceId), subject_digest: digest(row.subjectDigest),
    reviewer_agent_instance_id: id(row.reviewerInstanceId), review_task_id: id(row.reviewTaskId),
    persisted_status: status(row.reviewStatus, ["pending", "accepted", "changes_requested", "failed", "cancelled"]),
    current_turn_id: id(row.currentTurnId), attempt_turn_id: id(row.turnId), attempt_is_current: row.turnId === row.currentTurnId,
    turn_position: row.turnPosition, turn_status: status(row.turnStatus, ["queued", "waiting", "running", "completed", "failed", "cancelled"]),
    reviewer_run_id: id(row.reviewerRunId), reviewer_run_status: status(row.reviewerRunStatus, ["queued", "starting", "running", "awaiting_input", "paused", "completed", "failed", "cancelled"]),
    response_message_id: id(row.responseMessageId), response_bytes: row.responseBytes,
    original_context: { context_pack_id: id(row.contextId), run_id: id(row.contextRunId), task_id: id(row.contextTaskId),
      digest: digest(row.contextDigest), digest_format: "postgres-jsonb-text-utf8-sha256", bound_to_attempt: contextBinding,
      subject_task_id: id(row.contextSubjectTaskId), subject_run_id: id(row.contextSubjectRunId), evidence_id: id(row.contextEvidenceId),
      subject_digest: digest(row.contextSubjectDigest), request_id: id(row.contextRequestId), profile_id: id(row.contextProfileId),
      profile_digest: digest(row.contextProfileDigest), matches_current_review: contextBinding && row.contextSubjectTaskId === row.subjectTaskId
        && row.contextSubjectRunId === row.subjectRunId && row.contextEvidenceId === row.subjectEvidenceId && row.contextSubjectDigest === row.subjectDigest },
    verification_bindings: {
      source: { evidence_id: id(row.sourceEvidenceId), run_id: id(row.sourceEvidenceRunId), request_id: id(row.sourceEvidenceRequestId),
        profile_id: id(row.sourceEvidenceProfileId), subject_digest: digest(row.sourceEvidenceDigest), profile_digest: digest(row.sourceProfileDigest),
        outcome: status(row.sourceOutcome, ["passed", "failed"]), matches_recorded_source: sourceBinding },
      reviewer: { evidence_id: id(row.reviewerEvidenceId), run_id: id(row.reviewerEvidenceRunId), request_id: id(row.reviewerEvidenceRequestId),
        profile_id: id(row.reviewerEvidenceProfileId), subject_digest: digest(row.reviewerEvidenceDigest), profile_digest: digest(row.reviewerProfileDigest),
        outcome: status(row.reviewerOutcome, ["passed", "failed"]), matches_recorded_source: peerBinding },
    },
    response_binding_matches: responseBinding, parse_error: parseError, verdict,
  };
}

type Attempt = ReturnType<typeof projectLiveReviewAttempt>;
/** Bounded cache is independent of last_error and survives pending retries, read failure and final cleanup. */
export function createLiveReviewDiagnostics(options: {
  read(): ReturnType<typeof readLiveReviewDiagnosticRows>;
  redact: Redact;
  finalized(): boolean;
  readTimeoutMs?: number;
}) {
  let generation = 0, cleanupStarted = false;
  let attempts: Attempt[] = [], lastResponse: Attempt | null = null, lastBoundVerdict: Attempt | null = null;
  let truncated = false, readError: "read_failed" | "read_timeout" | null = null;
  const newer = (next: Attempt, prior: Attempt | null) => (next.turn_position ?? -1) >= (prior?.turn_position ?? -1);
  return {
    async capture(phase: "progress" | "failure" | "cleanup"): Promise<void> {
      if (options.finalized() || (cleanupStarted && phase !== "cleanup")) return;
      if (phase === "cleanup") cleanupStarted = true;
      const request = ++generation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Symbol("diagnostic read timeout");
      try {
        const result = await Promise.race([options.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout), options.readTimeoutMs ?? 2000);
        })]);
        if (options.finalized() || request !== generation) return;
        attempts = result.rows.slice(0, MAX_ATTEMPTS).map(row => projectLiveReviewAttempt(row, options.redact));
        truncated = result.truncated || result.rows.length > MAX_ATTEMPTS;
        readError = null;
        for (const attempt of attempts) {
          if (attempt.response_message_id && newer(attempt, lastResponse)) lastResponse = attempt;
          if (attempt.verdict?.recorded_source_matches && attempt.response_binding_matches
            && attempt.verification_bindings.source.matches_recorded_source && attempt.verification_bindings.reviewer.matches_recorded_source
            && newer(attempt, lastBoundVerdict)) lastBoundVerdict = attempt;
        }
      } catch (error) {
        if (!options.finalized() && request === generation) readError = error === timeout ? "read_timeout" : "read_failed";
      } finally { if (timer) clearTimeout(timer); }
    },
    snapshot() {
      return structuredClone({ version: 1, content_bearing: true,
        content_fields: ["attempts[].verdict.summary", "last_response.verdict.summary", "last_bound_verdict.verdict.summary"],
        scope: "Persisted review status, response schema and selected identity/source bindings only. Does not rerun node verification or authorize review acceptance.",
        limits: { max_attempts: MAX_ATTEMPTS, max_response_bytes: MAX_RESPONSE_BYTES, max_summary_chars: MAX_SUMMARY_CHARS },
        attempts, attempts_truncated: truncated, last_response: lastResponse, last_bound_verdict: lastBoundVerdict,
        read_error: readError, incomplete: readError !== null || truncated });
    },
  };
}
