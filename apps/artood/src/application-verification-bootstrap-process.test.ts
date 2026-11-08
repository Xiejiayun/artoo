// Controlled ChildProcess events only: no native host, filesystem admission,
// application runtime or product qualification is exercised by this suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import type { ApplicationInstallationPlan } from "./application-installation.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import type { PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), realpath: vi.fn(), createOwner: vi.fn(), auditInstallation: vi.fn(),
  readProfile: vi.fn(), readCandidate: vi.fn(), describeBackend: vi.fn(), readPin: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(),
  realpathSync: Object.assign(vi.fn(), { native: mocked.realpath }) }));
vi.mock("./application-installation.js", () => ({ createApplicationInstallationOwner: mocked.createOwner, auditApplicationInstallation: mocked.auditInstallation }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: mocked.readProfile }));
vi.mock("./application-verification-candidate.js", () => ({ readApplicationVerificationCandidate: mocked.readCandidate }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: mocked.describeBackend }));
vi.mock("./application-runtime-installation.js", () => ({ readApplicationRuntimePin: mocked.readPin }));
import { initializeApplicationVerificationStore, readApplicationVerificationStore, startApplicationVerificationService,
  type InitializedApplicationVerificationStore } from "./application-verification-bootstrap-process.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const pin = (path: string): ApplicationRuntimeFilePin => ({ path, bytes: 18, sha256: sha("controlled fixture") });
// These synthetic paths are absolute to both path implementations. Prepared
// local admission is mocked; the real status and file-pin schemas remain active.
const root = "/controlled", systemRoot = `${root}/Windows`, nodeId = "controlled-node";
const storeId = "11111111-1111-4111-8111-111111111111";
const profile = Object.freeze({}) as PreparedApplicationVerificationProfile;
const candidate = Object.freeze({}) as PreparedApplicationVerificationCandidate;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
const configured = {
  config: { node: pin(`${root}/toolchain/node.exe`), hostManifest: pin(`${root}/host/application-service-host-manifest.json`),
    installation_parent: `${root}/installations`, selection_parent: `${root}/selections`, origin: "http://127.0.0.1:31000" },
  roots: [`${root}/workspace`], hostEntry: pin(`${root}/host/application-service-bootstrap.mjs`),
};
const native = { directory: `${root}/native`, manifestSha256: sha("controlled backend") };
const candidateRecord = { manifest: pin(`${root}/candidate/candidate.json`) };
const reference = pin(`${configured.config.installation_parent}/${storeId}/control/REOPEN.v1.json`);
const initialized = () => ({ version: 1, kind: "application-service.initialized", reference, qualified_for_product: false,
  closure: { version: 1, scope: "original-native-owners", create_broker_normal: true, installation_audited: true, session_released: true } });
const listening = () => ({ version: 1, kind: "application-service.listening", origin: configured.config.origin,
  qualified_for_product: false, maximum_requests: 256, maximum_concurrent: 1 });
const closed = (invocations = 2) => ({ version: 1, kind: "application-service.closed", started: true, reason: "stdin", qualified_for_product: false,
  closure: { version: 1, scope: "original-native-owners", invocations, runtime_normal_closures: invocations,
    broker_normal_closures: invocations, listener_closed: true, preflight_normal: true, installation_audited: true, session_released: true } });

