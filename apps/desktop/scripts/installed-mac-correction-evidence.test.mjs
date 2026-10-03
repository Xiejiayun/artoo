import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { exportCorrectionWorkspaceEvidence, correctionProcessAlive } from "../../../scripts/fixtures/execution-correction-scenario.mjs";
import { verifyMacCorrectionWorkspaceExport } from "./installed-mac-correction-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exportedFixture(t) {
  // Synthetic byte/receipt unit data. No process, Git or installed-client claim.
  const root = mkdtempSync(join(tmpdir(), "artoo-mac-retention-export-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "disposable"), receiptsDirectory = join(directory, "receipts");
  mkdirSync(receiptsDirectory, { recursive: true });
  const workspaceRoots = Array.from({ length: 4 }, (_, i) => join(directory, `work-${i + 1}`));
  assert.equal(correctionProcessAlive(2147483647), false);
  for (let i = 0; i < 4; i++) {
    const receipt = { slot: i + 1, run_id: `run-${i + 1}`, pid: 2147483647, workspace_root: workspaceRoots[i] };
    mkdirSync(workspaceRoots[i]);
    for (const [name, field] of [["implementation.txt", "implementation_sha256"], ["unsaved.txt", "unsaved_sha256"],
      ["ignored.bin", "ignored_sha256"], ["context_pack.md", "context_sha256"], ["changes.patch", "artifact_sha256"]]) {
      if (name === "changes.patch" && i % 2 === 1) { receipt[field] = null; continue; }
      const bytes = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), Buffer.from(`Exact 中文 ${i + 1} ${name}\n`)]);
      writeFileSync(join(workspaceRoots[i], name), bytes); receipt[field] = hash(bytes);
    }
    writeFileSync(join(receiptsDirectory, `run-${i + 1}.json`), JSON.stringify(receipt));
  }
  const setup = { directory, receiptsDirectory, workspaceRoots }, destination = join(root, "preserved");
  const manifest = exportCorrectionWorkspaceEvidence({ setup, destination });
  return { setup, manifest, manifestPath: join(destination, "manifest.json"), complete: true, afterCleanup: true };
}

test("Mac preservation verifies all 18 independently exported files including binary bytes after disposable cleanup", (t) => {
  const input = exportedFixture(t);
  assert.throws(() => verifyMacCorrectionWorkspaceExport(input), /removed/);
  rmSync(input.setup.directory, { recursive: true });
  const result = verifyMacCorrectionWorkspaceExport(input);
  assert.equal(result.passed, true); assert.equal(result.files, 18); assert.equal(result.retained_workspaces, 4);
  assert.equal(result.ignored_files, 4); assert.equal(result.reports, 2); assert.equal(result.verified_after_fixture_cleanup, true);
  assert.equal(result.manifest_sha256, hash(readFileSync(input.manifestPath)));
  assert.ok(input.manifest.files.filter((file) => basename(file.copy) === "ignored.bin")
    .every((file) => readFileSync(file.copy).subarray(0, 5).equals(Buffer.from([0, 255, 128, 13, 10]))));
});

test("missing, replaced, resized, redirected and rewritten export evidence fails after cleanup", async (t) => {
  for (const [name, alter] of [
    ["missing ignored file", (input) => rmSync(input.manifest.files.find((file) => file.copy.endsWith("ignored.bin")).copy)],
    ["same length wrong bytes", (input) => { const file = input.manifest.files[0]; writeFileSync(file.copy, Buffer.alloc(file.bytes)); }],
    ["changed byte count", (input) => writeFileSync(input.manifest.files[0].copy, "short")],
    ["symlink copy", (input) => { const file = input.manifest.files[0]; rmSync(file.copy); symlinkSync(input.manifest.files[1].copy, file.copy); }],
    ["rewritten manifest", (input) => writeFileSync(input.manifestPath, JSON.stringify({ ...input.manifest, files: [] }))],
    ["missing slot", (input) => { input.manifest.files = input.manifest.files.filter((file) => file.slot !== 1); writeFileSync(input.manifestPath, JSON.stringify(input.manifest)); }],
    ["foreign source", (input) => { input.manifest.files[0].source = "/foreign/work/implementation.txt"; writeFileSync(input.manifestPath, JSON.stringify(input.manifest)); }],
    ["duplicate record", (input) => { input.manifest.files.push(input.manifest.files[0]); writeFileSync(input.manifestPath, JSON.stringify(input.manifest)); }],
  ]) await t.test(name, (t) => {
    const input = exportedFixture(t); rmSync(input.setup.directory, { recursive: true }); alter(input);
    assert.throws(() => verifyMacCorrectionWorkspaceExport(input));
  });
});

test("a partial failed-run export stays explicitly incomplete and never satisfies the successful four-run gate", (t) => {
  const input = exportedFixture(t);
  input.manifest.files = input.manifest.files.filter((file) => file.slot === 1);
  for (const slot of [2, 3, 4]) rmSync(join(input.manifestPath, "..", `slot-${slot}`), { recursive: true });
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest));
  rmSync(input.setup.directory, { recursive: true });
  assert.throws(() => verifyMacCorrectionWorkspaceExport(input));
  const result = verifyMacCorrectionWorkspaceExport({ ...input, complete: false });
  assert.equal(result.complete_four_run_inventory, false); assert.equal(result.files, 5);
});
