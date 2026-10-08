import { createHash } from "node:crypto";
import { RunStartPayloadSchema, type RunStartPayload } from "@artoo/domain";
import { allocateWorkspaceRoot, type AgentInstanceConfig, type AgentInstanceHandle, type CommandAck, type NodeSideTransport,
  type NodeToServerMessage, type RunStartCommand, type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeClient } from "./node-client.js";
import type { ManagedEventChannel, ManagedSession, RunDeliveryMode } from "./managed/managed-delivery.js";
import type { AdmissionResult, FreshLaunchPermit, Journal, JournalRun, StartRequest } from "./managed/journal-types.js";

// Admission/routing model only. No process, worktree, SQLite, socket or physical
// receipt is created here. The existing real-writer suites qualify those seams.
const gates: Array<{ resolve(): void }> = [];
const clients: Array<ReturnType<typeof createNodeClient>> = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const value = { promise, resolve }; gates.push(value); return value;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
  for (const pending of gates.splice(0)) pending.resolve();
  for (const client of clients.splice(0)) await client.stop();
});

function command(runId = "run_1", id = `start_${runId}`): RunStartCommand {
  const root = process.platform === "win32" ? "C:/mixed/workspace" : "/mixed/workspace";
  return { kind: "command", id, idempotency_key: `${runId}:start`, type: "run.start", payload: {
    run_id: runId, task_id: `task_${runId}`, agent_instance_id: "ai_1", runtime: "mock",
    workspace: { root }, context_pack: { id: `ctx_${runId}`, payload: {
      task: { id: `task_${runId}`, title: "Ordinary task", description: "Original request", acceptance_criteria: [] },
      project: { id: "project_1", name: "Project", default_workspace: root },
      workspace: { root, file_scope: [] }, policy: { filesystem_write_scope: [], requires_approval: [] },
      memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    } }, policy_snapshot: { filesystem_write_scope: [root], requires_approval: [] }, artifact_rules: { paths: [] },
  } };
}
function allocated(runId = "run_1", id = `allocated_${runId}`): RunStartCommand {
  const value = command(runId, id), base = process.platform === "win32" ? "C:/mixed/base" : "/mixed/base";
  const root = allocateWorkspaceRoot({ workspaceRoot: value.payload.workspace.root, branchBacked: true,
    targetComputerOs: process.platform, agentInstanceId: value.payload.agent_instance_id, runId,
    worktreeBase: { version: 1, strategy: "per-run", basePath: base } })!;
  value.payload.workspace = { root, branch: `task/${runId}` };
  value.payload.workspace_allocation = { version: 1, strategy: "per-run", base_path: base };
  value.payload.workspace_retention_reporting = "typed-v1";
  value.payload.policy_snapshot.filesystem_write_scope = [root];
  value.payload.context_pack.payload!.workspace.root = root;
  return value;
}
const stop = (runId = "run_1", id = `stop_${runId}`): ServerToNodeMessage => ({
  kind: "command", id, idempotency_key: `${runId}:stop`, type: "run.stop", payload: { run_id: runId, reason: "user_cancelled" },
});
const resume = (runId = "run_1"): ServerToNodeMessage => ({
  kind: "command", id: `resume_${runId}`, idempotency_key: `${runId}:resume`, type: "run.resume", payload: { run_id: runId },
});
function identity(payload: RunStartPayload): string {
  return createHash("sha256").update(JSON.stringify(RunStartPayloadSchema.parse(payload))).digest("hex");
}
function row(payload: RunStartPayload): JournalRun {
  return { namespace: "test_namespace", runId: payload.run_id, mode: payload.workspace_allocation ? "per-run" : "legacy",
    launchKey: identity(payload), revision: 1, phase: "admitted", stopRequested: false, ownership: "local_claim",
    receipt: null, finalOutcomeJson: null, liveAbort: null };
}
function admissionModel(rows = new Map<string, JournalRun>()) {
  const forbidden: string[] = [];
  const admitStart = vi.fn(async (request: StartRequest): Promise<AdmissionResult> => {
    const payload = RunStartPayloadSchema.parse(request.payload), existing = rows.get(request.runId);
    if (existing) {
      if (existing.mode === "fenced") return { kind: "fenced", run: existing };
      if (existing.launchKey !== identity(payload) || existing.mode !== (payload.workspace_allocation ? "per-run" : "legacy")) {
        return { kind: "conflict", run: existing };
      }
      return { kind: existing.ownership === "unknown" ? "unknown" : "pending", run: existing };
    }
    const saved = row(payload); rows.set(request.runId, saved);
    // Opaque mock admission marker, never passed to any producer/settlement API.
    return { kind: "fresh", run: saved, payload, permit: Object.freeze({}) as FreshLaunchPermit };
  });
  const lookupRun = vi.fn(async (query: { runId: string }) => rows.get(query.runId) ?? null);
  const requestStop = vi.fn(async (query: { runId: string; expectedKey?: string }): Promise<JournalRun> => {
    const existing = rows.get(query.runId);
    if (existing) {
      if (query.expectedKey !== undefined && existing.launchKey !== null && query.expectedKey !== existing.launchKey) throw new Error("stop key conflict");
      const updated = { ...existing, stopRequested: true }; rows.set(query.runId, updated); return updated;
    }
    const fenced: JournalRun = { namespace: "test_namespace", runId: query.runId, mode: "fenced",
      launchKey: query.expectedKey ?? null, revision: 1, phase: "closed", stopRequested: true, ownership: "fenced",
      receipt: { id: `fence_${query.runId}`, namespace: "test_namespace", nodeId: "node_1", runId: query.runId,
        launchKey: query.expectedKey ?? null, ownerRevision: 1,
        kind: query.expectedKey ? "not_started_fenced" : "run_fenced_unbound", contentJson: "{}" },
      finalOutcomeJson: null, liveAbort: null };
    rows.set(query.runId, fenced); return fenced;
  });
  const journal = new Proxy({ namespace: "test_namespace", incarnation: "test_incarnation", pragmas: {},
    admitStart, lookupRun, requestStop }, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return () => { forbidden.push(String(property)); throw new Error(`Physical/delivery journal API is forbidden in this admission model: ${String(property)}`); };
    },
  }) as unknown as Journal;
  return { journal, rows, admitStart, lookupRun, requestStop, forbidden };
}

