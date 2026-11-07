// Production owner, lifecycle parser, wire schemas and private closure consumer.
// Spawn/process events, protected configuration and observer transport are explicitly
// controlled seams. These tests do not establish native Job or live-provider acceptance.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSupervisorLaunchV1Schema, SourceCleanStopIntentV1Schema, SourceCleanStopReceiptV1Schema,
  sourceCleanDigestV1, type SourceCleanStopIntentV1, type SourceSupervisedCleanClosureV1 } from "@artoo/domain";
import type { PreparedSourceLifecycleObserver } from "./source-lifecycle-observer.js";
import type { PreparedCleanSupervisorConfiguration } from "./windows-clean-local-configuration.js";
import { sourceRecoveryRequestFixture, recoveryFixtureSha as sha } from "./test-fixtures/source-recovery-request.js";

const local = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), stable: vi.fn(), capture: vi.fn(),
  identity: vi.fn(), failure: vi.fn(), bind: vi.fn(), prepare: vi.fn(), commit: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: local.spawn,
}));
vi.mock("./windows-clean-local-configuration.js", () => ({ readCleanSupervisorConfiguration: local.read,
  assertCleanStableDescriptor: local.stable, captureClosedSourceHistory: local.capture }));
vi.mock("./source-lifecycle-observer.js", () => ({ sourceLifecycleObserverIdentity: local.identity,
  sourceLifecycleObserverFailure: local.failure, bindSourceLifecycleLaunch: local.bind,
  prepareSourceCleanStop: local.prepare, commitSourceCleanStop: local.commit }));
import { startCleanWindowsSupervisor, consumeOriginalSupervisedCleanClosure,
  type PreparedSupervisedCleanClosure } from "./windows-clean-supervised-owner.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Command = { version: number; kind: string; nonce?: string; generation?: number;
  data?: string; env?: Record<string, string> };
class ControlledNativeChild extends EventEmitter {
  readonly commands: Command[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { write: vi.fn((bytes: string | Uint8Array,
    callback?: (error: Error | null) => void) => {
    this.commands.push(JSON.parse(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")) as Command);
    callback?.(null); return true;
  }) });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const observerId = "00000000-0000-4000-8000-000000000101";
const configuration = Object.freeze({ controlled: "configuration admission" }) as unknown as PreparedCleanSupervisorConfiguration;
const observer = Object.freeze({ controlled: "observer admission" }) as unknown as PreparedSourceLifecycleObserver;
const supervisor = { pid: 101, creationTime: "1000", image: join(process.cwd(), "controlled", "Supervisor.exe"), sid: "S-1-5-21-100" };
const daemon = { pid: 102, creationTime: "1001", image: join(process.cwd(), "controlled", "node.exe"), sid: supervisor.sid };
function fixture() {
  const old = sourceRecoveryRequestFixture();
  const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: observerId, supervisor,
    launch_identity_digest: sha("controlled original native launch"), runtime_manifest_digest: sha("controlled fixed runtime manifest"),
    stable: { version: 1, node_id: old.registration.binding.node_id, device_id: old.registration.binding.device_id,
      store_family_identity_digest: sha("controlled physical family"), genesis_store_identity_digest: old.registration.binding.store_identity_digest,
      workspace_root: old.registration.binding.workspace_root, workspace_identity_digest: old.registration.binding.workspace_identity_digest,
      stable_configuration_digest: sha("controlled protected configuration") } });
  const intent = SourceCleanStopIntentV1Schema.parse({ version: 1, stop_id: "00000000-0000-4000-8000-000000000102",
    lineage_id: "00000000-0000-4000-8000-000000000103", generation_id: "00000000-0000-4000-8000-000000000104",
    revision: 0, launch, registration: old.registration, origin: old.request.origin,
    goal_id: old.request.goal_id, plan_id: old.request.plan_id,
    authorization: { ...old.request.authorization, consent_id: null }, operations: old.request.operations });
  const pin = (name: string) => ({ path: join(process.cwd(), "controlled", name), bytes: 42, sha256: sha(name) });
  const fixed = { nodeId: launch.stable.node_id,
    env: { SystemRoot: join(process.cwd(), "controlled", "Windows"), ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: process.execPath },
    entry: pin("artood.mjs"), node: pin("node.exe"), nativeManifest: pin("native-manifest.json"), nativeImage: pin("Supervisor.exe"),
    localFile: pin("source.json"), lineageFile: pin("lineage.json"),
    runtimeManifest: { ...pin("bundle-manifest.json"), sha256: launch.runtime_manifest_digest } };
  return { launch, intent, fixed };
}
let facts: ReturnType<typeof fixture>, child: ControlledNativeChild;
let preparing: ReturnType<typeof deferred<SourceCleanStopIntentV1>>, committing: ReturnType<typeof deferred<void>>;
let closures: SourceSupervisedCleanClosureV1[];

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Only the standalone platform gate is controlled; no native admission is claimed.
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  facts = fixture(); child = new ControlledNativeChild(); closures = [];
  preparing = deferred<SourceCleanStopIntentV1>(); committing = deferred<void>(); committing.resolve();
  local.spawn.mockReturnValue(child); local.read.mockImplementation((token: unknown) => {
    expect(token).toBe(configuration); return facts.fixed;
  });
  local.identity.mockImplementation((token: unknown) => {
    expect(token).toBe(observer); return { observer_id: observerId, node_id: facts.fixed.nodeId, server_origin: "http://127.0.0.1" };
  });
  local.failure.mockReturnValue(new Promise<Error>(() => {}));
  local.stable.mockImplementation((token: unknown, value: unknown) => {
    expect(token).toBe(configuration); expect(value).toEqual(facts.launch.stable); return value;
  });
  local.bind.mockImplementation(async (token: unknown, value: unknown) => {
    expect(token).toBe(observer); expect(value).toEqual(facts.launch);
  });
  local.prepare.mockImplementation((token: unknown, options: { waitForAcceptedH6: boolean; signal: AbortSignal }) => {
    expect(token).toBe(observer); expect(options.waitForAcceptedH6).toBe(true);
    return new Promise<SourceCleanStopIntentV1>((resolve, reject) => {
      const abort = () => reject(Error("Controlled planned acceptance wait cancelled"));
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      preparing.promise.then(value => { options.signal.removeEventListener("abort", abort); resolve(value); },
        error => { options.signal.removeEventListener("abort", abort); reject(error); });
    });
  });
  local.capture.mockImplementation((token: unknown, intent: unknown) => {
    expect(token).toBe(configuration); expect(intent).toEqual(facts.intent);
    return { retained_history_digest: sha("controlled closed source history") };
  });
  local.commit.mockImplementation(async (token: PreparedSourceLifecycleObserver, closure: PreparedSupervisedCleanClosure) => {
    expect(token).toBe(observer);
    // Exercise the real private token consumer. The controlled transport cannot
    // produce the token from copied terminal JSON or an observation object.
    const value = consumeOriginalSupervisedCleanClosure(closure, token, facts.intent); closures.push(value);
    await committing.promise;
    return SourceCleanStopReceiptV1Schema.parse({ version: 1, stop_id: facts.intent.stop_id, lineage_id: facts.intent.lineage_id,
      generation_id: facts.intent.generation_id, intent_digest: value.intent_digest, closure_digest: sourceCleanDigestV1(value, sha),
      committed_event_id: "controlled-original-commit" });
  });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  const pendingTimers = vi.getTimerCount();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  expect(pendingTimers).toBe(0);
});

