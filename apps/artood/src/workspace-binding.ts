import { spawn } from "node:child_process";

/**
 * Node-side workspace materialization for task #19 (concurrency Phase B/node).
 *
 * A run's `workspace { root, branch }` decides how artood prepares the directory
 * the {@link RuntimeAdapter} runs in, WITHOUT changing the frozen protocol shape:
 *
 * - `branch` absent → the root is an already-prepared ordinary workspace. artood
 *   runs in it as-is and never deletes it.
 * - `branch` present → artood materializes a per-run git worktree at `root` before
 *   spawning the adapter (`git -C <baseRepo> worktree add -b <branch> <root>`), then
 *   removes it on terminal completion/failure/cancel.
 *
 * The protocol does not carry the source repository, so worktree mode requires an
 * artood-local `worktreeBaseRepo`. If `branch` is present but no base repo is
 * configured, the run is rejected with `process_start_failed` — never guessed,
 * never silently run in an unmaterialized directory.
 */
export interface WorkspaceConfig {
  /** Local git repo artood creates per-run worktrees from. Absent = no worktree support. */
  worktreeBaseRepo?: string;
}

export interface RunWorkspace {
  root: string;
  branch?: string | null;
}

export type WorkspacePlan =
  | { kind: "ordinary"; root: string }
  | { kind: "worktree"; root: string; branch: string; baseRepo: string };

export type WorkspacePlanResult =
  | { ok: true; plan: WorkspacePlan }
  | { ok: false; code: "process_start_failed"; reason: string };

/**
 * Decide how to prepare a run's workspace. Pure: no IO. `branch` is trimmed; an
 * empty/whitespace branch is treated as absent (ordinary). Worktree mode requires
 * a configured base repo, otherwise the run is rejected (process_start_failed).
 */
export function planWorkspace(workspace: RunWorkspace, config: WorkspaceConfig): WorkspacePlanResult {
  const branch = workspace.branch?.trim();
  if (!branch) {
    return { ok: true, plan: { kind: "ordinary", root: workspace.root } };
  }
  const baseRepo = config.worktreeBaseRepo?.trim();
  if (!baseRepo) {
    return {
      ok: false,
      code: "process_start_failed",
      reason:
        "run.start carries workspace.branch (git worktree mode) but artood has no worktreeBaseRepo configured"
    };
  }
  return { ok: true, plan: { kind: "worktree", root: workspace.root, branch, baseRepo } };
}

/** Injectable git runner so materialization is deterministically testable. */
export interface GitExecutor {
  run(args: readonly string[]): Promise<void>;
}

/**
 * Materialize the planned workspace. Ordinary plans are a no-op (the root is
 * already prepared); worktree plans add a fresh worktree at the root on a NEW
 * branch. `-b` is required because per-run branches (e.g. `artoo/run-<id>`) do
 * not pre-exist — `git worktree add <root> <branch>` would abort with
 * "invalid reference" for an unknown branch.
 */
export async function materializeWorkspace(plan: WorkspacePlan, git: GitExecutor): Promise<void> {
  if (plan.kind === "ordinary") {
    return;
  }
  await git.run(["-C", plan.baseRepo, "worktree", "add", "-b", plan.branch, plan.root]);
}

/**
 * Tear down a materialized workspace. Only removes worktrees artood created;
 * ordinary roots are left untouched (artood did not create them).
 */
export async function cleanupWorkspace(plan: WorkspacePlan, git: GitExecutor): Promise<void> {
  if (plan.kind === "ordinary") {
    return;
  }
  await git.run(["-C", plan.baseRepo, "worktree", "remove", "--force", plan.root]);
}

/** Real git CLI executor: spawns `git`, rejecting on non-zero exit or spawn error. */
export function createGitCliExecutor(gitBin = "git"): GitExecutor {
  return {
    run(args) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(gitBin, [...args], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`));
          }
        });
      });
    }
  };
}
