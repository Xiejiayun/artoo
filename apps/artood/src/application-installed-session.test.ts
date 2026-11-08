// Controlled boundaries only: no actual native process, SQLite, socket or host.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedApplicationInstallation } from "./application-installation.js";
import type { InstalledApplicationReopenOptions } from "./application-installed-session.js";
const state = vi.hoisted(() => ({ describe: vi.fn(), bind: vi.fn(), audit: vi.fn(), reference: vi.fn(), reopen: vi.fn(), retire: vi.fn(),
  acquire: vi.fn(), release: vi.fn(), profile: vi.fn(), initialize: vi.fn(), preflight: vi.fn(), start: vi.fn(), host: vi.fn(), backend: vi.fn() }));
vi.mock("./application-installation.js", () => ({ describeApplicationInstallation: state.describe, bindApplicationInstallationSession: state.bind,
  auditApplicationInstallation: state.audit, createApplicationInstallationReopenReference: state.reference,
  reopenApplicationInstallation: state.reopen, retireApplicationInstallation: state.retire }));
vi.mock("./application-session-ownership.js", () => ({ acquireApplicationSession: state.acquire, releaseApplicationSession: state.release }));
vi.mock("./application-service-profile.js", () => ({ prepareInstalledApplicationServiceProfile: state.profile }));
vi.mock("./application-local-service.js", () => ({ initializeApplicationStore: state.initialize, checkExistingApplicationStore: state.preflight,
  startLocalApplicationService: state.start }));
