import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitWorktreePath, parseGitWorktreeRegistrations } from "./git-worktree-evidence.mjs";

const head = "a".repeat(40);
const record = (root, branch = "fixture-base", hash = head) => `worktree ${root}\nHEAD ${hash}\nbranch refs/heads/${branch}\n\n`;

test("Windows Git paths match native separators and drive case without changing directory text", () => {
  const root = "d:/Owned/Cafe\u0301/中文 work ";
  assert.equal(gitWorktreePath(root, "win32"), "D:\\Owned\\Cafe\u0301\\中文 work ");
  assert.equal(gitWorktreePath(root, "win32"), gitWorktreePath("D:\\Owned\\Cafe\u0301\\中文 work ", "win32"));
  assert.notEqual(gitWorktreePath(root, "win32"), gitWorktreePath("D:/Owned/Café/中文 work ", "win32"));
  assert.notEqual(gitWorktreePath(root, "win32"), gitWorktreePath("D:/Owned/Cafe\u0301/中文 work", "win32"));
  assert.notEqual(gitWorktreePath(root, "win32"), gitWorktreePath("D:/owned/Cafe\u0301/中文 work ", "win32"));
});

test("LF and CRLF registration output preserve complete roots, HEADs and branches", () => {
  const output = record("d:/Owned/base") + record("D:/Owned/中文 work", "artoo/run_1");
  const expected = [
    { root: "D:\\Owned\\base", head, branch: "refs/heads/fixture-base" },
    { root: "D:\\Owned\\中文 work", head, branch: "refs/heads/artoo/run_1" },
  ].sort((a, b) => a.root.localeCompare(b.root));
  assert.deepEqual(parseGitWorktreeRegistrations(output, "win32"), expected);
  assert.deepEqual(parseGitWorktreeRegistrations(output.replaceAll("\n", "\r\n"), "win32"), expected);
});

test("POSIX path spelling, Unicode and literal backslashes are preserved", () => {
  const root = "/private/tmp/Cafe\u0301/中文 \\ work ";
  assert.deepEqual(parseGitWorktreeRegistrations(record(root), "darwin"), [{ root, head, branch: "refs/heads/fixture-base" }]);
});

test("changed roots, HEADs, branches and extra records remain distinguishable", () => {
  const original = parseGitWorktreeRegistrations(record("D:/Owned/base"), "win32");
  for (const changed of [record("D:/Other/base"), record("D:/Owned/base", "other"),
    record("D:/Owned/base", "fixture-base", "b".repeat(40)), record("D:/Owned/base").repeat(2)]) {
    assert.notDeepEqual(parseGitWorktreeRegistrations(changed, "win32"), original);
  }
});

test("ambiguous or malformed Git records fail instead of losing identity", () => {
  for (const output of [record('"D:/quoted"'), record("relative/path"), record("D:/Owned/base").replace("HEAD ", "HEAD bad\nHEAD "),
    record("D:/Owned/base", "fixture-base", "invalid"), record("D:/Owned/base").replace("\nHEAD", "\rHEAD")]) {
    assert.throws(() => parseGitWorktreeRegistrations(output, "win32"));
  }
});

test("actual Git base and separate worktree retain exact registered identities", (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "artoo-git-registration-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = join(directory, "base 中文"), work = join(directory, "work 资料"), hooks = join(directory, "hooks");
  mkdirSync(base); mkdirSync(hooks); writeFileSync(join(directory, "gitconfig"), "");
  const git = (...args) => execFileSync("git", ["-C", base, "-c", `core.hooksPath=${hooks}`, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "gitconfig") },
  });
  git("init", "--initial-branch=fixture-base"); writeFileSync(join(base, "file.txt"), "original\n"); git("add", "file.txt");
  git("-c", "user.name=Artoo Fixture", "-c", "user.email=fixture@artoo.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture base");
  const actualHead = git("rev-parse", "HEAD").trim(); git("worktree", "add", "-b", "artoo/run_1", work);
  assert.deepEqual(parseGitWorktreeRegistrations(git("worktree", "list", "--porcelain")), [
    { root: gitWorktreePath(base), head: actualHead, branch: "refs/heads/fixture-base" },
    { root: gitWorktreePath(work), head: actualHead, branch: "refs/heads/artoo/run_1" },
  ].sort((a, b) => a.root.localeCompare(b.root)));
  assert.equal(git("status", "--porcelain"), "");
});
