import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const namesForSlot = (slot) => ["implementation.txt", "unsaved.txt", "ignored.bin", "context_pack.md",
  ...([1, 3].includes(slot) ? ["changes.patch"] : [])].sort();

/** Re-read immutable copies after the owner deliberately removes its disposable
 * fixture. This is test evidence only, never a product artifact or disk claim. */
export function verifyMacCorrectionWorkspaceExport({ setup, manifestPath, manifest, complete, afterCleanup = false }) {
  assert.ok(isAbsolute(manifestPath));
  const target = dirname(manifestPath), outside = relative(setup.directory, target);
  assert.ok(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside));
  assert.equal(basename(manifestPath), "manifest.json");
  assert.ok(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink());
  if (afterCleanup) assert.equal(existsSync(setup.directory), false, "Disposable correction fixture must be removed before final byte verification");
  const manifestBytes = readFileSync(manifestPath);
  assert.ok(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink());
  assert.deepEqual(JSON.parse(manifestBytes), manifest, "The export manifest must not be rewritten after capture");
  assert.ok(Array.isArray(manifest.files));
  const copies = new Set(), runs = new Map(), slots = new Map(); let totalBytes = 0;
  for (const file of manifest.files) {
    assert.ok(Number.isInteger(file.slot) && file.slot >= 1 && file.slot <= 4);
    assert.ok(typeof file.run_id === "string" && file.run_id.length > 0);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0); assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const name = basename(file.copy);
    assert.ok(namesForSlot(file.slot).includes(name));
    assert.equal(file.source, join(setup.workspaceRoots[file.slot - 1], name));
    assert.equal(file.copy, join(target, `slot-${file.slot}`, name));
    assert.equal(resolve(file.copy), file.copy); assert.equal(copies.has(file.copy), false); copies.add(file.copy);
    assert.ok(!runs.has(file.slot) || runs.get(file.slot) === file.run_id); runs.set(file.slot, file.run_id);
    const names = slots.get(file.slot) ?? []; names.push(name); slots.set(file.slot, names);
    const stat = lstatSync(file.copy); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const bytes = readFileSync(file.copy);
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
    totalBytes += bytes.length;
  }
  assert.equal(new Set(runs.values()).size, runs.size, "Each retained slot must identify a separate run");
  assert.deepEqual(readdirSync(target).sort(), ["manifest.json", ...[...slots.keys()].map((slot) => `slot-${slot}`)].sort());
  for (const [slot, names] of slots) {
    assert.ok(lstatSync(join(target, `slot-${slot}`)).isDirectory() && !lstatSync(join(target, `slot-${slot}`)).isSymbolicLink());
    assert.deepEqual(names.sort(), namesForSlot(slot));
    assert.deepEqual(readdirSync(join(target, `slot-${slot}`)).sort(), names);
  }
  const fullInventory = slots.size === 4 && manifest.files.length === 18;
  if (complete) assert.equal(fullInventory, true, "A successful correction requires all four retained workspaces and exactly 18 exported files");
  return { passed: true, scope: "Copied disposable-fixture byte evidence; no product artifact or current execution-computer disk assertion",
    manifest_path: manifestPath, manifest_sha256: hash(manifestBytes), files: manifest.files.length, bytes: totalBytes,
    retained_workspaces: slots.size, ignored_files: manifest.files.filter((file) => basename(file.copy) === "ignored.bin").length,
    reports: manifest.files.filter((file) => basename(file.copy) === "changes.patch").length,
    complete_four_run_inventory: fullInventory, verified_after_fixture_cleanup: afterCleanup };
}
