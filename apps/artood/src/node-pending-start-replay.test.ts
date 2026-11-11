// Real NodeClient dispatch with controlled verifier/adapter boundaries. These
// regressions do not qualify native execution or establish a live hang's cause.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStartCommandSchema, type NodeSideTransport, type NodeToServerMessage, type RuntimeAdapter,
  type ServerToNodeMessage } from "@artoo/protocol";
import { createNodeClient, type NodeClientOptions } from "./node-client.js";
import * as verification from "./verification.js";
import * as execution from "./process-adapter.js";
import * as publication from "./product-release.js";
import * as recoveryClient from "./source-recovery-client.js";
import * as recovery from "./windows-source-recovery.js";
import * as source from "./product-source-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitFor(check: () => boolean) { await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 5 }); }

function fixture(options: { manual?: boolean; replay?: boolean; holdAck?: boolean; failStart?: boolean; failAck?: boolean;
  cleanRecovery?: boolean; holdRetryAck?: boolean } = {}) {
  let session: object | undefined = {}, receive!: (message: ServerToNodeMessage) => void;
  const readSession = vi.fn(() => session);
  const entered = deferred(), startup = deferred(), ackEntered = deferred(), ackSend = deferred(), stream = deferred(), streamDone = deferred();
  const retryEntered = deferred(), retrySend = deferred();
  if (!options.holdAck) ackSend.resolve();
  if (!options.holdRetryAck) retrySend.resolve();
  const sent: NodeToServerMessage[] = [], attempts: NodeToServerMessage[] = [];
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, async send(message) {
    attempts.push(message);
    if (message.kind === "command.ack" && message.command_id === "original") {
      ackEntered.resolve(); await ackSend.promise;
      if (options.failAck) throw Error("Controlled original ACK delivery failure");
    }
    if (message.kind === "command.ack" && message.command_id === "retry" && message.status === "accepted") {
      retryEntered.resolve(); await retrySend.promise;
    }
    sent.push(message);
  }, subscribe(handler) { receive = handler; return () => {}; } };
  const profile: verification.PreparedVerificationProfile = { id: "profile", project_id: "project", workspace_root: "C:/controlled",
    commands: [], required_files: [], subject_paths: [], trustedFiles: [], digest: `sha256:${"a".repeat(64)}` };
  const audit = vi.spyOn(verification, "selectVerificationProfile").mockImplementation(payload => payload.verification ? profile : undefined);
  vi.spyOn(execution, "bindWindowsVerifiedExecution").mockReturnValue({} as execution.WindowsVerifiedExecutionAdmission);
  vi.spyOn(execution, "assertWindowsVerifiedExecutionClosed").mockImplementation(() => {});
  const boundary = vi.fn();
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    requestStop: vi.fn(), getHealthReports: () => [], assertWorkspaceBoundary: boundary } as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const adapter: RuntimeAdapter = { runtimeId: "fixture", start: vi.fn(async () => {
    entered.resolve(); await startup.promise;
    if (options.failStart) throw Error("Controlled original startup failure");
    return { runId: "run" };
  }), async *streamEvents() { stream.resolve(); await streamDone.promise; },
    stop: vi.fn(async () => { streamDone.resolve(); }), async collectArtifacts() { return []; } };
  const runtime = Object.freeze({}) as recovery.PreparedWindowsSourceRecoveryRuntime;
  const sourceRuntime = Object.freeze({}) as source.PreparedProductSourceRuntime;
  const recoveryHandle = vi.fn(async () => false), recoveryRead = vi.fn(() => runtime), sourceBoundary = vi.fn();
  let activateRecovery: (() => void) | undefined;
  if (options.cleanRecovery) {
    vi.spyOn(recoveryClient, "createProductSourceRecoveryClient").mockImplementation(config => {
      activateRecovery = () => config.activate(runtime);
      return { handle: recoveryHandle, readRuntime: recoveryRead, isActive: () => true, allowsOrdinary: () => true,
        invalidate() {}, settled: async () => {} } as unknown as ReturnType<typeof recoveryClient.createProductSourceRecoveryClient>;
    });
    vi.spyOn(recovery, "withWindowsSourceRecoveryOperation").mockImplementation((_runtime, _descriptor, work) => work());
    vi.spyOn(recovery, "readWindowsRecoverySourceRuntime").mockReturnValue(sourceRuntime);
    vi.spyOn(source, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
    vi.spyOn(source, "assertProductSourceWorkspaceBoundary").mockImplementation(sourceBoundary);
    vi.spyOn(source, "claimProductSourceRun").mockImplementation(() => {});
    vi.spyOn(source, "releaseProductSourceRun").mockImplementation(() => {});
  }
  const localOptions: NodeClientOptions = { nodeId: "node", adapter, transport,
    ...(options.cleanRecovery ? { productSourceRecovery: { configuration: {} as never, cleanLifecycle: {} as never,
      features: [], isCurrent: () => !!session, activate: () => sourceRuntime, replaySession: () => session } } : {}),
    ...(options.replay === false ? {} : { startupReplaySession: readSession }) };
  const client = createNodeClient(localOptions); client.start(); activateRecovery?.();
  const command = runStartCommandSchema.parse({ kind: "command", id: "original", type: "run.start", idempotency_key: "run:start",
    payload: { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: "C:/controlled" },
      context_pack: { id: "context", uri: "artoo://context/original" },
      policy_snapshot: { filesystem_write_scope: ["C:/controlled"], requires_approval: [] }, artifact_rules: { paths: [] },
      ...(options.manual ? {} : { verification: { version: 1, request_id: "verify", profile_id: "profile" } }) } });
  const start = (id = "original") => receive({ ...command, id });
  const ack = (id: string) => sent.find(message => message.kind === "command.ack" && message.command_id === id);
  cleanups.push(async () => { startup.resolve(); ackSend.resolve(); retrySend.resolve(); streamDone.resolve(); await client.stop(true); });
  return { client, command, receive, start, ack, audit, boundary, adapter, entered, startup, ackEntered, ackSend, stream, streamDone, sent, attempts,
    recoveryHandle, recoveryRead, sourceBoundary, readSession, retryEntered, retrySend,
    currentSession: () => session,
    changeSession(value: object | undefined) { session = value; }, stop() { receive({ kind: "command", id: "stop", type: "run.stop",
      idempotency_key: "run:stop", payload: { run_id: "run", reason: "user_cancelled" } }); } };
}

