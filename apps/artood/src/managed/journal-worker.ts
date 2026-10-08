import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertBoundary, beginProvision, finishProvision, openBoundary, syncDatabase,
  type Boundary, type Marker } from "./journal-boundary.js";
import { readDeliveryClock, type DeliveryClock } from "./journal-clock.js";
import type { ClosedRunDeliveryView, LiveDeliveryAbort, LiveDeliveryView, DeliveryCorrection, DeliveryFailureReason, DurableReceipt, JournalLocation, JournalRun, StoredEvent } from "./journal-types.js";

// Private worker protocol. No public API accepts a serialized physical proof.
// The facade authenticates the real producer object before this private channel.
type Command = { id: string; controlKey: string; op: string; input: Record<string, unknown> };
interface Boot extends JournalLocation { action: "provision" | "open"; expectedNamespace?: string; controlKey: string }
interface RunRow {
  namespace: string; run_id: string; mode: JournalRun["mode"]; launch_key: string | null;
  canonical_payload: string | null; owner_nonce: string | null; owner_incarnation: string | null;
  revision: number; phase: JournalRun["phase"]; stop_requested: number; next_sequence: number;
  receipt_id: string | null; final_outcome_json: string | null;
  delivery_revision: 0 | 1; delivery_state: ClosedRunDeliveryView["state"]; delivery_correction_json: string | null;
  delivery_clock_unknown: number; live_abort_json: string | null; committed_count: number; superseded_count: number;
}
interface ReceiptRow { id: string; namespace: string; node_id: string; run_id: string; launch_key: string | null;
  owner_revision: number; kind: DurableReceipt["kind"]; content_json: string }
interface EventRow { namespace: string; node_id: string; run_id: string; sequence: number; event_id: string;
  content_json: string; content_sha256: string; committed: number;
  role: StoredEvent["role"]; superseded: number; attempts_json: string; deadline_tick_ms: number | null; clock_id: string | null; exhausted: number }
interface Attempt { id: string; revision: 0 | 1; claimedTickMs: number; failure: DeliveryFailureReason | null; accepted: boolean }
const boot = workerData as Boot;
const incarnation = randomUUID();
const applicationId = 0x4152544f;
const codec = "run-start-schema-json-v1";
let database: DatabaseSync | undefined, boundary: Boundary | undefined, marker: Marker;
let unavailable = false;
let deliveryClock: DeliveryClock | null = null;
const maxSequence = 2 ** 31 - 1, maxBacklog = 10000, receiptWindowMs = 30000, maxAttempts = 3;
// Wait only inside SQLite; never replay a transaction after an uncertain commit.
const busyTimeoutMs = 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const string = (value: unknown): string => { if (typeof value !== "string") throw new Error("Invalid internal journal text"); return value; };
const number = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid internal journal integer"); return Number(value); };
const row = <T>(sql: string, ...args: SQLInputValue[]): T | undefined => database!.prepare(sql).get(...args) as T | undefined;
const rows = <T>(sql: string, ...args: SQLInputValue[]): T[] => database!.prepare(sql).all(...args) as T[];
const write = (sql: string, ...args: SQLInputValue[]) => database!.prepare(sql).run(...args);
const pragma = (name: string): string | number => Object.values(database!.prepare(`PRAGMA ${name}`).get()!)[0] as string | number;

