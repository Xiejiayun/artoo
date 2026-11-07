import { createHash } from "node:crypto";
import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupLiveAcceptance, createLiveAcceptanceReportWriter } from "./live-acceptance-test-support.js";
import { createLiveReviewDiagnostics, projectLiveReviewAttempt, readLiveReviewDiagnosticRows,
  type LiveReviewDiagnosticRow } from "./live-review-diagnostics-test-support.js";

const sourceDigest = `sha256:${"a".repeat(64)}`, profileDigest = `sha256:${"b".repeat(64)}`;
const contextDigest = `sha256:${"c".repeat(64)}`;
const secret = "fixture-private-provider-key";
// Same bounds/redaction contract as the live harness. Never use real environment credentials in this fixture.
const redact = (value: string) => value.replaceAll(secret, "[redacted]").slice(0, 2000);
const verdict = (overrides: Record<string, unknown> = {}) => ({ version: 1, reviewed_run_id: "source_run",
  verification_evidence_id: "source_evidence", subject_digest: sourceDigest, outcome: "changes_requested",
  summary: "Search loses the saved selection.", findings: [{ severity: "blocking", description: "Preserve selection." }], ...overrides });
function row(overrides: Partial<LiveReviewDiagnosticRow> = {}): LiveReviewDiagnosticRow {
  const response = JSON.stringify(verdict());
  return { reviewId: "review_1", subjectTaskId: "source_task", subjectRunId: "source_run", subjectEvidenceId: "source_evidence",
    subjectDigest: sourceDigest, reviewerInstanceId: "reviewer_instance", reviewTaskId: "review_task", currentTurnId: "turn_2",
    reviewStatus: "pending", turnId: "turn_2", turnPosition: 2, turnStatus: "completed", turnRunId: "review_run", responseMessageId: "reply_2",
    contextId: "context_2", contextRunId: "review_run", contextTaskId: "review_task", contextDigest,
    contextSubjectVersion: "1", contextVerificationVersion: "1", contextSubjectTaskId: "source_task", contextSubjectRunId: "source_run",
    contextEvidenceId: "source_evidence", contextSubjectDigest: sourceDigest, contextRequestId: "source_request",
    contextProfileId: "default", contextProfileDigest: profileDigest,
    sourceRunId: "source_run", sourceTaskId: "source_task", sourceRunStatus: "completed", sourceInstanceId: "author_instance", sourceComputerId: "computer_1",
    sourceRequestId: "source_request", sourceProfileId: "default", reviewerRunId: "review_run", reviewerRunStatus: "completed",
    reviewerTaskId: "review_task", reviewerRunInstanceId: "reviewer_instance", reviewerComputerId: "computer_1",
    reviewerRequestId: "review_request", reviewerProfileId: "default", sameWorkspace: true,
    sourceEvidenceId: "source_evidence", sourceEvidenceRunId: "source_run", sourceEvidenceRequestId: "source_request",
    sourceEvidenceProfileId: "default", sourceEvidenceDigest: sourceDigest, sourceProfileDigest: profileDigest, sourceOutcome: "passed",
    reviewerEvidenceId: "review_evidence", reviewerEvidenceRunId: "review_run", reviewerEvidenceRequestId: "review_request",
    reviewerEvidenceProfileId: "default", reviewerEvidenceDigest: sourceDigest, reviewerProfileDigest: profileDigest, reviewerOutcome: "passed",
    messageId: "reply_2", messageRunId: "review_run", messageTaskId: "review_task", messageActorType: "agent", messageActorId: "reviewer_instance",
    responseBytes: Buffer.byteLength(response), responseBody: response, ...overrides };
}
afterEach(() => vi.useRealTimers());

