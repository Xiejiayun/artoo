// Real NodeClient dispatch with controlled source/native and transport boundaries.
// No native process, model provider, filesystem grant or product acceptance is simulated as real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStartCommandSchema, type NodeSideTransport, type NodeToServerMessage, type RuntimeAdapter,
  type ServerToNodeMessage } from "@artoo/protocol";
import { createNodeClient } from "./node-client.js";
import * as recoveryClient from "./source-recovery-client.js";
import * as recovery from "./windows-source-recovery.js";
import * as source from "./product-source-runtime.js";
import * as publication from "./product-release.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); }
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check: () => boolean) {
  await vi.waitFor(() => { expect(check()).toBe(true); }, { timeout: 5000, interval: 5 });
}
function fixture(options: { holdAck?: boolean; holdStop?: boolean; replay?: boolean; clean?: boolean } = {}) {
  let active = true, session: object | undefined = {}, receive!: (message: ServerToNodeMessage) => void;
  const originalSession = session;
  const entered = deferred(), startup = deferred(), ackEntered = deferred(), ackSend = deferred();
  const stopEntered = deferred(), stopAudit = deferred();
  if (!options.holdAck) ackSend.resolve();
  if (!options.holdStop) stopAudit.resolve();
  const messages: NodeToServerMessage[] = [];
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, async send(message) {
    if (message.kind === "command.ack" && message.command_id === "original") { ackEntered.resolve(); await ackSend.promise; }
    messages.push(message);
  }, subscribe(handler) { receive = handler; return () => {}; } };
  const runtime = Object.freeze({}) as recovery.PreparedWindowsSourceRecoveryRuntime;
  const sourceRuntime = Object.freeze({}) as source.PreparedProductSourceRuntime;
  const handle = vi.fn(async (message: ServerToNodeMessage) => {
    if (message.type === "run.start") { entered.resolve(); await startup.promise; }
    if (message.type === "run.stop") { stopEntered.resolve(); await stopAudit.promise; }
    return false;
  });
  const readRuntime = vi.fn(() => {
    if (session !== originalSession) throw Error("Controlled original session invalidated");
    return runtime;
  });
  const controller = { handle, readRuntime, isActive: () => active, allowsOrdinary: () => active,
    invalidate() { active = false; }, settled: async () => {} };
  const create = vi.spyOn(recoveryClient, "createProductSourceRecoveryClient")
    .mockReturnValue(controller as unknown as ReturnType<typeof recoveryClient.createProductSourceRecoveryClient>);
  const operation = vi.spyOn(recovery, "withWindowsSourceRecoveryOperation").mockImplementation((_runtime, _descriptor, work) => work());
  vi.spyOn(recovery, "readWindowsRecoverySourceRuntime").mockReturnValue(sourceRuntime);
  vi.spyOn(source, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
  const boundary = vi.spyOn(source, "assertProductSourceWorkspaceBoundary").mockImplementation(() => {});
  const publisher = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), requestStop: vi.fn(), getHealthReports: () => [],
    assertWorkspaceBoundary: vi.fn() };
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue(publisher as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const adapter: RuntimeAdapter = { runtimeId: "fixture", start: vi.fn(async () => { throw Error("Forbidden fixture execution"); }),
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node", adapter, transport, productSourceRecovery: { configuration: {} as never,
    features: [], isCurrent: () => session === originalSession, activate: () => sourceRuntime,
    ...(options.clean ? { cleanLifecycle: {} as never } : {}),
    ...(options.replay === false ? {} : { replaySession: () => session }) } });
  client.start(); create.mock.calls[0]![0].activate(runtime); operation.mockClear();
  const command = runStartCommandSchema.parse({ kind: "command", id: "original", type: "run.start", idempotency_key: "run:start",
    payload: { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: "C:/controlled" },
      context_pack: { id: "context", uri: "artoo://context/original" },
      policy_snapshot: { filesystem_write_scope: ["C:/controlled"], requires_approval: [] }, artifact_rules: { paths: [] } } });
  const start = (id = "original") => receive({ ...command, id });
  const ack = (id: string) => messages.find(message => message.kind === "command.ack" && message.command_id === id);
  cleanups.push(async () => { startup.resolve(); ackSend.resolve(); stopAudit.resolve(); await client.stop(true); });
  return { client, handle, readRuntime, operation, boundary, adapter, entered, startup, ackEntered, ackSend, messages, start, ack,
    stopEntered, stopAudit,
    disconnect() { session = {}; }, stop() { receive({ kind: "command", id: "stop", type: "run.stop", idempotency_key: "run:stop",
      payload: { run_id: "run", reason: "user_cancelled" } }); } };
}

