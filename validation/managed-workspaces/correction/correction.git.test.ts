import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { fixture, observations, type FixtureClient } from "./journal.fixture.js";
import type { ClosedRunDeliveryClaim, ClosedRunDeliveryScope, ClosedRunDeliveryView, JournalRun, StartRequest, StoredEvent } from "../../../apps/artood/dist/managed/journal-types.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Claim = Extract<ClosedRunDeliveryClaim, { kind: "claimed" }>;
type Physical = { settled: JournalRun; physicalCleanupConfirmed: boolean; contextSha256: string; [key: string]: unknown };
async function withFixture(body: (f: Fixture) => Promise<void>) {
  const f = await fixture(); let failure: unknown;
  try { await body(f); } catch (error) { failure = error; }
  try { await f.close(failure === undefined); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "case and cleanup failed"); }
  if (failure !== undefined) throw failure;
}
function scopeOf(f: Fixture, run: JournalRun): ClosedRunDeliveryScope {
  return { expectedNamespace: f.options.expectedNamespace, runId: run.runId, launchKey: run.launchKey!, physicalReceiptId: run.receipt!.id };
}
async function settle(f: Fixture, name: string, mode = "settled", beforePhysical?: (owner: FixtureClient, request: StartRequest) => Promise<void>) {
  const owner = await f.client(), request = f.payload(name);
  expect(await owner.send("admit", { request })).toMatchObject({ kind: "fresh" });
  if (beforePhysical) await beforePhysical(owner, request);
  const physical = await owner.send<Physical>("physical", { request, runId: request.runId, root: f.root, physicalMode: mode });
  expect(physical.physicalCleanupConfirmed).toBe(true);
  expect(physical.settled).toMatchObject({ phase: "closed", ownership: "fenced", stopRequested: true, receipt: { kind: "process_exit_confirmed" } });
  observations.push({ case: `physical:${name}`, physical });
  return { owner, request, physical, scope: scopeOf(f, physical.settled) };
}
async function claim(client: FixtureClient, scope: ClosedRunDeliveryScope, role?: StoredEvent["role"]): Promise<Claim> {
  const value = await client.send<ClosedRunDeliveryClaim>("claim", { scope });
  expect(value.kind).toBe("claimed"); if (value.kind !== "claimed") throw new Error(`Expected claim: ${JSON.stringify(value)}`);
  if (role) expect(value.event.role).toBe(role); return value;
}
const receipt = (client: FixtureClient, scope: ClosedRunDeliveryScope, claimed: Claim, status: "accepted" | "rejected" = "accepted") =>
  client.send<ClosedRunDeliveryView>("receipt", { scope, sequence: claimed.event.sequence, hash: claimed.event.contentSha256, attemptId: claimed.attemptId, status });
const fail = (client: FixtureClient, scope: ClosedRunDeliveryScope, claimed: Claim, reason = "transport_failure") =>
  client.send<ClosedRunDeliveryView>("failure", { scope, sequence: claimed.event.sequence, attemptId: claimed.attemptId, reason });
const inspect = (client: FixtureClient, scope: ClosedRunDeliveryScope) => client.send<ClosedRunDeliveryView>("delivery-view", { scope });
async function startedAccepted(owner: FixtureClient, scope: ClosedRunDeliveryScope) {
  const started = await claim(owner, scope, "event"); expect(JSON.parse(started.event.contentJson)).toMatchObject({ type: "run.lifecycle", payload: { phase: "started" } });
  await receipt(owner, scope, started); return started;
}
async function acceptCorrection(owner: FixtureClient, scope: ClosedRunDeliveryScope) {
  const retained = await claim(owner, scope, "correction_retention");
  expect(JSON.parse(retained.event.contentJson).payload.outcome).toBe("incomplete_delivery"); await receipt(owner, scope, retained);
  const terminal = await claim(owner, scope, "correction_terminal");
  expect(JSON.parse(terminal.event.contentJson).payload).toEqual({ phase: "failed", reason: "incomplete_delivery" });
  const view = await receipt(owner, scope, terminal); expect(view.state).toBe("delivered"); return { retained, terminal, view };
}
async function storage(f: Fixture, action: string, runId?: string, value?: number) {
  const child = await f.client({}, "storage-fixture", { fixtureAction: action, fixtureRunId: runId, fixtureValue: value }); await child.close();
}
function unchangedPhysical(actual: JournalRun, expected: JournalRun) {
  expect(actual).toEqual(expected); // Includes permanent fence, original outcome and receipt bytes/revision.
}

