import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductReleaseExecutor, loadReleaseProfilesFile, prepareReleaseProfiles, type ReleaseProfile } from "./product-release.js";
import { prepareVerificationProfiles } from "./verification.js";
import type { RunStartPayload } from "@artoo/domain";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(realpathSync.native(root)).toBe(root);
    expect(root.startsWith(join(realpathSync.native(tmpdir()), "artoo-release-boundary-"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-release-boundary-"))); roots.push(root);
  const workspace = join(root, "workspace"), ordinary = join(root, "ordinary"), storage = join(root, "storage"), trusted = join(root, "trusted");
  for (const path of [workspace, ordinary, storage, trusted]) mkdirSync(path);
  mkdirSync(join(workspace, "web")); writeFileSync(join(workspace, "web/index.html"), "fixture");
  const script = join(trusted, "verify.mjs"); writeFileSync(script, "process.exit(0)");
  const rawVerifier = { id: "verify", project_id: "project", workspace_root: workspace, subject_paths: ["web"], required_files: ["web/index.html"],
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 5000 }] };
  const [verifier] = prepareVerificationProfiles([rawVerifier], [workspace, ordinary]);
  const raw: ReleaseProfile = { id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "web", public_url: "http://127.0.0.1:19876", listen_host: "127.0.0.1", listen_port: 19876,
    health_checks: [{ path: "/" }], health_timeout_ms: 1000 };
  return { root, workspace, ordinary, storage, trusted, raw, rawVerifier, verifier: verifier! };
}
const runAt = (root: string) => ({ workspace: { root } }) as RunStartPayload;

describe("protected release configuration provenance", () => {
  it("rejects a release JSON inside another ordinary writable root before node preparation", () => {
    const f = fixture(), config = join(f.ordinary, "releases.json"); writeFileSync(config, JSON.stringify([f.raw]));
    expect(() => loadReleaseProfilesFile(config, [f.rawVerifier], [f.workspace, f.ordinary])).toThrow(/outside every writable root/);
    expect(() => loadReleaseProfilesFile(config, [f.rawVerifier], [f.root])).toThrow(/outside every writable root/);
  });
  it("retains loader provenance through preparation when the programmatic loader omitted roots", () => {
    const f = fixture(), config = join(f.ordinary, "releases.json"); writeFileSync(config, JSON.stringify([f.raw]));
    const loaded = loadReleaseProfilesFile(config, [f.rawVerifier]);
    const prepared = prepareReleaseProfiles(loaded, [f.verifier]);
    const executor = createProductReleaseExecutor(prepared);
    expect(() => executor.assertWorkspaceBoundary(runAt(f.ordinary))).toThrow(/protected release configuration/);
    expect(() => executor.assertWorkspaceBoundary(runAt(f.root))).toThrow(/protected release configuration/);
    expect(() => executor.assertWorkspaceBoundary(runAt(config))).toThrow(/protected release configuration/);
    expect(() => executor.assertWorkspaceBoundary(runAt(join(f.ordinary, "unrelated-child")))).not.toThrow();
    expect(() => executor.assertWorkspaceBoundary(runAt(f.workspace))).not.toThrow();
  });
  it("rechecks remembered configuration against NodeRunner write roots even for an already prepared object", () => {
    const f = fixture(), config = join(f.ordinary, "releases.json"); writeFileSync(config, JSON.stringify([f.raw]));
    const loaded = loadReleaseProfilesFile(config, [f.rawVerifier]);
    expect(() => prepareReleaseProfiles(loaded, [f.verifier], { writableRoots: [f.workspace, f.ordinary] })).toThrow(/protected release configuration/);
    const prepared = prepareReleaseProfiles(loaded, [f.verifier]);
    expect(() => prepareReleaseProfiles(prepared, [f.verifier], { writableRoots: [f.ordinary] })).toThrow(/protected release configuration/);
    expect(prepareReleaseProfiles(prepared, [f.verifier], { writableRoots: [f.workspace] })[0]).toBe(prepared[0]);
  });
  it("keeps protected storage outside every ordinary root too", () => {
    const f = fixture();
    expect(() => prepareReleaseProfiles([f.raw], [f.verifier], { writableRoots: [f.workspace, f.storage] })).toThrow(/protected release storage/);
  });
  it("does not serialize a private configuration path or alter the existing release digest", () => {
    const f = fixture(), config = join(f.trusted, "releases.json"); writeFileSync(config, JSON.stringify([f.raw]));
    const loaded = loadReleaseProfilesFile(config, [f.rawVerifier], [f.workspace, f.ordinary]);
    const [fromFile] = prepareReleaseProfiles(loaded, [f.verifier], { writableRoots: [f.workspace, f.ordinary] });
    const [direct] = prepareReleaseProfiles([f.raw], [f.verifier]);
    expect(fromFile!.digest).toBe(direct!.digest); expect(JSON.stringify(loaded)).toBe(JSON.stringify([f.raw]));
    expect(JSON.stringify(fromFile)).not.toContain(config.replaceAll("\\", "\\\\"));
    expect(Object.keys(fromFile!)).toEqual(Object.keys(direct!));
  });
});
