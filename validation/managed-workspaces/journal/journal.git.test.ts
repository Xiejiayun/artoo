import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { fixture, observations } from "./journal.fixture.js";
import type { ClosedRunDeliveryClaim, ClosedRunDeliveryScope, JournalRun, LiveDeliveryClaim, StoredEvent } from "../../../apps/artood/dist/managed/journal-types.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Result = { kind: string; run: JournalRun };
async function withFixture(body: (f: Fixture) => Promise<void>) {
  const f = await fixture(); let failure: unknown;
  try { await body(f); } catch (error) { failure = error; }
  try { await f.close(failure === undefined); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "case and owned cleanup failed"); }
  if (failure !== undefined) throw failure;
}
const output = (text: string) => ({ type: "run.output" as const, payload: { stream: "stdout" as const, text } });
const query = (runId: string) => ({ runId });
function assertPhysicalFinal(run: JournalRun, phase: string, events: readonly StoredEvent[]) {
  expect(run).toMatchObject({ phase: "closed", ownership: "fenced", stopRequested: true, receipt: { kind: "process_exit_confirmed" } });
  expect(run.finalOutcomeJson).not.toBeNull();
  expect(JSON.parse(run.finalOutcomeJson!)).toMatchObject({ terminal: { type: "run.lifecycle", payload: { phase } },
    retained: { type: "run.workspace.retained", payload: { outcome: phase } } });
  expect(events).toHaveLength(2); expect(events.map((event) => event.sequence)).toEqual([0, 1]);
  expect(events.map((event) => JSON.parse(event.contentJson).type)).toEqual(["run.workspace.retained", "run.lifecycle"]);
  expect(events.some((event) => JSON.parse(event.contentJson).payload.phase === "started")).toBe(false);
}

it("two independent clients claim one immutable run; copied/foreign permits and mode changes grant no authority", async () => {
  await withFixture(async (f) => {
    const a = await f.client(), b = await f.client(), request = f.payload("claim");
    const results = await Promise.all([a.send<Result>("admit", { request }), b.send<Result>("admit", { request })]);
    expect(results.filter((result) => result.kind === "fresh")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "unknown")).toHaveLength(1);
    const winner = results[0]!.kind === "fresh" ? a : b;
    expect(await winner.send<Result>("admit", { request })).toMatchObject({ kind: "pending" });
    const changed = structuredClone(request); changed.payload.context_pack.payload!.task.description = "changed ContextPack";
    expect(await winner.send<Result>("admit", { request: changed })).toMatchObject({ kind: "conflict" });
    const downgrade = structuredClone(request); delete downgrade.payload.workspace_allocation;
    expect(await winner.send<Result>("admit", { request: downgrade })).toMatchObject({ kind: "conflict" });
    await expect(winner.send("copied-permit", query(request.runId))).rejects.toThrow("exact live fresh journal permit");
    await expect(winner.send("foreign-permit", query(request.runId))).rejects.toThrow("exact live fresh journal permit");
    await expect(winner.send("forged-closure", query(request.runId))).rejects.toThrow("exact recorded execution");
    expect(await winner.send<JournalRun>("lookup", query(request.runId))).toMatchObject({ phase: "admitted", revision: 1, receipt: null });
    expect(existsSync(request.payload.workspace.root)).toBe(false);
    observations.push({ case: "cross-process-claim", results, noPhysicalWork: true });
  });
});

it("Stop-before-start writes a permanent run fence across an actual client restart and blocks mode downgrade", async () => {
  await withFixture(async (f) => {
    const first = await f.client(), request = f.payload("tombstone");
    const fenced = await first.send<JournalRun>("stop", query(request.runId));
    expect(fenced).toMatchObject({ phase: "closed", mode: "fenced", receipt: { kind: "run_fenced_unbound", launchKey: null } });
    expect(fenced.finalOutcomeJson).toBeNull(); await first.close();
    const reopened = await f.client();
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "fenced", run: { receipt: { id: fenced.receipt!.id } } });
    const downgrade = structuredClone(request); delete downgrade.payload.workspace_allocation;
    expect(await reopened.send<Result>("admit", { request: downgrade })).toMatchObject({ kind: "fenced" });
    expect(await reopened.send<StoredEvent[]>("pending", query(request.runId))).toEqual([]);
    expect(existsSync(request.payload.workspace.root)).toBe(false);
    observations.push({ case: "persistent-run-tombstone", fenced, noInventedRetention: true });
  });
});

