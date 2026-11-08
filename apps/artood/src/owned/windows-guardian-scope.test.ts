// Controlled ownership routing. No test claims a native process or product passed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
const local = vi.hoisted(() => ({ guardian: {}, backend: {}, slot: {}, active: true, bound: true, reserve: vi.fn(), start: vi.fn(), audit: vi.fn() }));
vi.mock("./windows-runtime-guardian.js", () => ({
  readWindowsGuardianLocalRuntime: () => ({ mode: local.active ? "active" : "recovery", backend: local.backend, local: { workspaceRoot: "C:\\workspace" } }),
  windowsGuardianForBackend: (backend: object) => local.bound && backend === local.backend ? local.guardian : undefined,
  hasPreparedWindowsGuardian: () => local.bound, auditWindowsGuardianRuntime: local.audit, reserveWindowsGuardianSlot: local.reserve,
}));
vi.mock("./windows-owned-process.js", () => ({ startWindowsOwnedProcess: local.start }));
import { bindWindowsGuardianCallback, readWindowsGuardianOperation, startWindowsScopedProcess, withWindowsGuardianOperation } from "./windows-guardian-scope.js";
const descriptor = { operationId: "author", bindingDigest: "sha256:" + "a".repeat(64), serverOperation: null };
const input = () => ({ executable: "C:\\protected\\node.exe", args: ["C:\\protected\\verifier.js"], cwd: "C:\\workspace",
  env: { SystemRoot: "C:\\Windows" }, timeoutMs: 1000, maxOutputBytes: 1024, cleanupTimeoutMs: 5000,
  normalExitPolicy: "require-empty" as const, normalExitGraceMs: 250 });
beforeEach(() => { vi.clearAllMocks(); local.active = true; local.bound = true; local.reserve.mockResolvedValue(local.slot); local.start.mockReturnValue({}); });
describe("original Windows guardian operation scope", () => {
  it("rejects scoped execution without the original scope and an alternate backend inside it", async () => {
    await expect(startWindowsScopedProcess(local.backend as never, input(), "author")).rejects.toThrow("original authenticated");
    expect(() => withWindowsGuardianOperation(local.guardian as never, descriptor, () => readWindowsGuardianOperation({} as never))).toThrow("cannot switch");
    expect(local.start).not.toHaveBeenCalled();
  });
  it("preserves an unbound ordinary backend when recovery was not configured", async () => {
    local.bound = false; const value = input(); await startWindowsScopedProcess(local.backend as never, value, "author");
    expect(local.reserve).not.toHaveBeenCalled(); expect(local.start).toHaveBeenCalledWith(local.backend, value);
  });
  it("captures exact launch bytes before awaiting the native reservation", async () => {
    let finish!: (value: object) => void; local.reserve.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const value = input(), original = structuredClone(value);
    const work = withWindowsGuardianOperation(local.guardian as never, descriptor, () => startWindowsScopedProcess(local.backend as never, value, "verifier"));
    value.args.push("unbound-argument"); value.env.SystemRoot = "C:\\changed"; finish(local.slot); await work;
    expect(local.start).toHaveBeenCalledWith(local.backend, { ...original, guardianSlot: local.slot });
    const expected = { boundary: "atomic-job-subtree.v1", operation: descriptor.bindingDigest, kind: "verifier", ...original };
    expect(local.reserve.mock.calls[0]![1].bindingDigest).toBe("sha256:" + createHash("sha256").update(canonical(expected)).digest("hex"));
  });
  it("restores the original broker scope and rejects callbacks after epoch loss", () => {
    const callback = withWindowsGuardianOperation(local.guardian as never, descriptor, () => bindWindowsGuardianCallback(() => readWindowsGuardianOperation(local.backend as never)));
    expect(callback()?.operationId).toBe("author"); local.active = false;
    expect(() => callback()).toThrow("no longer active");
  });
});
