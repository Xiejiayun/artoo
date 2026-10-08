import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it } from "vitest";
import { fixture, observations } from "./journal.fixture.js";
import type { JournalRun, LiveDeliveryClaim, StoredEvent } from "../../../apps/artood/dist/managed/journal-types.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const output = (text: string) => ({ type: "run.output" as const, payload: { stream: "stdout" as const, text } });
const query = (runId: string) => ({ runId });
const caseBudgetMs = 3600000, cleanupReserveMs = 60000, historyEvents = 10000;

it("acknowledged output history does not consume the bounded pending-event backlog", async () => {
  const started = performance.now(), workDeadline = started + caseBudgetMs - cleanupReserveMs;
  const directory = process.env.ARTOO_JOURNAL_REPORT_DIR;
  if (!directory) throw new Error("Owned report directory is required");
  const history = { appended: 0, claimed: 0, receiptsRecorded: 0, directSqlCommittedRows: 0,
    firstSequence: null as number | null, lastSequence: null as number | null, serverAcceptanceClaimed: false };
  const progress = { case: "history-workload-progress", targetEvents: historyEvents, history,
    caseBudgetMs, cleanupReserveMs, workBudgetMs: caseBudgetMs - cleanupReserveMs,
    fixtureCommandTimeoutMs: 15000, productFacadeDefaultMs: 5000,
    stage: "fixture_setup", status: "running", elapsedMs: 0, workloadElapsedMs: 0,
    finalAssertionsPassed: false, fixtureCleanupCompleted: false,
    failedStage: null as string | null, error: null as string | null,
    timingScope: "Observed local durable fixture workload; no 15s, 90s or commercial throughput SLA" };
  observations.push(progress);
  let workloadStarted: number | undefined, workloadFinished: number | undefined;
  const checkpoint = () => {
    progress.elapsedMs = performance.now() - started;
    progress.workloadElapsedMs = workloadStarted === undefined ? 0 : (workloadFinished ?? performance.now()) - workloadStarted;
    const path = join(directory, "history-progress.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(progress, null, 2) + "\n");
    renameSync(`${path}.tmp`, path);
  };
  const beforeRequest = (stage: string) => {
    progress.stage = stage;
    if (performance.now() >= workDeadline) throw new Error("History bulk work deadline expired; stop issuing requests and preserve cleanup reserve");
  };
  let failure: unknown, ownedFixture: Fixture | undefined;
  try {
    checkpoint();
    const f = await fixture(); ownedFixture = f;
    beforeRequest("open_client");
    const owner = await f.client(), request = f.payload("backlog");
    beforeRequest("admit");
    await owner.send("admit", { request });
    // Genuine startup and physical closure precede this local history fixture.
    // The same fresh owner remains authorized; no running writer is asserted.
    beforeRequest("physical_unsettled");
    const physical = await owner.send("physical", { request, runId: request.runId, root: f.root, physicalMode: "unsettled" });
    expect(physical).toMatchObject({ physicalCleanupConfirmed: true, started: { phase: "started", receipt: { kind: "accepted" } } });
    const evidence: Record<string, unknown> = { case: "backlog-after-acknowledged-history", physical, history,
      deliveryFixtureOnly: true, seededCommittedOutputRows: 0, seededPhysicalReceipts: 0,
      performanceAcceptance: "Dedicated bounded workload; actual duration is reported, not a throughput SLA" };
    observations.push(evidence);
    workloadStarted = performance.now();
    for (let sequence = 0; sequence < historyEvents; sequence += 1) {
      // One existing product operation per command: a queued close never
      // waits behind a monolithic 30,000-operation child command.
      beforeRequest("append");
      const event = await owner.send<StoredEvent>("append", { runId: request.runId,
        eventId: `acknowledged-fixture-${sequence}`, event: output(`committed fixture history ${sequence}`) });
      expect(event.sequence).toBe(sequence); history.appended += 1;
      beforeRequest("live_claim");
      const claim = await owner.send<LiveDeliveryClaim>("live-claim", query(request.runId));
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") throw new Error("History fixture requires an actual durable live claim");
      expect(claim.event).toEqual(event); history.claimed += 1;
      beforeRequest("live_receipt");
      const result = await owner.send("live-receipt", { runId: request.runId, sequence: claim.event.sequence,
        hash: claim.event.contentSha256, attemptId: claim.attemptId, status: "accepted" });
      expect(result).toEqual({ state: "pending", abort: null }); history.receiptsRecorded += 1;
      history.firstSequence ??= sequence; history.lastSequence = sequence;
      if (history.receiptsRecorded % 100 === 0) checkpoint();
    }
    workloadFinished = performance.now();
    expect(history).toEqual({ appended: 10000, claimed: 10000, receiptsRecorded: 10000, directSqlCommittedRows: 0,
      firstSequence: 0, lastSequence: 9999, serverAcceptanceClaimed: false });
    beforeRequest("pending_empty");
    expect(await owner.send("pending", query(request.runId))).toEqual([]);
    beforeRequest("append_after_history");
    const appended = await owner.send<StoredEvent>("append", { runId: request.runId, eventId: "after-acked-history", event: output("new pending output") });
    expect(appended.sequence).toBe(10000); evidence["appended"] = appended;
    beforeRequest("pending_next_event");
    expect(await owner.send("pending", query(request.runId))).toEqual([appended]);
    beforeRequest("lookup_started");
    expect(await owner.send<JournalRun>("lookup", query(request.runId))).toMatchObject({ phase: "started", receipt: { kind: "accepted" }, finalOutcomeJson: null });
    progress.finalAssertionsPassed = true;
    progress.stage = "fixture_cleanup";
    checkpoint();
  } catch (error) {
    failure = error; progress.failedStage = progress.stage;
  }
  // Stop workload timing before cleanup, including on a partial-work failure.
  if (workloadStarted !== undefined && workloadFinished === undefined) workloadFinished = performance.now();
  if (ownedFixture) {
    progress.stage = "fixture_cleanup";
    try { await ownedFixture.close(failure === undefined); progress.fixtureCleanupCompleted = true; }
    catch (error) {
      progress.failedStage ??= "fixture_cleanup";
      failure = failure === undefined ? error : new AggregateError([failure, error], "case and owned cleanup failed");
    }
  }
  progress.status = failure === undefined ? "completed" : "failed";
  if (failure === undefined) progress.stage = "complete";
  else progress.error = String(failure);
  try { checkpoint(); }
  catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], "history and progress retention failed");
    progress.status = "failed"; progress.failedStage ??= "progress_retention"; progress.error = String(failure);
  }
  if (failure !== undefined) throw failure;
}, caseBudgetMs);

afterAll(() => {
  const directory = process.env.ARTOO_JOURNAL_REPORT_DIR;
  if (!directory) throw new Error("Owned report directory is required");
  // FixtureClient retains each actual response once; do not duplicate bodies.
  writeFileSync(join(directory, "journal-observations.json"), JSON.stringify({ node: process.version,
    scope: "10,000 actual local append/claim/exact-receipt triplets after genuine physical closure; no server/provider/GUI acceptance", observations,
  }, null, 2) + "\n");
});
