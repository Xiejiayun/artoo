import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Xcode can add user/workspace state while building. Bind the actual generated
// build configuration (pbxproj and all shared schemes), excluding that state.
function projectFingerprint(ios) {
  const project = join(ios, "Artoo.xcodeproj");
  for (const path of [project, join(project, "xcshareddata"), join(project, "xcshareddata/xcschemes")]) {
    assert.ok(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      "Generated project directories must be real directories",
    );
  }
  const schemes = readdirSync(join(project, "xcshareddata/xcschemes")).sort();
  assert.ok(
    schemes.includes("Artoo.xcscheme") && schemes.includes("ArtooUI.xcscheme"),
    "Both native schemes must exist",
  );
  const digest = createHash("sha256");
  for (const name of ["project.pbxproj", ...schemes.map((name) => `xcshareddata/xcschemes/${name}`)]) {
    const path = join(project, name),
      stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Generated configuration must be regular files");
    digest
      .update(name)
      .update("\0")
      .update(createHash("sha256").update(readFileSync(path)).digest())
      .update("\0");
  }
  return digest.digest("hex");
}

export function captureProjectPreparation(ios, source) {
  assert.match(source?.commit ?? "", /^[a-f0-9]{40}$/);
  for (const field of ["tracked_diff_sha256", "untracked_source_sha256"])
    assert.match(source[field] ?? "", /^[a-f0-9]{64}$/);
  assert.equal(source.untracked_source_complete, true);
  assert.ok(Number.isSafeInteger(source.untracked_source_files) && source.untracked_source_files >= 0);
  assert.equal(typeof source.working_tree_dirty, "boolean");
  return { version: 1, source: structuredClone(source), project_sha256: projectFingerprint(ios) };
}

export function assertProjectPreparation(ios, source, preparation) {
  assert.deepEqual(
    preparation,
    captureProjectPreparation(ios, source),
    "Common Xcode preparation must match the current source and generated build configuration",
  );
}
