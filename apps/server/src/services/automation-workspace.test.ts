import { describe, expect, it, vi } from "vitest";
import { automationWorkspacesOverlap, canonicalAutomationWorkspace, resolveAutomationWorkspace } from "./automation-workspace.js";

describe("autonomous workspace reservations", () => {
  it("normalizes aliases and checks both parent directions by path segment", () => {
    expect(automationWorkspacesOverlap("/work/app", "/work/app/sub/../sub", "linux")).toBe(true);
    expect(automationWorkspacesOverlap("/work/app/sub", "/work/app", "darwin")).toBe(true);
    expect(automationWorkspacesOverlap("/work/app", "/work/apple", "linux")).toBe(false);
    expect(() => canonicalAutomationWorkspace("../work", "linux")).toThrow("absolute");
  });
  it.each(["win32", "windows"])("handles %s drive roots and case without using host cwd", (os) => {
    expect(canonicalAutomationWorkspace("C:\\", os)).toBe("c:\\");
    expect(automationWorkspacesOverlap("C:\\Work\\App", "c:/work/app/sub", os)).toBe(true);
    expect(automationWorkspacesOverlap("C:\\", "C:\\Work", os)).toBe(true);
    expect(automationWorkspacesOverlap("C:\\Work", "D:\\Work", os)).toBe(false);
  });
  it("uses a Windows comparison key only to select and recheck the advertised execution path", () => {
    const root = "C:\\Work\\Product", computer = { id: "computer", os: "win32" }, instanceRoot = "c:/WORK/product/";
    const ctx = { getVerificationWorkspace: vi.fn(() => root), supportsVerificationProfile: vi.fn(() => true) };
    expect(resolveAutomationWorkspace(ctx, computer, "profile", "project", instanceRoot)).toBe(root);
    expect(ctx.getVerificationWorkspace).toHaveBeenLastCalledWith("computer", "profile", "project", instanceRoot);
    expect(ctx.supportsVerificationProfile).toHaveBeenLastCalledWith("computer", "profile", "project", root);
    ctx.getVerificationWorkspace.mockReturnValue("D:\\Different");
    expect(resolveAutomationWorkspace(ctx, computer, "profile", "project", instanceRoot)).toBeUndefined();
    ctx.getVerificationWorkspace.mockReturnValue(root); ctx.supportsVerificationProfile.mockReturnValue(false);
    expect(resolveAutomationWorkspace(ctx, computer, "profile", "project", instanceRoot)).toBeUndefined();
    expect(resolveAutomationWorkspace({ supportsVerificationProfile: () => true }, computer, "profile", "project", instanceRoot)).toBeUndefined();
  });
  it("retains POSIX normalization followed by exact profile matching without consulting a Windows lookup", () => {
    const getVerificationWorkspace = vi.fn(() => { throw new Error("POSIX matching does not use Windows aliases"); });
    const ctx = { getVerificationWorkspace, supportsVerificationProfile: (_node: string, _profile: string, _project: string, root: string) => root === "/Work/Product" };
    expect(resolveAutomationWorkspace(ctx, { id: "computer", os: "linux" }, "profile", "project", "/Work/./Product/")).toBe("/Work/Product");
    expect(resolveAutomationWorkspace(ctx, { id: "computer", os: "darwin" }, "profile", "project", "/work/product")).toBeUndefined();
    expect(getVerificationWorkspace).not.toHaveBeenCalled();
  });
});
