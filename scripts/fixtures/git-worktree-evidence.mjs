import assert from "node:assert/strict";
import { posix, win32 } from "node:path";

/** Git prints Windows worktree paths with forward slashes and may change the
 * drive letter's case. This representation is only for Git evidence matching;
 * application paths, copied recovery values and file contents remain exact. */
export function gitWorktreePath(value, platform = process.platform) {
  assert.ok(typeof value === "string" && !/[\0\r\n]/.test(value) && !value.startsWith('"'), "Unambiguous Git worktree path required");
  const paths = platform === "win32" ? win32 : posix;
  assert.ok(paths.isAbsolute(value), "Absolute Git worktree path required");
  const normalized = paths.normalize(value);
  return platform === "win32" ? normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : normalized;
}

export function parseGitWorktreeRegistrations(output, platform = process.platform) {
  assert.equal(typeof output, "string");
  const text = output.replaceAll("\r\n", "\n");
  assert.ok(!/[\0\r]/.test(text), "Unexpected control character in Git worktree evidence");
  return text.trimEnd().split("\n\n").filter(Boolean).map((block) => {
    const fields = new Map();
    for (const line of block.split("\n").filter(Boolean)) {
      const space = line.indexOf(" "), key = space < 0 ? line : line.slice(0, space);
      assert.ok(!fields.has(key), "Duplicate Git worktree field");
      fields.set(key, space < 0 ? true : line.slice(space + 1));
    }
    const head = fields.get("HEAD"), branch = fields.get("branch") ?? null;
    assert.ok(typeof head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head), "Exact Git HEAD required");
    assert.ok(branch === null || (typeof branch === "string" && branch.startsWith("refs/heads/")), "Exact Git branch required");
    return { root: gitWorktreePath(fields.get("worktree"), platform), head, branch };
  }).sort((a, b) => a.root.localeCompare(b.root));
}