describe("bounded persisted independent-review diagnostics", () => {
  it("retains the actual schema decision separately from persisted pending status", () => {
    const result = projectLiveReviewAttempt(row(), redact);
    expect(result).toMatchObject({ review_id: "review_1", persisted_status: "pending", response_binding_matches: true, parse_error: null,
      original_context: { context_pack_id: "context_2", digest: contextDigest, bound_to_attempt: true, matches_current_review: true },
      verdict: { schema: "IndependentReviewVerdict.v1", outcome: "changes_requested", summary: "Search loses the saved selection.", recorded_source_matches: true } });
    expect(result.verification_bindings.source.matches_recorded_source).toBe(true);
    expect(result.verification_bindings.reviewer.matches_recorded_source).toBe(true);
  });

  it("uses the old turn's context when the current review row now names another source", () => {
    const result = projectLiveReviewAttempt(row({ currentTurnId: "turn_3", subjectRunId: "new_source", subjectEvidenceId: "new_evidence",
      subjectDigest: `sha256:${"d".repeat(64)}` }), redact);
    expect(result).toMatchObject({ current_turn_id: "turn_3", attempt_turn_id: "turn_2", attempt_is_current: false,
      original_context: { subject_run_id: "source_run", evidence_id: "source_evidence", matches_current_review: false },
      verdict: { recorded_source_matches: true } });
    expect(result.verification_bindings.source.matches_recorded_source).toBe(true);
  });

  it.each([
    ["invalid_json", `not-json ${secret}`],
    ["invalid_schema", JSON.stringify({ outcome: "accepted", reason: secret, reviewer_run_id: "review_run" })],
    ["invalid_schema", JSON.stringify(verdict({ unexpected_private_field: secret }))],
    ["invalid_schema", JSON.stringify(verdict({ outcome: "accepted" }))],
  ])("records %s without parser exceptions or malformed content", (code, response) => {
    const result = projectLiveReviewAttempt(row({ responseBody: response, responseBytes: Buffer.byteLength(response) }), redact);
    expect(result.parse_error).toBe(code);
    expect(result.verdict).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/fixture-private-provider-key|unexpected_private_field|not-json|reviewer_run_id.*reason/);
  });

  it("bounds content after redaction and reports counts without raw finding descriptions", () => {
    const response = JSON.stringify(verdict({ summary: `${secret} ${"x".repeat(3000)}`,
      findings: [{ severity: "blocking", description: "private-tool-output", file: "private/path" }] }));
    const result = projectLiveReviewAttempt(row({ responseBody: response, responseBytes: Buffer.byteLength(response) }), redact);
    expect(result.verdict).toMatchObject({ summary_truncated: true, finding_count: 1, blocking_finding_count: 1 });
    expect(result.verdict!.summary).toHaveLength(2000);
    expect(result.verdict!.summary.startsWith("[redacted]")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/fixture-private-provider-key|private-tool-output|private\/path/);
    expect(projectLiveReviewAttempt(row({ responseBytes: 262145, responseBody: null }), redact).parse_error).toBe("response_too_large");
  });

  it.each([
    { messageActorId: "other_instance" }, { messageRunId: "other_run" }, { messageTaskId: "other_task" },
    { turnRunId: "other_run" }, { reviewerRunStatus: "running" },
  ])("does not parse a response with changed execution identity: %j", mutation => {
    const result = projectLiveReviewAttempt(row(mutation), redact);
    expect(result.parse_error).toBe("response_binding_mismatch");
    expect(result.verdict).toBeNull();
  });

  it.each([
    { contextId: null }, { contextRunId: "other_run" }, { sourceInstanceId: null }, { sourceInstanceId: "reviewer_instance" },
    { sourceProfileDigest: null, contextProfileDigest: null }, { contextProfileDigest: `sha256:${"d".repeat(64)}` },
    { contextRequestId: "other_request" }, { reviewerEvidenceRequestId: "other_request" }, { sourceEvidenceDigest: `sha256:${"d".repeat(64)}` },
  ])("does not cache a bound verdict when original context/evidence is missing or mismatched: %j", async mutation => {
    const diagnostics = createLiveReviewDiagnostics({ read: async () => ({ rows: [row(mutation)], truncated: false }), redact, finalized: () => false });
    await diagnostics.capture("progress");
    expect(diagnostics.snapshot().last_bound_verdict).toBeNull();
    expect(diagnostics.snapshot().attempts[0]?.verdict?.schema).toBe("IndependentReviewVerdict.v1");
  });

  it.each(["Goal retry budget would be exceeded", "Live team stopped", "cleanup failure"])("retains the last verdict through %s and a newer pending retry", async reason => {
    let rows = [row()];
    const diagnostics = createLiveReviewDiagnostics({ read: async () => ({ rows, truncated: false }), redact, finalized: () => false });
    await diagnostics.capture("progress");
    rows = [row({ turnId: "turn_3", turnPosition: 3, turnStatus: "running", responseMessageId: null, messageId: null, responseBody: null })];
    await diagnostics.capture("failure");
    const saved: Record<string, unknown>[] = [];
    const writer = createLiveAcceptanceReportWriter(report => saved.push(report));
    writer.finish({ error: reason, review_diagnostics: diagnostics.snapshot(), pipeline_passed: false, cleanup_passed: false }, "fail", false);
    expect(saved[0]).toMatchObject({ error: reason, passed: false, review_diagnostics: {
      last_bound_verdict: { attempt_turn_id: "turn_2", response_message_id: "reply_2", original_context: { digest: contextDigest },
        verdict: { outcome: "changes_requested" } } } });
  });

  it("keeps cached diagnostics on failed cleanup reads and still closes the database within the original cleanup step", async () => {
    let fails = false;
    const diagnostics = createLiveReviewDiagnostics({ read: async () => { if (fails) throw new Error(secret); return { rows: [row()], truncated: false }; },
      redact, finalized: () => false });
    await diagnostics.capture("progress"); fails = true;
    const close = vi.fn();
    const cleanup = await cleanupLiveAcceptance({ stopDispatchers: [], stopNode() {}, drainBinding() {}, closeBinding() {},
      closeServer: async () => { try { await diagnostics.capture("cleanup"); } finally { close(); } }, removeWorkspace() {}, finalized: () => false,
      describeError: error => String(error) });
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup.passed).toBe(true);
    expect(diagnostics.snapshot()).toMatchObject({ incomplete: true, read_error: "read_failed", last_bound_verdict: { response_message_id: "reply_2" } });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(secret);
  });

  it("bounds a hanging diagnostic read, retains the verdict, and ignores its late result", async () => {
    vi.useFakeTimers();
    let finish!: (value: Awaited<ReturnType<typeof readLiveReviewDiagnosticRows>>) => void;
    const read = vi.fn().mockResolvedValueOnce({ rows: [row()], truncated: false })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const diagnostics = createLiveReviewDiagnostics({ read, redact, finalized: () => false, readTimeoutMs: 50 });
    await diagnostics.capture("progress");
    const pending = diagnostics.capture("cleanup"); await vi.advanceTimersByTimeAsync(50); await pending;
    expect(diagnostics.snapshot()).toMatchObject({ incomplete: true, read_error: "read_timeout", last_bound_verdict: { attempt_turn_id: "turn_2" } });
    finish({ rows: [], truncated: false }); await Promise.resolve();
    await diagnostics.capture("failure");
    expect(read).toHaveBeenCalledTimes(2);
    expect(diagnostics.snapshot().last_bound_verdict?.attempt_turn_id).toBe("turn_2");
  });

  it("fences stale progress after cleanup and all reads after report finalization", async () => {
    let late!: (value: Awaited<ReturnType<typeof readLiveReviewDiagnosticRows>>) => void;
    let finalized = false;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
      .mockResolvedValueOnce({ rows: [row()], truncated: false });
    const diagnostics = createLiveReviewDiagnostics({ read, redact, finalized: () => finalized });
    const progress = diagnostics.capture("progress");
    await diagnostics.capture("cleanup");
    late({ rows: [], truncated: false }); await progress;
    const snapshot = diagnostics.snapshot(); finalized = true;
    await diagnostics.capture("cleanup");
    expect(read).toHaveBeenCalledTimes(2);
    expect(diagnostics.snapshot()).toEqual(snapshot);
    snapshot.attempts.length = 0;
    expect(diagnostics.snapshot().attempts).toHaveLength(1);
  });

  it("bounds records and labels summary content without marking schema parsing as server acceptance", async () => {
    const diagnostics = createLiveReviewDiagnostics({ read: async () => ({ rows: Array.from({ length: 17 }, () => row()), truncated: true }),
      redact, finalized: () => false });
    await diagnostics.capture("progress");
    const snapshot = diagnostics.snapshot();
    expect(snapshot.attempts).toHaveLength(16);
    expect(snapshot).toMatchObject({ incomplete: true, content_bearing: true, attempts_truncated: true });
    expect(snapshot.content_fields).toContain("last_bound_verdict.verdict.summary");
    expect(snapshot.scope).toContain("Does not rerun node verification or authorize review acceptance");
    expect(snapshot.last_bound_verdict?.persisted_status).toBe("pending");
  });

  it("cannot replace the final cached report with a late database response", async () => {
    const persisted: Record<string, unknown>[] = [];
    const writer = createLiveAcceptanceReportWriter(value => persisted.push(value));
    let resolveRead!: (value: Awaited<ReturnType<typeof readLiveReviewDiagnosticRows>>) => void;
    const read = vi.fn().mockResolvedValueOnce({ rows: [row()], truncated: false })
      .mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const diagnostics = createLiveReviewDiagnostics({ read, redact, finalized: () => writer.finalized });
    await diagnostics.capture("progress");
    const pending = diagnostics.capture("cleanup");
    const snapshot = diagnostics.snapshot();
    writer.finish({ error: "budget exhausted", review_diagnostics: snapshot }, "fail", true);
    resolveRead({ rows: [], truncated: false }); await pending;
    writer.progress({ review_diagnostics: diagnostics.snapshot() });
    expect(diagnostics.snapshot()).toEqual(snapshot);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ error: "budget exhausted", aborted: true, passed: false,
      review_diagnostics: { last_bound_verdict: { response_message_id: "reply_2" } } });
  });
});

