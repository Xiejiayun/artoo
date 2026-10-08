import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openLocalJournal, type FreshLaunchPermit, type Journal, type JournalOptions } from "../../../apps/artood/dist/managed/journal.js";
import { physicalRun, assertPhysicalFixturesClosed } from "./physical-run.fixture.js";
import type { NodeRunEvent, AgentInstanceHandle } from "@artoo/protocol";
import type { ClosedRunDeliveryScope, StartRequest } from "../../../apps/artood/dist/managed/journal-types.js";

interface Configuration { role: "client" | "locker"; options: JournalOptions; databasePath?: string }
interface Request { id: string; op: string; request?: StartRequest; runId?: string; phase?: "preparing" | "launch_intent";
  eventId?: string; event?: NodeRunEvent; sequence?: number; hash?: string; root?: string;
  physicalMode?: "unsettled" | "settled" | "startup-cancel" | "startup-not-spawned"; expectedKey?: string;
  scope?: ClosedRunDeliveryScope; attemptId?: string; status?: "accepted" | "rejected" }
const configuration = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Configuration;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let journal: Journal | undefined, locker: DatabaseSync | undefined;
const permits = new Map<string, FreshLaunchPermit>();
try {
  if (configuration.role === "locker") {
    locker = new DatabaseSync(configuration.databasePath!, { allowExtension: false });
    locker.exec("BEGIN EXCLUSIVE");
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
        case "live-claim": value = await journal!.claimNextLiveDelivery(permit()); break;
        case "live-receipt": value = await journal!.recordLiveEventReceipt(permit(), {
          sequence: command.sequence!, contentSha256: command.hash!, attemptId: command.attemptId!, status: command.status! }); break;
        case "unowned-live-receipt": value = await journal!.recordLiveEventReceipt(Object.freeze({}) as FreshLaunchPermit, {
          sequence: command.sequence!, contentSha256: command.hash!, attemptId: command.attemptId!, status: command.status! }); break;
        case "claim": value = await journal!.claimNextClosedRunDelivery(command.scope!); break;
        case "receipt": value = await journal!.recordClosedRunEventReceipt(command.scope!, {
          sequence: command.sequence!, contentSha256: command.hash!, attemptId: command.attemptId!, status: command.status! }); break;
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
