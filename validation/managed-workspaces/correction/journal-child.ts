import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openLocalJournal, type FreshLaunchPermit, type Journal, type JournalOptions } from "../../../apps/artood/dist/managed/journal.js";
import { physicalRun, assertPhysicalFixturesClosed } from "./physical-run.fixture.js";
import type { NodeRunEvent, AgentInstanceHandle } from "@artoo/protocol";
import type { ClosedRunDeliveryScope, DeliveryFailureReason, StartRequest } from "../../../apps/artood/dist/managed/journal-types.js";

interface Configuration { role: "client" | "locker" | "storage-fixture"; fixtureAction?: string; fixtureRunId?: string; fixtureValue?: number; options: JournalOptions; databasePath?: string; seedRunId?: string }
interface Request { id: string; op: string; request?: StartRequest; runId?: string; phase?: "preparing" | "launch_intent";
  eventId?: string; event?: NodeRunEvent; sequence?: number; hash?: string; root?: string;
  physicalMode?: "unsettled" | "settled" | "settled-failed" | "settled-cancelled" | "startup-cancel" | "startup-not-spawned"; expectedKey?: string; scope?: ClosedRunDeliveryScope; attemptId?: string; status?: "accepted" | "rejected"; reason?: DeliveryFailureReason }
const configuration = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Configuration;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let journal: Journal | undefined, locker: DatabaseSync | undefined;
const permits = new Map<string, FreshLaunchPermit>();
try {
  if (configuration.role === "locker") {
    locker = new DatabaseSync(configuration.databasePath!, { allowExtension: false });
    locker.exec("BEGIN EXCLUSIVE");
  } else if (configuration.role === "storage-fixture") {
    // Explicit low-level failure/capacity fixture; never seeds physical closure,
    // receipt, terminal, launch permission or delivery attempt/accepted ACK.
    const db = new DatabaseSync(configuration.databasePath!, { allowExtension: false });
    try {
      db.exec("BEGIN IMMEDIATE");
      const action = configuration.fixtureAction, runId = configuration.fixtureRunId!, ns = configuration.options.expectedNamespace;
      if (action === "fail-correction") db.exec("CREATE TRIGGER fixture_fail_correction BEFORE INSERT ON outbox WHEN NEW.role='correction_terminal' BEGIN SELECT RAISE(ABORT,'fixture: correction storage failure'); END");
      else if (action === "remove-failure") db.exec("DROP TRIGGER fixture_fail_correction");
      else if (action === "clock-discontinuity") db.prepare("UPDATE outbox SET clock_id='fixture:other-boot' WHERE namespace=? AND run_id=? AND deadline_tick_ms IS NOT NULL").run(ns, runId);
      else if (action === "sequence-edge") db.prepare("UPDATE runs SET next_sequence=? WHERE namespace=? AND run_id=?").run(configuration.fixtureValue!, ns, runId);
      else if (action === "seed-backlog") {
        const insert = db.prepare("INSERT INTO outbox (namespace,node_id,run_id,sequence,event_id,content_json,content_sha256,committed,role) VALUES(?,?,?,?,?,?,?,0,'event')");
        for (let sequence=0; sequence<configuration.fixtureValue!; sequence++) {
          const content = JSON.stringify({ type: "run.output", payload: { stream: "stdout", text: `storage fixture output ${sequence}` } });
          insert.run(ns, configuration.options.nodeId, runId, sequence, `fixture:backlog:${sequence}`, content, createHash("sha256").update(content).digest("hex"));
        }
        db.prepare("UPDATE runs SET next_sequence=? WHERE namespace=? AND run_id=?").run(configuration.fixtureValue!, ns, runId);
      } else throw new Error("Unknown labelled storage fixture action");
      db.exec("COMMIT");
    } finally { db.close(); }
  } else journal = await openLocalJournal(configuration.options);
  send({ kind: "ready", pid: process.pid, role: configuration.role, incarnation: journal?.incarnation });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = JSON.parse(line) as Request;
    try {
      let value: unknown;
      const query = { expectedNamespace: configuration.options.expectedNamespace, runId: command.runId! };
      const permit = () => { const p = permits.get(command.runId!); if (!p) throw new Error("Fixture has no real permit for this run"); return p; };
      switch (command.op) {
        case "admit": {
          const result = await journal!.admitStart(command.request!);
          if (result.kind === "fresh") permits.set(command.request!.runId, result.permit);
          value = { kind: result.kind, run: result.run }; break;
        }
        case "late-admit": {
          const pending = journal!.admitStart(command.request!);
          // A real parent event-loop pause delays receipt consumption. No fake
          // database response, injected transaction or test-only worker hook.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
          const result = await pending;
          if (result.kind === "fresh") permits.set(command.request!.runId, result.permit);
          value = { kind: result.kind, run: result.run }; break;
        }
        case "lookup": value = await journal!.lookupRun(query); break;
        case "advance": value = await journal!.advance(permit(), command.phase!); break;
        case "copied-permit": value = await journal!.advance(structuredClone(permit()), "preparing"); break;
        case "foreign-permit": {
          const foreign = await openLocalJournal(configuration.options);
          try { value = await foreign.advance(permit(), "preparing"); } finally { await foreign.close(); }
          break;
        }
        case "forged-closure": value = await journal!.settleOwnedProcess(permit(), Object.freeze({}) as AgentInstanceHandle,
          { kind: "confirmed_closed", observedAt: new Date().toISOString(), facts: { childSpawned: true } },
          { terminal: { type: "run.lifecycle", payload: { phase: "completed" } }, retentionOutcome: "completed" }); break;
        case "stop": value = await journal!.requestStop({ ...query, ...(command.expectedKey ? { expectedKey: command.expectedKey } : {}) }); break;
        case "append": value = await journal!.appendEvent(permit(), command.eventId!, command.event!); break;
        case "pending": value = await journal!.pendingEvents(query); break;
        case "legacy-ack": {
          if ("markEventCommitted" in journal!) throw new Error("Legacy ACK bypass still exposed");
          value = { removed: true }; break;
        }
        case "delivery-view": value = await journal!.inspectClosedRunDelivery(command.scope!); break;
        case "storage-clock-latch": {
          // Read-only fixture evidence, never a journal mutation/authority API.
          const db = new DatabaseSync(configuration.databasePath!, { readOnly: true, allowExtension: false });
          try { value = db.prepare("SELECT delivery_clock_unknown FROM runs WHERE namespace=? AND run_id=?").get(configuration.options.expectedNamespace, command.runId!); }
          finally { db.close(); }
          break;
        }
        case "storage-event-attempts": {
          // Read-only fixture evidence for safe recovery after SQLite busy.
          const db = new DatabaseSync(configuration.databasePath!, { readOnly: true, allowExtension: false });
          try { value = db.prepare("SELECT sequence,event_id,content_sha256,attempts_json,committed,superseded FROM outbox WHERE namespace=? AND run_id=? AND sequence=?")
            .get(configuration.options.expectedNamespace, command.runId!, command.sequence!); }
          finally { db.close(); }
          break;
        }
        case "claim": value = await journal!.claimNextClosedRunDelivery(command.scope!); break;
        case "receipt": value = await journal!.recordClosedRunEventReceipt(command.scope!, {
          sequence: command.sequence!, contentSha256: command.hash!, attemptId: command.attemptId!, status: command.status! }); break;
        case "failure": value = await journal!.recordClosedRunAttemptFailure(command.scope!, { sequence: command.sequence!, attemptId: command.attemptId!, reason: command.reason! }); break;
        case "lost-failure-reply": {
          const pending = journal!.recordClosedRunAttemptFailure(command.scope!, { sequence: command.sequence!, attemptId: command.attemptId!, reason: command.reason! });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
          value = await pending; break;
        }
        case "correction-then-exit": {
          await journal!.recordClosedRunAttemptFailure(command.scope!, { sequence: command.sequence!, attemptId: command.attemptId!, reason: command.reason! });
          // Actual abrupt client exit after durable commit, before returning the
          // command reply. Only already physically closed fixtures use this.
          process.exit(0);
        }
        case "physical": value = await physicalRun(journal!, permit(), command.request!, command.root!, command.physicalMode!); break;
        case "close":
          if (locker) { locker.exec("ROLLBACK"); locker.close(); locker = undefined; }
          await journal?.close(); journal = undefined;
          send({ id: command.id, ok: true, value: { closed: true } }); lines.close(); break;
        default: throw new Error("Unsupported fixture request");
      }
      if (command.op === "close") break;
      send({ id: command.id, ok: true, value });
    } catch (error) { send({ id: command.id, ok: false, error: String(error) }); }
  }
} catch (error) { send({ kind: "failed", error: String(error) }); process.exitCode = 1; }
finally {
  try { if (locker) { locker.exec("ROLLBACK"); locker.close(); } await journal?.close(); assertPhysicalFixturesClosed(); }
  catch (error) { send({ kind: "cleanup-failed", error: String(error) }); process.exitCode = 1; }
}