it("closed-run claims hold completed, remove legacy ACK bypass and reject an unclaimed terminal ACK", async () => {
  await withFixture(async (f) => {
    const { owner, request, physical, scope } = await settle(f, "hold");
    const started = await startedAccepted(owner, scope), snapshot = await owner.send<StoredEvent[]>("pending", { runId: request.runId });
    const terminal = snapshot.find((e) => e.role === "original_terminal")!;
    expect(await owner.send("legacy-ack")).toEqual({ removed: true });
    const retained = await claim(owner, scope, "original_retention");
    expect(await owner.send("claim", { scope })).toMatchObject({ kind: "waiting" });
    const invalid = await f.client();
    await expect(invalid.send("receipt", { scope, sequence: terminal.sequence, hash: terminal.contentSha256, attemptId: retained.attemptId, status: "accepted" })).rejects.toThrow("no exact durable claimed attempt"); await invalid.close();
    const badHash = await f.client();
    await expect(badHash.send("receipt", { scope, sequence: retained.event.sequence, hash: "0".repeat(64),
      attemptId: retained.attemptId, status: "accepted" })).rejects.toThrow("Receipt identity differs"); await badHash.close();
    const corrected = await receipt(owner, scope, retained, "rejected"); expect(corrected).toMatchObject({ revision: 1, state: "correcting", possibleCompletedExposure: false, superseded: 2 });
    const delivered = await acceptCorrection(owner, scope);
    const retainedPayload = JSON.parse(delivered.retained.event.contentJson).payload;
    expect(retainedPayload).toMatchObject({ workspace_root: request.payload.workspace.root, workspace_branch: request.payload.workspace.branch });
    unchangedPhysical(await owner.send<JournalRun>("lookup", { runId: request.runId }), physical.settled);
    expect(await owner.send("admit", { request })).toMatchObject({ kind: "fenced" });
    expect(await receipt(owner, scope, started)).toMatchObject({ revision: 1, state: "delivered" });
    expect(createHash("sha256").update(readFileSync(join(request.payload.workspace.root, "context_pack.md"))).digest("hex")).toBe(physical.contextSha256);
    expect(await owner.send("claim", { scope })).toMatchObject({ kind: "complete" });
    observations.push({ case: "held-completed-rejected-retention", original: physical.settled, snapshot, corrected, delivered, scopeLimit: "After the genuine settlement only delivery methods are called; no independent post-settlement writer counter is claimed" });
  });
});

