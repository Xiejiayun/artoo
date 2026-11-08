// Real temporary file identity checks with controlled storage-policy mocks; no Git, model, native helper or source runtime runs here.
import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "./windows-code-installation.js";
import * as resolver from "./cli-resolver.js";
import { prepareProductBootstrapGit, describeProductBootstrapGit, readProductBootstrapGit, resolveProductBootstrapGit,
  type PreparedProductBootstrapGit } from "./product-bootstrap-git.js";

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(storage, "prepareWindowsCodeInstallation").mockReturnValue(Object.freeze({}) as storage.PreparedWindowsCodeInstallation);
  vi.spyOn(storage, "assertWindowsCodeInstallation").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  const parent = realpathSync.native(tmpdir());
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep + "artoo-bootstrap-git-")) throw Error("Refusing fixture cleanup outside its temporary parent");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-bootstrap-git-"))); roots.push(root);
  const workspace = join(root, "workspace"), installation = join(root, "installed"); mkdirSync(workspace); mkdirSync(installation);
  const file = join(installation, "selected-git.exe"); writeFileSync(file, "controlled executable bytes");
  return { root, workspace, installation, file, prepare: () => prepareProductBootstrapGit({ file, allowedRoots: [workspace] }) };
}
describe("protected local Git selection (controlled policy boundary)", () => {
  it("keeps the explicit configured executable when PATH is absent or points elsewhere", () => {
    const f = fixture(), resolve = vi.spyOn(resolver, "resolveCliCommand").mockReturnValue([join(f.root, "other.exe")]);
    const prepared = f.prepare(), descriptor = describeProductBootstrapGit(prepared);
    expect(descriptor).toMatchObject({ version: 1, path: f.file, bytes: 27 });
    expect(descriptor.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolveProductBootstrapGit(prepared)).toBe(f.file); expect(resolve).not.toHaveBeenCalled();
    expect(storage.prepareWindowsCodeInstallation).toHaveBeenCalledWith({ directory: f.installation, writableWorkspaceRoots: [f.workspace] });
    const received = prepareProductBootstrapGit({ file: f.file, allowedRoots: [f.workspace], expected: descriptor });
    expect(readProductBootstrapGit(received)).toBe(f.file);
  });
  it("rejects wrong projected path, bytes, digest and unrecognized descriptor fields", () => {
    const f = fixture(), descriptor = describeProductBootstrapGit(f.prepare());
    for (const changed of [{ ...descriptor, path: join(f.root, "other.exe") }, { ...descriptor, bytes: descriptor.bytes + 1 },
      { ...descriptor, sha256: "sha256:" + "a".repeat(64) }, { ...descriptor, command: "git" }])
      expect(() => prepareProductBootstrapGit({ file: f.file, allowedRoots: [f.workspace], expected: changed })).toThrow();
  });
  it("rejects a changed executable before it can be selected again", () => {
    const f = fixture(), prepared = f.prepare(); writeFileSync(f.file, "changed executable bytes");
    expect(() => readProductBootstrapGit(prepared)).toThrow(/changed/);
    expect(() => describeProductBootstrapGit(prepared)).toThrow(/changed/);
  });
  it("rejects relative, non-executable and multi-link selections", () => {
    const f = fixture();
    expect(() => prepareProductBootstrapGit({ file: "git.exe", allowedRoots: [f.workspace] })).toThrow(/absolute physical/);
    const text = join(f.installation, "git.txt"); writeFileSync(text, "not executable");
    expect(() => prepareProductBootstrapGit({ file: text, allowedRoots: [f.workspace] })).toThrow(/executable/);
    linkSync(f.file, join(f.installation, "alias.exe")); expect(() => f.prepare()).toThrow(/single-link/);
  });
  it("rechecks the original configuration and protected directory and rejects reconstructed tokens", () => {
    const f = fixture(); let current = true;
    const prepared = prepareProductBootstrapGit({ file: f.file, allowedRoots: [f.workspace],
      assertConfigurationUnchanged: () => { if (!current) throw Error("configuration changed"); } });
    current = false; expect(() => readProductBootstrapGit(prepared)).toThrow(/configuration changed/); current = true;
    vi.mocked(storage.assertWindowsCodeInstallation).mockImplementation(() => { throw Error("protected directory changed"); });
    expect(() => readProductBootstrapGit(prepared)).toThrow(/protected directory changed/);
    expect(() => readProductBootstrapGit(Object.freeze({}) as PreparedProductBootstrapGit)).toThrow(/prepared local selection/);
  });
  it("preserves ordinary PATH resolution and the native executable-only legacy rule", () => {
    const resolve = vi.spyOn(resolver, "resolveCliCommand").mockReturnValue(["installed-git"]);
    expect(resolveProductBootstrapGit()).toBe("installed-git"); expect(resolve).toHaveBeenCalledWith("git");
    resolve.mockReturnValue(undefined); expect(() => resolveProductBootstrapGit()).toThrow(/installed native Git/);
    resolve.mockReturnValue(["node", "shim.js"]); expect(() => resolveProductBootstrapGit()).toThrow(/installed native Git/);
  });
});
