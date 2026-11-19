// Run after building: node --test apps/artood/test-fixtures/windows-worktree-results-real.test.mjs
// Native Windows Job/Git/NTFS ACL integration evidence for node-owned Git results.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createOwnedRunAdmission, createProcessAdapter } from "../dist/process-adapter.js";
import { prepareWindowsProcessBackend } from "../dist/owned/windows-owned-process.js";
import { openOwnedWorktreeResults } from "../dist/owned/worktree-results.js";
import {
  materializeOwnedWorktree,
  prepareOwnedWorktree,
  reserveOwnedWorktree,
} from "../dist/owned/worktree-reservation.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = resolve(here, "..", "native-dist", "windows-process-host");
const manifestPath = join(bundleDir, "manifest.json");
const gitExe = "C:\\Program Files\\Git\\cmd\\git.exe";
const supported = process.platform === "win32" && existsSync(manifestPath) && existsSync(gitExe);
const native = { skip: !supported, timeout: 480_000 };

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

function git(cwd, args) {
  return execFileSync(
    gitExe,
    ["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", ...args],
    {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function createFixture(t, { addExecutableFile = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(homedir()), ".artoo-win-results-test-")));
  const workRoot = join(root, "work");
  const repo = join(workRoot, "repository");
  const state = join(root, "result-state");
  mkdirSync(repo, { recursive: true });
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Retain diagnostics on unexpected Windows handle lock.
    }
  });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "--local", "user.name", "Artoo Fixture"]);
  git(repo, ["config", "--local", "user.email", "fixture@artoo.local"]);
  git(repo, ["config", "--local", "core.autocrlf", "false"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.txt"), "base-line\n", "utf8");
  git(repo, ["add", "src/base.txt"]);
  if (addExecutableFile) {
    writeFileSync(join(repo, "src", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
    git(repo, ["add", "--chmod=+x", "src/run.sh"]);
  }
  git(repo, ["commit", "-m", "baseline"]);
  const baselineCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  const helperRoot = realpathSync.native(bundleDir);
  const manifestSha256 = `sha256:${createHash("sha256").update(readFileSync(manifestPath)).digest("hex")}`;
  const windowsProcessBackend = prepareWindowsProcessBackend({
    directory: helperRoot,
    manifestSha256,
    assertLocalInstallation() {
      assert.equal(realpathSync.native(bundleDir), helperRoot);
      assert.equal(lstatSync(bundleDir).isSymbolicLink(), false);
      assert.equal(`sha256:${createHash("sha256").update(readFileSync(manifestPath)).digest("hex")}`, manifestSha256);
    },
  });
  const profile = {
    version: 1,
    id: "win-local",
    node_id: "node_win_1",
    project_id: "project_win_1",
    repository_root: repo,
    state_root: state,
    baseline_commit: baselineCommit,
    content_paths: ["src"],
    allowed_roots: [workRoot],
    git_executable: gitExe,
  };
  return { root, workRoot, repo, state, baselineCommit, windowsProcessBackend, profile };
}

async function runAuthorWrite(f, { runId, branch, relativeFile, content }) {
  const targetRoot = join(f.workRoot, runId);
  const prepared = await prepareOwnedWorktree(
    {
      root: targetRoot,
      branch,
      sourceRepo: f.repo,
      sourceCommit: f.baselineCommit,
      allowedRoots: [f.workRoot],
    },
    { gitExecutable: gitExe, windowsProcessBackend: f.windowsProcessBackend },
  );
  const worktree = await materializeOwnedWorktree(await reserveOwnedWorktree(prepared));
  const admission = createOwnedRunAdmission({
    launchKey: `launch-${runId}`,
    runId,
    taskId: `task-${runId}`,
    agentInstanceId: "inst_win_1",
    runtime: "fixture",
    workspaceRoot: worktree.root,
    workspaceBranch: branch,
  });
  const scriptPath = join(f.root, `writer-${runId}.mjs`);
  writeFileSync(
    scriptPath,
    `import * as fs from "node:fs";\nimport * as p from "node:path";\nconst target = p.join(process.cwd(), ${JSON.stringify(relativeFile)});\nfs.mkdirSync(p.dirname(target), { recursive: true });\nfs.writeFileSync(target, ${JSON.stringify(content)}, "utf8");\n`,
    "utf8",
  );
  const adapter = createProcessAdapter({
    runtimeId: "fixture",
    command: [process.execPath, scriptPath],
    allowedRoots: [f.workRoot],
    windowsProcessBackend: f.windowsProcessBackend,
  });
  const handle = await adapter.startOwnedRun(
    {
      runId,
      taskId: `task-${runId}`,
      agentInstanceId: "inst_win_1",
      runtime: "fixture",
      workspaceRoot: worktree.root,
      runStart: {
        run_id: runId,
        task_id: `task-${runId}`,
        agent_instance_id: "inst_win_1",
        runtime: "fixture",
        workspace: { root: worktree.root, branch },
        context_pack: { id: `ctx-${runId}`, uri: "inline" },
        policy_snapshot: { filesystem_write_scope: [worktree.root], requires_approval: [] },
        artifact_rules: { paths: [] },
      },
    },
    worktree,
    admission,
    new AbortController().signal,
  );
  for await (const _event of adapter.streamEvents(handle)) {
    // Drain stream until natural process completion.
  }
  const closure = await adapter.stopOwnedRun(handle, admission, "user_cancelled");
  assert.equal(closure.kind, "confirmed_closed");
  return { worktree, admission, handle, closure };
}

test(
  "Windows native owned Git results: create, open, capture, read and materialize with Job proofs",
  native,
  async (t) => {
    const f = createFixture(t);
    const created = await openOwnedWorktreeResults(f.profile, {
      mode: "create",
      windowsProcessBackend: f.windowsProcessBackend,
    });
    const reopened = await openOwnedWorktreeResults(f.profile, {
      mode: "open",
      windowsProcessBackend: f.windowsProcessBackend,
    });

    const authorA = await runAuthorWrite(f, {
      runId: "run_win_a",
      branch: "artoo/win-a",
      relativeFile: "src/a.txt",
      content: "from-author-a\n",
    });

    const sealedA = await created.capture({
      request_id: "cap_a",
      worktree: authorA.worktree,
      admission: authorA.admission,
      handle: authorA.handle,
      closure: authorA.closure,
    });
    assert.ok(sealedA.receipt.git.length > 0);
    assert.ok(sealedA.receipt.git.every((cmd) => cmd.windows_job_confirmed === true && cmd.cleanup_confirmed === true));
    assert.deepEqual(
      sealedA.receipt.manifest.files.map((item) => item.path),
      ["src/a.txt", "src/base.txt"],
    );
    assert.deepEqual(await reopened.read(sealedA.reference), sealedA);

    const materialized = await reopened.materialize({
      request_id: "mat_a",
      reference: sealedA.reference,
      root: join(f.workRoot, "materialized-a"),
      branch: "artoo/win-mat-a",
    });
    assert.equal(readFileSync(join(materialized.root, "src", "a.txt"), "utf8"), "from-author-a\n");
    assert.equal(readFileSync(join(materialized.root, "src", "base.txt"), "utf8"), "base-line\n");
  },
);

test("Windows native owned Git results fails closed on 100755 executable files (Option 1)", native, async (t) => {
  const f = createFixture(t, { addExecutableFile: true });
  await assert.rejects(
    openOwnedWorktreeResults(f.profile, {
      mode: "create",
      windowsProcessBackend: f.windowsProcessBackend,
    }),
    /executable Git mode 100755 is unsupported on Windows/,
  );
});