it("a paused previously claimed completed frame remains possible exposure; late ACK cannot undo correction", async () => {
  await withFixture(async (f) => {
    const { owner, physical, scope } = await settle(f, "exposure"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope, "original_retention"); await receipt(owner, scope, retained);
    const pausedSender = await claim(owner, scope, "original_terminal");
    expect(JSON.parse(pausedSender.event.contentJson).payload.phase).toBe("completed");
    const corrected = await receipt(owner, scope, pausedSender, "rejected"); expect(corrected.possibleCompletedExposure).toBe(true);
    const delivered = await acceptCorrection(owner, scope);
    const late = await receipt(owner, scope, pausedSender); expect(late).toMatchObject({ revision: 1, state: "delivered", correction: corrected.correction, possibleCompletedExposure: true });
    await receipt(owner, scope, retained); await fail(owner, scope, pausedSender);
    expect(await owner.send("claim", { scope })).toMatchObject({ kind: "complete" });
    unchangedPhysical(await owner.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    observations.push({ case: "paused-in-flight-receipt-fixture", pausedFrameStillExists: pausedSender, corrected, delivered, late, scopeLimit: "Local receipt fixture only; no socket/server ordering claim" });
  });
});

it("independent clients preserve one claim/correction after only the observed SQLite busy unavailability", async () => {
  await withFixture(async (f) => {
    const { owner, scope, physical } = await settle(f, "concurrent"); await startedAccepted(owner, scope); await owner.close();
    const clients = [await f.client(), await f.client()];
    const exactBusy = (reason: unknown) => {
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toMatch(/^(?:Error: )*database is locked$/u);
    };
    const describe = <T>(results: PromiseSettledResult<T>[]) => results.map((result) => result.status === "fulfilled"
      ? { status: result.status, value: result.value } : { status: result.status, error: String(result.reason) });
    const results = await Promise.allSettled(clients.map((client) => client.send<ClosedRunDeliveryClaim>("claim", { scope })));
    const granted = results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "claimed" ? [result.value] : []);
    expect(granted).toHaveLength(1); const retained = granted[0]!;
    expect(retained.event.role).toBe("original_retention");
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        exactBusy(result.reason); await clients[index]!.close(); clients[index] = await f.client();
      } else if (result.value.kind !== "claimed") expect(result.value).toMatchObject({ kind: "waiting", view: { revision: 0 } });
    }
    // A fresh independent reader proves recovery, without retrying the unknown
    // operation or obtaining a new frame/attempt from its former client.
    const observer = await f.client();
    expect(await observer.send("claim", { scope })).toMatchObject({ kind: "waiting", view: { revision: 0, correction: null } });
    const durable = await observer.send<{ sequence: number; event_id: string; content_sha256: string; attempts_json: string; committed: number; superseded: number }>(
      "storage-event-attempts", { runId: scope.runId, sequence: retained.event.sequence });
    expect(durable).toMatchObject({ sequence: retained.event.sequence, event_id: retained.event.eventId, content_sha256: retained.event.contentSha256, committed: 0, superseded: 0 });
    expect(JSON.parse(durable.attempts_json).map((attempt: { id: string }) => attempt.id)).toEqual([retained.attemptId]);
    const pair = await Promise.allSettled(clients.map((client) => receipt(client, scope, retained, "rejected")));
    const known = pair.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(known.length).toBeGreaterThanOrEqual(1); const corrected = known[0]!;
    expect(corrected).toMatchObject({ revision: 1, state: "correcting" }); expect(corrected.correction).not.toBeNull();
    for (const [index, result] of pair.entries()) {
      if (result.status === "rejected") { exactBusy(result.reason); await clients[index]!.close(); }
      else expect(result.value.correction).toEqual(corrected.correction);
    }
    const recovered = await inspect(observer, scope); expect(recovered).toMatchObject({ revision: 1, correction: corrected.correction });
    const pending = await observer.send<StoredEvent[]>("pending", { runId: scope.runId });
    const correctionRows = pending.filter((event) => event.role.startsWith("correction_"));
    expect(correctionRows.map((event) => ({ eventId: event.eventId, sequence: event.sequence, contentSha256: event.contentSha256 })))
      .toEqual([corrected.correction!.retention, corrected.correction!.terminal]);
    const replay = await receipt(observer, scope, retained, "rejected"); expect(replay.correction).toEqual(corrected.correction);
    for (const client of clients) await client.close(); await observer.close();
    const reopened = await f.client();
    expect(await inspect(reopened, scope)).toMatchObject({ correction: corrected.correction, revision: 1 });
    await acceptCorrection(reopened, scope); unchangedPhysical(await reopened.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    observations.push({ case: "two-client-claim-correction-with-explicit-busy-recovery", results: describe(results), durable,
      correctionResults: describe(pair), recovered, correctionRows, replay,
      scopeLimit: "Only the observed database-is-locked error is accepted as conservative unavailability; no storage policy relaxation or hidden suite retry" });
  });
});

