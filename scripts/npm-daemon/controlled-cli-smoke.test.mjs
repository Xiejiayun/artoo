import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { devicePlatform, prepareControlledCli } from "./controlled-cli-smoke.mjs";

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, "artoo-controlled-cli-test-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(`${parent}${sep}artoo-controlled-cli-test-`));
    rmSync(root, { recursive: true });
  });
  return { root, workspace };
}

test("pairing uses the actual desktop platform and rejects unsupported hosts", () => {
  assert.equal(devicePlatform("win32"), "windows");
  assert.equal(devicePlatform("darwin"), "macos");
  assert.equal(devicePlatform("linux"), "linux");
  for (const value of ["freebsd", "android", "ios", "windows"]) assert.throws(() => devicePlatform(value), /Unsupported smoke platform/);
});

test("controlled CLI launch isolates PATH and removes provider credentials and Node preload settings", t => {
  const { root, workspace } = fixture(t);
  const env = prepareControlledCli({ evidenceDirectory: root, workspace, env: {
    PATH: "/real/providers", Path: "C:\\real-providers", NODE_OPTIONS: "--require private-loader", NODE_PATH: "/outside-modules",
    OPENAI_API_KEY: "test-key", ANTHROPIC_AUTH_TOKEN: "test-token", GITHUB_TOKEN: "test-token", SAFE_MARKER: "preserved",
  } });
  assert.equal(env.PATH, join(root, "controlled-cli"));
  assert.equal(env.SAFE_MARKER, "preserved");
  for (const key of ["Path", "NODE_OPTIONS", "NODE_PATH", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"]) assert.equal(env[key], undefined);
  assert.equal(env.ARTOO_NPM_SMOKE_WORKSPACE_ROOT, realpathSync(workspace));
  for (const name of ["codex", "claude"]) {
    const entry = join(env.PATH, process.platform === "win32" ? `${name}.mjs` : name);
    assert.ok(readFileSync(entry, "utf8").includes("artoo.npm-controlled-cli.v1"));
    if (process.platform === "win32") assert.ok(readFileSync(join(env.PATH, `${name}.cmd`), "utf8").includes(`%dp0%\\${name}.mjs`));
  }
  if (process.platform !== "win32") assert.equal(realpathSync(join(env.PATH, "node")), realpathSync(process.execPath));
});

test("the actual controlled CLI process rejects an unbound context before writing evidence or output", t => {
  const { root, workspace } = fixture(t);
  const env = prepareControlledCli({ evidenceDirectory: root, workspace, env: process.env });
  const childWorkspace = join(workspace, "unbound"); mkdirSync(childWorkspace);
  const context = join(childWorkspace, "context_pack.md");
  writeFileSync(context, "# Context\n## Raw Payload\n" + JSON.stringify({ task: {
    id: "task-unbound", description: JSON.stringify({ fixture: "artoo.npm-controlled-cli.v1", runtime: "codex", outcome: "success", nonce: "different" }),
  } }));
  const command = join(env.PATH, process.platform === "win32" ? "codex.mjs" : "codex");
  const result = spawnSync(process.execPath, [command, "exec", "--json", "-C", childWorkspace, `Read the file ${context}.`],
    { cwd: childWorkspace, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.ifError(result.error); assert.notEqual(result.status, 0); assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  for (const file of ["fixture-start.json", "fixture-output.txt", "fixture-exit.json", "changes.patch"]) assert.equal(existsSync(join(childWorkspace, file)), false);
});