function fixture(options: { mode?: "mixed" | "managed-only" | "plain"; allowNewAllocations?: boolean;
  model?: ReturnType<typeof admissionModel>; startGate?: ReturnType<typeof gate>; streamGate?: ReturnType<typeof gate>;
  stopGate?: ReturnType<typeof gate>; gitGate?: ReturnType<typeof gate>; startError?: string; stopError?: string;
  failOutput?: boolean } = {}) {
  const model = options.model ?? admissionModel(), mode = options.mode ?? "mixed";
  const received: NodeToServerMessage[] = [], started: AgentInstanceConfig[] = [], stopped: string[] = [], gitCalls: string[][] = [];
  const startHandles: AgentInstanceHandle[] = [], stopHandles: AgentInstanceHandle[] = [];
  const bindings = new Map<string, RunDeliveryMode>(), cancelled = new Set<string>();
  let handler: ((value: ServerToNodeMessage) => void) | undefined;
  let session: ManagedSession = Object.freeze({ namespace: model.journal.namespace, nodeId: "node_1", generation: 1,
    sessionId: "session_1", helloNonce: "nonce_1" });
  const channel: ManagedEventChannel = {
    assertCurrentSession(expected) { if (expected && expected !== session) throw new Error("startup session changed"); return session; },
    async waitUntilUsable() { return session; },
    async exposeOnce() { throw new Error("No managed physical event is authorized by this fixture"); },
  };
  const transport: NodeSideTransport = {
    acknowledgesRunEvents: true,
    async send(message) {
      if (message.kind === "run.event") {
        if (mode === "mixed" && bindings.get(message.run_id) !== "legacy") throw new Error("ordinary event lane was not admitted");
        if (options.failOutput && message.event.type === "run.output") throw new Error("mock event delivery failed");
      }
      received.push(message);
    },
    subscribe(listener) { handler = listener; return () => { handler = undefined; }; },
  };
  const adapter: RuntimeAdapter = {
    runtimeId: "mock",
    async start(config) { started.push(config); await options.startGate?.promise;
      if (options.startError) throw new Error(options.startError);
      const handle = { runId: config.runId }; startHandles.push(handle); return handle; },
    async *streamEvents(handle) {
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      await options.streamGate?.promise;
      yield { type: "run.output", payload: { stream: "stdout", text: "ordinary response" } };
      yield { type: "run.lifecycle", payload: { phase: cancelled.has(handle.runId) ? "cancelled" : "completed" } };
    },
    async stop(handle) { stopped.push(handle.runId); stopHandles.push(handle); await options.stopGate?.promise;
      if (options.stopError) throw new Error(options.stopError);
      cancelled.add(handle.runId); options.streamGate?.resolve(); },
    async collectArtifacts() { return []; },
  };
  const client = createNodeClient({ nodeId: "node_1", transport, adapter,
    workspace: { worktreeBaseRepo: process.platform === "win32" ? "C:/mixed/source" : "/mixed/source" },
    git: { async run(args) { gitCalls.push([...args]); await options.gitGate?.promise; } },
    ...(mode === "plain" ? {} : { managedJournal: { journal: model.journal, channel,
      ...(mode === "mixed" ? { mixed: { allowNewAllocations: options.allowNewAllocations ?? true,
        bindRun(runId: string, selected: RunDeliveryMode) {
          if (bindings.has(runId) && bindings.get(runId) !== selected) throw new Error("run mode changed");
          bindings.set(runId, selected);
        } } } : {}) } }),
  });
  clients.push(client); client.start();
  const ack = (id: string) => received.find((value): value is CommandAck => value.kind === "command.ack" && value.command_id === id);
  return { client, model, received, started, startHandles, stopped, stopHandles, gitCalls, bindings,
    send(value: ServerToNodeMessage) { if (!handler) throw new Error("client is not subscribed"); handler(value); },
    ack,
    async waitAck(id: string) { await vi.waitFor(() => expect(ack(id)).toBeDefined()); return ack(id)!; },
    changeSession() { const previous = session; session = Object.freeze({ ...session, generation: 2, sessionId: "session_2" });
      client.invalidateManagedStartupSession(previous, new Error("test session lost")); },
  };
}

