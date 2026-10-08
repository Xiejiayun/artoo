import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { failureObservations, mixedFailureFixture, stamp, type SelectedRun } from "./mixed-failure.fixture.js";
import { modifiedBytes, type SpawnObservation } from "../managed/live.fixture.js";
import { until } from "../managed/ws-network.fixture.js";

interface WorkerObservation {
  worker: Worker; entry: string; directory: string; action: string; threadId: number;
  created: { at: string; tick: number }; ready?: { at: string; tick: number; kind: string; namespace: string; incarnation?: string };
  exited: Promise<number>; exit?: { at: string; tick: number; code: number }; errors: string[];
}
const observed = vi.hoisted(() => ({ spawn: undefined as SpawnObservation | undefined, workers: [] as WorkerObservation[] }));
// This wrapper returns the actual native object and forwards every constructor
// argument unchanged. No worker method, message or product factory is mocked.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const Worker = new Proxy(actual.Worker, { construct(target, args) {
    const worker = Reflect.construct(target, args) as import("node:worker_threads").Worker;
    const data = (args[1] as WorkerOptions | undefined)?.workerData;
    const entry = String(args[0]);
    if (entry === new URL("../../../apps/artood/dist/managed/journal-worker.js", import.meta.url).href
      && data && typeof data.directory === "string" && typeof data.action === "string") {
      const now = () => ({ at: new Date().toISOString(), tick: performance.now() });
      let record!: WorkerObservation;
      const exited = new Promise<number>((resolve) => worker.once("exit", (code) => { record.exit = { ...now(), code }; resolve(code); }));
      record = { worker, entry, directory: data.directory, action: data.action, threadId: worker.threadId, created: now(), exited, errors: [] };
      worker.on("message", (value: unknown) => {
        if (!value || typeof value !== "object" || !("kind" in value) || !("namespace" in value)) return;
        if (["ready", "provisioned"].includes(String(value.kind)) && typeof value.namespace === "string") {
          record.ready = { ...now(), kind: String(value.kind), namespace: value.namespace,
            ...("incarnation" in value && typeof value.incarnation === "string" ? { incarnation: value.incarnation } : {}) };
        }
      });
      worker.on("error", (error) => { record.errors.push(error.message); }); observed.workers.push(record);
    }
    return worker;
  } });
  return { ...actual, Worker };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    observed.spawn?.(args[0], Array.isArray(args[1]) ? args[1] : [], (Array.isArray(args[1]) ? args[2] : args[1]) as SpawnOptions | undefined, child);
    return child;
  } };
});
type Fixture = Awaited<ReturnType<typeof mixedFailureFixture>>;
const workerEvidence = (records: WorkerObservation[]) => records.map(({ worker: _worker, exited: _exited, ...record }) => record);
async function withFixture(id: "F01" | "F02", body: (f: Fixture) => Promise<void>) {
  const f = await mixedFailureFixture(id); observed.spawn = f.observe; let failure: unknown;
  try { await body(f); } catch (error) { failure = error; }
  try { await f.close(failure === undefined); } catch (error) { failure = failure ? new AggregateError([failure, error], "Failure case and fixture cleanup failed") : error; }
  finally { observed.spawn = undefined; f.evidence.workers = workerEvidence(observed.workers.filter((record) => record.directory === f.location.directory)); }
  failureObservations.push({ case: id, fixtureRoot: f.root, passed: failure === undefined, error: failure ? String(failure) : undefined });
  if (failure !== undefined) throw failure;
}
function ownedWorkers(f: Fixture) {
  const records = observed.workers.filter((record) => record.directory === f.location.directory);
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.action).sort()).toEqual(["open", "provision"]);
  const provision = records.find((record) => record.action === "provision")!;
  expect(provision.ready).toMatchObject({ kind: "provisioned", namespace: f.binding.expectedNamespace });
  expect(provision.exit?.code).toBe(0);
  const worker = records.find((record) => record.action === "open")!;
  expect(worker.threadId).toBeGreaterThan(0); expect(worker.worker.threadId).toBe(worker.threadId);
  expect(worker.ready).toMatchObject({ kind: "ready", namespace: f.binding.expectedNamespace }); expect(worker.exit).toBeUndefined();
  return worker;
}
async function terminateOwnedJournal(f: Fixture) {
  const worker = ownedWorkers(f);
  expect(f.failure).toBeUndefined(); expect(f.evidence.explicitStopJoin).toBeUndefined(); expect(f.releasesAbsent()).toBe(true);
  expect(f.proxy.connections).toHaveLength(1);
  expect(f.proxy.records.some((row) => row.direction === "down" && row.frame.type === "node.session.ready")).toBe(true);
  expect(f.proxy.records.some((row) => row.direction === "down" && row.frame.type === "node.session.pong")).toBe(true);
  const requested = stamp();
  // The only injected operation: terminate this actual open worker after exact
  // current-fixture matching. Product failed promises initiate all other stops.
  const terminationCode = await worker.worker.terminate(), exitCode = await worker.exited;
  f.evidence.fault = { requested, returned: stamp(), threadId: worker.threadId, terminationCode, exitCode };
  expect(terminationCode).toBe(1); expect(exitCode).toBe(1); expect(worker.errors).toEqual([]);
  await f.observeAutomaticClosure();
  expect(f.failure?.message).toBe("Journal worker exited with code 1; ownership is unknown");
  expect(f.evidence.explicitStopJoin).toBeUndefined(); expect(f.releasesAbsent()).toBe(true);
  await f.joinStop();
  expect(observed.workers.filter((record) => record.directory === f.location.directory && record.action === "open")).toHaveLength(1);
  expect(f.proxy.connections).toHaveLength(1);
  f.evidence.journalExitObserved = true;
}
function assertActivePair(f: Fixture, run: SelectedRun) {
  const rows = f.physical().filter((row) => row.runId === run.command.payload.run_id);
  expect(rows.map((row) => row.role).sort()).toEqual(["cli", "guardian"]);
  for (const row of rows) expect(row).toMatchObject({ exitObserved: false, stdioCloseObserved: false, childAbsent: false, groupAbsent: false });
}

