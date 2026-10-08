import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { qualifyRunEventMessage } from "../../../apps/server/dist/services/run-event-receipt.js";
import { managedWriterFixture, writerObservations, type WriterOptions, type OutboxRow } from "./managed-writer.fixture.js";
import { absent, type SpawnObservation } from "./live.fixture.js";
import { pause, until, type WireRecord } from "./ws-network.fixture.js";

const spawnObservation = vi.hoisted(() => ({ observer: undefined as SpawnObservation | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    spawnObservation.observer?.(args[0], Array.isArray(args[1]) ? args[1] : [], (Array.isArray(args[1]) ? args[2] : args[1]) as SpawnOptions | undefined, child);
    return child;
  } };
});
type Fixture = Awaited<ReturnType<typeof managedWriterFixture>>;
async function withWriter(id: string, body: (f: Fixture) => Promise<void>, options: WriterOptions = {}) {
  const f = await managedWriterFixture(options); spawnObservation.observer = f.observe; let failure: unknown;
  try { await body(f); } catch (error) { failure = error; }
  try { await f.close(failure === undefined); } catch (error) { failure = failure ? new AggregateError([failure, error], "test and owned cleanup failed") : error; }
  finally { spawnObservation.observer = undefined; }
  writerObservations.push({ case: id, passed: failure === undefined, error: failure ? String(failure) : undefined });
  if (failure !== undefined) throw failure;
}
const isEvent = (row: WireRecord, type?: string) => row.direction === "up" && row.frame.kind === "run.event" && (type === undefined || row.frame.event.type === type);
const isCompleted = (row: WireRecord) => isEvent(row, "run.lifecycle") && row.frame.event.payload.phase === "completed";
const isOutput = (row: WireRecord) => isEvent(row, "run.output");
const isAck = (row: WireRecord, sequence: number) => row.direction === "down" && row.frame.type === "run.event.ack" && row.frame.payload.sequence === sequence;
const attempts = (row: OutboxRow) => JSON.parse(row.attempts_json) as Array<{ id: string; claimedTickMs: number; failure: string | null; accepted: boolean }>;
function assertClosedProcesses(f: Fixture) {
  const owned = f.physical().filter((row) => row.role !== "git"); expect(owned.map((row) => row.role).sort()).toEqual(["cli", "guardian"]);
  for (const row of owned) expect(row).toMatchObject({ exitObserved: true, stdioCloseObserved: true, childAbsent: true, groupAbsent: true });
}
function assertTerminalAfterClosure(f: Fixture) {
  for (const row of f.proxy.records.filter((record) => isEvent(record, "run.lifecycle") && record.frame.event.payload.phase !== "started")) {
    const physical = (row.physical as ReturnType<Fixture["physical"]>).filter((value) => value.role !== "git");
    expect(physical.map((value) => value.role).sort()).toEqual(["cli", "guardian"]);
    for (const value of physical) expect(value).toMatchObject({ exitObserved: true, stdioCloseObserved: true, childAbsent: true, groupAbsent: true });
  }
}
async function deliveryView(f: Fixture) { const run = await f.closed(); return f.journal.inspectClosedRunDelivery({ ...f.query(), launchKey: run.launchKey!, physicalReceiptId: run.receipt!.id }); }
async function began(f: Fixture) { await f.begin(); await f.writerReady(); }
function firstOutputSequence(f: Fixture) { return f.proxy.records.find(isOutput)?.frame.sequence as number | undefined; }
function pendingOutput(f: Fixture) { const sequence = firstOutputSequence(f); if (sequence === undefined) throw new Error("No actual output exposure"); return f.rows().find((row) => row.sequence === sequence)!; }
async function acceptedBodies(f: Fixture) {
  const snapshot = await f.snapshot();
  for (const receipt of snapshot.receipts) {
    const exposed = f.proxy.records.find((row) => isEvent(row) && row.frame.sequence === receipt.sequence);
    expect(exposed).toBeDefined(); expect(receipt.bodyIdentity).toBe(qualifyRunEventMessage(exposed!.frame).bodyIdentity);
  }
  expect(new Set(snapshot.receipts.map((row) => row.sequence)).size).toBe(snapshot.receipts.length); return snapshot;
}

