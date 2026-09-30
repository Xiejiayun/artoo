import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileSha256, runMacCommand } from "./mac-distribution.mjs";

/** Only images created by the distribution build are supplied by the smoke.
 * Never mount over /Applications or copy over an existing user installation.
 */
export function mountPreviewDmg(artifact, { execute = runMacCommand, onCreated = () => {} } = {}) {
  assert.equal(artifact.kind, "dmg", "DMG installation requires a DMG artifact");
  assert.equal(fileSha256(artifact.path), artifact.sha256, "DMG bytes changed after this invocation's build");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "artoo-mac-dmg-")));
  const mountpoint = join(directory, "volume"); mkdirSync(mountpoint);
  const info = () => JSON.parse(execute("plutil", ["-convert", "json", "-o", "-", "-"], { input: execute("hdiutil", ["info", "-plist"]).stdout }).stdout);
  const atMountpoint = (image) => image["system-entities"]?.some((entity) => entity["mount-point"] && resolve(entity["mount-point"]) === mountpoint);
  let detached = false;
  function detach() {
    if (detached) return;
    const image = (info().images ?? []).find(atMountpoint);
    if (image) {
      assert.equal(realpathSync(image["image-path"]), realpathSync(artifact.path), "Refusing to detach an unrelated disk image");
      execute("hdiutil", ["detach", mountpoint]);
      assert.equal((info().images ?? []).some(atMountpoint), false, "The owned DMG is still mounted");
    }
    rmSync(directory, { recursive: true, force: true }); detached = true;
  }
  const app = join(mountpoint, "Artoo.app");
  const handle = { app, mountpoint, detach, get detached() { return detached; } };
  try {
    // The caller retains cleanup ownership even if attach/validation fails and
    // the first detach attempt is rejected (for example, a busy mount).
    onCreated(handle);
    execute("hdiutil", ["attach", artifact.path, "-readonly", "-nobrowse", "-mountpoint", mountpoint, "-plist"]);
    const image = (info().images ?? []).find(atMountpoint);
    assert.ok(image, "hdiutil did not mount the DMG at this invocation's mountpoint");
    assert.equal(realpathSync(image["image-path"]), realpathSync(artifact.path));
    assert.equal(image.writeable, false, "DMG must be mounted read-only");
    assert.ok(existsSync(join(app, "Contents/MacOS/Artoo")), "The mounted DMG does not contain Artoo.app");
    assert.ok(realpathSync(app).startsWith(`${mountpoint}${sep}`), "The app must come from inside this DMG");
    return handle;
  } catch (error) {
    try { detach(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `DMG validation failed and detach failed: ${cleanupError.message}`); }
    throw error;
  }
}
