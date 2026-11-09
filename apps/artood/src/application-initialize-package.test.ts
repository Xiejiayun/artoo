// Coordinator boundaries only: no installation filesystem, native process or SQLite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationPackageInitializationOptions } from "./application-initialize-package.js";
const state = vi.hoisted(() => ({ assert: vi.fn(), create: vi.fn(), materialize: vi.fn(), install: vi.fn(), abandon: vi.fn(),
  initialize: vi.fn(), invalidate: vi.fn(), publication: vi.fn(), materializePublication: vi.fn(), facts: vi.fn(), token: Object.freeze({}), bootstrap: Object.freeze({}) }));
vi.mock("./application-bootstrap-admission.js", () => ({ assertApplicationInitializationAdmission: state.assert,
  assertApplicationPublicationInitializationAdmission: state.publication }));
vi.mock("./application-installation.js", () => ({ createApplicationInstallationOwner: state.create, invalidateApplicationInstallation: state.invalidate }));
vi.mock("./application-install-package.js", () => ({ materializeApplicationInstallationPlan: state.materialize,
  materializeApplicationInstallationPlanWithProvenance: state.materializePublication }));
vi.mock("./application-installed-session.js", () => ({ initializeRestartableApplication: state.initialize, readInitializedApplicationInstallation: state.facts }));
import { initializeApplicationPackage, initializeApplicationPublicationPackage } from "./application-initialize-package.js";
const owner = Object.freeze({ generationId: "fixed", directory: "C:\\dest\\fixed\\code", storageDirectory: "C:\\dest\\fixed\\store", install: state.install, abandon: state.abandon });
const plan = Object.freeze({}), reference = Object.freeze({ path: "C:\\dest\\fixed\\control\\REOPEN.v1.json", bytes: 42, sha256: "sha256:" + "a".repeat(64) });
const pin = (path: string) => ({ path, bytes: 42, sha256: "sha256:" + "b".repeat(64) });
const input = (): ApplicationPackageInitializationOptions => ({ parent: "C:\\dest", nodeId: "node1", allowedRoots: ["C:\\work"],
  node: pin("C:\\node\\node.exe"), sourceManifest: pin("C:\\package\\application-install-package.json"),
  backend: {} as ApplicationPackageInitializationOptions["backend"], hostCode: {} as ApplicationPackageInitializationOptions["hostCode"],
  hostDirectory: "C:\\host", bootstrap: state.bootstrap as ApplicationPackageInitializationOptions["bootstrap"] });
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
beforeEach(() => {
  for (const mock of [state.assert, state.create, state.materialize, state.install, state.abandon, state.initialize, state.invalidate,
    state.publication, state.materializePublication, state.facts]) mock.mockReset();
  state.assert.mockImplementation((token: object) => { if (token !== state.bootstrap) throw Error("original initialization admission required"); });
  state.create.mockReturnValue(owner); state.materialize.mockReturnValue(plan); state.install.mockReturnValue(state.token);
  state.initialize.mockResolvedValue(reference);
});
describe("fixed original package initialization", () => {
  it("exports provenance from the same materialization and facts only after original initialization closes", async () => {
    const provenance = Object.freeze({ format: "controlled-relocation" }), installation = Object.freeze({ generation_id: "controlled" });
    const initialized = deferred<typeof reference>(); state.initialize.mockReturnValue(initialized.promise);
    state.materializePublication.mockReturnValue({ plan, provenance }); state.facts.mockReturnValue(installation);
    const work = initializeApplicationPublicationPackage(input()); await Promise.resolve();
    expect(state.publication).toHaveBeenCalledOnce(); expect(state.materialize).not.toHaveBeenCalled(); expect(state.facts).not.toHaveBeenCalled();
    expect(state.initialize).toHaveBeenCalledExactlyOnceWith(state.token, undefined, true);
    initialized.resolve(reference); expect(await work).toEqual({ reference, provenance, installation });
    expect(state.facts).toHaveBeenCalledExactlyOnceWith(reference);
  });
  it("does not upgrade a legacy initialization admission to publication", async () => {
    state.publication.mockImplementation(() => { throw Error("original publication initialization selection required"); });
    await expect(initializeApplicationPublicationPackage(input())).rejects.toThrow("original publication");
    expect(state.create).not.toHaveBeenCalled(); expect(state.materializePublication).not.toHaveBeenCalled();
  });
  it("preserves original authority and returns only the original initializer's reference after actual settlement", async () => {
    const selected = input(), controller = new AbortController(), initialized = deferred<typeof reference>(); state.initialize.mockReturnValue(initialized.promise);
    const work = initializeApplicationPackage(selected, controller.signal); let settled = false; void work.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(state.create).toHaveBeenCalledWith({ parent: selected.parent, nodeId: selected.nodeId, allowedRoots: selected.allowedRoots,
      node: selected.node, backend: selected.backend, signal: controller.signal,
      initialization: { bootstrap: state.bootstrap, sourceManifest: selected.sourceManifest, hostCode: selected.hostCode, hostDirectory: selected.hostDirectory } });
    const passed = state.materialize.mock.calls[0]!;
    expect(passed[0]).toBe(state.bootstrap); expect(passed[2]).toBe(owner); expect(passed[1].backend).toBe(selected.backend);
    expect(state.install).toHaveBeenCalledExactlyOnceWith(plan); expect(state.initialize).toHaveBeenCalledExactlyOnceWith(state.token, controller.signal);
    selected.node.bytes = 1; (selected.allowedRoots as string[]).push("C:\\other"); selected.sourceManifest.sha256 = "sha256:" + "c".repeat(64);
    expect(passed[1].node.bytes).toBe(42); expect(passed[1].allowedRoots).toEqual(["C:\\work"]); expect(passed[1].sourceManifest.sha256).toBe("sha256:" + "b".repeat(64));
    initialized.resolve(reference); expect(await work).toBe(reference); expect(state.abandon).not.toHaveBeenCalled(); expect(state.invalidate).not.toHaveBeenCalled();
  });
  it.each(["materialize", "install", "post-materialize-admission"])("retains a failed %s attempt without starting the broker", async phase => {
    const failure = Error(phase);
    if (phase === "post-materialize-admission") state.assert.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw failure; });
    else state[phase as "materialize" | "install"].mockImplementation(() => { throw failure; });
    await expect(initializeApplicationPackage(input())).rejects.toBe(failure);
    expect(state.abandon).toHaveBeenCalledOnce(); expect(state.initialize).not.toHaveBeenCalled(); expect(state.invalidate).not.toHaveBeenCalled();
  });
  it("invalidates an installed authority on failed original broker closure and preserves the failure", async () => {
    const failure = Error("uncertain broker closure"); state.initialize.mockRejectedValue(failure);
    await expect(initializeApplicationPackage(input())).rejects.toBe(failure);
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith(state.token); expect(state.abandon).not.toHaveBeenCalled();
  });
  it("does not claim a generation for a forged token or already cancelled request", async () => {
    await expect(initializeApplicationPackage({ ...input(), bootstrap: {} as ApplicationPackageInitializationOptions["bootstrap"] })).rejects.toThrow("original initialization");
    const controller = new AbortController(); controller.abort(); await expect(initializeApplicationPackage(input(), controller.signal)).rejects.toThrow("cancelled");
    expect(state.create).not.toHaveBeenCalled();
  });
  it("does not start an install after cancellation during pure assembly", async () => {
    const controller = new AbortController(); state.materialize.mockImplementation(() => { controller.abort(); return plan; });
    await expect(initializeApplicationPackage(input(), controller.signal)).rejects.toThrow("cancelled");
    expect(state.install).not.toHaveBeenCalled(); expect(state.initialize).not.toHaveBeenCalled(); expect(state.abandon).toHaveBeenCalledOnce();
  });
});