it("F01 real idle prepared opt-out journal failure automatically closes its qualified session", async () => {
  await withFixture("F01", async (f) => {
    expect(f.workspace).not.toHaveProperty("worktreeBaseRepo"); await f.begin();
    const hello = f.proxy.records.find((row) => row.direction === "up" && row.frame.kind === "node.hello")!.frame;
    expect(hello.execution_features).toEqual([]); expect(hello.managed_receipts).toBeDefined();
    expect(f.entries()).toEqual([]); expect(f.physical()).toEqual([]);
    f.evidence.beforeStorage = f.storage();
    await terminateOwnedJournal(f);
    const after = f.storage(); expect(after).toEqual({ runs: [], receipts: [], outbox: [] });
    f.evidence.afterStorage = after; f.evidence.noDurableTerminal = true;
  });
});

it("F02 real journal failure automatically closes simultaneously active ordinary and allocated producers", async () => {
  await withFixture("F02", async (f) => {
    await f.begin(); const ordinary = await f.taskRun(false); await f.ready(ordinary);
    const allocated = await f.taskRun(true); await f.ready(allocated);
    const ordinaryId = ordinary.command.payload.run_id, allocatedId = allocated.command.payload.run_id;
    await until(() => f.storage().outbox.some((row) => row.run_id === allocatedId && row.committed === 1
      && JSON.parse(String(row.content_json)).type === "run.lifecycle" && JSON.parse(String(row.content_json)).payload.phase === "started"), "genuine managed startup receipt committed");
    assertActivePair(f, ordinary); assertActivePair(f, allocated); expect(f.entries()).toHaveLength(2);
    const before = f.storage();
    expect(before.runs.find((row) => row.run_id === ordinaryId)).toMatchObject({ mode: "legacy", phase: "admitted", receipt_id: null, final_outcome_json: null });
    expect(before.runs.find((row) => row.run_id === allocatedId)).toMatchObject({ mode: "per-run", phase: "started", final_outcome_json: null });
    f.evidence.beforeStorage = before; f.evidence.activeBeforeFault = { ...stamp(), physical: f.physical(), releasesAbsent: f.releasesAbsent() };
    await terminateOwnedJournal(f);
    const after = f.storage();
    expect(after.runs).toEqual(before.runs); expect(after.receipts).toEqual(before.receipts);
    expect(after.receipts.filter((row) => row.run_id === ordinaryId)).toEqual([]);
    expect(after.receipts.filter((row) => row.run_id === allocatedId).map((row) => row.kind)).toEqual(["accepted"]);
    expect(after.outbox.filter((row) => row.run_id === ordinaryId)).toEqual([]);
    for (const row of after.outbox) {
      expect(row.run_id).toBe(allocatedId); expect(row.role).toBe("event");
      const event = JSON.parse(String(row.content_json));
      if (event.type === "run.lifecycle") expect(event.payload.phase).toBe("started");
    }
    const terminal = f.proxy.records.filter((row) => row.direction === "up" && row.frame.kind === "run.event"
      && row.frame.event.type === "run.lifecycle" && row.frame.event.payload.phase !== "started");
    expect(terminal.filter((row) => row.frame.run_id === allocatedId)).toEqual([]);
    const retained = readFileSync(join(allocated.command.payload.workspace.root, "tracked.bin")); expect(retained).toEqual(modifiedBytes);
    f.evidence.afterStorage = after; f.evidence.noDurableTerminal = true;
    f.evidence.ordinaryTerminalFrames = terminal.filter((row) => row.frame.run_id === ordinaryId);
    f.evidence.retainedWorkspaceSha256 = createHash("sha256").update(retained).digest("hex");
  });
});

afterAll(() => {
  const directory = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR; if (!directory) throw new Error("Reviewed owned mixed-failure harness required");
  writeFileSync(join(directory, "mixed-failure-observations.json"), JSON.stringify({ schema_version: 1, photos: [], observations: failureObservations,
    workers: workerEvidence(observed.workers) }, null, 2));
});