it("W01 actual auth/admin/assignment dispatch streams durable writer events and qualified receipts", async () => {
  let uploads = 0;
  await withWriter("W01", async (f) => {
    await began(f); await until(() => f.rows().some((row) => JSON.parse(row.content_json).type === "run.output" && row.committed === 1), "durable output while writer alive");
    expect(absent(f.launches()[0]!.pid)).toBe(false);
    const before = f.rows(); expect(before.some((row) => ["run.answer", "run.usage", "artifact.created"].includes(JSON.parse(row.content_json).type))).toBe(false);
    f.release(); const closed = await f.closed(); await f.delivered(); assertClosedProcesses(f); assertTerminalAfterClosure(f);
    expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.phase).toBe("completed");
    const rows = f.rows(), events = rows.map((row) => JSON.parse(row.content_json));
    expect(events).toContainEqual({ type: "run.answer", payload: { text: "fixture final answer" } });
    expect(events.find((event) => event.type === "run.usage").payload).toMatchObject({ input_tokens: 11, output_tokens: 7, provider_session_id: "fixture-session" });
    expect(events.find((event) => event.type === "artifact.created").payload).toMatchObject({ uri: "/fixture/artifacts/stable", metadata: { fixture_tag: "full body retained" } });
    expect(uploads).toBe(1); expect(rows.every((row) => row.content_sha256 === createHash("sha256").update(row.content_json).digest("hex"))).toBe(true);
    const server = await acceptedBodies(f); expect(server.run!.status).toBe("completed"); expect(server.task!.status).toBe("review");
    expect(server.receipts).toHaveLength(rows.length); writerObservations.push({ case: "W01-content", before, rows, closed, server, uploads });
  }, { artifact: true, uploadArtifact: async (_run, _root, event) => { uploads++; return { type: "artifact.created", payload: { ...event.payload, uri: "/fixture/artifacts/stable", metadata: { ...event.payload.metadata, fixture_tag: "full body retained" } } }; } });
});

it("W02 committed receipt ACK loss retries exact immutable claim through a new session", async () => {
  await withWriter("W02", async (f) => {
    let sequence: number | undefined, lost = false;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) sequence = row.frame.sequence;
      if (sequence !== undefined && isAck(row, sequence) && !lost) { lost = true; queueMicrotask(() => f.proxy.cut()); return "drop"; } return "forward"; });
    await began(f); await until(() => sequence !== undefined && f.rows().some((row) => row.sequence === sequence && row.committed === 1 && attempts(row).length === 2), "new coordinator retry accepted");
    const row = pendingOutput(f), copies = f.proxy.records.filter((record) => isOutput(record) && record.frame.sequence === row.sequence);
    expect(copies).toHaveLength(2); expect(copies[0]!.text).toBe(copies[1]!.text); expect(copies[0]!.generation).not.toBe(copies[1]!.generation);
    expect(attempts(row)).toHaveLength(2); expect(row.deadline_tick_ms! - attempts(row)[0]!.claimedTickMs).toBe(30000);
    expect(attempts(row)[1]!.claimedTickMs).toBeLessThan(row.deadline_tick_ms!);
    const sessions = f.proxy.records.filter((record) => record.direction === "down" && record.frame.type === "node.session.ready");
    expect(sessions[0]!.frame.payload.hello_nonce).not.toBe(sessions[1]!.frame.payload.hello_nonce); expect(sessions[0]!.frame.payload.session_id).not.toBe(sessions[1]!.frame.payload.session_id);
    f.release(); await f.closed(); await f.delivered(); const server = await acceptedBodies(f);
    expect(server.receipts.filter((receipt) => receipt.sequence === row.sequence)).toHaveLength(1); writerObservations.push({ case: "W02-retry", row, copies, server });
  });
});

