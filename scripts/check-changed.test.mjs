import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, "artoo-code-quality-"));
  t.after(() => {
    const owned = realpathSync(directory);
    const inside = relative(parent, owned);
    assert.ok(inside.startsWith("artoo-code-quality-") && !inside.includes(sep) && !inside.startsWith(".."));
    rmSync(owned, { recursive: true });
  });
  function git(...args) {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Quality Test", "-c", "user.email=quality@example.test", ...args],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function check(base) {
    return spawnSync(process.execPath, [join(root, "scripts/check-changed.mjs"), `--since=${base}`], {
      cwd: directory,
      encoding: "utf8",
    });
  }
  git("init", "-b", "main");
  copyFileSync(join(root, ".gitattributes"), join(directory, ".gitattributes"));
  copyFileSync(join(root, "biome.json"), join(directory, "biome.json"));
  writeFileSync(join(directory, "existing.ts"), "export const existing = 1;\n");
  writeFileSync(join(directory, "legacy.ts"), "export const untouched={legacy:true}\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const base = git("rev-parse", "HEAD");
  git("switch", "-c", "feature");
  return { directory, git, check, base };
}

test("checks actual committed new and modified files, leaving untouched legacy files out", (t) => {
  const { directory, git, check, base } = fixture(t);
  writeFileSync(join(directory, "existing.ts"), "export const existing=2\n");
  writeFileSync(join(directory, "added.ts"), "export const added={ready:true}\n");
  git("add", ".");
  assert.equal(check(base).status, 0, "--changed deliberately excludes uncommitted/staged changes");
  git("commit", "-m", "unformatted new and changed files");
  const failed = check(base);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /existing\.ts/);
  assert.match(failed.stdout + failed.stderr, /added\.ts/);
  writeFileSync(join(directory, "existing.ts"), "export const existing = 2;\n");
  writeFileSync(join(directory, "added.ts"), "export const added = { ready: true };\n");
  git("add", ".");
  git("commit", "-m", "format the two changed files");
  const passed = check(base);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout + passed.stderr, /Checked 2 files/);
});

test("rejects an absent base before Biome, while allowing an unsupported-only change", (t) => {
  const { directory, git, check, base } = fixture(t);
  const missing = check("refs/heads/absent-quality-base");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot resolve code quality base/);
  writeFileSync(join(directory, "README.md"), "Only a document changed.\n");
  git("add", ".");
  git("commit", "-m", "document change");
  const passed = check(base);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout + passed.stderr, /Checked 0 files/);
});

test("enforces the configured correctness rules even when formatting is already valid", (t) => {
  const { directory, git, check, base } = fixture(t);
  writeFileSync(
    join(directory, "invalid-typeof.ts"),
    'export function read(value: unknown) {\n  return typeof value === "strnig";\n}\n',
  );
  git("add", ".");
  git("commit", "-m", "formatted code with invalid typeof comparison");
  const result = check(base);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /useValidTypeof/);
});
