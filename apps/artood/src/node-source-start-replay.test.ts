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
import * as verification from "./verification.js";
import * as execution from "./process-adapter.js";
import { markWindowsNativeFailure, windowsNativeFailureDetail } from "./owned/windows-process-diagnostic.js";

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
function fixture(options: { holdAck?: boolean; holdStop?: boolean; replay?: boolean; clean?: boolean;
  acceptStart?: boolean; failAcceptedAck?: boolean } = {}) {
  let active = true, session: object | undefined = {}, receive!: (message: ServerToNodeMessage) => void;
  const originalSession = session;
  const entered = deferred(), startup = deferred(), ackEntered = deferred(), ackSend = deferred();
  const stopEntered = deferred(), stopAudit = deferred();
  if (!options.holdAck) ackSend.resolve();
  if (!options.holdStop) stopAudit.resolve();
  const messages: NodeToServerMessage[] = [], sendAttempts: NodeToServerMessage[] = [];
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, async send(message) {
    sendAttempts.push(message);
    if (message.kind === "command.ack" && message.command_id === "original") { ackEntered.resolve(); await ackSend.promise; }
    if (options.failAcceptedAck && message.kind === "command.ack" && message.command_id === "original" && message.status === "accepted") {
      throw Error("Controlled accepted ACK delivery failure");
    }
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
  const claim = vi.spyOn(source, "claimProductSourceRun").mockImplementation(() => {});
  const release = vi.spyOn(source, "releaseProductSourceRun").mockImplementation(() => {});
  if (options.acceptStart) {
    // Controlled admission/closure only, to reach the real NodeClient ACK path.
    // These local authority mocks do not qualify a native process or verifier.
    const profile: verification.PreparedVerificationProfile = { id: "profile", project_id: "project", workspace_root: "C:/controlled",
      commands: [], required_files: [], subject_paths: [], trustedFiles: [], digest: `sha256:${"a".repeat(64)}` };
    vi.spyOn(verification, "selectVerificationProfile").mockReturnValue(profile);
    vi.spyOn(execution, "bindWindowsVerifiedExecution").mockReturnValue({} as execution.WindowsVerifiedExecutionAdmission);
    vi.spyOn(execution, "assertWindowsVerifiedExecutionClosed").mockImplementation(() => {});
  }
  const publisher = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), requestStop: vi.fn(), getHealthReports: () => [],
    assertWorkspaceBoundary: vi.fn() };
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue(publisher as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const adapter: RuntimeAdapter = { runtimeId: "fixture", start: vi.fn(async () => {
    if (options.acceptStart) return { runId: "run" };
    throw Error("Forbidden fixture execution");
  }),
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node", adapter, transport, productSourceRecovery: { configuration: {} as never,
    features: [], isCurrent: () => session === originalSession, activate: () => sourceRuntime,
    ...(options.clean ? { cleanLifecycle: {} as never } : {}),
    ...(options.replay === false ? {} : { replaySession: () => session }) } });
  client.start(); create.mock.calls[0]![0].activate(runtime); operation.mockClear();
  const command = runStartCommandSchema.parse({ kind: "command", id: "original", type: "run.start", idempotency_key: "run:start",
    payload: { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: "C:/controlled" },
      context_pack: { id: "context", uri: "artoo://context/original" },
      policy_snapshot: { filesystem_write_scope: ["C:/controlled"], requires_approval: [] }, artifact_rules: { paths: [] },
      ...(options.acceptStart ? { verification: { version: 1, request_id: "verify", profile_id: "profile" } } : {}) } });
  const start = (id = "original") => receive({ ...command, id });
  const ack = (id: string) => messages.find(message => message.kind === "command.ack" && message.command_id === id);
  cleanups.push(async () => { startup.resolve(); ackSend.resolve(); stopAudit.resolve(); await client.stop(true); });
  return { client, handle, readRuntime, operation, boundary, claim, release, adapter, entered, startup, ackEntered, ackSend,
    messages, sendAttempts, start, ack,
    stopEntered, stopAudit,
    disconnect() { session = {}; }, stop() { receive({ kind: "command", id: "stop", type: "run.stop", idempotency_key: "run:stop",
      payload: { run_id: "run", reason: "user_cancelled" } }); } };
}

