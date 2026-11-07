// Admission only: no filesystem, native helper, browser or provider is started.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPack } from "@artoo/domain";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const local = vi.hoisted(() => ({ assertBackend: vi.fn() }));
vi.mock("./owned/windows-owned-process.js", async original => ({
  ...await original<typeof import("./owned/windows-owned-process.js")>(), assertWindowsProcessBackend: local.assertBackend,
}));
import { runWebAcceptance } from "./web-acceptance.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const backend = Object.freeze({ controlled: true }) as unknown as PreparedWindowsProcessBackend;
const context = {} as ContextPack;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.resetAllMocks(); });
describe("private Windows browser runtime admission", () => {
  it("rejects explicit opt-in without an original local backend before reading a workspace", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await expect(runWebAcceptance("unread-workspace", context, { windows_browser_process: { version: 1 } }))
      .rejects.toThrow("requires a genuine local Windows backend");
    expect(local.assertBackend).not.toHaveBeenCalled();
  });
  it("rejects an unsolicited private backend when the protected option is absent", async () => {
    await expect(runWebAcceptance("unread-workspace", context, {}, "request", undefined, { windowsProcessBackend: backend }))
      .rejects.toThrow("requires explicit protected opt-in");
    expect(local.assertBackend).not.toHaveBeenCalled();
  });
  it("revalidates the original backend and never treats a serialized copy as authority", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const copy = JSON.parse(JSON.stringify(backend));
    local.assertBackend.mockImplementation(value => { expect(value).toBe(copy); throw new Error("controlled unprepared copy"); });
    await expect(runWebAcceptance("unread-workspace", context, { windows_browser_process: { version: 1 } }, "request", undefined,
      { windowsProcessBackend: copy })).rejects.toThrow("controlled unprepared copy");
    expect(local.assertBackend).toHaveBeenCalledOnce();
  });
  it.each(["linux", "darwin"])("rejects explicit Windows Job execution on %s", async name => {
    Object.defineProperty(process, "platform", { ...platform, value: name });
    await expect(runWebAcceptance("unread-workspace", context, { windows_browser_process: { version: 1 } }, "request", undefined,
      { windowsProcessBackend: backend })).rejects.toThrow("requires a genuine local Windows backend");
    expect(local.assertBackend).not.toHaveBeenCalled();
  });
});