describe("mixed NodeClient admission and races (mock journal, no physical qualification)", () => {
  it("leaves plain ordinary execution and managed-only rejection unchanged", async () => {
    const plain = fixture({ mode: "plain" }); plain.send(command());
    expect(await plain.waitAck("start_run_1")).toMatchObject({ status: "accepted" });
    await plain.client.stop();
    expect(plain.started).toHaveLength(1); expect(plain.model.admitStart).not.toHaveBeenCalled(); expect(plain.bindings.size).toBe(0);
    const managed = fixture({ mode: "managed-only" }); managed.send(command());
    expect(await managed.waitAck("start_run_1")).toMatchObject({ status: "rejected", message: "Managed execution requires an explicit per-run allocation" });
    expect(managed.started).toHaveLength(0); expect(managed.model.admitStart).not.toHaveBeenCalled();
  });

  it("preserves ordinary assistant, discussion/planning and task streams on one client", async () => {
    const f = fixture();
    for (const [index, kind] of ["assistant", "planning", "task", "assistant"].entries()) {
      const value = command(`run_${index}`);
      if (kind === "assistant") value.payload.context_pack.payload!.conversation = { room_id: "room_1", turn_id: `turn_${index}`,
        current_request: "Help me", messages: [], history_truncated: false };
      if (kind === "planning") value.payload.context_pack.payload!.policy.execution_mode = "discussion";
      f.send(value); expect(await f.waitAck(value.id)).toMatchObject({ status: "accepted" });
    }
    await f.client.stop();
    expect(f.started).toHaveLength(4); expect([...f.bindings.values()]).toEqual(["legacy", "legacy", "legacy", "legacy"]);
    expect(f.received.filter((m) => m.kind === "run.event" && m.event.type === "run.output")).toHaveLength(4);
    expect(f.model.forbidden).toEqual([]); expect([...f.model.rows.values()].every((r) => r.receipt === null && r.phase === "admitted")).toBe(true);
  });

  it("admits before Git materialization using a detached frozen input payload", async () => {
    const admission = gate(), model = admissionModel(), originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => { await admission.promise; return originalAdmit(request); });
    const f = fixture({ model }), value = command(); value.payload.workspace.branch = "topic";
    f.send(value); await turn();
    expect(f.gitCalls).toEqual([]); expect(f.started).toEqual([]); expect(f.bindings.size).toBe(0);
    value.payload.context_pack.payload!.task.description = "mutation after dispatch";
    admission.resolve(); expect(await f.waitAck(value.id)).toMatchObject({ status: "accepted" });
    expect(f.gitCalls).toHaveLength(1); expect(f.started[0]!.runStart!.context_pack.payload!.task.description).toBe("Original request");
    expect(Object.isFrozen(model.admitStart.mock.calls[0]![0].payload.context_pack.payload!.task)).toBe(true);
  });

  it("joins matching duplicates through both admission and adapter startup", async () => {
    const admission = gate(), startup = gate(), model = admissionModel(), originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => { await admission.promise; return originalAdmit(request); });
    const f = fixture({ model, startGate: startup });
    f.send(command()); f.send(command("run_1", "duplicate")); await turn();
    expect(f.ack("start_run_1")).toBeUndefined(); expect(f.ack("duplicate")).toBeUndefined();
    admission.resolve(); await vi.waitFor(() => expect(f.started).toHaveLength(1));
    expect(f.ack("duplicate")).toBeUndefined(); startup.resolve();
    expect(await f.waitAck("start_run_1")).toMatchObject({ status: "accepted" });
    expect(await f.waitAck("duplicate")).toMatchObject({ status: "accepted" }); expect(model.admitStart).toHaveBeenCalledTimes(1);
  });

  it("returns the same admission failure to duplicates without filesystem or adapter work", async () => {
    const admission = gate(), model = admissionModel();
    model.admitStart.mockImplementation(async () => { await admission.promise; throw new Error("admission unavailable"); });
    const f = fixture({ model }), value = command(); value.payload.workspace.branch = "topic";
    f.send(value); f.send({ ...value, id: "duplicate" }); admission.resolve();
    for (const id of [value.id, "duplicate"]) expect(await f.waitAck(id)).toMatchObject({ status: "rejected", message: "admission unavailable" });
    expect(f.started).toEqual([]); expect(f.gitCalls).toEqual([]); expect(f.bindings.size).toBe(0);
  });

  it.each(["pending", "replay", "conflict", "fenced", "unknown"] as const)("never executes a %s admission without a local attempt", async (kind) => {
    const model = admissionModel(); model.admitStart.mockResolvedValue({ kind, run: row(command().payload) });
    const f = fixture({ model }); f.send(command());
    expect(await f.waitAck("start_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining(`is ${kind}`) });
    expect(f.started).toEqual([]); expect(f.gitCalls).toEqual([]); expect(f.bindings.size).toBe(0);
  });

  it("rejects changed ordinary payload, mode and idempotency on a remembered run", async () => {
    const f = fixture(); f.send(command()); await f.waitAck("start_run_1");
    const changed = command("run_1", "changed"); changed.payload.context_pack.payload!.task.description = "another request";
    f.send(changed); f.send(allocated()); f.send({ ...command("run_1", "bad_key"), idempotency_key: "different:start" });
    for (const id of ["changed", "allocated_run_1", "bad_key"]) expect(await f.waitAck(id)).toMatchObject({ status: "rejected" });
    expect(f.started).toHaveLength(1); expect(f.model.admitStart).toHaveBeenCalledTimes(1); expect(f.model.forbidden).toEqual([]);
  });

  it("joins a pre-adapter workspace rejection instead of accepting its duplicate", async () => {
    const f = fixture(), value = command(); value.payload.policy_snapshot.filesystem_write_scope = ["/different/workspace"];
    f.send(value); f.send({ ...value, id: "duplicate" });
    const first = await f.waitAck(value.id), duplicate = await f.waitAck("duplicate");
    expect(first.status).toBe("rejected"); expect(duplicate).toMatchObject({ status: "rejected", message: first.message });
    expect(f.started).toEqual([]); expect(f.gitCalls).toEqual([]); expect(f.model.admitStart).toHaveBeenCalledTimes(1);
  });

  it("cannot remove allocation from a remembered rejected physical attempt", async () => {
    const f = fixture(); f.send(allocated());
    // This mock adapter deliberately has no authenticated owned-process seam.
    expect(await f.waitAck("allocated_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining("authenticated owned-run") });
    f.send(command()); expect(await f.waitAck("start_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining("binding changed") });
    expect(f.started).toEqual([]); expect(f.model.admitStart).not.toHaveBeenCalled(); expect(f.model.forbidden).toEqual([]);
  });

  it("rejects durable mode removal and unknown legacy restart while allowing a new run ID", async () => {
    const rows = new Map<string, JournalRun>();
    rows.set("run_allocated", { ...row(allocated("run_allocated").payload), ownership: "unknown" });
    rows.set("run_old", { ...row(command("run_old").payload), ownership: "unknown" });
    const f = fixture({ model: admissionModel(rows) });
    f.send(command("run_allocated")); f.send(command("run_old")); f.send(command("run_new"));
    expect(await f.waitAck("start_run_allocated")).toMatchObject({ status: "rejected", message: expect.stringContaining("conflict") });
    expect(await f.waitAck("start_run_old")).toMatchObject({ status: "rejected", message: expect.stringContaining("unknown") });
    expect(await f.waitAck("start_run_new")).toMatchObject({ status: "accepted" });
    f.send(stop("run_old")); f.send(resume("run_old"));
    expect(await f.waitAck("stop_run_old")).toMatchObject({ status: "rejected", error_code: "process_start_failed", message: expect.stringContaining("unknown") });
    expect(await f.waitAck("resume_run_old")).toMatchObject({ status: "rejected", error_code: "process_start_failed", message: expect.stringContaining("unknown") });
    expect(f.started.map((start) => start.runId)).toEqual(["run_new"]); expect(f.model.forbidden).toEqual([]);
  });

  it("denies an unknown Stop race before the journal fence reply without accepting Stop early", async () => {
    const persistence = gate(), model = admissionModel(), originalStop = model.requestStop.getMockImplementation()!;
    model.requestStop.mockImplementation(async (query) => { await persistence.promise; return originalStop(query); });
    const f = fixture({ model }); f.send(stop()); f.send(command()); f.send(allocated());
    expect(await f.waitAck("start_run_1")).toMatchObject({ status: "rejected" });
    expect(await f.waitAck("allocated_run_1")).toMatchObject({ status: "rejected" });
    expect(f.ack("stop_run_1")).toBeUndefined(); expect(model.admitStart).not.toHaveBeenCalled();
    persistence.resolve(); expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "accepted" }); expect(f.started).toEqual([]);
  });

  it("Stop during ordinary admission prevents Git and adapter invocation", async () => {
    const admission = gate(), model = admissionModel(), originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => { await admission.promise; return originalAdmit(request); });
    const f = fixture({ model }), value = command(); value.payload.workspace.branch = "topic";
    f.send(value); f.send(stop()); await turn(); expect(f.ack("stop_run_1")).toBeUndefined();
    admission.resolve(); expect(await f.waitAck(value.id)).toMatchObject({ status: "rejected" });
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "accepted" });
    expect(f.gitCalls).toEqual([]); expect(f.started).toEqual([]); expect(f.bindings.size).toBe(0);
  });

  it("Stop during materialization waits for that operation and prevents adapter invocation", async () => {
    const materializing = gate(), f = fixture({ gitGate: materializing }), value = command(); value.payload.workspace.branch = "topic";
    f.send(value); await vi.waitFor(() => expect(f.gitCalls).toHaveLength(1)); f.send(stop()); await turn();
    expect(f.ack("stop_run_1")).toBeUndefined(); materializing.resolve();
    expect(await f.waitAck(value.id)).toMatchObject({ status: "rejected" });
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "accepted" }); expect(f.started).toEqual([]);
  });

  it("Stop after adapter invocation joins the returned handle and actual stop completion", async () => {
    const startup = gate(), stopping = gate(), streaming = gate(), f = fixture({ startGate: startup, stopGate: stopping, streamGate: streaming });
    f.send(command()); await vi.waitFor(() => expect(f.started).toHaveLength(1)); f.send(stop()); await turn();
    expect(f.ack("stop_run_1")).toBeUndefined(); startup.resolve();
    await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"])); expect(f.ack("stop_run_1")).toBeUndefined();
    stopping.resolve(); expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "accepted" });
    expect(f.started).toHaveLength(1); expect(f.model.rows.get("run_1")!.receipt).toBeNull();
  });

  it("a failed Stop journal write still stops the returned adapter handle and rejects the ACK", async () => {
    const streaming = gate(), f = fixture({ streamGate: streaming });
    f.send(command()); await f.waitAck("start_run_1");
    f.model.requestStop.mockRejectedValue(new Error("stop persistence failed")); f.send(stop());
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", message: "stop persistence failed" });
    expect(f.stopped).toEqual(["run_1"]); expect(f.model.forbidden).toEqual([]);
  });

  it.each(["committed", "failed"] as const)("retains the exact handle when the stream ends before a %s Stop journal reply", async (storage) => {
    const persistence = gate(), startup = gate(), streaming = gate(), stopping = gate();
    const model = admissionModel(), originalStop = model.requestStop.getMockImplementation()!;
    model.requestStop.mockImplementation(async (query) => {
      await persistence.promise;
      if (storage === "failed") throw new Error("delayed Stop persistence failed");
      return originalStop(query);
    });
    const f = fixture({ model, startGate: startup, streamGate: streaming, stopGate: stopping });
    f.send(command()); await vi.waitFor(() => expect(f.started).toHaveLength(1));
    // Stop starts while the adapter has been invoked but has not returned yet.
    f.send(stop()); startup.resolve(); await f.waitAck("start_run_1");
    expect(f.startHandles).toHaveLength(1); streaming.resolve();
    await vi.waitFor(() => expect(f.received.some((message) => message.kind === "run.event"
      && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(true));
    await turn(); expect(f.ack("stop_run_1")).toBeUndefined(); expect(f.stopped).toEqual([]);
    persistence.resolve(); await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"]));
    expect(f.stopHandles[0]).toBe(f.startHandles[0]); expect(f.ack("stop_run_1")).toBeUndefined();
    stopping.resolve();
    expect(await f.waitAck("stop_run_1")).toMatchObject(storage === "committed" ? { status: "accepted" }
      : { status: "rejected", message: "delayed Stop persistence failed" });
    f.send(resume()); expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", error_code: "process_exited" });
    await f.client.stop(true); expect(f.stopped).toHaveLength(1); expect(f.started).toHaveLength(1);
    expect(f.model.rows.get("run_1")!.receipt).toBeNull();
  });

  it("does not convert a rejected invoked start without a handle into clean Stop or shutdown", async () => {
    const f = fixture({ startError: "start returned no handle" }); f.send(command());
    expect(await f.waitAck("start_run_1")).toMatchObject({ status: "rejected", message: "start returned no handle" });
    f.send(command("run_1", "retry")); f.send(stop()); f.send(resume());
    expect(await f.waitAck("retry")).toMatchObject({ status: "rejected", message: "start returned no handle" });
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining("uncertain") });
    expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    await expect(f.client.stop(true)).rejects.toThrow("closure remains uncertain"); expect(f.started).toHaveLength(1); expect(f.stopped).toEqual([]);
  });

  it("retains mixed Stop authority after stream failure and retries it on Stop and shutdown", async () => {
    const f = fixture({ failOutput: true, stopError: "adapter closure uncertain" }); f.send(command()); await f.waitAck("start_run_1");
    await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"])); await turn();
    f.send(stop()); expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", message: "adapter closure uncertain" });
    await expect(f.client.stop(true)).rejects.toThrow("adapter closure uncertain");
    expect(f.stopped).toEqual(["run_1", "run_1", "run_1"]);
    expect(f.stopHandles.every((handle) => handle === f.stopHandles[0])).toBe(true);
    expect(f.started).toHaveLength(1);
  });

  it("retries a transient mixed Stop failure with the same handle and releases it only after success", async () => {
    const behavior: { failOutput: boolean; stopError?: string } = { failOutput: true, stopError: "temporary stop failure" };
    const f = fixture(behavior); f.send(command()); await f.waitAck("start_run_1");
    await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"])); await turn();
    delete behavior.stopError;
    f.send(stop()); expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "accepted" });
    expect(f.stopped).toEqual(["run_1", "run_1"]); expect(f.stopHandles[1]).toBe(f.stopHandles[0]);
    f.send(resume()); expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", error_code: "process_exited" });
    await f.client.stop(true); expect(f.stopped).toHaveLength(2); expect(f.started).toHaveLength(1);
    expect(f.model.rows.get("run_1")!.receipt).toBeNull();
  });

  it("retains the same handle when a mixed stream ends before its pending Stop fails", async () => {
    const streaming = gate(), stopping = gate();
    const behavior: { streamGate: ReturnType<typeof gate>; stopGate: ReturnType<typeof gate>; stopError?: string } = {
      streamGate: streaming, stopGate: stopping, stopError: "late stop failure" };
    const f = fixture(behavior); f.send(command()); await f.waitAck("start_run_1"); f.send(stop());
    await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"]));
    streaming.resolve();
    await vi.waitFor(() => expect(f.received.some((message) => message.kind === "run.event"
      && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(true));
    await turn(); expect(f.ack("stop_run_1")).toBeUndefined(); stopping.resolve();
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", message: "late stop failure" });
    delete behavior.stopError;
    f.send(stop("run_1", "retry_stop")); expect(await f.waitAck("retry_stop")).toMatchObject({ status: "accepted" });
    expect(f.stopped).toEqual(["run_1", "run_1"]); expect(f.stopHandles[1]).toBe(f.stopHandles[0]);
    f.send(resume()); expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", error_code: "process_exited" });
    await f.client.stop(true); expect(f.stopped).toHaveLength(2); expect(f.started).toHaveLength(1);
  });

  it("preserves plain no-journal Stop delegation and normal stream completion", async () => {
    const streaming = gate();
    const behavior: { mode: "plain"; streamGate: ReturnType<typeof gate>; stopError?: string } = {
      mode: "plain", streamGate: streaming, stopError: "ordinary stop failed" };
    const f = fixture(behavior); f.send(command()); await f.waitAck("start_run_1"); f.send(stop());
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", error_code: "process_exited", message: "ordinary stop failed" });
    delete behavior.stopError;
    f.send(stop("run_1", "retry_stop")); expect(await f.waitAck("retry_stop")).toMatchObject({ status: "accepted" });
    await turn(); f.send(resume()); expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", error_code: "process_exited" });
    expect(f.stopped).toEqual(["run_1", "run_1"]); expect(f.stopHandles[1]).toBe(f.stopHandles[0]);
    expect(f.started).toHaveLength(1); expect(f.model.admitStart).not.toHaveBeenCalled(); expect(f.model.requestStop).not.toHaveBeenCalled();
    await f.client.stop(true); expect(f.stopped).toHaveLength(2);
  });

  it("joins resume to a local ordinary startup instead of treating its journal row as a restart", async () => {
    const startup = gate(), streaming = gate(), f = fixture({ startGate: startup, streamGate: streaming });
    f.send(command()); await vi.waitFor(() => expect(f.started).toHaveLength(1)); f.send(resume()); await turn();
    expect(f.ack("resume_run_1")).toBeUndefined(); startup.resolve();
    expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "accepted" }); expect(f.model.lookupRun).not.toHaveBeenCalled();
    streaming.resolve();
  });

  it("refuses restart Stop/resume for a legacy row without a current handle", async () => {
    const rows = new Map([["run_1", { ...row(command().payload), ownership: "unknown" as const }]]);
    const f = fixture({ model: admissionModel(rows) }); f.send(stop()); f.send(resume());
    expect(await f.waitAck("stop_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining("unknown") });
    expect(await f.waitAck("resume_run_1")).toMatchObject({ status: "rejected", message: expect.stringContaining("unknown") });
    expect(f.started).toEqual([]); expect(f.stopped).toEqual([]); expect(f.model.forbidden).toEqual([]);
  });

  it("session loss during admission prevents startup and preserves its rejected duplicate outcome", async () => {
    const admission = gate(), model = admissionModel(), originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => { await admission.promise; return originalAdmit(request); });
    const f = fixture({ model }); f.send(command()); f.changeSession(); admission.resolve();
    expect(await f.waitAck("start_run_1")).toMatchObject({ status: "rejected", message: "test session lost" });
    f.send(command("run_1", "retry")); expect(await f.waitAck("retry")).toMatchObject({ status: "rejected", message: "test session lost" });
    expect(f.started).toEqual([]); expect(f.gitCalls).toEqual([]);
  });

  it("shutdown latches before a pending ordinary admission can start its adapter", async () => {
    const admission = gate(), model = admissionModel(), originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => { await admission.promise; return originalAdmit(request); });
    const f = fixture({ model }); f.send(command()); const closing = f.client.stop(true); admission.resolve(); await closing;
    expect(f.ack("start_run_1")).toMatchObject({ status: "rejected" }); expect(f.started).toEqual([]); expect(f.gitCalls).toEqual([]);
  });

  it("shutdown retains a finished stream's handle while waiting for another ordinary admission", async () => {
    const admission = gate(), streaming = gate(), stopping = gate(), model = admissionModel();
    const originalAdmit = model.admitStart.getMockImplementation()!;
    model.admitStart.mockImplementation(async (request) => {
      if (request.runId === "run_wait") await admission.promise;
      return originalAdmit(request);
    });
    const f = fixture({ model, streamGate: streaming, stopGate: stopping });
    f.send(command()); await f.waitAck("start_run_1"); f.send(command("run_wait")); await turn();
    let closed = false;
    const closing = f.client.stop(true).then(() => { closed = true; });
    streaming.resolve();
    await vi.waitFor(() => expect(f.received.some((message) => message.kind === "run.event" && message.run_id === "run_1"
      && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(true));
    await turn(); expect(f.stopped).toEqual([]); expect(closed).toBe(false);
    admission.resolve(); await vi.waitFor(() => expect(f.stopped).toEqual(["run_1"]));
    expect(f.stopHandles[0]).toBe(f.startHandles[0]); expect(closed).toBe(false);
    stopping.resolve(); await closing;
    expect(f.started.map((start) => start.runId)).toEqual(["run_1"]); expect(f.stopped).toHaveLength(1);
    expect(f.ack("start_run_wait")).toMatchObject({ status: "rejected" });
  });

  it("disabling new allocations still permits ordinary work and never admits a new allocated writer", async () => {
    const f = fixture({ allowNewAllocations: false }); f.send(allocated());
    expect(await f.waitAck("allocated_run_1")).toMatchObject({ status: "rejected", message: "New per-run allocations are disabled on this worker" });
    expect(f.model.admitStart).not.toHaveBeenCalled(); f.send(command("run_2"));
    expect(await f.waitAck("start_run_2")).toMatchObject({ status: "accepted" }); expect(f.started.map((value) => value.runId)).toEqual(["run_2"]);
    expect(f.model.forbidden).toEqual([]);
  });
});