it("W03 exactly three possible exposure failures stop the genuine writer without a fourth claim", async () => {
  await withWriter("W03", async (f) => {
    let sequence: number | undefined, failures = 0;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) sequence = row.frame.sequence;
      if (isOutput(row) && row.frame.sequence === sequence) { failures++; queueMicrotask(() => f.proxy.cut()); return "drop"; } return "forward"; });
    await began(f); const closed = await f.closed(); assertClosedProcesses(f);
    const row = pendingOutput(f); expect(attempts(row)).toHaveLength(3); expect(failures).toBe(3); expect(new Set(attempts(row).map((item) => item.id)).size).toBe(3);
    expect(row.deadline_tick_ms! - attempts(row)[0]!.claimedTickMs).toBe(30000); expect(closed.liveAbort).not.toBeNull(); expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.phase).toBe("failed");
    await pause(80); expect(f.proxy.records.filter((record) => isOutput(record) && record.frame.sequence === sequence)).toHaveLength(3); assertTerminalAfterClosure(f);
    writerObservations.push({ case: "W03-three-claims", row, closed });
  });
});

it("W04 prolonged unqualified reconnect keeps original deadline and cannot send expired output", async () => {
  await withWriter("W04", async (f) => {
    let sequence: number | undefined, disconnected = false;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) { sequence = row.frame.sequence; disconnected = true; queueMicrotask(() => f.proxy.cut()); return "drop"; }
      if (disconnected && row.direction === "down" && row.frame.type === "node.session.ready") return "drop"; return "forward"; });
    await began(f); const closed = await f.closed(); const before = pendingOutput(f); expect(attempts(before)).toHaveLength(1); assertClosedProcesses(f);
    expect(closed.liveAbort).not.toBeNull(); f.proxy.setPolicy();
    await pause(150); expect(f.proxy.records.filter((row) => isOutput(row) && row.frame.sequence === sequence)).toHaveLength(1);
    expect(pendingOutput(f).deadline_tick_ms).toBe(before.deadline_tick_ms); expect(attempts(pendingOutput(f))).toHaveLength(1);
    writerObservations.push({ case: "W04-expired", before, closed, lossDeadline: f.runner.lossDeadlineTickMs, failure: f.runner.failure?.message });
  });
});

it("W05 real ACK held beyond 30s records history after genuine stop without restoring success", async () => {
  await withWriter("W05", async (f) => {
    let sequence: number | undefined;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) sequence = row.frame.sequence; return sequence !== undefined && isAck(row, sequence) ? "hold" : "forward"; });
    await began(f); await until(() => f.proxy.held.some((item) => sequence !== undefined && isAck(item.record, sequence)), "actual generated ACK held");
    const closed = await f.closed(); assertClosedProcesses(f); const originalOutcome = closed.finalOutcomeJson;
    expect(closed.liveAbort).not.toBeNull(); expect(JSON.parse(originalOutcome!).terminal.payload.phase).toBe("failed");
    f.proxy.setPolicy(); f.proxy.release((row) => isAck(row, sequence!)); await until(() => pendingOutput(f).committed === 1, "late historical ACK persisted");
    expect((await f.journal.lookupRun(f.query()))!.finalOutcomeJson).toBe(originalOutcome); expect((await f.journal.lookupRun(f.query()))!.liveAbort).not.toBeNull();
    const row = pendingOutput(f); expect(attempts(row)[0]).toMatchObject({ accepted: true, failure: "receipt_timeout" }); writerObservations.push({ case: "W05-late-real-ack", row, closed });
  });
});

