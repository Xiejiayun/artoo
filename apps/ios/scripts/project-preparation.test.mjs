import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProjectPreparation, captureProjectPreparation } from "./project-preparation.mjs";

const source = {
  commit: "a".repeat(40),
  tracked_diff_sha256: "b".repeat(64),
  untracked_source_sha256: "c".repeat(64),
  untracked_source_complete: true,
  untracked_source_files: 0,
  working_tree_dirty: false,
  branch: "main",
};
function fixture(t) {
  const ios = mkdtempSync(join(tmpdir(), "artoo-ios-preparation-"));
  t.after(() => rmSync(ios, { recursive: true, force: true }));
  const project = join(ios, "Artoo.xcodeproj"),
    schemes = join(project, "xcshareddata/xcschemes");
  mkdirSync(schemes, { recursive: true });
  for (const name of ["Artoo", "ArtooUI"]) writeFileSync(join(schemes, `${name}.xcscheme`), `<Scheme name="${name}"/>`);
  writeFileSync(join(project, "project.pbxproj"), "generated project");
  return { ios, project, schemes };
}

test("preparation binds source and generated configuration while allowing Xcode user state", (t) => {
  const { ios, project, schemes } = fixture(t),
    prepared = captureProjectPreparation(ios, source);
  assertProjectPreparation(ios, source, JSON.parse(JSON.stringify(prepared)));
  mkdirSync(join(project, "xcuserdata"));
  writeFileSync(join(project, "xcuserdata/state"), "transient Xcode state");
  assertProjectPreparation(ios, source, prepared);
  assert.throws(() => assertProjectPreparation(ios, { ...source, commit: "d".repeat(40) }, prepared));
  assert.throws(() => assertProjectPreparation(ios, source, { ...prepared, version: 2 }));
  assert.throws(() => captureProjectPreparation(ios, { ...source, untracked_source_complete: false }));
  for (const path of [
    join(project, "project.pbxproj"),
    join(schemes, "ArtooUI.xcscheme"),
    join(schemes, "Extra.xcscheme"),
  ]) {
    const before = existsSync(path) ? readFileSync(path) : null;
    writeFileSync(path, "changed");
    assert.throws(() => assertProjectPreparation(ios, source, prepared));
    if (before) writeFileSync(path, before);
    else rmSync(path);
    assertProjectPreparation(ios, source, prepared);
  }
});

test("missing schemes and linked generated directories fail closed", (t) => {
  const { ios, schemes } = fixture(t);
  rmSync(join(schemes, "ArtooUI.xcscheme"));
  assert.throws(() => captureProjectPreparation(ios, source));
  rmSync(schemes, { recursive: true });
  mkdirSync(join(ios, "external"));
  symlinkSync(join(ios, "external"), schemes, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => captureProjectPreparation(ios, source), /real directories/);
});