describe("ordinary verified pending-start replay", () => {
  it("performs the original full audits once for 256 identical pending retransmissions", async () => {
    const f = fixture({ holdAck: true }); f.start(); await f.entered.promise;
    for (let index = 0; index < 256; index++) f.start("retry");
    await settle();
    expect(f.audit).toHaveBeenCalledTimes(1); expect(f.boundary).toHaveBeenCalledTimes(1);
    expect(f.adapter.start).toHaveBeenCalledTimes(1); expect(f.sent).toEqual([]);
    f.startup.resolve(); await f.ackEntered.promise; expect(f.ack("retry")).toBeUndefined();
    f.ackSend.resolve(); await f.stream.promise; await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toEqual({ ...f.ack("original"), command_id: "retry" });
    // This is a startup wait, not a retained approval or a wait for the full run.
    f.start("after-start"); await waitFor(() => !!f.ack("after-start"));
    expect(f.audit).toHaveBeenCalledTimes(2); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it("joins clean-lifecycle retries before the original recovery and workspace audits", async () => {
    const f = fixture({ cleanRecovery: true, holdAck: true }); f.start(); await f.entered.promise;
    for (let index = 0; index < 256; index++) f.start("retry");
    await settle(); expect(f.recoveryHandle).toHaveBeenCalledTimes(1); expect(f.recoveryRead).toHaveBeenCalledTimes(1);
    expect(f.sourceBoundary).toHaveBeenCalledTimes(1); expect(f.audit).toHaveBeenCalledTimes(1); expect(f.sent).toEqual([]);
    f.startup.resolve(); await f.ackEntered.promise; f.ackSend.resolve(); await f.stream.promise;
    await waitFor(() => !!f.ack("retry")); expect(f.ack("retry")).toEqual({ ...f.ack("original"), command_id: "retry" });
    f.start("after-start"); await waitFor(() => !!f.ack("after-start"));
    expect(f.recoveryRead).toHaveBeenCalledTimes(2); expect(f.sourceBoundary).toHaveBeenCalledTimes(2);
    expect(f.audit).toHaveBeenCalledTimes(2); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it("joins identical original reply IDs until the actual original ACK settles", async () => {
    const f = fixture({ holdAck: true }); f.start(); await f.entered.promise;
    for (let index = 0; index < 256; index++) f.start();
    await settle(); expect(f.attempts).toEqual([]); expect(f.audit).toHaveBeenCalledTimes(1);
    f.startup.resolve(); await f.ackEntered.promise;
    expect(f.attempts).toHaveLength(1); f.ackSend.resolve(); await f.stream.promise;
    await waitFor(() => f.sent.filter(message => message.kind === "command.ack").length === 2);
    expect(f.sent[0]).toEqual(f.sent[1]);
  });

  it("keeps the original reply identity when an in-memory caller mutates its retry during startup", async () => {
    const f = fixture(); f.start(); await f.entered.promise;
    const retry = structuredClone(f.command); retry.id = "retry"; f.receive(retry);
    retry.id = "mutated-reply"; retry.payload.context_pack.uri = "artoo://context/mutated";
    f.startup.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toEqual({ ...f.ack("original"), command_id: "retry" });
    expect(f.ack("mutated-reply")).toBeUndefined(); expect(f.audit).toHaveBeenCalledTimes(1);
  });

  it("retains a pending retry send's reply identity after the original ACK has settled", async () => {
    const f = fixture({ holdRetryAck: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.retryEntered.promise;
    expect(f.ack("original")).toMatchObject({ status: "accepted" }); expect(f.ack("retry")).toBeUndefined();
    const other = structuredClone(f.command); other.id = "retry";
    other.payload.run_id = "other-run"; other.idempotency_key = "other-run:start";
    f.receive(other); await waitFor(() => !!f.ack("retry"));
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("belongs to another") });
    expect(f.adapter.start).toHaveBeenCalledTimes(1); f.retrySend.resolve();
  });

  it("joins only an exactly bound pending reply send while new requests still take full audits", async () => {
    const f = fixture({ holdRetryAck: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.retryEntered.promise;
    f.start("after-start"); // A separate admission may coexist with the old reply owner.
    for (let index = 0; index < 256; index++) f.start("retry");
    await waitFor(() => !!f.ack("after-start"));
    expect(f.audit).toHaveBeenCalledTimes(2);
    expect(f.attempts.filter(message => message.kind === "command.ack" && message.command_id === "retry")).toHaveLength(1);
    const changed = structuredClone(f.command); changed.id = "retry"; changed.payload.context_pack.uri = "artoo://context/changed";
    f.receive(changed); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("changed payload") });
    expect(f.audit).toHaveBeenCalledTimes(2);
    f.retrySend.resolve();
    const acceptedRetries = () => f.sent.filter(message => message.kind === "command.ack" && message.command_id === "retry" && message.status === "accepted");
    await waitFor(() => acceptedRetries().length === 1); await settle();
    f.start("retry"); await waitFor(() => acceptedRetries().length === 2);
    expect(f.audit).toHaveBeenCalledTimes(3); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, {}])("rejects an old pending reply send after its socket identity changes to %s", async identity => {
    const f = fixture({ holdRetryAck: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.retryEntered.promise; f.changeSession(identity); f.start("retry");
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("session") });
    expect(f.audit).toHaveBeenCalledTimes(1); f.retrySend.resolve();
  });

  it.each(["context", "verification", "scope", "artifact", "runtime", "envelope", "deadline", "unknown", "remove-verification", "reply-alias"])(
    "rejects a changed %s before joining a pending reply or repeating an audit", async change => {
      const f = fixture(); f.start(); await f.entered.promise; f.start("retry");
      const changed = structuredClone(f.command); changed.id = "retry";
      if (change === "context") changed.payload.context_pack.uri = "artoo://context/changed";
      if (change === "verification") changed.payload.verification!.request_id = "other";
      if (change === "scope") changed.payload.policy_snapshot.filesystem_write_scope.push("C:/other");
      if (change === "artifact") changed.payload.artifact_rules.paths.push("other");
      if (change === "runtime") changed.payload.runtime = "other";
      if (change === "envelope") changed.idempotency_key = "other:start";
      if (change === "deadline") changed.deadline_at = "2099-01-01T00:00:00.000Z";
      if (change === "unknown") Object.assign(changed.payload, { unknown_authority: true });
      if (change === "remove-verification") delete changed.payload.verification;
      if (change === "reply-alias") { changed.payload.run_id = "other"; changed.idempotency_key = "other:start"; delete changed.payload.verification; }
      f.receive(changed); await waitFor(() => !!f.ack("retry"));
      expect(f.ack("retry")).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
      expect(f.audit).toHaveBeenCalledTimes(1); expect(f.adapter.start).toHaveBeenCalledTimes(1);
      f.startup.resolve(); await f.stream.promise;
      await waitFor(() => f.sent.filter(message => message.kind === "command.ack" && message.command_id === "retry").length === 2);
    });

  it.each(["changed", "missing", "disconnect-hook"])("fences pending waiters when their session is %s", async variant => {
    const f = fixture(); f.start(); await f.entered.promise; f.start("retry"); await settle();
    f.changeSession(variant === "changed" ? {} : undefined);
    if (variant === "disconnect-hook") f.client.invalidatePendingStartupReplay?.(); else f.start("new-session-retry");
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringMatching(/session|stopped/) });
    expect(f.ack("original")).toBeUndefined(); expect(f.audit).toHaveBeenCalledTimes(1);
    // Disconnecting retries neither claims process closure nor invokes stop.
    expect(f.adapter.stop).not.toHaveBeenCalled();
    f.startup.resolve(); await f.stream.promise; await settle();
    expect(f.sent.filter(message => message.kind === "command.ack" && message.command_id === "retry" && message.status === "accepted")).toEqual([]);
  });

  it("rechecks the socket after the original ACK even without a disconnect notification", async () => {
    const f = fixture({ holdAck: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.ackEntered.promise; f.changeSession({}); f.ackSend.resolve();
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringMatching(/session|stopped/) });
    expect(f.audit).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "disconnect"])("rechecks %s between replay outcome resolution and its actual send", async fence => {
    const f = fixture({ holdAck: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.ackEntered.promise;
    f.readSession.mockImplementationOnce(() => {
      const original = f.currentSession();
      queueMicrotask(() => {
        if (fence === "stop") f.stop();
        else { f.changeSession(undefined); f.client.invalidatePendingStartupReplay?.(); }
      });
      return original;
    });
    f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("original")).toMatchObject({ status: "accepted" });
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringMatching(/session|stopped/) });
    expect(f.audit).toHaveBeenCalledTimes(1); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it("Stop wakes retries before startup finishes and preserves the actual stop/closure path", async () => {
    const f = fixture(); f.start(); await f.entered.promise; f.start("retry"); f.stop();
    await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringMatching(/Stop|stopped/) });
    expect(f.ack("stop")).toBeUndefined(); expect(f.adapter.stop).not.toHaveBeenCalled();
    f.start("after-stop"); await waitFor(() => !!f.ack("after-stop"));
    expect(f.ack("after-stop")).toMatchObject({ status: "rejected" }); expect(f.audit).toHaveBeenCalledTimes(1);
    f.startup.resolve(); await waitFor(() => !!f.ack("stop"));
    expect(f.adapter.stop).toHaveBeenCalledTimes(1); expect(f.ack("stop")).toMatchObject({ status: "accepted" });
  });

  it("client shutdown wakes retries while retaining the original startup until it closes", async () => {
    const f = fixture(); f.start(); await f.entered.promise; f.start("retry");
    const stopped = f.client.stop(true);
    await waitFor(() => !!f.ack("retry")); expect(f.ack("retry")).toMatchObject({ status: "rejected" });
    expect(f.adapter.stop).not.toHaveBeenCalled(); f.startup.resolve(); await stopped;
    expect(f.adapter.stop).toHaveBeenCalledTimes(1);
  });

  it("replays the original startup rejection only after its actual ACK send", async () => {
    const f = fixture({ holdAck: true, failStart: true }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.ackEntered.promise;
    expect(f.ack("retry")).toBeUndefined(); f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Controlled original startup failure" });
    expect(f.ack("retry")).toEqual({ ...f.ack("original"), command_id: "retry" });
    expect(f.adapter.start).toHaveBeenCalledTimes(1); expect(f.audit).toHaveBeenCalledTimes(1);
  });

  it("propagates synchronous original audit rejection while its ACK send is pending", async () => {
    const f = fixture({ holdAck: true }); f.audit.mockImplementationOnce(() => { throw Error("Controlled verifier audit failure"); });
    f.start(); await f.ackEntered.promise; f.start("retry"); await settle();
    expect(f.audit).toHaveBeenCalledTimes(1); expect(f.ack("retry")).toBeUndefined();
    f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("original")).toMatchObject({ status: "rejected", message: "Controlled verifier audit failure" });
    expect(f.ack("retry")).toEqual({ ...f.ack("original"), command_id: "retry" });
    expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps failed original ACK delivery uncertain (startup rejection: %s)", async failStart => {
    const f = fixture({ holdAck: true, failAck: true, failStart }); f.start(); await f.entered.promise; f.start("retry");
    f.startup.resolve(); await f.ackEntered.promise; f.ackSend.resolve(); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("original")).toBeUndefined();
    expect(f.ack("retry")).toMatchObject({ status: "rejected", message: expect.stringContaining("ACK delivery failed") });
    expect(f.attempts.filter(message => message.kind === "command.ack" && message.command_id === "original")).toHaveLength(1);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });

  it("bounds distinct pending replay waiters without dropping original ownership", async () => {
    const f = fixture(); f.start(); await f.entered.promise;
    for (let index = 0; index < 65; index++) f.start(`retry-${index}`);
    await waitFor(() => !!f.ack("retry-64"));
    expect(f.ack("retry-64")).toMatchObject({ status: "rejected", message: expect.stringContaining("waiter capacity") });
    expect(f.audit).toHaveBeenCalledTimes(1); expect(f.adapter.start).toHaveBeenCalledTimes(1);
    f.startup.resolve(); await waitFor(() => !!f.ack("retry-63"));
    expect(f.ack("retry-63")).toEqual({ ...f.ack("original"), command_id: "retry-63" });
  });

  it.each(["manual", "no-option"])("preserves the existing %s path", async variant => {
    const f = fixture({ manual: variant === "manual", replay: variant !== "no-option" });
    if (variant === "manual") f.command.idempotency_key = "custom-manual-key";
    f.start(); await f.entered.promise; f.start("retry"); await waitFor(() => !!f.ack("retry"));
    expect(f.ack("retry")).toMatchObject({ status: "accepted" }); expect(f.audit).toHaveBeenCalledTimes(2);
    expect(f.ack("original")).toBeUndefined(); expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });
});