const flush = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
const arms = () => child.commands.filter(value => value.kind === "arm-graceful-stop");
const daemonInputs = () => child.commands.filter(value => value.kind === "daemon-input")
  .map(value => JSON.parse(Buffer.from(value.data!, "base64").toString("utf8")) as { kind: string });
function start() {
  const onReady = vi.fn();
  // The standalone check is synchronous. Restore the test worker's actual IPC
  // connection before any asynchronous observation or Vitest reporting.
  let owner: ReturnType<typeof startCleanWindowsSupervisor>;
  Object.defineProperty(process, "connected", { configurable: true, value: undefined });
  try { owner = startCleanWindowsSupervisor({ configuration, observer, manageStopSignals: false, onReady }); }
  finally {
    if (originalConnected) Object.defineProperty(process, "connected", originalConnected);
    else Reflect.deleteProperty(process, "connected");
  }
  const nonce = child.commands[0]!.env!.ARTOO_SUPERVISED_CONTROL_NONCE!;
  let sequence = 0;
  const frame = (kind: string, payload: unknown) => child.stdout.emit("data",
    Buffer.from(JSON.stringify({ version: 1, sequence: sequence++, kind, payload }) + "\n"));
  const output = (prefix: string, value: unknown) => frame("daemon_output", { generation: 0, stream: "stdout",
    data: Buffer.from(prefix + JSON.stringify(value) + "\n").toString("base64") });
  const lifecycleOutput = (kind: "ready" | "stopped", exitCode?: number) => output("ARTOO_SUPERVISED_V1 ",
    { version: 1, kind, nonce, pid: daemon.pid, ...(exitCode === undefined ? {} : { exitCode }) });
  const started = (bufferedReady = false) => {
    child.emit("spawn");
    const values: { kind: string; payload: unknown }[] = [{ kind: "supervisor_ready", payload: { capability: "artoo.windows-daemon-supervisor.v1", supervisor,
      launchIdentityDigest: facts.launch.launch_identity_digest,
      lifetimeOwnership: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", cleanupTimeoutMs: 15000,
        gracefulStopMs: 45000, sharedJob: true, runtimeManifest: facts.fixed.runtimeManifest } } },
    { kind: "daemon_started", payload: { generation: 0, daemon, launchIdentityDigest: facts.launch.launch_identity_digest, atomicJobMember: true } }];
    if (bufferedReady) {
      // Adversarial buffered frames arrive in one original stdout callback,
      // before armStop can resume from its daemon_started promise.
      const line = "ARTOO_SOURCE_LIFECYCLE_V1 " + JSON.stringify({ version: 1, kind: "source-lifecycle", nonce,
        pid: daemon.pid, launch: facts.launch }) + "\n" + "ARTOO_SUPERVISED_V1 "
        + JSON.stringify({ version: 1, kind: "ready", nonce, pid: daemon.pid }) + "\n";
      values.push({ kind: "daemon_output", payload: { generation: 0, stream: "stdout", data: Buffer.from(line).toString("base64") } });
    }
    child.stdout.emit("data", Buffer.from(values.map(value => JSON.stringify({ version: 1, sequence: sequence++, ...value }) + "\n").join("")));
  };
  const registered = async () => {
    started(); output("ARTOO_SOURCE_LIFECYCLE_V1 ", { version: 1, kind: "source-lifecycle", nonce, pid: daemon.pid, launch: facts.launch });
    await vi.waitFor(() => expect(daemonInputs().filter(value => value.kind === "source-lifecycle-bound")).toHaveLength(1));
    lifecycleOutput("ready"); await owner.ready;
  };
  const nativeStopped = (terminal = true) => {
    const arm = arms()[0]!;
    frame("command_ack", { nonce: arm.nonce, kind: arm.kind, generation: arm.generation });
    expect(daemonInputs().filter(value => value.kind === "shutdown")).toHaveLength(1);
    lifecycleOutput("stopped", 0);
    frame("daemon_exit", { generation: 0, daemon, rootWaitObserved: true, exitCode: 0, exitTime: "2000", stdoutEof: true, stderrEof: true });
    if (terminal) frame("supervisor_stopped", { reason: "stopped", facts: { launchIdentityDigest: facts.launch.launch_identity_digest,
      incarnations: [{ generation: 0, daemon, rootWaitObserved: true, exitCode: 0, stdoutEof: true, stderrEof: true, atomicJobMember: true }],
      lifetimeClosure: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", jobCreated: true,
        allRootsWaitObserved: true, jobEmptyObserved: true, allStdoutEof: true, allStderrEof: true, cleanupConfirmed: true,
        gracefulStopArmed: true, gracefulStopTimedOut: false, forcedJobTermination: false } } });
  };
  const exit = (code = 0) => { child.exitCode = code; child.emit("exit", code, null); };
  const eof = () => { child.stdout.emit("end"); child.stderr.emit("end"); };
  const close = (code = 0) => { child.emit("close", code, null); };
  const originalClosed = () => { exit(); eof(); close(); };
  return { owner, onReady, started, registered, frame, nativeStopped, exit, eof, close, originalClosed };
}

