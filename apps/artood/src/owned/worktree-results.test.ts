import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OwnedGitError, type OwnedGitReceipt } from "./owned-git.js";
import { WorktreeReservationError } from "./worktree-reservation.js";
import { preflightFreshWorktree } from "./worktree-preflight.js";
import { WorktreeResultsProfileSchema, WorktreeResultReferenceSchema, WorktreeConflictReferenceSchema,
  worktreeResultFailureIsUncertain } from "./worktree-results.js";

const root = resolve(tmpdir(), "artoo-worktree-result-unit");
const profile = () => ({ version: 1, id: "local", node_id: "node_1", project_id: "project_1",
  repository_root: join(root, "repo"), state_root: join(root, "state"), baseline_commit: "a".repeat(40),
  content_paths: ["src", "tests"], allowed_roots: [root], git_executable: join(root, "git") });

describe("node-local Git result contracts (no Git execution)", () => {
  it("keeps explicit protected repository and content scope while refusing remote execution knobs", () => {
    expect(WorktreeResultsProfileSchema.parse(profile())).toEqual(profile());
    for (const change of [{ argv: ["anything"] }, { version: 2 }, { baseline_commit: "main" },
      { baseline_commit: "a".repeat(12) }, { repository_root: "relative" }, { state_root: "relative" },
      { content_paths: [] }, { content_paths: ["src", "src/lib"] }, { content_paths: ["src", "src"] },
      { content_paths: ["../outside"] }, { content_paths: [".git/config"] }, { content_paths: ["src/../other"] },
      { content_paths: ["src\\other"] }, { content_paths: ["src\nother"] }]) {
      expect(WorktreeResultsProfileSchema.safeParse({ ...profile(), ...change }).success).toBe(false);
    }
  });

  it("references carry only exact node-stored identities, not paths, patches or arbitrary commits", () => {
    const receipt_digest = `sha256:${"b".repeat(64)}`;
    expect(WorktreeResultReferenceSchema.parse({ result_id: "result_1", receipt_digest })).toEqual({ result_id: "result_1", receipt_digest });
    expect(WorktreeConflictReferenceSchema.parse({ operation_id: "merge_1", state_digest: receipt_digest }).operation_id).toBe("merge_1");
    for (const value of [{ result_id: "../result", receipt_digest }, { result_id: "result", receipt_digest, path: "/tmp/work" },
      { result_id: "result", receipt_digest, commit: "a".repeat(40) }, { result_id: "result", receipt_digest: "unknown" }]) {
      expect(WorktreeResultReferenceSchema.safeParse(value).success).toBe(false);
    }
    expect(WorktreeConflictReferenceSchema.safeParse({ result_id: "result", receipt_digest }).success).toBe(false);
  });

  it("rejects mutable branch names and non-string fixed baselines before filesystem or Git access", async () => {
    for (const sourceCommit of ["main", "HEAD", "a".repeat(12), "A".repeat(40), ["a".repeat(40)]]) {
      await expect(preflightFreshWorktree({ root: join(root, "uncreated"), sourceRepo: join(root, "absent"),
        allowedRoots: [root], sourceCommit: sourceCommit as string })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });
});

describe("Git result uncertainty classification (controlled failure objects only)", () => {
  const failure = (confirmed: boolean) => new OwnedGitError("cleanup_uncertain", { cleanupConfirmed: confirmed } as OwnedGitReceipt, Buffer.alloc(0), Buffer.alloc(0));
  it("retains uncertain Git closure through worktree materialization error wrappers", () => {
    const inner = failure(false), reservation = new WorktreeReservationError("git_failed", "retained", root, inner);
    expect(worktreeResultFailureIsUncertain(inner)).toBe(true);
    expect(worktreeResultFailureIsUncertain(reservation)).toBe(true);
    expect(worktreeResultFailureIsUncertain(new Error("outer", { cause: reservation }))).toBe(true);
  });
  it("does not manufacture uncertainty or closure authority from a lookalike JSON object", () => {
    expect(worktreeResultFailureIsUncertain(failure(true))).toBe(false);
    expect(worktreeResultFailureIsUncertain({ name: "OwnedGitError", receipt: { cleanupConfirmed: false } })).toBe(false);
    expect(worktreeResultFailureIsUncertain(new Error("ordinary I/O failure"))).toBe(false);
    const cyclic = new Error("cyclic"); Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(worktreeResultFailureIsUncertain(cyclic)).toBe(false);
  });
});