it("W06 completed before correction retains server completed/review and late ACK is historical", async () => {
  await withWriter("W06", async (f) => {
    let sequence: number | undefined;
    f.proxy.setPolicy((row) => { if (isCompleted(row)) sequence = row.frame.sequence; return sequence !== undefined && isAck(row, sequence) ? "hold" : "forward"; });
    await began(f); f.release(); const closed = await f.closed(); const originalOutcome = closed.finalOutcomeJson;
    await until(async () => (await deliveryView(f)).revision === 1, "one genuine delivery correction", 45000);
    await until(async () => (await f.snapshot()).events.some((event) => JSON.stringify(event.payload).includes("incomplete_delivery")), "server retention correction");
    const before = await f.snapshot(); expect(before.run!.status).toBe("completed"); expect(before.task!.status).toBe("review");
    f.proxy.setPolicy(); f.proxy.release((row) => isAck(row, sequence!)); await until(() => f.rows().find((row) => row.sequence === sequence)?.committed === 1, "late completed receipt persisted");
    expect((await f.journal.lookupRun(f.query()))!.finalOutcomeJson).toBe(originalOutcome); expect((await deliveryView(f)).revision).toBe(1);
    expect((await f.snapshot()).run!.status).toBe("completed"); assertTerminalAfterClosure(f); writerObservations.push({ case: "W06-completed-first", closed, view: await deliveryView(f), rows: f.rows(), server: await f.snapshot() });
  });
});

it("W07 correction before held original completed keeps failed/blocked and immutable physical outcome", async () => {
  await withWriter("W07", async (f) => {
    f.proxy.setPolicy((row) => isCompleted(row) ? "hold" : "forward");
    await began(f); f.release(); const closed = await f.closed(); const originalOutcome = closed.finalOutcomeJson;
    await until(async () => (await f.snapshot()).run!.status === "failed", "correction before original completed", 45000);
    expect((await f.snapshot()).task!.status).toBe("blocked"); expect((await deliveryView(f)).revision).toBe(1);
    f.proxy.setPolicy(); f.proxy.release(isCompleted); await until(() => f.rows().some((row) => row.role === "original_terminal" && row.committed === 1), "late completed ACK");
    const after = await f.snapshot(); expect(after.run!.status).toBe("failed"); expect(after.task!.status).toBe("blocked");
    expect((await f.journal.lookupRun(f.query()))!.finalOutcomeJson).toBe(originalOutcome); expect(JSON.parse(originalOutcome!).terminal.payload.phase).toBe("completed");
    expect(f.rows().filter((row) => row.role === "correction_retention")).toHaveLength(1); expect(f.rows().filter((row) => row.role === "correction_terminal")).toHaveLength(1);
    assertTerminalAfterClosure(f); writerObservations.push({ case: "W07-correction-first", closed, server: after, rows: f.rows() });
  });
});

it("W08 explicit local user Stop during reconnect closes the writer and preserves cancellation", async () => {
  await withWriter("W08", async (f) => {
    let lost = false;
    f.proxy.setPolicy((row) => { if (!lost && isOutput(row)) { lost = true; queueMicrotask(() => f.proxy.cut()); return "drop"; }
      if (lost && row.direction === "down" && row.frame.type === "node.session.ready") return "drop"; return "forward"; });
    await began(f); await until(() => f.runner.lossDeadlineTickMs !== undefined, "reconnect wait"); const before = pendingOutput(f);
    await expect(f.runner.requestStop("run_not_owned")).rejects.toThrow(/owned managed run/);
    await f.runner.requestStop(f.payload.run_id); const closed = await f.closed(); assertClosedProcesses(f); expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload).toMatchObject({ phase: "cancelled", reason: "user_cancelled" });
    f.proxy.setPolicy(); await pause(100); expect(pendingOutput(f).deadline_tick_ms).toBe(before.deadline_tick_ms); expect(attempts(pendingOutput(f))).toHaveLength(1);
    expect(f.proxy.records.filter((row) => isOutput(row) && row.frame.sequence === before.sequence)).toHaveLength(1); writerObservations.push({ case: "W08-stop", closed, rows: f.rows() });
  });
});