it("admitted, preparing and launch_intent survive independent process reopen as unknown with zero respawn", async () => {
  await withFixture(async (f) => {
    for (const phase of ["admitted", "preparing", "launch_intent"] as const) {
      const owner = await f.client(), request = f.payload(phase);
      expect(await owner.send<Result>("admit", { request })).toMatchObject({ kind: "fresh" });
      if (phase !== "admitted") await owner.send("advance", { runId: request.runId, phase: "preparing" });
      if (phase === "launch_intent") await owner.send("advance", { runId: request.runId, phase });
      await owner.close();
      const observer = await f.client();
      expect(await observer.send<Result>("admit", { request })).toMatchObject({ kind: "unknown", run: { phase, ownership: "unknown" } });
      const stopped = await observer.send<JournalRun>("stop", query(request.runId));
      expect(stopped).toMatchObject({ phase, stopRequested: true, ownership: "unknown", receipt: null });
      expect(existsSync(request.payload.workspace.root)).toBe(false); await observer.close();
    }
    observations.push({ case: "restart-stages", stages: ["admitted", "preparing", "launch_intent"], noPhysicalWork: true });
  });
});

it("a real started writer closed without durable settlement reopens unknown rather than acquiring another permit", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), request = f.payload("startedgap");
    await owner.send("admit", { request });
    const physical = await owner.send("physical", { request, runId: request.runId, root: f.root, physicalMode: "unsettled" });
    expect(physical).toMatchObject({ physicalCleanupConfirmed: true, started: { phase: "started", receipt: { kind: "accepted" } } });
    await owner.close(); const reopened = await f.client();
    const result = await reopened.send<Result>("admit", { request });
    expect(result).toMatchObject({ kind: "unknown", run: { phase: "started", ownership: "unknown", finalOutcomeJson: null } });
    expect(await reopened.send<StoredEvent[]>("pending", query(request.runId))).toEqual([]);
    observations.push({ case: "real-started-unsettled-reopen", physical, result });
  });
});

it("trusted bridge uses the frozen full payload and real closure atomically preserves the final outcome plus both event identities", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), request = f.payload("settled");
    await owner.send("admit", { request });
    const supplied = structuredClone(request); supplied.payload.context_pack.payload!.task.description = "REPLACEMENT CONTEXT MUST NOT REACH PRODUCER";
    const physical = await owner.send<{ settled: JournalRun; contextText: string }>("physical", {
      request: supplied, runId: request.runId, root: f.root, physicalMode: "settled",
    });
    expect(physical.contextText).toContain("Preserve exact launch"); expect(physical.contextText).not.toContain("REPLACEMENT CONTEXT");
    const original = await owner.send<StoredEvent[]>("pending", query(request.runId));
    assertPhysicalFinal(physical.settled, "completed", original);
    await owner.close(); const reopened = await f.client();
    const replay = await reopened.send<Result>("admit", { request });
    expect(replay.kind).toBe("fenced"); expect(replay.run.receipt).toEqual(physical.settled.receipt);
    expect(await reopened.send<StoredEvent[]>("pending", query(request.runId))).toEqual(original);
    const scope: ClosedRunDeliveryScope = { expectedNamespace: f.options.expectedNamespace, runId: request.runId,
      launchKey: physical.settled.launchKey!, physicalReceiptId: physical.settled.receipt!.id };
    expect(await reopened.send("legacy-ack")).toEqual({ removed: true });
    for (const event of original) {
      const claim = await reopened.send<ClosedRunDeliveryClaim>("claim", { scope });
      expect(claim.kind).toBe("claimed"); if (claim.kind !== "claimed") throw new Error("Expected actual closed-run claim");
      expect(claim.event).toEqual(event);
      await reopened.send("receipt", { scope, sequence: claim.event.sequence, hash: claim.event.contentSha256,
        attemptId: claim.attemptId, status: "accepted" });
    }
    expect(await reopened.send("pending", query(request.runId))).toEqual([]);
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "fenced" });
    observations.push({ case: "atomic-genuine-terminal", physical, original, replay, typedDeliveryCorrectionQualified: false });
  });
});