describe("source startup replay before NodeClient audit", () => {
  it.each(["readRuntime", "operation"] as const)("records a synchronous %s failure in the original ticket without repeating its audit", async point => {
    const f = fixture({ holdAck: true });
    const failure = markWindowsNativeFailure(new Error("Controlled synchronous source admission failure"), "native_timeout");
    f[point].mockImplementationOnce(() => { throw failure; });
    f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.ackEntered.promise;
    expect(f.messages).toEqual([]); expect(f.ack("retry")).toBeUndefined();
    expect(f.sendAttempts).toMatchObject([{ kind: "command.ack", command_id: "original", status: "rejected",
      error_code: "process_start_failed", message: expect.stringContaining('"code":"native_timeout"') }]);
    f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    const original = f.ack("original");
    expect(original).toMatchObject({ command_id: "original", status: "rejected", error_code: "process_start_failed" });
    expect(f.ack("retry")).toEqual({ ...original, command_id: "retry" });
    f.start("late-retry"); await waitFor(() => !!f.ack("late-retry"));
    expect(f.ack("late-retry")).toEqual({ ...original, command_id: "late-retry" });
    expect(f.sendAttempts.filter(message => message.kind === "command.ack" && message.command_id === "original")).toHaveLength(1);
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.operation).toHaveBeenCalledTimes(point === "operation" ? 1 : 0);
    expect(f.boundary).not.toHaveBeenCalled(); expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });

  it("does not replace a failed accepted ACK with a rejected original ACK after dispatch has begun", async () => {
    const f = fixture({ acceptStart: true, holdAck: true, failAcceptedAck: true });
    f.start(); await f.entered.promise; f.start("retry"); f.startup.resolve(); await f.ackEntered.promise;
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    expect(f.sendAttempts).toMatchObject([{ kind: "command.ack", command_id: "original", status: "accepted" }]);
    expect(f.ack("retry")).toBeUndefined(); f.ackSend.resolve();
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("ACK delivery failed") });
    await waitFor(() => f.release.mock.calls.length === 1);
    f.start("late-retry"); await waitFor(() => !!f.ack("late-retry"));
    expect(f.ack("late-retry")).toEqual({ ...f.ack("retry"), command_id: "late-retry" });
    expect(f.sendAttempts.filter(message => message.kind === "command.ack" && message.command_id === "original"))
      .toMatchObject([{ status: "accepted" }]);
    expect(f.ack("original")).toBeUndefined();
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.operation).toHaveBeenCalledTimes(1); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it("does not add an original rejection after dispatch entry and keeps a detached late ACK unknown to replay", async () => {
    const f = fixture({ acceptStart: true, holdAck: true });
    let dispatched: Promise<unknown> | undefined;
    f.operation.mockImplementationOnce((_runtime, _descriptor, work) => {
      dispatched = Promise.resolve(work());
      throw Error("Controlled failure after dispatch callback entry");
    });
    f.start(); f.startup.resolve(); await f.ackEntered.promise; f.ackSend.resolve(); await dispatched;
    expect(f.sendAttempts.filter(message => message.kind === "command.ack" && message.command_id === "original"))
      .toMatchObject([{ status: "accepted" }]);
    f.start("retry"); await waitFor(() => !!f.ack("retry"));
    // The scope error settled the ticket before detached dispatch first observed
    // its ACK. A later send cannot retroactively establish that ticket's outcome.
    expect(f.ack("retry")).toMatchObject({ status: "rejected", error_code: "process_start_failed",
      message: "Original source startup outcome remains unknown; original execution ownership is retained" });
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.operation).toHaveBeenCalledTimes(1); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "session"] as const)("keeps the %s fence ahead of a synchronous failure whose ACK is still pending", async fence => {
    const f = fixture({ holdAck: true });
    f.operation.mockImplementationOnce(() => { throw Error("Controlled original admission failure"); });
    f.start(); await f.entered.promise; f.start("retry"); f.startup.resolve(); await f.ackEntered.promise;
    if (fence === "stop") f.stop(); else f.disconnect();
    f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("stopped or no longer belongs") });
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Controlled original admission failure" });
    f.start("late-retry"); await waitFor(() => !!f.ack("late-retry"));
    expect(f.ack("late-retry")).toMatchObject({ status: "rejected", message: expect.stringMatching(/Stop|epoch|session/) });
    expect(f.adapter.start).not.toHaveBeenCalled(); expect(f.claim).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
    expect(f.handle.mock.calls.filter(([message]) => message.type === "run.start")).toHaveLength(1);
  });

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
    await waitFor(() => !!f.ack("original"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Controlled original session invalidated" });
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

describe("NodeClient native startup failure ACK diagnostics", () => {
  const suffix = (failure: { code: string; detail?: unknown }) => `\n[windows_native_failure.v1 ${JSON.stringify({ version: 1, ...failure })}]`;
  const nativeLine = JSON.stringify({ version: 1, kind: "native_failure_diagnostic", payload: {
    version: 1, phase: "guardian_response_read", code: "operation_cancelled", nativeError: null } }) + "\n";

  it("retains one locally tagged cause's code/detail pair without copying raw errors or private fields", async () => {
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(nativeLine))!;
    const leaf = markWindowsNativeFailure(Object.assign(new Error("private-cause-secret"), {
      stderr: "private-stderr-secret", stdout: "private-stdout-secret", argv: ["private-argv-secret"],
      env: { KEY: "private-env-secret" }, cwd: "C:/private-path-secret", token: "private-token-secret",
    }), "native_nonzero_exit", detail);
    const message = "Windows process bundle lacks synchronous local installation qualification";
    const wrapperDetail = windowsNativeFailureDetail("guardian_observer_sync", 3, Buffer.alloc(0))!;
    const error = markWindowsNativeFailure(new Error(message, { cause: leaf }), "native_qualification_failed", wrapperDetail);
    const f = fixture(); f.boundary.mockImplementationOnce(() => { throw error; });
    f.start(); await f.entered.promise; f.start("retry"); f.startup.resolve(); await waitFor(() => !!f.ack("retry"));
    const original = f.ack("original");
    expect(original).toMatchObject({ status: "rejected", error_code: "process_start_failed",
      message: message + suffix({ code: "native_nonzero_exit", detail }) });
    expect(f.ack("retry")).toEqual({ ...original, command_id: "retry" });
    expect(JSON.stringify(f.messages)).not.toContain("private-");
    expect(JSON.stringify(original)).not.toContain("guardian_observer_sync");
    expect(f.boundary).toHaveBeenCalledTimes(1); expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it.each(["no-detail", "rejected-stderr", "invalid-detail"] as const)("preserves the native category with %s and no raw cause output", async variant => {
    const detail = variant === "rejected-stderr"
      ? windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(nativeLine + "private-stderr-secret\n"))
      : undefined;
    const leaf = markWindowsNativeFailure(new Error("private-cause-secret"), "native_timeout",
      variant === "invalid-detail" ? { env: "private-env-secret" } as never : detail);
    const wrapper = markWindowsNativeFailure(new Error("Original qualification failed", { cause: leaf }), "native_qualification_failed",
      windowsNativeFailureDetail("guardian_observer_sync", 3, Buffer.alloc(0)));
    const f = fixture(); f.boundary.mockImplementationOnce(() => { throw wrapper; });
    f.start(); f.startup.resolve(); await waitFor(() => !!f.ack("original"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Original qualification failed"
      + suffix({ code: "native_timeout", ...(detail ? { detail } : {}) }) });
    expect(JSON.stringify(f.messages)).not.toContain("private-");
    expect(JSON.stringify(f.messages)).not.toContain("guardian_observer_sync");
  });

  it("does not treat copied diagnostic fields as local native authority or change an ordinary error message", async () => {
    const error = Object.assign(new Error("Ordinary process failure"), {
      native_failure_code: "native_timeout", native_failure_detail: { env: "private-env-secret" }, cause: Error("private-cause-secret"),
    });
    const f = fixture(); f.boundary.mockImplementationOnce(() => { throw error; });
    f.start(); f.startup.resolve(); await waitFor(() => !!f.ack("original"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Ordinary process failure" });
    expect(JSON.stringify(f.messages)).not.toContain("private-");
  });

  it("bounds a long native message while retaining the complete versioned suffix for original and replay ACKs", async () => {
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(nativeLine))!;
    const diagnostic = suffix({ code: "native_nonzero_exit", detail });
    const error = markWindowsNativeFailure(new Error("Original qualification failed: " + "x".repeat(9000)), "native_nonzero_exit", detail);
    const f = fixture(); f.boundary.mockImplementationOnce(() => { throw error; });
    f.start(); await f.entered.promise; f.start("retry"); f.startup.resolve(); await waitFor(() => !!f.ack("retry"));
    const original = f.ack("original");
    expect(original).toMatchObject({ status: "rejected", message: expect.stringMatching(/^Original qualification failed: /) });
    if (original?.kind !== "command.ack" || original.status !== "rejected") throw Error("Missing rejected original ACK");
    expect(original.message).toHaveLength(8192);
    expect(original.message.endsWith("\n[Startup diagnostic truncated]" + diagnostic)).toBe(true);
    expect(f.ack("retry")).toEqual({ ...original, command_id: "retry" });
  });
});
