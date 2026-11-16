import { afterEach, describe, expect, it, vi } from "vitest";
import { runOwnedGit } from "./owned-git.js";

// Invocation ordering only; native Git/worktree evidence lives in the POSIX fixture.
const control = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: control.spawn,
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  control.spawn.mockReset();
});
const request = { cwd: "/fixture", args: ["worktree", "add"], kind: "materialize" as const };
const options = {
  gitExecutable: "/usr/bin/git",
  readTimeoutMs: 1000,
  materializeTimeoutMs: 1000,
  maxOutputBytes: 1024,
};
function posix() {
  Object.defineProperty(process, "platform", { value: "linux" });
}

describe("owned Git private materialization guard", () => {
  it("rejects at the physical spawn boundary with a genuine not-launched receipt", async () => {
    posix();
    const cause = new Error("Original start window expired");
    const guard = vi.fn(() => {
      throw cause;
    });
    await expect(runOwnedGit(request, { ...options, assertStartCurrent: guard })).rejects.toMatchObject({
      code: "start_not_authorized",
      cause,
      receipt: {
        spawned: false,
        pid: null,
        groupState: "not-launched",
        cleanupConfirmed: true,
        observersDisposed: true,
      },
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("rejects IPC-guardian and read-only combinations before any helper is launched", async () => {
    posix();
    const guard = vi.fn();
    for (const [input, config] of [
      [request, { ...options, guardParent: true, assertStartCurrent: guard }],
      [
        { ...request, kind: "read" as const },
        { ...options, assertStartCurrent: guard },
      ],
    ] as const) {
      await expect(runOwnedGit(input, config)).rejects.toMatchObject({
        code: "invalid_input",
        receipt: { spawned: false, cleanupConfirmed: true },
      });
    }
    expect(guard).not.toHaveBeenCalled();
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("does not accept an asynchronous or value-returning startup guard", async () => {
    posix();
    for (const guard of [() => Promise.resolve(), () => true]) {
      await expect(runOwnedGit(request, { ...options, assertStartCurrent: guard })).rejects.toMatchObject({
        code: "start_not_authorized",
        receipt: { spawned: false },
      });
    }
    expect(control.spawn).not.toHaveBeenCalled();
  });
});
