// Real POSIX Git, filesystem reservations and process closure. The wrapper only
// pauses a read; it neither fabricates output nor substitutes lifecycle receipts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  prepareOwnedWorktree,
  reserveOwnedWorktree,
  materializeOwnedWorktree,
  assertOwnedMaterializedWorktree,
} from "../dist/owned/worktree-reservation.js";
import { runOwnedGit } from "../dist/owned/owned-git.js";

const native = { skip: !["darwin", "linux"].includes(process.platform), timeout: 60_000 };
const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
function uncertain(error) {
  return (
    error?.receipt?.cleanupConfirmed === false ||
    error?.code === "cleanup_uncertain" ||
    (error?.cause && uncertain(error.cause))
  );
}
async function fixture(t, body) {
  const parent = realpathSync.native(tmpdir()),
    root = realpathSync.native(mkdtempSync(join(parent, "artoo-worktree-start-")));
  const gate = join(root, "pause"),
    marker = join(root, "read-paused"),
    wrapper = join(root, "git-wrapper.mjs");
  const pending = new Set(),
    errors = [];
  const failures = [];
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  let valid = true;
  const guard = () => {
    if (!valid) throw new Error("Original start window expired");
  };
  const observe = (promise) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      (error) => {
        pending.delete(promise);
        errors.push(error);
      },
    );
    return promise;
  };
  const git = (args) =>
    execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: environment,
    });
  try {
    assert.ok(!/\s/.test(process.execPath), "Fixture requires a shebang-compatible Node executable");
    writeFileSync(
      wrapper,
      `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nif(existsSync(${JSON.stringify(gate)})){writeFileSync(${JSON.stringify(marker)},'ready');while(existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,5));}\nconst r=spawnSync('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});if(r.error)throw r.error;process.exitCode=r.status??1;\n`,
      { flag: "wx", mode: 0o700 },
    );
    git(["init", "--quiet", "--initial-branch=main", "repo"]);
    git([
      "-C",
      "repo",
      "-c",
      "user.name=Artoo fixture",
      "-c",
      "user.email=fixture@artoo.local",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      "baseline",
    ]);
    const repo = join(root, "repo"),
      target = join(root, "target"),
      branch = "fixture/guard";
    const options = { gitExecutable: wrapper, signal: t.signal };
    const prepare = () =>
      observe(
        prepareOwnedWorktree(
          {
            root: target,
            sourceRepo: repo,
            sourceCommit: git(["-C", repo, "rev-parse", "HEAD"]).trim(),
            branch,
            allowedRoots: [root],
          },
          options,
          guard,
        ),
      );
    const expireWhile = async (operation) => {
      writeFileSync(gate, "pause", { flag: "wx" });
      let completed = false;
      const outcome = observe(operation()).then(
        (value) => {
          completed = true;
          return { value };
        },
        (error) => {
          completed = true;
          return { error };
        },
      );
      const until = performance.now() + 10_000;
      while (!existsSync(marker)) {
        t.signal.throwIfAborted();
        assert.equal(completed, false, "Operation settled before its actual Git read paused");
        assert.ok(performance.now() < until, "Actual Git read did not reach the pause");
        await delay();
      }
      valid = false;
      unlinkSync(gate);
      const result = await outcome;
      assert.ok(result.error, "Expired startup operation must fail");
      assert.match(result.error.message, /expired/);
      return result.error;
    };
    await body({
      root,
      repo,
      target,
      branch,
      git,
      guard,
      prepare,
      observe,
      expireWhile,
      expire: () => {
        valid = false;
      },
      restore: () => {
        valid = true;
      },
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    valid = false;
    if (existsSync(gate)) unlinkSync(gate);
    // Abort-aware owned executors must actually settle before removing paths.
    await Promise.allSettled([...pending]);
    if (errors.some(uncertain)) {
      t.diagnostic(`Physical Git cleanup uncertain; retained ${root}`);
      throw new Error("Retained uncertain Git fixture");
    }
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith("artoo-worktree-start-"));
    assert.equal(realpathSync.native(root), root);
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Worktree fixture and cleanup failed");
}

test("expiry during real reservation preflight prevents mkdir and cannot reuse the handle", native, async (t) =>
  fixture(t, async (f) => {
    const prepared = await f.prepare();
    await f.expireWhile(() => reserveOwnedWorktree(prepared));
    assert.equal(existsSync(f.target), false);
    f.restore();
    await assert.rejects(reserveOwnedWorktree(prepared), /fresh prepared handle/);
    assert.equal(existsSync(f.target), false);
  }),
);

test(
  "expiry during real pre-materialization reads retains an empty reservation and creates no branch",
  native,
  async (t) =>
    fixture(t, async (f) => {
      const reservation = await f.observe(reserveOwnedWorktree(await f.prepare()));
      await f.expireWhile(() => materializeOwnedWorktree(reservation));
      assert.deepEqual(readdirSync(f.target), []);
      assert.equal(f.git(["-C", f.repo, "branch", "--list", f.branch]).trim(), "");
      f.restore();
      await assert.rejects(materializeOwnedWorktree(reservation), /unused owned reservation/);
    }),
);

test("successful guarded materialization retains ordinary later reads after startup expiry", native, async (t) =>
  fixture(t, async (f) => {
    const worktree = await f.observe(
      materializeOwnedWorktree(await f.observe(reserveOwnedWorktree(await f.prepare()))),
    );
    f.expire();
    await f.observe(assertOwnedMaterializedWorktree(worktree));
    assert.equal(f.git(["-C", worktree.root, "branch", "--show-current"]).trim(), f.branch);
  }),
);

test("the actual Git spawn boundary rejects expiry with no subprocess or branch", native, async (t) =>
  fixture(t, async (f) => {
    f.expire();
    await assert.rejects(
      f.observe(
        runOwnedGit(
          { cwd: f.repo, args: ["branch", "fixture/never-started"], kind: "materialize" },
          {
            gitExecutable: "/usr/bin/git",
            readTimeoutMs: 1000,
            materializeTimeoutMs: 1000,
            maxOutputBytes: 1024,
            assertStartCurrent: f.guard,
          },
        ),
      ),
      (error) => {
        assert.equal(error.code, "start_not_authorized");
        assert.equal(error.receipt.spawned, false);
        assert.equal(error.receipt.pid, null);
        assert.equal(error.receipt.groupState, "not-launched");
        assert.equal(error.receipt.cleanupConfirmed, true);
        return true;
      },
    );
    assert.equal(f.git(["-C", f.repo, "branch", "--list", "fixture/never-started"]).trim(), "");
  }),
);