function configure(provision: boolean): Record<string, string | number> {
  if (provision) database!.exec("PRAGMA journal_mode=DELETE");
  if (pragma("journal_mode") !== "delete") throw new Error("Unsupported journal mode; no automatic conversion");
  database!.exec(`PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=${busyTimeoutMs}`);
  const settings = Object.fromEntries(["journal_mode", "synchronous", "fullfsync", "foreign_keys", "trusted_schema", "busy_timeout"].map((name) => [name, pragma(name)]));
  if (settings["synchronous"] !== 3 || settings["fullfsync"] !== 1 || settings["foreign_keys"] !== 1
    || settings["trusted_schema"] !== 0 || settings["busy_timeout"] !== busyTimeoutMs) throw new Error("Required SQLite pragmas were not applied");
  return settings;
}
function assertMetadata(): void {
  const meta = row<{ namespace: string; controller_scope: string; node_id: string; codec: string; version: number }>("SELECT * FROM journal_meta WHERE id=1");
  if (!meta || meta.namespace !== marker.namespace || meta.controller_scope !== marker.controllerScope
    || meta.node_id !== marker.nodeId || meta.codec !== codec || meta.version !== 3
    || pragma("application_id") !== applicationId || pragma("user_version") !== 3) {
    throw new Error("Journal metadata continuity failed; Older-schema delivery history is unknown and is not migrated/reset");
  }
}
function transaction<T>(operation: () => T): T {
  assertBoundary(boundary!); assertMetadata();
  let committed = false;
  try {
    database!.exec("BEGIN IMMEDIATE");
    const value = operation();
    database!.exec("COMMIT"); committed = true;
    assertBoundary(boundary!); assertMetadata();
    return value;
  } catch (error) {
    if (!committed) { try { database!.exec("ROLLBACK"); } catch { /* No successful commit is inferred. */ } }
    throw error;
  }
}
function run(runId: string): RunRow | undefined {
  return row<RunRow>("SELECT * FROM runs WHERE namespace=? AND run_id=?", marker.namespace, runId);
}
function receipt(receiptId: string | null): DurableReceipt | null {
  if (receiptId === null) return null;
  const value = row<ReceiptRow>("SELECT * FROM receipts WHERE id=?", receiptId);
  if (!value) throw new Error("Journal receipt reference is missing");
  return { id: value.id, namespace: value.namespace, nodeId: value.node_id, runId: value.run_id,
    launchKey: value.launch_key, ownerRevision: value.owner_revision, kind: value.kind, contentJson: value.content_json };
}
function view(value: RunRow): JournalRun {
  const recorded = receipt(value.receipt_id);
  if (value.phase === "closed" && (!recorded || recorded.kind === "accepted")) throw new Error("Closed journal row lacks its durable fence receipt");
  if (recorded?.kind === "process_exit_confirmed") {
    if (!value.final_outcome_json || !value.launch_key) throw new Error("Physical closure lacks a durable terminal outcome");
    const outcome = JSON.parse(value.final_outcome_json) as { retained: unknown; terminal: unknown };
    const expected = [JSON.stringify(outcome.retained), JSON.stringify(outcome.terminal)];
    for (const [index, suffix] of ["retained", "terminal"].entries()) {
      const saved = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND event_id=?", value.namespace, value.run_id, `sys:settlement:${value.launch_key}:${suffix}`);
      if (!saved || saved.content_json !== expected[index]) throw new Error("Physical closure lacks an exact required terminal event");
      event(saved);
    }
  }
  return { namespace: value.namespace, runId: value.run_id, mode: value.mode, launchKey: value.launch_key,
    revision: value.revision, phase: value.phase, stopRequested: value.stop_requested === 1,
    ownership: value.phase === "closed" ? "fenced" : value.owner_incarnation === incarnation ? "local_claim" : "unknown",
    receipt: recorded, finalOutcomeJson: value.final_outcome_json, liveAbort: liveAbort(value) };
}
function owned(input: Record<string, unknown>): RunRow {
  const value = run(string(input["runId"]));
  if (!value || value.owner_incarnation !== incarnation || value.owner_nonce !== input["nonce"] || value.launch_key !== input["key"]) {
    throw new Error("Journal mutation lacks this process's exact fresh claim");
  }
  return value;
}
function insertReceipt(value: RunRow, kind: DurableReceipt["kind"], detail: unknown): DurableReceipt {
  const id = randomUUID();
  const contentJson = JSON.stringify({ version: 1, namespace: marker.namespace, nodeId: marker.nodeId,
    runId: value.run_id, launchKey: value.launch_key, ownerRevision: value.revision, kind, detail });
  write("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?)", id, marker.namespace, marker.nodeId,
    value.run_id, value.launch_key, value.revision, kind, contentJson);
  write("UPDATE runs SET receipt_id=? WHERE namespace=? AND run_id=?", id, marker.namespace, value.run_id);
  return receipt(id)!;
}
function event(value: EventRow): StoredEvent {
  if (digest(value.content_json) !== value.content_sha256) throw new Error("Journal event content digest differs");
  return { namespace: value.namespace, nodeId: value.node_id, runId: value.run_id, sequence: value.sequence,
    eventId: value.event_id, contentJson: value.content_json, contentSha256: value.content_sha256, committed: value.committed === 1,
    role: value.role, superseded: value.superseded === 1 };
}
// Active backlog is bounded even when committed live history grows.
function runEvents(runId: string): EventRow[] {
  const active = rows<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND committed=0 AND superseded=0 ORDER BY sequence LIMIT ?", marker.namespace, runId, maxBacklog + 1);
  if (active.length > maxBacklog) throw new Error("Active outbox bound exceeded");
  const current = run(runId);
  const original = ["retained", "terminal"].flatMap((suffix) => {
    if (!current?.launch_key || current.phase !== "closed") return [];
    const saved = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND event_id=?", marker.namespace, runId, `sys:settlement:${current.launch_key}:${suffix}`);
    return saved ? [saved] : [];
  });
  return [...new Map([...active, ...original].map((e) => [e.sequence,e])).values()].sort((a,b) => a.sequence-b.sequence);
}
function attempts(value: EventRow): Attempt[] {
  const saved = JSON.parse(value.attempts_json) as Attempt[];
  if (!Array.isArray(saved) || saved.length > maxAttempts || new Set(saved.map((a) => a.id)).size !== saved.length
    || saved.some((a) => !a.id || !Number.isSafeInteger(a.claimedTickMs) || a.claimedTickMs < 0 || ![0, 1].includes(a.revision)
      || typeof a.accepted !== "boolean" || (a.failure !== null && !["rejected", "transport_failure", "receipt_timeout"].includes(a.failure)))
    || (saved.length > 0 && (value.clock_id === null || value.deadline_tick_ms === null))) throw new Error("Invalid durable delivery attempt history");
  return saved;
}
function closedRun(input: Record<string, unknown>): RunRow {
  const value = run(string(input["runId"]));
  if (!value || value.phase !== "closed" || value.mode !== "per-run" || value.launch_key !== input["key"]
    || value.receipt_id !== input["physicalReceiptId"] || view(value).receipt?.kind !== "process_exit_confirmed") {
    throw new Error("Closed-run delivery requires an exact durable physical settlement, key and receipt");
  }
  return value;
}
function correction(value: RunRow): DeliveryCorrection | null {
  const saved = value.delivery_correction_json === null ? null : JSON.parse(value.delivery_correction_json) as DeliveryCorrection;
  if ((saved === null) !== (value.delivery_revision === 0)) throw new Error("Delivery correction revision differs");
  if (saved) {
    if (saved.id !== `sys:delivery:${value.receipt_id}:correction:1` || saved.physicalReceiptId !== value.receipt_id || saved.revision !== 1) throw new Error("Delivery correction identity differs");
    for (const [role, identity] of [["correction_retention", saved.retention], ["correction_terminal", saved.terminal]] as const) {
      const savedEvent = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND sequence=?", marker.namespace, value.run_id, identity.sequence);
      if (!savedEvent || savedEvent.role !== role || savedEvent.event_id !== identity.eventId || savedEvent.content_sha256 !== identity.contentSha256) throw new Error("Incomplete atomic delivery correction");
      event(savedEvent);
    }
  }
  return saved;
}
function clockHealthy(events: readonly EventRow[]): boolean {
  return deliveryClock !== null && events.every((e) => e.committed || e.superseded || e.clock_id === null || e.clock_id === deliveryClock!.id);
}
function deliveryView(value: RunRow): ClosedRunDeliveryView {
  const saved = correction(value), events = runEvents(value.run_id), active = events.filter((e) => !e.committed && !e.superseded);
  for (const e of events) { event(e); attempts(e); }
  if (active.length > 0 && !clockHealthy(active)) {
    write("UPDATE runs SET delivery_clock_unknown=1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
    value.delivery_clock_unknown = 1;
  }
  const state = active.length === 0 ? "delivered" : value.delivery_clock_unknown || active.every((e) => e.exhausted) ? "blocked"
    : saved ? "correcting" : "pending";
  write("UPDATE runs SET delivery_state=? WHERE namespace=? AND run_id=?", state, marker.namespace, value.run_id);
  return { revision: value.delivery_revision, state, originalOutcomeJson: value.final_outcome_json!, physicalReceiptId: value.receipt_id!, correction: saved,
    committed: value.committed_count, superseded: value.superseded_count, outstanding: active.length,
    possibleCompletedExposure: events.some((e) => e.role === "original_terminal" && attempts(e).length > 0
      && JSON.parse(e.content_json).payload.phase === "completed") };
}
function persistAttempts(value: EventRow, saved: Attempt[], exhausted?: number): void {
  if (exhausted === undefined) write("UPDATE outbox SET attempts_json=? WHERE namespace=? AND run_id=? AND sequence=?", JSON.stringify(saved), marker.namespace, value.run_id, value.sequence);
  else write("UPDATE outbox SET attempts_json=?, exhausted=? WHERE namespace=? AND run_id=? AND sequence=?", JSON.stringify(saved), exhausted, marker.namespace, value.run_id, value.sequence);
}
function commitEvent(value: EventRow): void {
  const changed = Number(write("UPDATE outbox SET committed=1 WHERE namespace=? AND run_id=? AND sequence=? AND committed=0", marker.namespace, value.run_id, value.sequence).changes);
  if (changed === 1) write("UPDATE runs SET committed_count=committed_count+1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
}
function createCorrection(value: RunRow, trigger: EventRow, attempt: Attempt, reason: DeliveryFailureReason): void {
  if (value.delivery_revision !== 0) return;
  const original = JSON.parse(value.final_outcome_json!) as { retained: { type: string; payload: { version: number; workspace_root: string; workspace_branch: string; outcome: string } }; terminal: { payload: { phase: string } } };
  if (original.terminal.payload.phase !== "completed") return;
  const pending = runEvents(value.run_id).filter((e) => !e.committed && !e.superseded).length;
  if (pending > maxBacklog - 2 || value.next_sequence > maxSequence - 1) throw new Error("Reserved correction capacity/sequence is unavailable");
  const id = `sys:delivery:${value.receipt_id}:correction:1`;
  const contents = [JSON.stringify({ ...original.retained, payload: { ...original.retained.payload, outcome: "incomplete_delivery" } }),
    JSON.stringify({ type: "run.lifecycle", payload: { phase: "failed", reason: "incomplete_delivery" } })];
  const identities = contents.map((content, index) => {
    const eventId = `${id}:${index === 0 ? "retained" : "terminal"}`, sequence = value.next_sequence + index, contentSha256 = digest(content);
    write("INSERT INTO outbox (namespace,node_id,run_id,sequence,event_id,content_json,content_sha256,committed,role) VALUES(?,?,?,?,?,?,?,0,?)",
      marker.namespace, marker.nodeId, value.run_id, sequence, eventId, content, contentSha256, index === 0 ? "correction_retention" : "correction_terminal");
    return { eventId, sequence, contentSha256 };
  });
  const saved: DeliveryCorrection = { id, revision: 1, physicalReceiptId: value.receipt_id!,
    trigger: { sequence: trigger.sequence, attemptId: attempt.id, reason }, retention: identities[0]!, terminal: identities[1]! };
  // Preserve all original bytes, exposure/ACK history and physical/start fences.
  // Returned or in-flight frames cannot be recalled by this local transaction.
  // Indexed active range is bounded by maxBacklog. Already-ACKed original
  // settlement rows are then reached through their unique event identities.
  let superseded = Number(write("UPDATE outbox SET superseded=1 WHERE namespace=? AND run_id=? AND committed=0 AND superseded=0 AND sequence<?", marker.namespace, value.run_id, value.next_sequence).changes);
  for (const suffix of ["retained", "terminal"]) superseded += Number(write("UPDATE outbox SET superseded=1 WHERE namespace=? AND run_id=? AND event_id=? AND superseded=0", marker.namespace, value.run_id, `sys:settlement:${value.launch_key}:${suffix}`).changes);
  write("UPDATE runs SET superseded_count=superseded_count+? WHERE namespace=? AND run_id=?", superseded, marker.namespace, value.run_id);
  write("UPDATE runs SET delivery_revision=1, delivery_state='correcting', delivery_correction_json=?, next_sequence=next_sequence+2 WHERE namespace=? AND run_id=?",
    JSON.stringify(saved), marker.namespace, value.run_id);
}
function failAttempt(value: RunRow, target: EventRow, saved: Attempt[], attempt: Attempt, reason: DeliveryFailureReason, now: number): void {
  if (reason === "receipt_timeout" && (target.clock_id !== deliveryClock?.id || target.deadline_tick_ms === null || now < target.deadline_tick_ms)) throw new Error("A receipt timeout requires the original elapsed monotonic deadline");
  if (target.committed || attempt.accepted) return;
  if (attempt.failure === null) attempt.failure = reason;
  const completedPath = value.delivery_revision === 0 && JSON.parse(value.final_outcome_json!).terminal.payload.phase === "completed";
  const exhausted = (reason === "rejected" && completedPath) || now >= target.deadline_tick_ms!
    || (saved.length >= maxAttempts && saved.every((a) => a.failure !== null || a.accepted)) ? 1 : target.exhausted;
  persistAttempts(target, saved, exhausted);
  if (!target.superseded && exhausted) createCorrection(value, target, attempt, reason);
}
function liveAbort(value: RunRow): LiveDeliveryAbort | null {
  return value.live_abort_json === null ? null : JSON.parse(value.live_abort_json) as LiveDeliveryAbort;
}
function liveView(value: RunRow): LiveDeliveryView {
  return { state: value.live_abort_json || value.stop_requested ? "stop_required" : "pending", abort: liveAbort(value) };
}
function latchAbort(value: RunRow, cause: LiveDeliveryAbort): LiveDeliveryView {
  if (!value.live_abort_json) write("UPDATE runs SET live_abort_json=?, stop_requested=1 WHERE namespace=? AND run_id=?",
    JSON.stringify(cause), marker.namespace, value.run_id);
  return liveView(run(value.run_id)!);
}
function executeLive(op: string, input: Record<string, unknown>): unknown {
  const value = owned(input);
  if (op === "live_receipt" && value.phase === "closed") {
    // A late same-owner callback can cross the settlement await. Recheck the
    // durable physical scope and exact claim through the closed receipt path;
    // this grants no new live claim or execution authority.
    executeDelivery("delivery_receipt", { ...input, physicalReceiptId: value.receipt_id });
    return liveView(run(value.run_id)!);
  }
  if (value.mode !== "per-run" || value.phase === "closed") throw new Error("Live delivery requires this current fresh owner before physical settlement");
  if (op === "live_abort") return latchAbort(value, input["cause"] as unknown as LiveDeliveryAbort);
  if (value.phase !== "started" || receipt(value.receipt_id)?.kind !== "accepted") throw new Error("Live delivery requires authenticated durable startup");
  const active = runEvents(value.run_id), healthy = !value.delivery_clock_unknown && clockHealthy(active);
  const now = healthy ? deliveryClock!.tickMs() : 0;
  if (op === "live_receipt" || op === "live_failure") {
    const target = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND sequence=?", marker.namespace, value.run_id, number(input["sequence"]));
    if (!target || target.role !== "event") throw new Error("Live receipt event is missing");
    event(target); const saved = attempts(target), attempt = saved.find((a) => a.id === input["attemptId"]);
    if (!attempt || (op === "live_receipt" && target.content_sha256 !== input["hash"])) throw new Error("Live receipt lacks an exact durable claim");
    if (!healthy) {
      write("UPDATE runs SET delivery_clock_unknown=1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
      latchAbort(value, { code: "clock_unknown", message: "Live delivery clock continuity is unknown", sequence: target.sequence, attemptId: attempt.id });
    }
    const expired = healthy && target.deadline_tick_ms !== null && now >= target.deadline_tick_ms;
    if (!target.committed && expired) latchAbort(run(value.run_id)!, { code: "receipt_timeout", message: "Live event receipt deadline expired", sequence: target.sequence, attemptId: attempt.id });
    if (op === "live_receipt" && input["status"] === "accepted") {
      attempt.accepted = true; persistAttempts(target, saved);
      commitEvent(target);
      return liveView(run(value.run_id)!);
    }
    if (target.committed || attempt.accepted) return liveView(run(value.run_id)!);
    const reason = op === "live_receipt" ? "rejected" : string(input["reason"]) as DeliveryFailureReason;
    if (reason === "receipt_timeout" && healthy && !expired) throw new Error("Live timeout requires its original elapsed deadline");
    if (attempt.failure === null) attempt.failure = reason;
    const exhausted = expired || reason === "rejected" || (saved.length >= maxAttempts && saved.every((a) => a.failure !== null || a.accepted));
    persistAttempts(target, saved, exhausted ? 1 : target.exhausted);
    if (exhausted) latchAbort(run(value.run_id)!, { code: reason, message: "Live event delivery failed", sequence: target.sequence, attemptId: attempt.id });
    return liveView(run(value.run_id)!);
  }
  if (op !== "live_claim") throw new Error("Unsupported live operation");
  if (value.live_abort_json || value.stop_requested) return { kind: "stop_required", view: liveView(value) };
  if (!healthy) {
    write("UPDATE runs SET delivery_clock_unknown=1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
    return { kind: "stop_required", view: latchAbort(value, { code: "clock_unknown", message: "Live delivery clock continuity is unknown" }) };
  }
  const target = active.find((e) => !e.committed && !e.superseded);
  if (!target) return { kind: "waiting", view: liveView(value) };
  if (target.role !== "event") throw new Error("Terminal event cannot enter live delivery");
  event(target); const saved = attempts(target), last = saved.at(-1);
  if (target.exhausted || (target.deadline_tick_ms !== null && now >= target.deadline_tick_ms)) {
    return { kind: "stop_required", view: latchAbort(value, { code: "receipt_timeout", message: "Live event delivery budget expired", sequence: target.sequence, ...(last ? { attemptId: last.id } : {}) }) };
  }
  if (last && last.failure === null && !last.accepted) return { kind: "waiting", view: { ...liveView(value), state: "waiting" } };
  if (saved.length >= maxAttempts) return { kind: "stop_required", view: latchAbort(value, { code: "attempt_budget", message: "Live event attempt budget exhausted", sequence: target.sequence }) };
  const deadline = target.deadline_tick_ms ?? now + receiptWindowMs;
  const attempt: Attempt = { id: randomUUID(), revision: 0, claimedTickMs: now, failure: null, accepted: false }; saved.push(attempt);
  write("UPDATE outbox SET attempts_json=?, deadline_tick_ms=?, clock_id=? WHERE namespace=? AND run_id=? AND sequence=?", JSON.stringify(saved), deadline, deliveryClock!.id, marker.namespace, value.run_id, target.sequence);
  return { kind: "claimed", event: event(target), attemptId: attempt.id, revision: 0, clockId: deliveryClock!.id, deadlineTickMs: deadline };
}
function executeDelivery(op: string, input: Record<string, unknown>): unknown {
  let value = closedRun(input);
  correction(value);
  if (op === "delivery_inspect") return deliveryView(value);
  if (op === "delivery_receipt" || op === "delivery_failure") {
    const attemptId = string(input["attemptId"]), events = runEvents(value.run_id);
    const target = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND sequence=?", marker.namespace, value.run_id, number(input["sequence"]));
    if (!target || !attempts(target).some((a) => a.id === attemptId)) throw new Error("Receipt/failure has no exact durable claimed attempt");
    event(target);
    const saved = attempts(target), attempt = saved.find((a) => a.id === attemptId)!;
    if (op === "delivery_receipt" && (target.sequence !== input["sequence"] || target.content_sha256 !== input["hash"])) throw new Error("Receipt identity differs from its durable claimed event");
    if (op === "delivery_receipt" && input["status"] === "accepted") {
      // An accepted old legitimate attempt is historical evidence even after
      // its local timeout/correction. It cannot change supersession/revision.
      const healthy = !value.delivery_clock_unknown && clockHealthy(events);
      if (!healthy) deliveryView(value); // Latch unknown before ACK removes an old-clock pending row.
      else if (!target.committed && !target.superseded && target.deadline_tick_ms !== null
        && deliveryClock!.tickMs() >= target.deadline_tick_ms) {
        // Receipt arrival ordering after restart cannot revive an expired
        // success path. Record the correction before this historical ACK.
        failAttempt(value, target, saved, attempt, "receipt_timeout", deliveryClock!.tickMs());
      }
      attempt.accepted = true; persistAttempts(target, saved);
      commitEvent(target);
      return deliveryView(run(value.run_id)!);
    }
    if (value.delivery_clock_unknown || !clockHealthy(events)) return deliveryView(value);
    const reason = op === "delivery_receipt" ? "rejected" : string(input["reason"]) as DeliveryFailureReason;
    failAttempt(value, target, saved, attempt, reason, deliveryClock!.tickMs());
    return deliveryView(run(value.run_id)!);
  }
  if (op !== "delivery_claim") throw new Error("Unsupported closed-run delivery operation");
  let events = runEvents(value.run_id);
  // All obligations may have historical accepted receipts after clock blocking.
  // Completion grants no send and does not reset the durable clock latch.
  if (events.every((e) => e.committed || e.superseded)) return { kind: "complete", reason: "delivered", view: deliveryView(value) };
  if (value.delivery_clock_unknown || !clockHealthy(events)) return { kind: "blocked", reason: "clock_continuity_unknown", view: deliveryView(value) };
  const now = deliveryClock!.tickMs();
  for (const target of events) {
    if (target.committed || target.superseded || target.exhausted || target.deadline_tick_ms === null || now < target.deadline_tick_ms) continue;
    const saved = attempts(target), attempt = saved.at(-1);
    if (!attempt) throw new Error("Deadline has no claimed attempt");
    const previousRevision = value.delivery_revision;
    failAttempt(value, target, saved, attempt, "receipt_timeout", now);
    value = run(value.run_id)!;
    if (previousRevision === 0 && value.delivery_revision === 1) break;
  }
  events = runEvents(value.run_id);
  const active = events.filter((e) => !e.committed && !e.superseded), originalCompleted = JSON.parse(value.final_outcome_json!).terminal.payload.phase === "completed";
  const successPath = originalCompleted && value.delivery_revision === 0;
  // Non-success metadata gets an initial attempt before its terminal. After a
  // failed attempt, let the failure terminal proceed and retry metadata later.
  const ordered = successPath ? active : [...active].sort((a, b) => {
    const priority = (e: EventRow) => attempts(e).at(-1)?.failure !== null && attempts(e).length > 0 ? 1 : 0;
    return priority(a) - priority(b) || a.sequence - b.sequence;
  });
  for (const target of ordered) {
    const saved = attempts(target), last = saved.at(-1);
    if (target.exhausted) continue;
    if (last && last.failure === null && !last.accepted) {
      return { kind: "waiting", reason: "awaiting_existing_attempt", view: deliveryView(value) };
    }
    if (target.role === "original_terminal" && successPath) {
      const retention = events.find((e) => e.role === "original_retention");
      if (!retention?.committed) return { kind: "waiting", reason: "completed_retention_not_accepted", view: deliveryView(value) };
    }
    if (saved.length >= maxAttempts) throw new Error("Delivery attempt budget differs from exhaustion state");
    const deadline = target.deadline_tick_ms ?? now + receiptWindowMs;
    if (deadline <= now) throw new Error("Expired delivery cannot receive a new claim");
    const attempt: Attempt = { id: randomUUID(), revision: value.delivery_revision, claimedTickMs: now, failure: null, accepted: false };
    saved.push(attempt);
    write("UPDATE outbox SET attempts_json=?, deadline_tick_ms=?, clock_id=? WHERE namespace=? AND run_id=? AND sequence=?", JSON.stringify(saved), deadline, deliveryClock!.id, marker.namespace, value.run_id, target.sequence);
    return { kind: "claimed", event: event(target), attemptId: attempt.id, revision: value.delivery_revision, clockId: deliveryClock!.id, deadlineTickMs: deadline };
  }
  const state = deliveryView(value);
  return { kind: state.state === "delivered" ? "complete" : state.state === "blocked" ? "blocked" : "waiting", reason: state.state, view: state };
}
function execute(op: string, input: Record<string, unknown>): unknown {
  if (op === "lookup") {
    assertBoundary(boundary!); assertMetadata();
    const value = run(string(input["runId"])), result = value ? view(value) : null;
    assertBoundary(boundary!); return result;
  }
  if (op === "admit") return transaction(() => {
    const runId = string(input["runId"]), existing = run(runId);
    if (existing) {
      const record = view(existing);
      if (existing.launch_key !== null && (existing.launch_key !== input["key"] || (existing.mode !== "fenced" && existing.mode !== input["mode"]))) return { kind: "conflict", run: record };
      if (existing.phase === "closed") return { kind: "fenced", run: record };
      if (existing.owner_incarnation !== incarnation) return { kind: "unknown", run: record };
      return { kind: existing.receipt_id ? "replay" : "pending", run: record };
    }
    write("INSERT INTO runs (namespace,run_id,mode,launch_key,canonical_payload,owner_nonce,owner_incarnation,revision,phase,stop_requested,next_sequence,receipt_id,final_outcome_json) VALUES (?,?,?,?,?,?,?,1,'admitted',0,0,NULL,NULL)", marker.namespace, runId,
      string(input["mode"]), string(input["key"]), string(input["canonical"]), string(input["nonce"]), incarnation);
    return { kind: "fresh", run: view(run(runId)!) };
  });
  if (op === "advance") return transaction(() => {
    const value = owned(input), phase = string(input["phase"]);
    const next = value.phase === "admitted" ? "preparing" : value.phase === "preparing" ? "launch_intent" : undefined;
    if (value.stop_requested || value.revision !== input["revision"] || next !== phase) return { kind: "blocked", run: view(value) };
    write("UPDATE runs SET phase=?, revision=revision+1 WHERE namespace=? AND run_id=?", phase, marker.namespace, value.run_id);
    return { kind: "advanced", run: view(run(value.run_id)!) };
  });
  if (op === "stop") return transaction(() => {
    const runId = string(input["runId"]), value = run(runId), key = input["key"] === undefined ? null : string(input["key"]);
    if (!value) {
      write("INSERT INTO runs (namespace,run_id,mode,launch_key,canonical_payload,owner_nonce,owner_incarnation,revision,phase,stop_requested,next_sequence,receipt_id,final_outcome_json) VALUES (?,?,'fenced',?,NULL,NULL,NULL,1,'closed',1,0,NULL,NULL)", marker.namespace, runId, key);
      insertReceipt(run(runId)!, key === null ? "run_fenced_unbound" : "not_started_fenced", { scope: "run-wide-permanent-fence" });
    } else {
      if (key !== null && value.launch_key !== null && key !== value.launch_key) return { kind: "conflict", run: view(value) };
      if (!value.stop_requested) write("UPDATE runs SET stop_requested=1, revision=revision+1 WHERE namespace=? AND run_id=?", marker.namespace, runId);
    }
    return { kind: "stopped_intent", run: view(run(runId)!) };
  });
  if (op === "started") return transaction(() => {
    const value = owned(input);
    if (value.phase !== "launch_intent") return { kind: "blocked", run: view(value) };
    write("UPDATE runs SET phase='started', revision=revision+1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
    insertReceipt(run(value.run_id)!, "accepted", { observation: "authenticated producer handle; historical startup only" });
    return { kind: "recorded", run: view(run(value.run_id)!) };
  });
  if (op === "producer_closed") return transaction(() => {
    const value = owned(input), outcome = string(input["outcome"]);
    if (value.live_abort_json && JSON.parse(outcome).terminal.payload.phase === "completed") throw new Error("Live delivery abort forbids completed settlement");
    if (value.phase === "closed") {
      if (value.final_outcome_json !== outcome) throw new Error("An immutable terminal settlement already differs");
      return view(value);
    }
    if (input["proofSource"] === "returned_handle" ? value.phase !== "started"
      : input["proofSource"] === "startup_error" ? value.phase !== "launch_intent" : true) throw new Error("Physical settlement has no corresponding owned producer stage");
    const contents = input["eventContents"];
    if (!Array.isArray(contents) || contents.length !== 2 || contents.some((item) => typeof item !== "string")) throw new Error("Two required terminal event contents are necessary");
    const pending = row<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE namespace=? AND run_id=? AND committed=0 AND superseded=0", marker.namespace, value.run_id)!.count;
    if (pending > maxBacklog - 4 || value.next_sequence > maxSequence - 3) throw new Error("Required terminal events cannot be durably allocated");
    const identities = [];
    for (const [index, suffix] of ["retained", "terminal"].entries()) {
      const eventId = `sys:settlement:${value.launch_key}:${suffix}`, content = string(contents[index]), sequence = value.next_sequence + index;
      write("INSERT INTO outbox (namespace,node_id,run_id,sequence,event_id,content_json,content_sha256,committed,role) VALUES (?,?,?,?,?,?,?,0,?)", marker.namespace, marker.nodeId, value.run_id, sequence, eventId, content, digest(content), index === 0 ? "original_retention" : "original_terminal");
      identities.push({ eventId, sequence, contentSha256: digest(content) });
    }
    write("UPDATE runs SET phase='closed', stop_requested=1, revision=revision+1, next_sequence=next_sequence+2, final_outcome_json=? WHERE namespace=? AND run_id=?", outcome, marker.namespace, value.run_id);
    insertReceipt(run(value.run_id)!, "process_exit_confirmed", { producer: input["detail"], proofSource: input["proofSource"], outcome: JSON.parse(outcome), events: identities });
    return view(run(value.run_id)!);
  });
  if (op === "append") return transaction(() => {
    const value = owned(input), eventId = string(input["eventId"]), content = string(input["content"]);
    const prior = row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND event_id=?", marker.namespace, value.run_id, eventId);
    if (prior) return { kind: prior.content_json === content ? "stored" : "conflict", event: event(prior), revision: value.revision };
    const count = row<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE namespace=? AND run_id=? AND committed=0 AND superseded=0", marker.namespace, value.run_id)!.count;
    if (value.phase === "closed" || value.live_abort_json) return { kind: "closed_or_aborted" };
    if (count >= maxBacklog - 4 || value.next_sequence > maxSequence - 4) return { kind: "full" };
    const hash = digest(content);
    write("INSERT INTO outbox (namespace,node_id,run_id,sequence,event_id,content_json,content_sha256,committed,role) VALUES (?,?,?,?,?,?,?,0,'event')", marker.namespace, marker.nodeId, value.run_id, value.next_sequence, eventId, content, hash);
    write("UPDATE runs SET next_sequence=next_sequence+1, revision=revision+1 WHERE namespace=? AND run_id=?", marker.namespace, value.run_id);
    return { kind: "stored", revision: value.revision + 1, event: event(row<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND sequence=?", marker.namespace, value.run_id, value.next_sequence)!) };
  });
  if (op === "pending") {
    assertBoundary(boundary!); assertMetadata();
    const value = rows<EventRow>("SELECT * FROM outbox WHERE namespace=? AND run_id=? AND committed=0 ORDER BY sequence LIMIT ?", marker.namespace, string(input["runId"]), number(input["limit"])).map(event);
    assertBoundary(boundary!); return value;
  }
  if (op.startsWith("live_")) return transaction(() => executeLive(op, input));
  if (op.startsWith("delivery_")) return transaction(() => executeDelivery(op, input));
  throw new Error("Unsupported private journal operation");
}

try {
  if (boot.action === "provision") {
    marker = beginProvision({ directory: boot.directory, controllerScope: boot.controllerScope, nodeId: boot.nodeId });
    database = new DatabaseSync(join(marker.directory, "journal.sqlite"), { allowExtension: false, timeout: busyTimeoutMs });
    const pragmas = configure(true);
    database.exec(`BEGIN IMMEDIATE;
      PRAGMA application_id=${applicationId}; PRAGMA user_version=3;
      CREATE TABLE journal_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=3), namespace TEXT NOT NULL UNIQUE, controller_scope TEXT NOT NULL, node_id TEXT NOT NULL, codec TEXT NOT NULL) STRICT;
      CREATE TABLE runs (namespace TEXT NOT NULL REFERENCES journal_meta(namespace), run_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('per-run','legacy','fenced')), launch_key TEXT, canonical_payload TEXT, owner_nonce TEXT, owner_incarnation TEXT, revision INTEGER NOT NULL CHECK(revision>0), phase TEXT NOT NULL CHECK(phase IN ('admitted','preparing','launch_intent','started','closed')), stop_requested INTEGER NOT NULL CHECK(stop_requested IN(0,1)), next_sequence INTEGER NOT NULL CHECK(next_sequence>=0), receipt_id TEXT, final_outcome_json TEXT, delivery_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivery_revision IN(0,1)), delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN('pending','correcting','delivered','blocked')), delivery_correction_json TEXT, delivery_clock_unknown INTEGER NOT NULL DEFAULT 0 CHECK(delivery_clock_unknown IN(0,1)), live_abort_json TEXT, committed_count INTEGER NOT NULL DEFAULT 0 CHECK(committed_count>=0), superseded_count INTEGER NOT NULL DEFAULT 0 CHECK(superseded_count>=0), PRIMARY KEY(namespace,run_id)) STRICT;
      CREATE TABLE receipts (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, node_id TEXT NOT NULL, run_id TEXT NOT NULL, launch_key TEXT, owner_revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN('accepted','not_started_fenced','run_fenced_unbound','process_exit_confirmed')), content_json TEXT NOT NULL, FOREIGN KEY(namespace,run_id) REFERENCES runs(namespace,run_id)) STRICT;
      CREATE TABLE outbox (namespace TEXT NOT NULL, node_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=2147483647), event_id TEXT NOT NULL, content_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, committed INTEGER NOT NULL CHECK(committed IN(0,1)), role TEXT NOT NULL CHECK(role IN('event','original_retention','original_terminal','correction_retention','correction_terminal')), superseded INTEGER NOT NULL DEFAULT 0 CHECK(superseded IN(0,1)), attempts_json TEXT NOT NULL DEFAULT '[]', deadline_tick_ms INTEGER, clock_id TEXT, exhausted INTEGER NOT NULL DEFAULT 0 CHECK(exhausted IN(0,1)), PRIMARY KEY(namespace,run_id,sequence), UNIQUE(namespace,run_id,event_id), FOREIGN KEY(namespace,run_id) REFERENCES runs(namespace,run_id)) STRICT;
      CREATE INDEX outbox_active ON outbox(namespace,run_id,committed,superseded,sequence);
      CREATE INDEX outbox_role ON outbox(namespace,run_id,role);`);
    write("INSERT INTO journal_meta VALUES(1,3,?,?,?,?)", marker.namespace, marker.controllerScope, marker.nodeId, codec);
    database.exec("COMMIT");
    syncDatabase(join(marker.directory, "journal.sqlite"));
    boundary = finishProvision(marker); assertMetadata(); assertBoundary(boundary);
    database.close(); database = undefined;
    parentPort!.postMessage({ kind: "provisioned", namespace: marker.namespace, pragmas });
    parentPort!.close();
  } else {
    boundary = openBoundary(boot, string(boot.expectedNamespace)); marker = boundary.marker;
    database = new DatabaseSync(boundary.databasePath, { allowExtension: false, timeout: busyTimeoutMs });
    assertMetadata();
    const pragmas = configure(false);
    deliveryClock = readDeliveryClock();
    if (pragma("quick_check(1)") !== "ok") throw new Error("Journal quick_check failed");
    assertBoundary(boundary);
    parentPort!.on("message", (command: Command) => {
      if (command.controlKey !== boot.controlKey) { unavailable = true; return; }
      if (command.op === "close") {
        try { database?.close(); database = undefined; parentPort!.postMessage({ kind: "closed" }); parentPort!.close(); }
        catch (error) { parentPort!.postMessage({ kind: "failed", message: String(error) }); process.exitCode = 1; parentPort!.close(); }
        return;
      }
      try {
        if (unavailable) throw new Error("Journal remains unavailable after a storage error");
        const value = execute(command.op, command.input);
        parentPort!.postMessage({ kind: "result", id: command.id, value });
      } catch (error) {
        unavailable = true;
        parentPort!.postMessage({ kind: "error", id: command.id, message: String(error) });
      }
    });
    parentPort!.postMessage({ kind: "ready", namespace: marker.namespace, incarnation, pragmas });
  }
} catch (error) {
  try { database?.close(); } catch { /* Failed initialization remains unavailable; files retained. */ }
  parentPort!.postMessage({ kind: "failed", message: String(error) });
  process.exitCode = 1; parentPort!.close();
}