it("W09 policy-close fatal cause survives distinct post-commit startup rejection and genuine closure", async () => {
  let release!: () => void, committed = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withWriter("W09", async (f) => {
    try {
    await f.begin(); await f.writerReady(); await until(() => committed, "actual recordStarted committed");
    f.proxy.cut(1008); await until(() => f.runner.failure !== undefined, "fatal policy-close latch"); const firstCause = f.runner.failure!.message;
    expect(firstCause).toMatch(/credential\/session was rejected/); release(); const closed = await f.closed(); await f.runner.stop(); assertClosedProcesses(f);
    expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.reason).toBe(firstCause); expect(closed.liveAbort?.message).toBe(firstCause);
    expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.reason).not.toContain("later startup rejection");
    const generation = f.runner.link.diagnostics.generation; await pause(100); expect(f.runner.link.diagnostics.generation).toBe(generation);
    writerObservations.push({ case: "W09-first-cause", label: "actual private WS1008 policy-close/fatal-session injection; no credential revocation claim", firstCause, closed, rows: f.rows() });
    } finally { release(); }
  }, { afterRecordStarted: async () => { committed = true; await gate; throw new Error("distinct later startup rejection"); } });
});

it("W10 shutdown with held genuine receipt joins CLI/guardian closure and retains pending history", async () => {
  await withWriter("W10", async (f) => {
    let sequence: number | undefined;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) sequence = row.frame.sequence; return sequence !== undefined && isAck(row, sequence) ? "hold" : "forward"; });
    await began(f); await until(() => f.proxy.held.length > 0, "held real receipt"); const start = performance.now(); await f.runner.stop();
    const closed = await f.closed(); expect(performance.now() - start).toBeLessThan(15000); assertClosedProcesses(f); expect(f.runner.link.connected).toBe(false);
    const count = f.proxy.records.length; await pause(100); expect(f.proxy.records).toHaveLength(count); expect(f.rows().some((row) => row.committed === 0)).toBe(true);
    writerObservations.push({ case: "W10-shutdown", elapsedMs: performance.now() - start, closed, rows: f.rows(), heldActualReceipts: f.proxy.held.length });
  });
});

it("W11 reopened journal and new Node deliver genuine closed history without another writer", async () => {
  await withWriter("W11", async (f) => {
    f.proxy.setPolicy((row) => isCompleted(row) ? "hold" : "forward");
    await began(f); f.release(); const closed = await f.closed(); await until(() => f.proxy.held.some((item) => isCompleted(item.record)), "actual completed exposure pending");
    const original = closed.finalOutcomeJson;
    // A known transport loss must be durably recorded before stopping the old
    // coordinator. Stopping first intentionally leaves an uncertain old claim;
    // a new worker must not pretend that still-pending claim was safe to retry.
    f.proxy.setPolicy((row) => row.direction === "down" && row.frame.type === "node.session.ready" ? "drop" : "forward");
    f.proxy.cut();
    await until(() => f.rows().some((row) => row.role === "original_terminal" && attempts(row).at(-1)?.failure === "transport_failure"), "genuine closed attempt transport failure committed");
    const before = f.rows(); expect(before.some((row) => row.committed === 0)).toBe(true);
    f.proxy.setPolicy(); await f.reopenClosed(); await f.delivered(); expect(f.launches()).toHaveLength(1); assertClosedProcesses(f);
    expect((await f.journal.lookupRun(f.query()))!.finalOutcomeJson).toBe(original); expect(f.lifetimes.filter((row) => row.role === "cli")).toHaveLength(1);
    for (const row of before) expect(f.rows().find((value) => value.sequence === row.sequence)).toMatchObject({ event_id: row.event_id, content_json: row.content_json, content_sha256: row.content_sha256 });
    writerObservations.push({ case: "W11-closed-reopen", closed, before, after: f.rows(), scope: "same OS process, new worker/incarnation and Node; no daemon adoption/respawn claim" });
  });
});