vi.mock("./windows-code-installation.js", () => ({ assertWindowsCodeInstallation: state.host }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: state.backend }));
import { initializeRestartableApplication, reopenInstalledApplicationService } from "./application-installed-session.js";
const installation = Object.freeze({}) as PreparedApplicationInstallation, session = Object.freeze({}), profile = Object.freeze({});
const reference = { path: "C:\\installed\\generation\\control\\REOPEN.v1.json", bytes: 42, sha256: "sha256:" + "a".repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function input(): InstalledApplicationReopenOptions {
  return { reference: { ...reference }, nodeId: "node1", allowedRoots: ["C:\\work"],
    node: { path: "C:\\node\\node.exe", bytes: 9, sha256: "sha256:" + "b".repeat(64) },
    hostDirectory: "C:\\host", hostCode: {} as InstalledApplicationReopenOptions["hostCode"],
    backend: {} as InstalledApplicationReopenOptions["backend"] };
}
let closure: ReturnType<typeof deferred<void>>, close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.describe.mockReturnValue({ directory: "C:\\installed\\generation\\code", allowedRoots: ["C:\\work"] });
  state.acquire.mockReturnValue(session); state.profile.mockReturnValue(profile); state.reopen.mockReturnValue(installation);
  state.reference.mockReturnValue(reference); state.initialize.mockResolvedValue({ normalShutdown: true }); state.preflight.mockResolvedValue({ normalShutdown: true });
  closure = deferred(); close = vi.fn(() => closure.promise);
  state.start.mockResolvedValue({ origin: "http://127.0.0.1:31000", closed: closure.promise, close });
});
describe("clean-only installed application coordination", () => {
  it("publishes the pinned descriptor only after the actual initializer resolves, then retires before releasing", async () => {
    const initialized = deferred<void>(); state.initialize.mockReturnValue(initialized.promise);
    const work = initializeRestartableApplication(installation); await tick();
    expect(state.bind).toHaveBeenCalledWith(installation, session); expect(state.reference).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
    initialized.resolve(); expect(await work).toBe(reference);
    expect(state.retire).toHaveBeenCalledExactlyOnceWith(installation); expect(state.release).toHaveBeenCalledExactlyOnceWith(session);
    expect(state.reference.mock.invocationCallOrder[0]).toBeGreaterThan(state.initialize.mock.invocationCallOrder[0]!);
    expect(state.release.mock.invocationCallOrder[0]).toBeGreaterThan(state.retire.mock.invocationCallOrder[0]!);
    expect(state.preflight).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled();
  });
  it.each(["initialize", "reference", "audit", "retire"])("retains original ownership when initial %s fails", phase => {
    const failure = Error(phase);
    if (phase === "initialize") state.initialize.mockRejectedValue(failure);
    else state[phase as "reference" | "audit" | "retire"].mockImplementation(() => { throw failure; });
    return expect(initializeRestartableApplication(installation)).rejects.toBe(failure).then(() => {
      expect(state.release).not.toHaveBeenCalled(); if (phase === "initialize") expect(state.reference).not.toHaveBeenCalled();
    });
  });
  it("opens under the original fresh objects and waits for database preflight before listening", async () => {
    const bootstrap = Object.freeze({}) as NonNullable<InstalledApplicationReopenOptions["bootstrap"]>;
    const selected = { ...input(), bootstrap }, checked = deferred<void>(); state.preflight.mockReturnValue(checked.promise);
    const work = reopenInstalledApplicationService(selected); await tick();
    expect(state.reopen).toHaveBeenCalledWith({ ...selected, session }); expect(state.start).not.toHaveBeenCalled(); expect(state.initialize).not.toHaveBeenCalled();
    expect(state.reopen.mock.calls[0]![0].bootstrap).toBe(bootstrap);
    expect(state.reopen.mock.calls[0]![0].backend).toBe(selected.backend); expect(state.reopen.mock.calls[0]![0].hostCode).toBe(selected.hostCode);
    checked.resolve(); const live = await work;
    expect(live.origin).toBe("http://127.0.0.1:31000"); expect(state.release).not.toHaveBeenCalled();
    const stopping = live.close(); expect(live.close()).toBe(stopping); await tick(); expect(close).toHaveBeenCalledTimes(1); expect(state.release).not.toHaveBeenCalled();
    closure.resolve(); await stopping; await live.closed;
    expect(state.audit).toHaveBeenCalledExactlyOnceWith(installation); expect(state.retire).toHaveBeenCalledExactlyOnceWith(installation);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(session);
  });
  it("releases a normal automatic listener drain only after original closed settles", async () => {
    const live = await reopenInstalledApplicationService(input()); closure.resolve(); await live.closed;
    expect(close).not.toHaveBeenCalled(); expect(state.release).toHaveBeenCalledOnce();
  });
  it.each(["reopen", "preflight", "start"])("retains the lock and existing database on %s failure", async phase => {
    const failure = Error(phase);
    if (phase === "reopen") state.reopen.mockImplementation(() => { throw failure; });
    else (phase === "preflight" ? state.preflight : state.start).mockRejectedValue(failure);
    await expect(reopenInstalledApplicationService(input())).rejects.toBe(failure);
    expect(state.initialize).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled(); expect(state.retire).not.toHaveBeenCalled();
    if (phase !== "start") expect(state.start).not.toHaveBeenCalled();
  });
  it("does not bind a listener when bootstrap admission changes during the awaited preflight", async () => {
    const bootstrap = Object.freeze({}) as NonNullable<InstalledApplicationReopenOptions["bootstrap"]>;
    const selected = { ...input(), bootstrap }, checked = deferred<void>(), failure = Error("bootstrap admission changed during preflight");
    let current = true;
    const assertAdmission = vi.fn(() => { if (!current) throw failure; });
    state.profile.mockImplementation(token => { expect(token).toBe(installation); assertAdmission(); return profile; });
    state.preflight.mockReturnValue(checked.promise);
    const listen = vi.fn().mockResolvedValue({ origin: "http://127.0.0.1:31000", closed: closure.promise, close });
    // Coordinator boundary only: the real startLocalApplicationService performs
    // its profile admission checks synchronously before binding any listener.
    // The installation/profile tests verify the actual low-level guard wiring.
    state.start.mockImplementation(token => { expect(token).toBe(profile); assertAdmission(); return listen(token); });
    const work = reopenInstalledApplicationService(selected); await tick();
    expect(state.reopen.mock.calls[0]![0].bootstrap).toBe(bootstrap); expect(state.start).not.toHaveBeenCalled();
    expect(state.preflight).toHaveBeenCalledExactlyOnceWith(profile, undefined);
    current = false; checked.resolve(); await expect(work).rejects.toBe(failure);
    expect(state.start).toHaveBeenCalledExactlyOnceWith(profile); expect(assertAdmission).toHaveBeenCalledTimes(2);
    expect(listen).not.toHaveBeenCalled(); expect(state.initialize).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
  });
  it("does not reinterpret an existing lock as a stale session", async () => {
    const failure = Object.assign(Error("busy"), { code: "EEXIST" }); state.acquire.mockImplementation(() => { throw failure; });
    await expect(reopenInstalledApplicationService(input())).rejects.toBe(failure);
    expect(state.reopen).not.toHaveBeenCalled(); expect(state.preflight).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
  });
  it("does not release on failed actual listener/owner settlement", async () => {
    const live = await reopenInstalledApplicationService(input()), failure = Error("uncertain owner");
    closure.reject(failure); await expect(live.closed).rejects.toBe(failure);
    expect(state.retire).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
  });
  it("retains changed bootstrap admission at the final audit after normal underlying closure", async () => {
    const bootstrap = Object.freeze({}) as NonNullable<InstalledApplicationReopenOptions["bootstrap"]>;
    const selected = { ...input(), bootstrap }, failure = Error("bootstrap admission changed before final audit");
    let current = true;
    const assertAdmission = vi.fn(() => { if (!current) throw failure; });
    state.profile.mockImplementation(token => { expect(token).toBe(installation); assertAdmission(); return profile; });
    // This controlled audit models the coordinator's installation boundary;
    // it does not claim to execute the real bootstrap or native admission.
    state.audit.mockImplementation(token => { expect(token).toBe(installation); assertAdmission(); });
    const live = await reopenInstalledApplicationService(selected);
    expect(state.reopen.mock.calls[0]![0].bootstrap).toBe(bootstrap); expect(state.audit).not.toHaveBeenCalled();
    current = false; expect(state.retire).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
    closure.resolve(); await expect(live.closed).rejects.toBe(failure);
    expect(state.audit).toHaveBeenCalledExactlyOnceWith(installation); expect(assertAdmission).toHaveBeenCalledTimes(2);
    expect(state.release).not.toHaveBeenCalled(); expect(state.retire).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it("retains a failed release as terminal closure failure", async () => {
    const live = await reopenInstalledApplicationService(input()), failure = Error("remove failed"); state.release.mockImplementation(() => { throw failure; });
    closure.resolve(); await expect(live.closed).rejects.toBe(failure); await expect(live.close()).rejects.toThrow("closure failed");
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("does not acquire ownership for already cancelled or malformed selections", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(reopenInstalledApplicationService(input(), controller.signal)).rejects.toThrow("cancelled");
    await expect(initializeRestartableApplication(installation, controller.signal)).rejects.toThrow("cancelled");
    const selected = { ...input(), reference: { ...reference, path: "C:\\installed\\generation\\control\\other.json" } };
    await expect(reopenInstalledApplicationService(selected)).rejects.toThrow("descriptor required"); expect(state.acquire).not.toHaveBeenCalled();
  });
  it("retains cancellation during preflight without starting a listener", async () => {
    const controller = new AbortController(); state.preflight.mockImplementation(async () => { controller.abort(); });
    await expect(reopenInstalledApplicationService(input(), controller.signal)).rejects.toThrow("cancelled");
    expect(state.start).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
  });
  it("waits for the exact late listener if cancellation occurs during asynchronous listen", async () => {
    const controller = new AbortController(), started = deferred<{ origin: string; closed: Promise<void>; close: typeof close }>();
    state.start.mockReturnValue(started.promise);
    const work = reopenInstalledApplicationService(input(), controller.signal); const result = work.catch(error => error); await tick();
    controller.abort(); started.resolve({ origin: "http://127.0.0.1:31000", closed: closure.promise, close }); await tick();
    expect(close).toHaveBeenCalledOnce(); expect(state.release).not.toHaveBeenCalled();
    closure.resolve(); expect(await result).toBeInstanceOf(Error); expect(state.release).toHaveBeenCalledOnce();
  });
});