describe("source startup replay before NodeClient audit", () => {
  it("joins retries before the original audit, then waits for its actual rejected ACK send", async () => {
    const f = fixture({ holdAck: true }); f.start(); await f.entered.promise;
    for (let index = 0; index < 8; index++) f.start(`retry-${index}`);
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).not.toHaveBeenCalled();
    expect(f.operation).not.toHaveBeenCalled(); expect(f.messages).toEqual([]);
    f.startup.resolve(); await f.ackEntered.promise;
    expect(f.readRuntime).toHaveBeenCalledTimes(1); expect(f.operation).toHaveBeenCalledTimes(1);
    expect(f.boundary).toHaveBeenCalledTimes(1); expect(f.messages).toEqual([]);
    f.ackSend.resolve(); await waitFor(() => !!f.ack("retry-7"));
    const original = f.ack("original"); expect(original).toMatchObject({ status: "rejected", error_code: "process_start_failed",
      message: "Product source runtime requires original Windows verified execution" });
    for (let index = 0; index < 8; index++) expect(f.ack(`retry-${index}`)).toEqual({ ...original, command_id: `retry-${index}` });
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.operation).toHaveBeenCalledTimes(1); expect(f.adapter.start).not.toHaveBeenCalled();
    f.start("late-retry"); await waitFor(() => !!f.ack("late-retry"));
    expect(f.ack("late-retry")).toEqual({ ...original, command_id: "late-retry" }); expect(f.handle).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending retry when its authenticated session changes", async () => {
    const f = fixture(); f.start(); await f.entered.promise; f.start("retry"); f.disconnect(); f.startup.resolve();
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("epoch/session") });
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.operation).not.toHaveBeenCalled(); expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("wakes a pending retry at run.stop before the original audit completes", async () => {
    const f = fixture(); f.start(); await f.entered.promise; f.start("retry"); f.stop();
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("stopped") });
    expect(f.ack("original")).toBeUndefined(); f.startup.resolve(); await waitFor(() => !!f.ack("original"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: expect.stringContaining("fenced by Stop") });
    expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("fences first startup while an earlier Stop still awaits its own source audit", async () => {
    const f = fixture({ holdStop: true }); f.stop(); await f.stopEntered.promise; f.start();
    await waitFor(() => !!f.ack("original"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: expect.stringContaining("fenced by Stop") });
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.handle.mock.calls[0]![0].type).toBe("run.stop");
    expect(f.readRuntime).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
    expect(f.boundary).not.toHaveBeenCalled(); expect(f.adapter.start).not.toHaveBeenCalled();
    f.stopAudit.resolve(); await waitFor(() => !!f.ack("stop"));
  });

  it.each(["no-session", "clean-lifecycle"])("keeps %s recovery clients on the original dispatch path", async variant => {
    const f = fixture({ replay: variant !== "no-session", clean: variant === "clean-lifecycle" }); f.start(); await f.entered.promise; f.start("retry");
    expect(f.handle).toHaveBeenCalledTimes(2); f.startup.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.readRuntime).toHaveBeenCalledTimes(2); expect(f.operation).toHaveBeenCalledTimes(2);
    expect(f.adapter.start).not.toHaveBeenCalled();
  });
});
