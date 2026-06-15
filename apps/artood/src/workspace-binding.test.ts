import { describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  materializeWorkspace,
  planWorkspace,
  type GitExecutor,
  type WorkspacePlan
} from "./workspace-binding.js";

function fakeGit(): GitExecutor & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push([...args]);
    }
  };
}

describe("planWorkspace", () => {
  it("treats a root without a branch as an ordinary, already-prepared workspace", () => {
    expect(planWorkspace({ root: "/ws/run1" }, {})).toEqual({
      ok: true,
      plan: { kind: "ordinary", root: "/ws/run1" }
    });
  });

  it("treats an empty/whitespace branch as ordinary (no worktree)", () => {
    expect(planWorkspace({ root: "/ws/run1", branch: "   " }, { worktreeBaseRepo: "/repo" })).toEqual({
      ok: true,
      plan: { kind: "ordinary", root: "/ws/run1" }
    });
  });

  it("plans a worktree when branch + base repo are present", () => {
    expect(
      planWorkspace({ root: "/ws/run1", branch: "task/run1" }, { worktreeBaseRepo: "/repo" })
    ).toEqual({
      ok: true,
      plan: { kind: "worktree", root: "/ws/run1", branch: "task/run1", baseRepo: "/repo" }
    });
  });

  it("rejects with process_start_failed when branch is set but no base repo is configured", () => {
    const result = planWorkspace({ root: "/ws/run1", branch: "task/run1" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("process_start_failed");
    }
  });

  it("rejects when the configured base repo is blank", () => {
    const result = planWorkspace({ root: "/ws/run1", branch: "task/run1" }, { worktreeBaseRepo: "  " });
    expect(result.ok).toBe(false);
  });

  it("preserves source-case in the root (an FS/git path, never canonicalized/lowercased)", () => {
    // workspace.root is an execution path: case must survive on case-sensitive
    // filesystems. Only lease control keys are lowercased (normalizeLeasePath).
    const result = planWorkspace(
      { root: "/Ws/Run_1/SrcCase", branch: "Task/Run_1" },
      { worktreeBaseRepo: "/Repo" }
    );
    expect(result).toEqual({
      ok: true,
      plan: { kind: "worktree", root: "/Ws/Run_1/SrcCase", branch: "Task/Run_1", baseRepo: "/Repo" }
    });
  });
});

describe("materializeWorkspace", () => {
  it("is a no-op for an ordinary workspace", async () => {
    const git = fakeGit();
    await materializeWorkspace({ kind: "ordinary", root: "/ws/run1" }, git);
    expect(git.calls).toEqual([]);
  });

  it("adds a git worktree at the root from the base repo", async () => {
    const git = fakeGit();
    const plan: WorkspacePlan = {
      kind: "worktree",
      root: "/ws/run1",
      branch: "task/run1",
      baseRepo: "/repo"
    };
    await materializeWorkspace(plan, git);
    expect(git.calls).toEqual([["-C", "/repo", "worktree", "add", "-b", "task/run1", "/ws/run1"]]);
  });
});

describe("cleanupWorkspace", () => {
  it("is a no-op for an ordinary workspace (artood did not create it)", async () => {
    const git = fakeGit();
    await cleanupWorkspace({ kind: "ordinary", root: "/ws/run1" }, git);
    expect(git.calls).toEqual([]);
  });

  it("force-removes a worktree it created", async () => {
    const git = fakeGit();
    const plan: WorkspacePlan = {
      kind: "worktree",
      root: "/ws/run1",
      branch: "task/run1",
      baseRepo: "/repo"
    };
    await cleanupWorkspace(plan, git);
    expect(git.calls).toEqual([["-C", "/repo", "worktree", "remove", "--force", "/ws/run1"]]);
  });
});