it("real post-spawn startup cancellation persists authenticated closure and terminal events without inventing started", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), request = f.payload("startupcancel"); await owner.send("admit", { request });
    const physical = await owner.send<{ settled: JournalRun }>("physical", { request, runId: request.runId, root: f.root, physicalMode: "startup-cancel" });
    const original = await owner.send<StoredEvent[]>("pending", query(request.runId)); assertPhysicalFinal(physical.settled, "cancelled", original);
    expect(JSON.parse(physical.settled.receipt!.contentJson).detail).toMatchObject({ proofSource: "startup_error", producer: { facts: { childSpawned: true } } });
    await owner.close(); const reopened = await f.client();
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "fenced" });
    expect(await reopened.send<StoredEvent[]>("pending", query(request.runId))).toEqual(original);
    observations.push({ case: "actual-startup-cancellation", physical, original, existingServerAcceptanceClaimed: false });
  });
});

it("real not_spawned startup evidence remains unknown and cannot be promoted by a fresh journal permit", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), request = f.payload("notspawned"); await owner.send("admit", { request });
    const physical = await owner.send("physical", { request, runId: request.runId, root: f.root, physicalMode: "startup-not-spawned" });
    expect(physical).toMatchObject({ actualWriterChildren: 0, noStartedEvent: true, physicalCleanupConfirmed: true });
    expect(await owner.send<JournalRun>("stop", query(request.runId))).toMatchObject({ phase: "launch_intent", stopRequested: true, receipt: null });
    await owner.close(); const reopened = await f.client();
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "unknown", run: { phase: "launch_intent", receipt: null } });
    expect(await reopened.send("pending", query(request.runId))).toEqual([]);
    observations.push({ case: "not-spawned-is-not-global-absence", physical });
  });
});

it("durable output events retain sequence/content on restart and reject conflicting same-event content", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), request = f.payload("events"); await owner.send("admit", { request });
    // The real writer is physically closed; its original fresh owner keeps a
    // durable started row without settlement. Delivery does not respawn it.
    const physical = await owner.send("physical", { request, runId: request.runId, root: f.root, physicalMode: "unsettled" });
    expect(physical).toMatchObject({ physicalCleanupConfirmed: true, started: { phase: "started", receipt: { kind: "accepted" } } });
    const first = await owner.send<StoredEvent>("append", { runId: request.runId, eventId: "output-1", event: output("first") });
    expect(await owner.send("append", { runId: request.runId, eventId: "output-1", event: output("first") })).toEqual(first);
    await expect(owner.send("append", { runId: request.runId, eventId: "output-1", event: output("changed") })).rejects.toThrow("event conflict");
    const second = await owner.send<StoredEvent>("append", { runId: request.runId, eventId: "output-2", event: output("second") });
    expect([first.sequence, second.sequence]).toEqual([0, 1]);
    expect(await owner.send("legacy-ack")).toEqual({ removed: true });
    const firstClaim = await owner.send<LiveDeliveryClaim>("live-claim", query(request.runId));
    expect(firstClaim.kind).toBe("claimed"); if (firstClaim.kind !== "claimed") throw new Error("Expected actual live claim");
    expect(firstClaim.event).toEqual(first);
    await owner.send("live-receipt", { runId: request.runId, sequence: firstClaim.event.sequence,
      hash: firstClaim.event.contentSha256, attemptId: firstClaim.attemptId, status: "accepted" });
    const secondClaim = await owner.send<LiveDeliveryClaim>("live-claim", query(request.runId));
    expect(secondClaim.kind).toBe("claimed"); if (secondClaim.kind !== "claimed") throw new Error("Expected second actual live claim");
    expect(secondClaim.event).toEqual(second);
    // This exact claimed event rejects a changed hash. The worker then fails
    // closed, so verification continues through a fresh independent reader.
    await expect(owner.send("live-receipt", { runId: request.runId, sequence: secondClaim.event.sequence,
      hash: "0".repeat(64), attemptId: secondClaim.attemptId, status: "accepted" })).rejects.toThrow("Live receipt lacks an exact durable claim");
    await owner.close(); const reopened = await f.client();
    expect(await reopened.send("pending", query(request.runId))).toEqual([second]);
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "unknown", run: { phase: "started", ownership: "unknown" } });
    // Reopen grants no fresh-owner permit. This does not deny legitimate closed
    // receipts for a separately genuine settled scope and persisted claim.
    await expect(reopened.send("live-receipt", { runId: request.runId, sequence: second.sequence,
      hash: second.contentSha256, attemptId: secondClaim.attemptId, status: "accepted" })).rejects.toThrow("Fixture has no real permit");
    await expect(reopened.send("unowned-live-receipt", { runId: request.runId, sequence: second.sequence,
      hash: second.contentSha256, attemptId: secondClaim.attemptId, status: "accepted" })).rejects.toThrow("exact live fresh journal permit");
    await expect(reopened.send("ack", { runId: request.runId, sequence: second.sequence, hash: "0".repeat(64) })).rejects.toThrow("Unsupported fixture request");
    expect(await reopened.send("pending", query(request.runId))).toEqual([second]);
    observations.push({ case: "output-sequence-replay", physical, first, second, firstClaim, secondClaim,
      typedRetentionCorrection: "not exercised", serverAcceptanceClaimed: false,
      deliveryAuthority: "Current genuine-started owner only; writer physically closed without durable settlement; reopened unknown row has no fresh permit" });
  });
});