class Input extends EventEmitter {
  readonly write = vi.fn((_value: string | Buffer) => true);
  // Deliberately separate end() from finish so tests cannot infer a flushed
  // shutdown command merely from asking the original writable to end.
  readonly end = vi.fn((_value?: string | Buffer) => this);
}
interface Completion {
  omit?: "exit" | "stdout" | "stderr";
  exitCode?: number | null; closeCode?: number | null;
  exitSignal?: NodeJS.Signals | null; closeSignal?: NodeJS.Signals | null;
}
class OriginalChild extends EventEmitter {
  readonly pid = 12345;
  readonly stdin = new Input(); readonly stdout = new EventEmitter(); readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
  isClosed = false;
  send(event: unknown) { this.output(Buffer.from(JSON.stringify(event) + "\n")); }
  output(bytes: Buffer) { this.stdout.emit("data", bytes); }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) { this.emit("exit", code, signal); }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.isClosed) return; this.isClosed = true; this.emit("close", code, signal);
  }
  complete({ omit, exitCode = 0, closeCode = 0, exitSignal = null, closeSignal = null }: Completion = {}) {
    if (this.isClosed) return;
    if (omit !== "exit") this.exit(exitCode, exitSignal);
    if (omit !== "stdout") this.stdout.emit("end");
    if (omit !== "stderr") this.stderr.emit("end");
    this.close(closeCode, closeSignal);
  }
}
const children: OriginalChild[] = [], work: Promise<unknown>[] = [];
const selections: { generationId: string; directory: string; installation: object; plan?: ApplicationInstallationPlan }[] = [];
function observe<T>(promise: Promise<T>) {
  const observation = { promise, settled: false };
  work.push(promise);
  void promise.then(() => { observation.settled = true; }, () => { observation.settled = true; });
  return observation;
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function begin(deadline = performance.now() + 60_000, controller = new AbortController()) {
  const result = observe(initializeApplicationVerificationStore(profile, candidate, nodeId, backend, deadline, controller.signal));
  return { ...result, child: children.at(-1)!, controller, observation: result };
}
async function initializedStore() {
  const init = begin(); init.child.send(initialized()); init.child.complete(); return init.promise;
}
async function runningService() {
  const token = await initializedStore(), controller = new AbortController();
  const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, controller.signal));
  const child = children.at(-1)!; child.send(listening());
  const service = await startup.promise;
  return { token, child, controller, service, closure: observe(service.closed) };
}
function selection(index: number) {
  const record = selections[index]!, member = record.plan!.files.find(file => file.path === "selection.json")!;
  if (!("content" in member)) throw Error("Controlled selection content missing");
  const bytes = Buffer.from(member.content);
  expect(member.bytes).toBe(bytes.length); expect(member.sha256).toBe(sha(bytes));
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(process, "kill").mockImplementation(() => { throw Error("PID cleanup is forbidden in this controlled suite"); });
  for (const mock of Object.values(mocked)) mock.mockReset();
  mocked.realpath.mockReturnValue(systemRoot);
  mocked.readProfile.mockImplementation(value => { expect(value).toBe(profile); return configured; });
  mocked.readCandidate.mockImplementation(value => { expect(value).toBe(candidate); return candidateRecord; });
  mocked.describeBackend.mockImplementation(value => { expect(value).toBe(backend); return native; });
  mocked.readPin.mockReturnValue(Buffer.from("controlled fixture"));
  mocked.createOwner.mockImplementation(() => {
    const generationId = `22222222-2222-4222-8222-${String(selections.length + 1).padStart(12, "0")}`;
    const record = { generationId, directory: `${configured.config.selection_parent}/${generationId}`,
      installation: Object.freeze({}), plan: undefined as ApplicationInstallationPlan | undefined };
    selections.push(record);
    return { generationId, directory: record.directory,
      install: (plan: ApplicationInstallationPlan) => { record.plan = plan; return record.installation; },
      describeAttempt: () => ({ phase: "claimed" }), abandon: vi.fn() };
  });
  mocked.auditInstallation.mockImplementation(value => { expect(selections.some(record => record.installation === value)).toBe(true); });
  mocked.spawn.mockImplementation(() => { const child = new OriginalChild(); children.push(child); return child; });
});
afterEach(async () => {
  for (const child of children) child.complete({ exitCode: 1, closeCode: 1 });
  await Promise.allSettled(work);
  children.length = 0; selections.length = 0; work.length = 0;
  vi.clearAllTimers(); vi.useRealTimers();
  try { expect(process.kill).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
});

describe("application verification bootstrap original controlled process", () => {
  it("uses the protected selection and fixed host without sending initialization EOF or shutdown", async () => {
    const init = begin(), record = selections[0]!;
    expect(mocked.createOwner).toHaveBeenCalledWith({ parent: configured.config.selection_parent, nodeId,
      allowedRoots: configured.roots, node: configured.config.node, backend, signal: init.controller.signal });
    expect(selection(0)).toEqual({ version: 1, node_id: nodeId, writable_workspace_roots: configured.roots, node: configured.config.node,
      host_manifest: configured.config.hostManifest, backend: { directory: native.directory, manifest_sha256: native.manifestSha256 },
      system_root: systemRoot, shutdown: "stdin", format: "artoo.application-initialize-selection.v1",
      installation_parent: configured.config.installation_parent, source_manifest: candidateRecord.manifest });
    expect(mocked.spawn).toHaveBeenCalledWith(configured.config.node.path,
      [configured.hostEntry.path, `--selection=${win32.join(record.directory, "selection.json")}`], {
        cwd: win32.dirname(configured.hostEntry.path), shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"],
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") } });
    expect(init.child.stdin.write).not.toHaveBeenCalled(); expect(init.child.stdin.end).not.toHaveBeenCalled();
    init.child.send(initialized()); await tick(); expect(init.observation.settled).toBe(false);
    expect(init.child.stdin.end).not.toHaveBeenCalled();
    init.child.exit(); init.child.stdout.emit("end"); init.child.stderr.emit("end"); await tick();
    expect(init.observation.settled).toBe(false);
    init.child.close(); const token = await init.promise;
    expect(readApplicationVerificationStore(token)).toEqual({ testStoreId: storeId });
    expect(mocked.readPin).toHaveBeenCalledWith(reference);
    expect(init.child.stdin.end).not.toHaveBeenCalled(); expect(init.child.kill).not.toHaveBeenCalled();
    expect(() => readApplicationVerificationStore({ ...token })).toThrow("Original initialized application store required");
  });

  it.each(["exit", "stdout", "stderr"] as const)("requires the original %s even with a valid marker and close code 0", async omit => {
    const init = begin(); init.child.send(initialized()); init.child.complete({ omit });
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("cannot replace original close with exit code 0 and both EOFs, and bounds uncertain cleanup", async () => {
    const init = begin(); init.child.send(initialized()); init.child.exit(); init.child.stdout.emit("end"); init.child.stderr.emit("end");
    await tick(); expect(init.observation.settled).toBe(false);
    init.controller.abort(); expect(init.child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(init.observation.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(init.promise).rejects.toThrow("Original application bootstrap closure is unconfirmed");
    init.child.close(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each([
    { name: "exit code", exitCode: 1 }, { name: "close code", closeCode: 1 },
    { name: "unknown exit code", exitCode: null }, { name: "unknown close code", closeCode: null },
    { name: "exit signal", exitSignal: "SIGTERM" as const }, { name: "close signal", closeSignal: "SIGTERM" as const },
  ])("rejects abnormal $name despite a valid internal closure report", async ({ name: _name, ...completion }) => {
    const init = begin(); init.child.send(initialized()); init.child.complete(completion);
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not accept an initialization marker plus CLI exit 0 without the internal owner report", async () => {
    const init = begin(), { closure: _closure, ...marker } = initialized();
    init.child.send(marker); init.child.complete();
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError); expect(init.child.kill).toHaveBeenCalledOnce();
  });

  it.each(["create_broker_normal", "installation_audited", "session_released"])("requires initialization closure field %s", async field => {
    const init = begin(), marker = initialized();
    init.child.send({ ...marker, closure: { ...marker.closure, [field]: false } }); init.child.complete();
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not credit another original child, even with the same PID, to a pending owner", async () => {
    const first = begin(), replacement = begin(); first.child.send(initialized());
    expect(first.child.pid).toBe(replacement.child.pid);
    replacement.child.send(initialized()); replacement.child.complete(); await replacement.promise;
    expect(first.observation.settled).toBe(false);
    // The second owner's EOF and exit cannot fill the first owner's missing ones.
    first.child.close(); await expect(first.promise).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
  });

  it.each(["synchronous-error", "throw"])("attempts kill once when original kill produces %s", async mode => {
    const init = begin(); init.child.send(initialized());
    init.child.kill.mockImplementation(() => {
      if (mode === "throw") throw Error("controlled kill throw");
      init.child.emit("error", Error("controlled synchronous kill error")); return true;
    });
    expect(() => init.child.stderr.emit("data", Buffer.from("failure"))).not.toThrow();
    init.child.stdin.emit("error", Error("second transport failure"));
    expect(init.child.kill).toHaveBeenCalledOnce(); await tick(); expect(init.observation.settled).toBe(false);
    init.child.complete(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["duplicate", "json", "utf8", "line-bound", "total-bound", "partial-tail", "stderr"])("rejects %s output despite normal original exit", async fault => {
    const init = begin();
    if (fault === "json") init.child.output(Buffer.from("{\n"));
    else if (fault === "utf8") init.child.output(Buffer.from([0xff, 10]));
    else if (fault === "line-bound") init.child.output(Buffer.alloc(4096, 32));
    else if (fault === "total-bound") init.child.output(Buffer.alloc(12_289, 32));
    else {
      init.child.send(initialized());
      if (fault === "duplicate") init.child.send(initialized());
      if (fault === "partial-tail") init.child.output(Buffer.from("{"));
      if (fault === "stderr") init.child.stderr.emit("data", Buffer.from("diagnostic"));
    }
    init.child.complete(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["readProfile", "readCandidate", "auditInstallation", "readPin"] as const)("reaudits %s after the original host closes", async boundary => {
    const init = begin(); init.child.send(initialized()); const failure = Error(`controlled changed ${boundary}`);
    mocked[boundary].mockImplementation(() => { throw failure; });
    init.child.complete(); await expect(init.promise).rejects.toBe(failure);
  });

  it.each(["parent", "generation", "control", "filename"])("rejects an initialized reference with a different %s", async field => {
    const init = begin();
    const paths = { parent: `${root}/other/${storeId}/control/REOPEN.v1.json`,
      generation: `${configured.config.installation_parent}/not-a-guid/control/REOPEN.v1.json`,
      control: `${configured.config.installation_parent}/${storeId}/other/REOPEN.v1.json`,
      filename: `${configured.config.installation_parent}/${storeId}/control/other.json` };
    init.child.send({ ...initialized(), reference: pin(paths[field as keyof typeof paths]) }); init.child.complete();
    await expect(init.promise).rejects.toThrow("escaped its selected store");
  });

  it("reads the final store pin before issuing its opaque token", async () => {
    const init = begin(), failure = Error("controlled store pin changed"); init.child.send(initialized());
    mocked.readPin.mockImplementation((file: ApplicationRuntimeFilePin) => {
      if (file.path === reference.path) throw failure; return Buffer.from("controlled fixture");
    });
    init.child.complete(); await expect(init.promise).rejects.toBe(failure);
  });

  it("rejects cancellation and elapsed deadlines before spawn", async () => {
    const controller = new AbortController(), failure = Error("already aborted"); controller.abort(failure);
    await expect(begin(undefined, controller).promise).rejects.toBe(failure);
    await expect(begin(performance.now() - 1).promise).rejects.toThrow("before spawn");
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("does not qualify closure when its final synchronous audit crosses the deadline", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const init = begin(200); init.child.send(initialized());
    mocked.readCandidate.mockImplementation(() => { now = 200; return candidateRecord; });
    init.child.complete(); await expect(init.promise).rejects.toThrow("deadline elapsed");
  });

  it("sends exactly one fixed shutdown, requires original input finish, and reads counts only after closure", async () => {
    const { child, service, closure } = await runningService();
    expect(selection(1)).toMatchObject({ format: "artoo.application-service-selection.v1", installation_reference: reference, shutdown: "stdin" });
    expect(selection(1)).not.toHaveProperty("source_manifest");
    expect(child.stdin.end).not.toHaveBeenCalled(); expect(() => service.invocations()).toThrow("not normally closed");
    const first = service.close(), second = service.close(); expect(first).toBe(second); expect(first).toBe(service.closed);
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith('{"version":1,"kind":"shutdown"}\n');
    expect(child.stdin.write).not.toHaveBeenCalled();
    child.stdin.emit("finish"); child.send(closed()); child.exit(); child.stdout.emit("end"); child.stderr.emit("end"); await tick();
    expect(closure.settled).toBe(false); expect(() => service.invocations()).toThrow("not normally closed");
    child.close(); await first; expect(service.invocations()).toBe(2); expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["stdin-finish", "internal-report"])("requires service %s despite fixed shutdown and exit code 0", async missing => {
    const { child, service } = await runningService(); void service.close();
    if (missing !== "stdin-finish") child.stdin.emit("finish");
    if (missing !== "internal-report") child.send(closed());
    child.complete(); await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(() => service.invocations()).toThrow("not normally closed");
  });

  it.each(["runtime_normal_closures", "broker_normal_closures"])("requires %s to equal the invocation count", async field => {
    const { child, service } = await runningService(), report = closed(); void service.close(); child.stdin.emit("finish");
    child.send({ ...report, closure: { ...report.closure, [field]: report.closure.invocations - 1 } }); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["listener_closed", "preflight_normal", "installation_audited", "session_released"])("requires service closure field %s", async field => {
    const { child, service } = await runningService(), report = closed(); void service.close(); child.stdin.emit("finish");
    child.send({ ...report, closure: { ...report.closure, [field]: false } }); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each([0, 256])("accepts %i invocations only with equal internal normal closure counts", async count => {
    const { child, service } = await runningService(); void service.close(); child.stdin.emit("finish"); child.send(closed(count)); child.complete();
    await service.closed; expect(service.invocations()).toBe(count);
  });

  it.each(["unsolicited-close", "duplicate-listening", "wrong-reason", "not-started", "over-budget"])("rejects service %s", async fault => {
    const { child, service } = await runningService();
    if (fault === "unsolicited-close") child.send(closed());
    else if (fault === "duplicate-listening") child.send(listening());
    else {
      void service.close(); child.stdin.emit("finish");
      child.send(fault === "wrong-reason" ? { ...closed(), reason: "budget-exhausted" }
        : fault === "not-started" ? { ...closed(), started: false } : closed(257));
    }
    child.complete(); await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("joins the original failed startup before rejecting a wrong listening origin", async () => {
    const token = await initializedStore();
    const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, new AbortController().signal));
    const child = children.at(-1)!; child.send({ ...listening(), origin: "http://127.0.0.1:31001" });
    await tick(); expect(startup.settled).toBe(false); expect(child.kill).toHaveBeenCalledOnce();
    child.complete(); await expect(startup.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not turn cancellation after readiness into a normal closure", async () => {
    const { child, service, controller, closure } = await runningService(); controller.abort();
    expect(child.kill).toHaveBeenCalledOnce(); await tick(); expect(closure.settled).toBe(false);
    void service.close(); child.stdin.emit("finish"); child.send(closed()); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("rejects a fabricated initialized store before spawning any service", async () => {
    await expect(startApplicationVerificationService({} as InitializedApplicationVerificationStore,
      performance.now() + 60_000, new AbortController().signal)).rejects.toThrow("Original initialized application store required");
    expect(mocked.spawn).not.toHaveBeenCalled();
  });
});