describe("clean supervisor owner sequencing with controlled process observations", () => {
  it("stops before readiness without H6, waits for actual daemon_started, and settles the planned wait", async () => {
    const f = start(), transition = f.owner.transitionAfterAcceptedH6();
    const notReady = expect(f.owner.ready).rejects.toThrow("User stopped");
    const stopping = f.owner.stop(); await flush();
    expect(arms()).toHaveLength(0); expect(local.prepare).not.toHaveBeenCalled();
    f.started(); await stopping; await transition; await notReady;
    expect(arms()).toHaveLength(1); expect(local.bind).not.toHaveBeenCalled();
    f.nativeStopped(); f.originalClosed();
    await expect(f.owner.completion).resolves.toEqual({ reason: "user-stop" });
    expect(local.capture).not.toHaveBeenCalled(); expect(local.commit).not.toHaveBeenCalled();
  });

  it("keeps Stop latched when started, descriptor and ready arrive in one original stdout chunk", async () => {
    const f = start(), transition = f.owner.transitionAfterAcceptedH6();
    const notReady = expect(f.owner.ready).rejects.toThrow("User stopped");
    const stopping = f.owner.stop(); f.started(true);
    await stopping; await transition; await notReady; await flush();
    expect(f.onReady).not.toHaveBeenCalled(); expect(local.prepare).not.toHaveBeenCalled(); expect(arms()).toHaveLength(1);
    f.nativeStopped(); f.originalClosed();
    await expect(f.owner.completion).resolves.toEqual({ reason: "user-stop" });
    expect(local.commit).not.toHaveBeenCalled();
  });

  it("does not arm while acceptance is pending and preserves a rejected preparation", async () => {
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6(); await flush();
    expect(local.prepare).toHaveBeenCalledOnce(); expect(arms()).toHaveLength(0);
    const rejected = expect(transition).rejects.toThrow("Controlled H6 not accepted");
    const closed = expect(f.owner.completion).rejects.toThrow("Controlled H6 not accepted");
    preparing.reject(Error("Controlled H6 not accepted")); await rejected;
    expect(arms()).toHaveLength(0); expect(child.commands.filter(value => value.kind === "stop")).toHaveLength(1);
    f.originalClosed(); await closed;
    expect(local.capture).not.toHaveBeenCalled(); expect(local.commit).not.toHaveBeenCalled();
  });

  it("rejects an intent from a different launch before graceful arm", async () => {
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6();
    const rejected = expect(transition).rejects.toThrow("lost its original live launch");
    const closed = expect(f.owner.completion).rejects.toThrow("lost its original live launch");
    preparing.resolve({ ...facts.intent, launch: { ...facts.launch, launch_identity_digest: sha("different launch") } });
    await rejected; expect(arms()).toHaveLength(0);
    f.originalClosed(); await closed; expect(local.commit).not.toHaveBeenCalled();
  });

  it("cancels a pending accepted-H6 wait on user stop and cannot adopt its later result", async () => {
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6(); await flush();
    const signal = local.prepare.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false); expect(arms()).toHaveLength(0);
    await f.owner.stop(); await transition;
    expect(signal.aborted).toBe(true); expect(arms()).toHaveLength(1);
    preparing.resolve(facts.intent); await flush();
    f.nativeStopped(); f.originalClosed();
    await expect(f.owner.completion).resolves.toEqual({ reason: "user-stop" });
    expect(local.capture).not.toHaveBeenCalled(); expect(local.commit).not.toHaveBeenCalled();
  });

  it("joins terminal, original exit, both EOFs and close before consuming one closure and awaiting its receipt", async () => {
    committing = deferred<void>();
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6(); preparing.resolve(facts.intent); await transition;
    expect(arms()).toHaveLength(1); f.nativeStopped(); await flush();
    expect(local.commit).not.toHaveBeenCalled();
    f.exit(); await flush(); expect(local.commit).not.toHaveBeenCalled();
    child.stdout.emit("end"); await flush(); expect(local.commit).not.toHaveBeenCalled();
    child.stderr.emit("end"); await flush(); expect(local.commit).not.toHaveBeenCalled();
    let completed = false; void f.owner.completion.then(() => { completed = true; });
    f.close(); await flush();
    expect(local.commit).toHaveBeenCalledOnce(); expect(completed).toBe(false);
    expect(closures[0]!.parent).toEqual({ spawned: true, exited: true, closed: true, stdout_eof: true,
      stderr_eof: true, exit_code: 0, close_code: 0, signal: null, close_signal: null, inputs_unchanged: true });
    const token = local.commit.mock.calls[0]![1] as PreparedSupervisedCleanClosure;
    expect(() => consumeOriginalSupervisedCleanClosure(token, observer, facts.intent)).toThrow("unconsumed");
    committing.resolve();
    await expect(f.owner.completion).resolves.toMatchObject({ reason: "planned-transition", receipt: { stop_id: facts.intent.stop_id } });
    expect(local.capture).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["before native closure", "during receipt commit"] as const)
  ("retains a prepared receipt but returns user-stop when Stop arrives %s", async when => {
    committing = deferred<void>();
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6(); preparing.resolve(facts.intent); await transition;
    if (when === "before native closure") await f.owner.stop();
    f.nativeStopped(); f.originalClosed(); await flush(); expect(local.commit).toHaveBeenCalledOnce();
    if (when === "during receipt commit") await f.owner.stop();
    committing.resolve();
    await expect(f.owner.completion).resolves.toMatchObject({ reason: "user-stop", receipt: { stop_id: facts.intent.stop_id } });
    expect(arms()).toHaveLength(1); expect(local.commit).toHaveBeenCalledOnce();
  });

  it.each(["exit", "stdout EOF", "stderr EOF", "nonzero exit", "close mismatch", "terminal"] as const)
  ("never captures history or commits when original %s closure is unconfirmed", async missing => {
    const f = start(); await f.registered();
    const transition = f.owner.transitionAfterAcceptedH6(); preparing.resolve(facts.intent); await transition;
    const rejected = expect(f.owner.completion).rejects.toThrow();
    f.nativeStopped(missing !== "terminal");
    if (missing !== "exit") f.exit(missing === "nonzero exit" ? 1 : 0);
    if (missing !== "stdout EOF") child.stdout.emit("end");
    if (missing !== "stderr EOF") child.stderr.emit("end");
    f.close(missing === "close mismatch" ? 1 : 0); await rejected;
    expect(local.capture).not.toHaveBeenCalled(); expect(local.commit).not.toHaveBeenCalled();
  });
});