it("W12 actual control send failure after startup preserves history and never replays command ACK", async () => {
  let armed = true, failedCommand: string | undefined;
  let release!: () => void;
  const programEntry = new Promise<void>((resolve) => { release = resolve; });
  class ControlFailureSocket extends WebSocket {
    override send(data: Parameters<WebSocket["send"]>[0]) { const message = JSON.parse(String(data));
      if (armed && message.kind === "command.ack" && message.status === "accepted") { armed = false; failedCommand = message.command_id; throw new Error("labelled actual socket.send control failure"); } super.send(data); }
  }
  await withWriter("W12", async (f) => {
    try {
    await began(f); release(); const closed = await f.closed(); expect(failedCommand).toBeDefined(); assertClosedProcesses(f);
    expect(closed.receipt!.kind).toBe("process_exit_confirmed"); expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.phase).toBe("failed");
    expect(f.proxy.records.some((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === failedCommand)).toBe(false);
    expect(f.launches()).toHaveLength(1); writerObservations.push({ case: "W12-control-write-fault", label: "Real native socket.send method fault injection, not an external network outage", failedCommand, closed, rows: f.rows() });
    } finally { release(); }
  }, { WebSocketImpl: ControlFailureSocket, afterRecordStarted: () => programEntry });
});

it("W13 genuinely silent writer survives compatible reconnect before unchanged loss deadline", async () => {
  await withWriter("W13", async (f) => {
    await began(f); await until(() => f.rows().some((row) => row.committed === 1), "started committed"); const pid = f.launches()[0]!.pid;
    const root = f.launches()[0]!.rawRoot, before = f.rows(); f.proxy.cut(); await until(() => f.runner.lossDeadlineTickMs !== undefined, "first loss episode"); const lossDeadline = f.runner.lossDeadlineTickMs!;
    await until(() => f.runner.link.connected && f.runner.lossDeadlineTickMs === undefined, "ready and first pong recovery");
    const count = Number(readFileSync(join(root, "alive"), "utf8")); await until(() => Number(readFileSync(join(root, "alive"), "utf8")) > count, "same silent writer continues filesystem heartbeat");
    expect(absent(pid)).toBe(false); expect(f.launches()).toHaveLength(1); expect(f.rows()).toEqual(before); expect(f.runner.failure).toBeUndefined();
    f.release(); await f.closed(); await f.delivered(); expect(f.proxy.records.filter(isOutput)).toHaveLength(0);
    writerObservations.push({ case: "W13-silent-survival", pid, lossDeadline, before, after: f.rows() });
  }, { silent: true });
});

it("W14 silent writer stops at first loss deadline despite repeated heartbeat-write failures", async () => {
  let armed = false, failedWrites = 0;
  class HeartbeatFailureSocket extends WebSocket {
    override send(data: Parameters<WebSocket["send"]>[0]) { const message = JSON.parse(String(data));
      if (armed && message.kind === "node.heartbeat") { failedWrites++; throw new Error("labelled heartbeat socket.send failure"); } super.send(data); }
  }
  await withWriter("W14", async (f) => {
    await began(f); await until(() => f.rows().some((row) => row.committed === 1), "started receipt"); armed = true;
    await until(() => f.runner.lossDeadlineTickMs !== undefined, "heartbeat first loss"); const deadline = f.runner.lossDeadlineTickMs!;
    await until(() => failedWrites >= 2, "unqualified reconnect heartbeat failed"); expect(f.runner.lossDeadlineTickMs).toBe(deadline);
    const closed = await f.closed(); assertClosedProcesses(f); expect(f.runner.failure!.message).toContain("heartbeat");
    expect(JSON.parse(closed.finalOutcomeJson!).terminal.payload.reason).toContain("heartbeat"); expect(f.proxy.records.filter(isOutput)).toHaveLength(0);
    expect(f.runner.lossDeadlineTickMs).toBe(deadline); writerObservations.push({ case: "W14-silent-loss-expiry", deadline, failedWrites, closed, rows: f.rows() });
  }, { silent: true, WebSocketImpl: HeartbeatFailureSocket, heartbeatIntervalMs: 1000 });
});