it("correction failure retries only the same pair within persistent budgets and preserves late accepted attempts", async () => {
  await withFixture(async (f) => {
    const { owner, scope } = await settle(f, "budget"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope); const corrected = await receipt(owner, scope, retained, "rejected");
    const claims: Claim[] = [], counts = new Map<string, number>();
    for (let i=0; i<6; i++) {
      const current = await claim(owner, scope); claims.push(current); counts.set(current.event.eventId, (counts.get(current.event.eventId) ?? 0) + 1);
      await receipt(owner, scope, current, "rejected");
      if (i===1) { await owner.close(); }
      // Reopen below through the separate client after two failures.
      if (i===1) break;
    }
    const reopened = await f.client();
    for (let i=2; i<6; i++) {
      const current = await claim(reopened, scope); claims.push(current); counts.set(current.event.eventId, (counts.get(current.event.eventId) ?? 0) + 1);
      await receipt(reopened, scope, current, "rejected");
    }
    expect([...counts.values()].sort()).toEqual([3,3]);
    for (const id of counts.keys()) expect(new Set(claims.filter((c) => c.event.eventId===id).map((c) => c.deadlineTickMs)).size).toBe(1);
    expect(await reopened.send("claim", { scope })).toMatchObject({ kind: "blocked", view: { revision: 1, correction: corrected.correction } });
    await receipt(reopened, scope, claims[0]!); const late = await receipt(reopened, scope, claims.find((c) => c.event.role === "correction_terminal")!);
    expect(late).toMatchObject({ state: "delivered", revision: 1, correction: corrected.correction });
    observations.push({ case: "fixed-correction-budget-across-restart", corrected, claims, late });
  });
});

it("the original monotonic receipt deadline survives a real process restart and creates one correction", async () => {
  await withFixture(async (f) => {
    const { owner, scope } = await settle(f, "timeout"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope, "original_retention"); await owner.close();
    const remaining = retained.deadlineTickMs - Number(process.hrtime.bigint()/1_000_000n);
    expect(remaining).toBeGreaterThan(0); expect(remaining).toBeLessThanOrEqual(30000);
    await new Promise((resolve) => setTimeout(resolve, remaining + 75));
    const reopened = await f.client();
    const lateAccepted = await receipt(reopened, scope, retained);
    expect(lateAccepted).toMatchObject({ revision: 1, correction: { trigger: { reason: "receipt_timeout" } } });
    const next = await claim(reopened, scope, "correction_retention");
    const corrected = await inspect(reopened, scope); expect(corrected).toMatchObject({ revision: 1, correction: { trigger: { attemptId: retained.attemptId, reason: "receipt_timeout" } }, possibleCompletedExposure: false });
    await fail(reopened, scope, next);
    const correctionTerminal = await claim(reopened, scope, "correction_terminal"); await reopened.close();
    const pairRemaining = Math.max(next.deadlineTickMs, correctionTerminal.deadlineTickMs) - Number(process.hrtime.bigint()/1_000_000n);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pairRemaining) + 75));
    const finalClient = await f.client();
    expect(await finalClient.send("claim", { scope })).toMatchObject({ kind: "blocked", view: { revision: 1, correction: corrected.correction } });
    await receipt(finalClient, scope, next); await receipt(finalClient, scope, correctionTerminal);
    expect(await finalClient.send("claim", { scope })).toMatchObject({ kind: "complete" });
    observations.push({ case: "real-30s-original-and-correction-deadlines-across-process-restart", retained, corrected, next, correctionTerminal, scopeLimit: "Two actual deadline windows in same boot only; suspend/power loss not tested" });
  });
});

