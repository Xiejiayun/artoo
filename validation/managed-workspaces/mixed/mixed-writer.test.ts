import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { qualifyRunEventMessage } from "../../../apps/server/dist/services/run-event-receipt.js";
import { mixedWriterFixture, mixedObservations, type MixedRun } from "./mixed-writer.fixture.js";
import { modifiedBytes, type SpawnObservation } from "../managed/live.fixture.js";

const spawnObservation = vi.hoisted(() => ({ observer: undefined as SpawnObservation | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    spawnObservation.observer?.(args[0], Array.isArray(args[1]) ? args[1] : [], (Array.isArray(args[1]) ? args[2] : args[1]) as SpawnOptions | undefined, child);
    return child;
  } };
});
type Fixture = Awaited<ReturnType<typeof mixedWriterFixture>>;
async function withWriter(id: string, count: number, body: (fixture: Fixture) => Promise<void>) {
  const fixture = await mixedWriterFixture(count); spawnObservation.observer = fixture.observe; let failure: unknown;
  try { await body(fixture); } catch (error) { failure = error; }
  try { await fixture.close(failure === undefined); } catch (error) { failure = failure ? new AggregateError([failure, error], "Mixed test and cleanup failed") : error; }
  finally { spawnObservation.observer = undefined; }
  mixedObservations.push({ case: id, fixtureRoot: fixture.root, passed: failure === undefined, error: failure ? String(failure) : undefined });
  if (failure !== undefined) throw failure;
}

async function completed(f: Fixture, record: MixedRun) {
  const entry = await f.ready(record), result = await f.finish(record), runId = record.command.payload.run_id;
  expect(f.launches().filter((item) => item.runId === runId)).toHaveLength(1);
  expect(result.run?.status).toBe("completed");
  const physical = f.physical().filter((item) => item.runId === runId);
  expect(physical.map((item) => item.role).sort()).toEqual(["cli", "guardian"]);
  for (const item of physical) expect(item).toMatchObject({ exitObserved: true, stdioCloseObserved: true, childAbsent: true, groupAbsent: true });
  const frames = f.proxy.records.filter((row) => row.direction === "up" && row.frame.kind === "run.event" && row.frame.run_id === runId);
  expect(frames.length).toBeGreaterThan(0); expect(result.receipts.length).toBe(frames.length);
  for (const receipt of result.receipts) {
    const frame = frames.find((row) => row.frame.sequence === receipt.sequence); expect(frame).toBeDefined();
    expect(receipt.bodyIdentity).toBe(qualifyRunEventMessage(frame!.frame).bodyIdentity);
  }
  const storage = f.storage(), rows = storage.outbox.filter((row) => row.run_id === runId), receipts = storage.receipts.filter((row) => row.run_id === runId);
  if (record.kind === "allocated-task") {
    expect(result.journal).toMatchObject({ mode: "per-run", phase: "closed", receipt: { kind: "process_exit_confirmed" } });
    expect(JSON.parse(result.journal!.finalOutcomeJson!).terminal.payload.phase).toBe("completed");
    expect(rows.length).toBeGreaterThan(0); expect(rows.every((row) => row.committed === 1)).toBe(true);
    expect(receipts.map((row) => row.kind).sort()).toEqual(["accepted", "process_exit_confirmed"]);
    expect(readFileSync(join(entry.rawRoot, "tracked.bin"))).toEqual(modifiedBytes);
    // The terminal is observed only after this run's real CLI/guardian closure.
    const terminal = frames.filter((row) => row.frame.event.type === "run.lifecycle" && row.frame.event.payload.phase !== "started");
    expect(terminal).toHaveLength(1);
    const atTerminal = (terminal[0]!.physical as ReturnType<Fixture["physical"]>).filter((item) => item.runId === runId);
    expect(atTerminal).toHaveLength(2);
    for (const item of atTerminal) expect(item).toMatchObject({ exitObserved: true, stdioCloseObserved: true, childAbsent: true, groupAbsent: true });
  } else {
    expect(record.command.payload.workspace_allocation).toBeUndefined();
    expect(result.journal).toMatchObject({ mode: "legacy", phase: "admitted", receipt: null, finalOutcomeJson: null });
    expect(rows).toEqual([]); expect(receipts).toEqual([]);
  }
  return result;
}

