import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createZeroArtifactWorkspaceSetup, createZeroArtifactWorkspaceObserver,
  verifyZeroArtifactWorkspaceExport } from "./zero-artifact-workspace-scenario.mjs";
import { zeroArtifactHash as hash } from "./zero-artifact-workspace.mjs";

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "artoo-zero-observer-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test("local setup does not pair, start a node, register an instance or materialize the execution root", (t) => {
  const setup = createZeroArtifactWorkspaceSetup({ temporary: temporary(t), projectId: "p", suffix: "installed-mac", runtimeId: "codex" });
  assert.equal(setup.fields.runtime_id, "codex"); assert.equal(setup.fields.computer_id, undefined);
  assert.equal(setup.fields.instance_id, undefined); assert.equal(existsSync(setup.fields.workspace_root), false);
  assert.deepEqual(readdirSync(setup.receipts), []);
  assert.equal(readFileSync(join(setup.baseRepo, ".gitignore"), "utf8"), "ignored.bin\n");
  assert.deepEqual(JSON.parse(readFileSync(setup.configurationPath)), setup.configuration);
  assert.equal(setup.fields.base_repository, setup.baseRepo); assert.equal(setup.fields.workspace_parent, setup.directory);
});

test("the installed-worker observer uses only reads and binds the caller's exact computer, instance and runtime", async (t) => {
  const setup = createZeroArtifactWorkspaceSetup({ temporary: temporary(t), projectId: "p", suffix: "observer", runtimeId: "codex" });
  const calls = [];
  const request = async (...args) => { calls.push(args); assert.equal(args.length, 1); return { tasks: [] }; };
  const observer = createZeroArtifactWorkspaceObserver({ setup, request, computerId: "installed-computer", instanceId: "installed-instance" });
  const value = await observer.observe();
  assert.equal(value.snapshot, null); assert.equal(value.workspace, null); assert.deepEqual(value.run_reads, []);
  assert.deepEqual(calls, [["/api/v1/tasks?project_id=p"]]);
  assert.equal(observer.fields.computer_id, "installed-computer"); assert.equal(observer.fields.instance_id, "installed-instance");
  assert.equal(observer.fields.runtime_id, "codex"); assert.equal(setup.fields.computer_id, undefined);
  observer.close(); await assert.rejects(observer.observe(), /observer is closed/); assert.equal(calls.length, 1);
  assert.deepEqual(readdirSync(setup.receipts), []);
});

test("unsafe suffixes and absent worker identities are rejected before use", (t) => {
  const root = temporary(t);
  for (const suffix of ["", "../escape", "bad/name", "bad\\name", "space name"]) {
    assert.throws(() => createZeroArtifactWorkspaceSetup({ temporary: root, projectId: "p", suffix }));
    assert.deepEqual(readdirSync(root), []);
  }
  const setup = createZeroArtifactWorkspaceSetup({ temporary: root, projectId: "p", suffix: "valid" });
  assert.throws(() => createZeroArtifactWorkspaceObserver({ setup, request() {}, computerId: "", instanceId: "i" }));
});

test("closing a passive observer promptly stops an already-pending completion poll", async (t) => {
  const setup = createZeroArtifactWorkspaceSetup({ temporary: temporary(t), projectId: "p", suffix: "close-poll" });
  let observer, attempts = 0;
  observer = createZeroArtifactWorkspaceObserver({ setup, request: async () => ({ tasks: [] }), computerId: "c", instanceId: "i",
    until: async (predicate) => {
      attempts++; assert.equal(await predicate(), false); observer.close();
      attempts++; await predicate(); assert.fail("A closed poll cannot continue");
    } });
  await assert.rejects(observer.waitForVerified(), /observer is closed/); assert.equal(attempts, 2);
});

test("shared post-cleanup verification rejects altered copies, extra reports and rewritten manifests", (t) => {
  // Synthetic byte-export unit data, not process or client UI evidence.
  const root = temporary(t), owned = join(root, "owned"), target = join(root, "copies");
  mkdirSync(owned); mkdirSync(target);
  const files = ["implementation.txt", "unuploaded.txt", "ignored.bin", "context_pack.md"].map((name) => {
    const bytes = Buffer.from([0, 255, 128, 13, 10]); const copied = join(target, name); writeFileSync(copied, bytes);
    return { source: join(owned, "worktree", name), copied, sha256: hash(bytes), size: bytes.length };
  });
  const manifest = { scope: "Synthetic unit data", files }, manifestPath = join(target, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const input = { manifest, manifestPath, workspaceRoot: join(owned, "worktree"), temporary: owned, afterCleanup: true };
  assert.throws(() => verifyZeroArtifactWorkspaceExport(input), /removed/);
  rmSync(owned, { recursive: true });
  assert.equal(verifyZeroArtifactWorkspaceExport(input).files, 4);
  writeFileSync(join(target, "changes.patch"), "unexpected report");
  assert.throws(() => verifyZeroArtifactWorkspaceExport(input)); rmSync(join(target, "changes.patch"));
  writeFileSync(files[0].copied, "wrong"); assert.throws(() => verifyZeroArtifactWorkspaceExport(input));
  writeFileSync(files[0].copied, Buffer.from([0, 255, 128, 13, 10]));
  writeFileSync(manifestPath, JSON.stringify({ scope: "rewritten", files }));
  assert.throws(() => verifyZeroArtifactWorkspaceExport(input), /unchanged/);
});