it("an actual abrupt client exit after correction commit and before reply reopens with the same pair", async () => {
  await withFixture(async (f) => {
    const { owner, scope, physical } = await settle(f, "crashreply"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope, "original_retention");
    await expect(owner.send("correction-then-exit", { scope, sequence: retained.event.sequence, attemptId: retained.attemptId, reason: "rejected" })).rejects.toThrow("exited before command reply"); await owner.close();
    const reopened = await f.client(), corrected = await inspect(reopened, scope); expect(corrected.revision).toBe(1);
    await receipt(reopened, scope, retained, "rejected"); expect((await inspect(reopened, scope)).correction).toEqual(corrected.correction);
    await acceptCorrection(reopened, scope); unchangedPhysical(await reopened.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    observations.push({ case: "real-client-exit-after-correction-commit-before-reply", corrected });
  });
});

it("failure of the second SQL correction insert rolls back the pair, failure state and supersession", async () => {
  await withFixture(async (f) => {
    const { owner, scope, physical } = await settle(f, "rollback"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope, "original_retention"); await storage(f, "fail-correction");
    await expect(receipt(owner, scope, retained, "rejected")).rejects.toThrow("correction storage failure"); await owner.close();
    const reopened = await f.client(); expect(await inspect(reopened, scope)).toMatchObject({ revision: 0, correction: null, superseded: 0, possibleCompletedExposure: false });
    expect(await reopened.send("claim", { scope })).toMatchObject({ kind: "waiting" });
    unchangedPhysical(await reopened.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    await storage(f, "remove-failure"); const corrected = await receipt(reopened, scope, retained, "rejected");
    expect(corrected.correction!.retention.sequence).toBe(3); expect(corrected.correction!.terminal.sequence).toBe(4);
    await acceptCorrection(reopened, scope); observations.push({ case: "real-sql-second-insert-rollback", corrected, fixture: "SQLite ABORT trigger; not a simulated physical receipt" });
  });
});

it("live rows, no-launch fences, wrong namespace/key/receipt and fabricated attempts cannot enter closed delivery", async () => {
  await withFixture(async (f) => {
    const { owner, scope } = await settle(f, "authority"); await startedAccepted(owner, scope);
    const admitted = f.payload("live"); await owner.send("admit", { request: admitted });
    const tombstone = f.payload("tombstone"); await owner.send("stop", { runId: tombstone.runId });
    for (const invalidScope of [{ ...scope, runId: admitted.runId }, { ...scope, runId: tombstone.runId }, { ...scope, launchKey: "wrong" }, { ...scope, physicalReceiptId: "wrong" }, { ...scope, expectedNamespace: "wrong" }]) {
      const c = await f.client(); await expect(c.send("claim", { scope: invalidScope })).rejects.toThrow(); await c.close();
    }
    const invented = await f.client(); await expect(invented.send("failure", { scope, sequence: 0, attemptId: "invented", reason: "rejected" })).rejects.toThrow("no exact durable claimed attempt"); await invented.close();
    const fakeAck = await f.client(), pending = await owner.send<StoredEvent[]>("pending", { runId: scope.runId });
    const held = pending.find((e) => e.role === "original_terminal")!;
    await expect(fakeAck.send("receipt", { scope, sequence: held.sequence, hash: held.contentSha256, attemptId: "invented", status: "accepted" })).rejects.toThrow("no exact durable claimed attempt"); await fakeAck.close();
    expect(await inspect(owner, scope)).toMatchObject({ revision: 0, correction: null, possibleCompletedExposure: false });
    expect(existsSync(admitted.payload.workspace.root)).toBe(false); expect(existsSync(tombstone.payload.workspace.root)).toBe(false);
    observations.push({ case: "closed-only-authority-no-live-lane", noLaunchForInvalidScopes: true });
  });
});

it("failed/cancelled settlement reasons survive metadata failure and their terminals can still be claimed", async () => {
  await withFixture(async (f) => {
    for (const phase of ["failed", "cancelled"] as const) {
      const { owner, scope, physical } = await settle(f, phase, `settled-${phase}`); await startedAccepted(owner, scope);
      const retained = await claim(owner, scope, "original_retention"); await receipt(owner, scope, retained, "rejected");
      const terminal = await claim(owner, scope, "original_terminal"); expect(JSON.parse(terminal.event.contentJson).payload).toEqual({ phase, reason: `original_${phase}_reason` }); await receipt(owner, scope, terminal);
      for (let i=0; i<2; i++) await receipt(owner, scope, await claim(owner, scope, "original_retention"), "rejected");
      const blocked = await owner.send("claim", { scope }); expect(blocked).toMatchObject({ kind: "blocked", view: { revision: 0, correction: null } });
      unchangedPhysical(await owner.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
      observations.push({ case: `original-${phase}-reason-preserved`, terminal, blocked }); await owner.close();
    }
  });
});

it("a full allowed ordinary backlog still reserves both original settlement and correction rows", async () => {
  await withFixture(async (f) => {
    const { owner, scope, physical } = await settle(f, "capacity", "settled", async (_owner, request) => storage(f, "seed-backlog", request.runId, 9995));
    const first = await claim(owner, scope, "event"), corrected = await receipt(owner, scope, first, "rejected");
    expect(corrected).toMatchObject({ revision: 1, superseded: 9998, outstanding: 2 });
    expect(corrected.correction!.retention.sequence).toBe(9998); expect(corrected.correction!.terminal.sequence).toBe(9999);
    await acceptCorrection(owner, scope); unchangedPhysical(await owner.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    observations.push({ case: "real-sqlite-backlog-reserved-capacity", corrected, fixture: "Ordinary output backlog seeded; no closure/claim/ACK authority seeded" });
  });
});

it("int32 sequence slots are reserved through the final correction without wrapping or reuse", async () => {
  await withFixture(async (f) => {
    const edge = 2 ** 31 - 1;
    const { owner, scope } = await settle(f, "sequence", "settled", async (_owner, request) => storage(f, "sequence-edge", request.runId, edge - 4));
    await startedAccepted(owner, scope); const retained = await claim(owner, scope, "original_retention");
    const corrected = await receipt(owner, scope, retained, "rejected");
    expect(corrected.correction!.retention.sequence).toBe(edge - 1); expect(corrected.correction!.terminal.sequence).toBe(edge);
    await acceptCorrection(owner, scope); observations.push({ case: "int32-final-reserved-slots", corrected, fixture: "Sequence counter storage boundary only" });
  });
});

it("unknown boot continuity blocks future claims while an exact historical accepted receipt remains recordable", async () => {
  await withFixture(async (f) => {
    const { owner, scope, physical } = await settle(f, "clock"); await startedAccepted(owner, scope);
    const retained = await claim(owner, scope, "original_retention"); await owner.close();
    await storage(f, "clock-discontinuity", scope.runId); const reopened = await f.client();
    // The ACK is deliberately the first delivery operation after reopening.
    const recorded = await receipt(reopened, scope, retained);
    expect(recorded).toMatchObject({ revision: 0, state: "blocked", correction: null, possibleCompletedExposure: false });
    expect(await reopened.send("claim", { scope })).toMatchObject({ kind: "blocked", reason: "clock_continuity_unknown" });
    await reopened.close(); const finalClient = await f.client();
    expect(await finalClient.send("claim", { scope })).toMatchObject({ kind: "blocked", reason: "clock_continuity_unknown" });
    unchangedPhysical(await finalClient.send<JournalRun>("lookup", { runId: scope.runId }), physical.settled);
    observations.push({ case: "clock-id-storage-fault-fixture", retained, recorded, scopeLimit: "Fault fixture; not a real reboot/suspend/power-loss test" });
    expect(await finalClient.send("storage-clock-latch", { runId: scope.runId })).toEqual({ delivery_clock_unknown: 1 });

    const exposed = await settle(f, "clock-already-claimed"); await startedAccepted(exposed.owner, exposed.scope);
    await receipt(exposed.owner, exposed.scope, await claim(exposed.owner, exposed.scope, "original_retention"));
    const completed = await claim(exposed.owner, exposed.scope, "original_terminal"); await exposed.owner.close();
    await storage(f, "clock-discontinuity", exposed.scope.runId);
    const accepting = await f.client();
    const historical = await receipt(accepting, exposed.scope, completed);
    expect(historical).toMatchObject({ revision: 0, correction: null, state: "delivered", possibleCompletedExposure: true });
    expect(await accepting.send("storage-clock-latch", { runId: exposed.scope.runId })).toEqual({ delivery_clock_unknown: 1 });
    expect(await accepting.send("claim", { scope: exposed.scope })).toMatchObject({ kind: "complete" }); await accepting.close();
    const completedReopen = await f.client();
    expect(await completedReopen.send("storage-clock-latch", { runId: exposed.scope.runId })).toEqual({ delivery_clock_unknown: 1 });
    expect(await completedReopen.send("claim", { scope: exposed.scope })).toMatchObject({ kind: "complete" });
    unchangedPhysical(await completedReopen.send<JournalRun>("lookup", { runId: exposed.scope.runId }), exposed.physical.settled);
    observations.push({ case: "historical-completed-ack-with-clock-latch", completed, historical, clockLatchStillOneAfterReopen: true, noNewClaimRequired: true });
  });
});

afterAll(() => {
  const directory = process.env["ARTOO_JOURNAL_REPORT_DIR"]; if (!directory) throw new Error("Owned report directory is required");
  writeFileSync(join(directory, "journal-observations.json"), JSON.stringify({ scope: "Closed-run local SQLite delivery slice; receipt/server outcomes are explicitly fixtures", observations }, null, 2) + "\n");
});