it("W15 private real WS no-pong proxy expires silent writer without renewing loss grace", async () => {
  await withWriter("W15", async (f) => {
    await began(f); await until(() => f.rows().some((row) => row.committed === 1), "started receipt");
    f.proxy.setPolicy((row) => row.direction === "down" && row.frame.type === "node.session.pong" ? "hold" : "forward");
    await until(() => f.runner.lossDeadlineTickMs !== undefined, "probe timeout starts first loss", 25000); const deadline = f.runner.lossDeadlineTickMs!;
    await until(() => f.proxy.connections.length >= 2 && f.proxy.held.length >= 2, "replacement ready without first pong", 15000); expect(f.runner.lossDeadlineTickMs).toBe(deadline);
    const closed = await f.closed(); assertClosedProcesses(f); expect(f.runner.failure!.message).toMatch(/probe|pong/); expect(f.proxy.records.filter(isOutput)).toHaveLength(0);
    const frames = f.proxy.records.filter((row) => isEvent(row)).length;
    expect(() => f.proxy.release((row) => row.generation === 1 && row.frame.type === "node.session.pong")).toThrow(/closed/);
    await pause(80); expect(f.proxy.records.filter((row) => isEvent(row))).toHaveLength(frames); expect(f.runner.link.connected).toBe(false); expect(f.runner.lossDeadlineTickMs).toBe(deadline);
    writerObservations.push({ case: "W15-no-pong", label: "Private loopback transparent proxy; no OS/global network manipulation", deadline, heldPongs: f.proxy.held.length, closed, rows: f.rows() });
  }, { silent: true });
});

it("W16 actual live journal loss then new managed WS Node keeps nonclosed ownership unknown", async () => {
  await withWriter("W16", async (f) => {
    let sequence: number | undefined;
    f.proxy.setPolicy((row) => { if (isOutput(row) && sequence === undefined) sequence = row.frame.sequence; return sequence !== undefined && isAck(row, sequence) ? "hold" : "forward"; });
    await began(f); await until(() => f.proxy.held.length > 0, "genuine committed receiver ACK held");
    const before = await f.journal.lookupRun(f.query()); expect(before).toMatchObject({ phase: "started", receipt: { kind: "accepted" }, finalOutcomeJson: null });
    await f.journal.close(); f.proxy.setPolicy(); f.proxy.release((row) => isAck(row, sequence!));
    await until(() => f.physical().filter((row) => row.role !== "git").every((row) => row.childAbsent && row.groupAbsent && row.stdioCloseObserved), "original captured writer stopped despite journal loss");
    const nextGeneration = f.proxy.connections.length + 1;
    const unknown = await f.reopenUnknown(); assertClosedProcesses(f);
    await until(() => f.proxy.records.some((row) => row.generation >= nextGeneration && row.direction === "up" && row.frame.kind === "command.ack" && row.frame.status === "rejected" && row.frame.message?.includes("ownership remains unknown")), "actual new WS Node rejects nonclosed resume");
    await expect(f.runner.requestStop(f.payload.run_id)).rejects.toThrow(/owned managed run/);
    expect(f.launches()).toHaveLength(1); expect(f.lifetimes.filter((row) => row.role === "cli")).toHaveLength(1);
    expect(f.proxy.records.filter((row) => isEvent(row, "run.lifecycle") && row.frame.event.payload.phase !== "started")).toHaveLength(0);
    expect(await f.journal.lookupRun(f.query())).toMatchObject({ phase: "started", ownership: "unknown", finalOutcomeJson: null, receipt: { kind: "accepted" } });
    writerObservations.push({ case: "W16-nonclosed-restart", before, unknown, rows: f.rows(), actualNewWsGeneration: nextGeneration,
      scope: "Real closed worker/new journal incarnation and new Node through real compatible WS; original actual process stopped by its captured authority; no durable terminal manufactured, no adoption, no respawn" });
  });
});

afterAll(() => { const directory = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR; if (!directory) throw new Error("Reviewed owned harness required"); writeFileSync(join(directory, "writer-observations.json"), JSON.stringify(writerObservations, null, 2)); });