describe("SELECT-only review diagnostic storage boundary", () => {
  it("reads historical responses under READ ONLY with the original context and exact evidence request", async () => {
    const db = await PgliteDbClient.create();
    try {
      // Minimal persisted-table fixture: no model, node, browser, process or live provider.
      await db.migrate([
        "create table autonomous_reviews (id text, organization_id text, goal_id text, task_id text, subject_run_id text, evidence_id text, subject_digest text, reviewer_instance_id text, review_task_id text, turn_id text, status text, updated_at timestamptz)",
        "create table assistant_turns (id text, organization_id text, task_id text, agent_instance_id text, position bigint, run_id text, response_message_id text, status text)",
        "create table runs (id text, organization_id text, task_id text, agent_instance_id text, computer_id text, workspace_root text, status text, verification_requirement jsonb, context_pack_id text)",
        "create table context_packs (id text, organization_id text, task_id text, run_id text, payload jsonb)",
        "create table messages (id text, organization_id text, task_id text, run_id text, actor_type text, actor_id text, body text)",
        "create table run_evidence (id text, organization_id text, run_id text, request_id text, payload jsonb)",
      ]);
      const context = { review_subject: { version: 1, task_id: "source_task", run_id: "source_run", evidence_id: "source_evidence",
        subject_digest: sourceDigest, verification: { version: 1, request_id: "source_request", profile_id: "default", profile_digest: profileDigest } },
        private_context: "must-not-appear" };
      const evidence = { profile_id: "default", subject_digest: sourceDigest, profile_digest: profileDigest, outcome: "passed" };
      await db.db.execute(sql`insert into autonomous_reviews values ('review_1','org_1','goal_1','source_task','new_source','new_evidence',${sourceDigest},'reviewer_instance','review_task','turn_3','pending',now())`);
      await db.db.execute(sql`insert into autonomous_reviews values ('foreign_review','org_2','goal_1','source_task','source_run','source_evidence',${sourceDigest},'reviewer_instance','review_task','turn_2','accepted',now())`);
      await db.db.execute(sql`insert into autonomous_reviews values ('other_goal','org_1','goal_2','source_task','source_run','source_evidence',${sourceDigest},'reviewer_instance','review_task','turn_2','accepted',now())`);
      await db.db.execute(sql`insert into assistant_turns values ('turn_2','org_1','review_task','reviewer_instance',2,'review_run','reply_2','completed'), ('turn_3','org_1','review_task','reviewer_instance',3,null,null,'queued'), ('foreign_turn','org_2','review_task','reviewer_instance',4,'review_run','reply_2','completed')`);
      await db.db.execute(sql`insert into runs values ('source_run','org_1','source_task','author_instance','computer_1','workspace','completed',${JSON.stringify({ request_id: "source_request", profile_id: "default" })}::jsonb,null), ('review_run','org_1','review_task','reviewer_instance','computer_1','workspace','completed',${JSON.stringify({ request_id: "review_request", profile_id: "default" })}::jsonb,'context_2')`);
      await db.db.execute(sql`insert into context_packs values ('context_2','org_1','review_task','review_run',${JSON.stringify(context)}::jsonb)`);
      await db.db.execute(sql`insert into messages values ('reply_2','org_1','review_task','review_run','agent','reviewer_instance',${JSON.stringify(verdict())})`);
      await db.db.execute(sql`insert into run_evidence values ('source_evidence','org_1','source_run','source_request',${JSON.stringify(evidence)}::jsonb), ('review_evidence','org_1','review_run','review_request',${JSON.stringify(evidence)}::jsonb), ('wrong_request','org_1','review_run','other_request',${JSON.stringify(evidence)}::jsonb), ('foreign_evidence','org_2','review_run','review_request',${JSON.stringify(evidence)}::jsonb)`);
      const result = await db.transaction(async tx => {
        await tx.execute(sql`set transaction read only`);
        return readLiveReviewDiagnosticRows({ select: tx.select.bind(tx) }, { organizationId: "org_1", goalId: "goal_1" });
      });
      expect(result.rows.map(value => value.turnId)).toEqual(["turn_3", "turn_2"]);
      expect(result.rows.every(value => value.reviewId === "review_1")).toBe(true);
      const historical = result.rows[1]!;
      expect(historical.reviewerEvidenceId).toBe("review_evidence");
      const expectedContext = await db.db.execute<{ text: string }>(sql`select payload::text as text from context_packs where id='context_2'`);
      expect(historical.contextDigest).toBe(`sha256:${createHash("sha256").update(expectedContext.rows[0]!.text).digest("hex")}`);
      const projected = projectLiveReviewAttempt(historical, redact);
      expect(projected).toMatchObject({ attempt_is_current: false, original_context: { matches_current_review: false },
        verdict: { outcome: "changes_requested", recorded_source_matches: true } });
      expect(projected.verification_bindings.source.matches_recorded_source).toBe(true);
      expect(JSON.stringify(projected)).not.toContain("must-not-appear");
    } finally { await db.close(); }
  });
});