it("a real independent SQLite lock failure disables admission without returning a permit", async () => {
  await withFixture(async (f) => {
    const owner = await f.client(), locker = await f.client({}, "locker"), request = f.payload("locked");
    await expect(owner.send("admit", { request })).rejects.toThrow(/locked|busy/i);
    await locker.close();
    await expect(owner.send("admit", { request })).rejects.toThrow("Journal unavailable");
    await owner.close(); const reopened = await f.client();
    expect(await reopened.send("lookup", query(request.runId))).toBeNull();
    expect(existsSync(request.payload.workspace.root)).toBe(false);
    observations.push({ case: "real-sqlite-lock-failure", noPermitReturned: true, noPhysicalWork: true });
  });
});

it("a real committed admission whose response arrives after the parent deadline never grants a late permit", async () => {
  await withFixture(async (f) => {
    const owner = await f.client({ operationTimeoutMs: 25 }), request = f.payload("latecommit");
    await expect(owner.send("late-admit", { request })).rejects.toThrow(/deadline|Late journal commit reply/);
    await expect(owner.send("admit", { request })).rejects.toThrow("Journal unavailable");
    await owner.close(); const reopened = await f.client();
    const record = await reopened.send<JournalRun>("lookup", query(request.runId));
    expect(record).toMatchObject({ phase: "admitted", ownership: "unknown" });
    expect(await reopened.send<Result>("admit", { request })).toMatchObject({ kind: "unknown" });
    expect(existsSync(request.payload.workspace.root)).toBe(false);
    observations.push({ case: "actual-late-commit-reply", record, noLatePermit: true });
  });
});

it("namespace, scope, permissions, missing marker and corrupt storage fail closed without implicit provisioning", async () => {
  await withFixture(async (f) => {
    expect(lstatSync(f.options.directory).mode & 0o777).toBe(0o700);
    const database = join(f.options.directory, "journal.sqlite"), marker = join(f.options.directory, "namespace.json");
    expect(lstatSync(database).mode & 0o777).toBe(0o600); expect(lstatSync(marker).mode & 0o777).toBe(0o600);
    const rejectOpen = async (extra: Parameters<Fixture["client"]>[0], pattern: RegExp) => {
      await expect(f.client(extra)).rejects.toThrow(pattern); f.clients.at(-1)!.expectInitializationFailure(); await f.clients.at(-1)!.close();
    };
    await rejectOpen({ expectedNamespace: "wrong-namespace" }, /continuity/);
    await rejectOpen({ controllerScope: "another-controller" }, /continuity/);
    const owner = await f.client(), request = f.payload("storage"); await owner.send("admit", { request });
    chmodSync(database, 0o400);
    try { await expect(owner.send("lookup", query(request.runId))).rejects.toThrow(/private single-link/); }
    finally { chmodSync(database, 0o600); }
    await owner.close();
    renameSync(marker, `${marker}.retained`);
    try { await rejectOpen({}, /ENOENT/); expect(existsSync(marker)).toBe(false); }
    finally { renameSync(`${marker}.retained`, marker); }
    const bytes = readFileSync(database); writeFileSync(database, Buffer.from("not a SQLite database"));
    await rejectOpen({}, /database|malformed/i);
    expect(readFileSync(database)).toEqual(Buffer.from("not a SQLite database"));
    observations.push({ case: "continuity-and-storage-failures", originalDatabaseBytes: bytes.length, corruptedBytesPreserved: true,
      restoredMarkerExplicitlyByFixture: true, implicitProvisioning: false });
  });
});

afterAll(() => {
  const directory = process.env.ARTOO_JOURNAL_REPORT_DIR;
  if (!directory) throw new Error("Owned report directory is required");
  writeFileSync(join(directory, "journal-observations.json"), JSON.stringify({ node: process.version,
    scope: "Real local SQLite processes, worker storage and selected genuine Git/adapter boundary; no server/provider/GUI/NodeClient integration", observations,
  }, null, 2) + "\n");
});
