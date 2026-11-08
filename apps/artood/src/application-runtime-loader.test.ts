import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ load: vi.fn(), capture: vi.fn(), revoke: vi.fn(), createOwner: vi.fn(), boundary: vi.fn() }));
vi.mock("./application-runtime-installation.js", () => ({ loadApplicationRuntimeConfiguration: state.load }));
vi.mock("./application-artifact-admission.js", () => ({ createApplicationArtifactOwner: state.createOwner }));
vi.mock("./application-quickjs-wasm-boundary.js", () => ({ createApplicationQuickJsWasmBoundary: state.boundary }));
import { createApplicationRuntime } from "./application-runtime-loader.js";
const pin = { path: "C:\\fixed\\application-runtime.json", bytes: 1, sha256: "sha256:" + "a".repeat(64) };
describe("fixed runtime loader failure ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.spyOn(performance, "now").mockReturnValue(100);
    state.load.mockReturnValue({ config: { expectation: {} }, capture: {} }); state.capture.mockReturnValue(Object.freeze({ captured: true }));
    state.createOwner.mockReturnValue({ capture: state.capture, revoke: state.revoke });
    state.boundary.mockImplementation(() => { throw Error("controlled-boundary-construction-failure"); });
  });
  afterEach(() => vi.restoreAllMocks());
  it("floors only the remaining boundary budget and revokes capture if boundary construction fails", async () => {
    await expect(createApplicationRuntime(pin, 350.75)).rejects.toThrow("controlled-boundary-construction-failure");
    expect(state.boundary).toHaveBeenCalledWith({ lifetimeMs: 250 });
    expect(state.revoke).toHaveBeenCalledOnce(); expect(state.revoke).toHaveBeenCalledWith(state.capture.mock.results[0]!.value);
  });
  it("rejects submillisecond remaining time before creating a boundary, while revoking capture", async () => {
    await expect(createApplicationRuntime(pin, 100.75)).rejects.toThrow("deadline");
    expect(state.boundary).not.toHaveBeenCalled(); expect(state.revoke).toHaveBeenCalledOnce();
  });
  it("does not invent a captured owner when immutable configuration admission fails", async () => {
    state.load.mockImplementation(() => { throw Error("controlled-config-pin-failure"); });
    await expect(createApplicationRuntime(pin, 300)).rejects.toThrow("controlled-config-pin-failure");
    expect(state.createOwner).not.toHaveBeenCalled(); expect(state.revoke).not.toHaveBeenCalled();
  });
});