it("M01 one qualified worker executes real assistant, discussion contribution, allocated task and ordinary task routes", async () => {
  await withWriter("M01", 4, async (f) => {
    await f.begin();
    const assistant = await f.assistantRun(); expect(assistant.command.payload.context_pack.payload?.conversation?.current_request).toBe("Give one concise response"); await completed(f, assistant);
    const discussion = await f.discussionRun();
    expect(discussion.command.payload.context_pack.payload?.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
    expect(discussion.command.payload.context_pack.payload?.conversation?.current_request).toContain("planning discussion");
    await completed(f, discussion); expect(f.launches().find((entry) => entry.runId === discussion.command.payload.run_id)?.discussionCommand).toBe(true);
    const allocated = await f.taskRun(true); expect(allocated.command.payload.workspace_allocation?.strategy).toBe("per-run"); await completed(f, allocated);
    const ordinary = await f.taskRun(false); await completed(f, ordinary);
    expect(f.proxy.connections).toHaveLength(1); expect(f.incarnations).toHaveLength(1); expect(f.runner.failure).toBeUndefined();
    expect(f.selectedRuns.map((run) => run.kind)).toEqual(["assistant", "discussion-contribution", "allocated-task", "ordinary-task"]);
    expect(new Set(f.launches().map((entry) => entry.runId)).size).toBe(4);
    expect(new Set(f.storage().outbox.map((row) => row.run_id))).toEqual(new Set([allocated.command.payload.run_id]));
    expect(f.proxy.records.filter((row) => row.direction === "up" && row.frame.kind === "node.hello")).toHaveLength(1);
    expect(f.proxy.records.some((row) => row.direction === "down" && row.frame.type === "node.session.ready")).toBe(true);
    expect(f.proxy.records.some((row) => row.direction === "down" && row.frame.type === "node.session.pong")).toBe(true);
  });
});

it("M02 reopened real journal rejects ordinary respawn and both mode changes while a fresh ordinary route still executes", async () => {
  await withWriter("M02", 3, async (f) => {
    await f.begin();
    const ordinary = await f.taskRun(false); await completed(f, ordinary);
    const allocated = await f.taskRun(true); const originalManaged = await completed(f, allocated);
    const changed = structuredClone(ordinary.command.payload); changed.context_pack.payload!.task.description += " changed fixture instruction";
    const upgraded = f.toManaged(ordinary), downgraded = structuredClone(allocated.command.payload); delete downgraded.workspace_allocation;
    expect((await f.injectStart(ordinary, ordinary.command.payload, "same-process identical ordinary replay")).status).toBe("accepted");
    for (const [record, payload, label] of [[ordinary, changed, "changed ordinary context"], [ordinary, upgraded, "ordinary to managed"], [allocated, downgraded, "managed to ordinary"]] as const) {
      expect((await f.injectStart(record, payload, "before reopen: " + label)).status).toBe("rejected");
    }
    const beforeReopen = { launches: f.launches(), workspace: f.workspaceInventory(), storage: f.storage() };
    await f.reopen(); expect(new Set(f.incarnations).size).toBe(2); expect(f.proxy.connections).toHaveLength(2);
    expect(await f.journal.lookupRun(f.query(ordinary.command.payload.run_id))).toMatchObject({ mode: "legacy", phase: "admitted", ownership: "unknown", receipt: null, finalOutcomeJson: null });
    expect((await f.injectStart(ordinary, ordinary.command.payload, "after reopen: identical ordinary must not respawn")).status).toBe("rejected");
    for (const [record, payload, label] of [[ordinary, changed, "changed ordinary context"], [ordinary, upgraded, "ordinary to managed"], [allocated, downgraded, "managed to ordinary"]] as const) {
      expect((await f.injectStart(record, payload, "after reopen: " + label)).status).toBe("rejected");
    }
    const ordinaryResume = await f.resume(ordinary), managedResume = await f.resume(allocated);
    expect(ordinaryResume).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    expect(ordinaryResume.message).toContain("ownership remains unknown");
    expect(managedResume).toMatchObject({ status: "rejected", error_code: "process_exited", message: "Durable closed delivery is complete" });
    expect((await f.journal.lookupRun(f.query(allocated.command.payload.run_id)))!.finalOutcomeJson).toBe(originalManaged.journal!.finalOutcomeJson);
    expect(f.launches()).toEqual(beforeReopen.launches); expect(f.workspaceInventory()).toEqual(beforeReopen.workspace); expect(f.storage()).toEqual(beforeReopen.storage);
    const fresh = await f.taskRun(false); await completed(f, fresh);
    expect(fresh.command.payload.run_id).not.toBe(ordinary.command.payload.run_id); expect(f.launches()).toHaveLength(3); expect(f.runner.failure).toBeUndefined();
    mixedObservations.push({ case: "mixed-reopen", fixtureRoot: f.root, incarnations: f.incarnations, legacyRunId: ordinary.command.payload.run_id,
      managedRunId: allocated.command.payload.run_id, freshRunId: fresh.command.payload.run_id, ordinaryResume, managedResume, beforeReopen,
      after: { launches: f.launches(), storage: f.storage() }, scope: "Same OS process, new journal worker/incarnation and NodeClient. No historical ordinary producer adoption or closure proof." });
  });
});

afterAll(() => {
  const directory = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR; if (!directory) throw new Error("Reviewed owned mixed harness required");
  writeFileSync(join(directory, "mixed-observations.json"), JSON.stringify({ schema_version: 1, photos: [], observations: mixedObservations }, null, 2));
});
