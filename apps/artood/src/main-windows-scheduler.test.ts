// Composition doubles only. No native installation, Git, journal, socket or
// process is qualified or launched by this suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const local = vi.hoisted(() => ({ qualify: vi.fn(), linked: false, git: "C:\\Program Files\\Git\\bin\\git.exe" }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const native = actual.realpathSync.native;
  return { ...actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...args: unknown[]) => path === local.git
      ? { isFile: () => true, isSymbolicLink: () => local.linked }
      : Reflect.apply(actual.lstatSync, actual, [path, ...args]),
    realpathSync: Object.assign(actual.realpathSync.bind(actual), { native: (path: Parameters<typeof native>[0], ...args: unknown[]) => path === local.git ? path : Reflect.apply(native, actual, [path, ...args]) }),
  };
});
vi.mock("./owned/windows-owned-process.js", async (original) => ({
  ...await original<typeof import("./owned/windows-owned-process.js")>(), assertWindowsSchedulerStartBackend: local.qualify,
}));
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import * as bootstrap from "./managed/managed-bootstrap.js";
import { createNodeFromConfig, helloFor, type ArtoodConfig } from "./main.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
function config(): ArtoodConfig {
  return { url: "wss://paired.example/api/v1/node?token=controlled", nodeId: "node", runtimes: ["codex"],
    allowedRoots: ["C:\\work"], worktreeBaseRepo: "C:\\work\\repo", windowsProcessBackend: backend,
    windowsGitExecutable: local.git, allowNewAllocations: true, scheduler: true,
    managedJournal: { version: 1, serverOrigin: "https://paired.example", nodeId: "node", directory: "C:\\private\\journal", expectedNamespace: "saved", controllerScope: "controller" } };
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  local.linked = false; local.qualify.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

describe("Windows managed bootstrap composition", () => {
  it("passes the locally qualified backend and exact Git program to the existing managed owner", () => {
    const managed = vi.spyOn(bootstrap, "createManagedBootstrap").mockReturnValue({ start: async () => {}, stop: async () => {}, failed: new Promise(() => {}) });
    const input = config();
    createNodeFromConfig(input);
    expect(local.qualify).toHaveBeenCalledWith(backend);
    expect(managed.mock.calls[0]![0]).toMatchObject({ binding: input.managedJournal, scheduler: true,
      allowNewAllocations: true, ownedGit: { windowsProcessBackend: backend, gitExecutable: local.git } });
    const wire = JSON.stringify(helloFor(input));
    expect(wire).not.toContain(local.git); expect(wire).not.toContain("windowsProcessBackend");
  });
  it("retains rejection for old/unknown native capabilities before constructing a managed node", () => {
    const managed = vi.spyOn(bootstrap, "createManagedBootstrap");
    local.qualify.mockImplementation(() => { throw new Error("Native launch-window capability is missing"); });
    expect(() => createNodeFromConfig(config())).toThrow("launch-window capability");
    expect(managed).not.toHaveBeenCalled();
  });
  it("rejects missing, remote, relative, normalized or linked Git selection without starting a node", () => {
    const managed = vi.spyOn(bootstrap, "createManagedBootstrap");
    for (const windowsGitExecutable of [undefined, "git", "\\\\server\\git.exe", "C:/Git/git.exe", "C:\\Git\\..\\git.exe"])
      expect(() => createNodeFromConfig({ ...config(), windowsGitExecutable })).toThrow();
    local.linked = true;
    expect(() => createNodeFromConfig(config())).toThrow("physical local executable");
    expect(managed).not.toHaveBeenCalled();
  });
});
