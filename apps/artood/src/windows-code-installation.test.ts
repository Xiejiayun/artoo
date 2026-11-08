// Controlled filesystem/ACL facts. This does not claim live NTFS or native collector qualification.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawnSync: vi.fn(), sequence: 0n,
  nodes: new Map<string, { directory: boolean; ino: bigint; ctimeNs: bigint; link?: boolean; nlink?: bigint }>(),
  aliases: new Map<string, string>() }));
vi.mock("node:child_process", () => ({ spawnSync: state.spawnSync }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:fs", () => ({
  lstatSync: (path: string, options?: { bigint?: boolean }) => {
    const node = state.nodes.get(path); if (!node) throw Object.assign(Error("Missing controlled file"), { code: "ENOENT" });
    return { isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => !!node.link,
      nlink: options?.bigint ? node.nlink ?? 1n : Number(node.nlink ?? 1n), dev: 1n, ino: node.ino,
      ctimeNs: node.ctimeNs, mtimeNs: 1n, size: 0n };
  },
  readdirSync: (path: string) => [...state.nodes.keys()].filter(value => value.startsWith(`${path}\\`)
    && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1)),
  realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
}));
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, auditWindowsCodeInstallation,
  type PreparedWindowsCodeInstallation, type WindowsCodeInstallationInput } from "./windows-code-installation.js";
import type { WindowsAclFact, WindowsAclReport, WindowsAclTarget } from "./windows-local-acl.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const currentSid = "S-1-5-21-100-200-300-1001", otherSid = "S-1-5-21-100-200-300-1002";
const directory = "C:\\Program Files\\Git\\bin", git = `${directory}\\git.exe`, workspace = "C:\\products\\one";
let input: WindowsCodeInstallationInput, change: (report: WindowsAclReport) => void;
function add(path: string, directory = true): void { state.nodes.set(path, { directory, ino: ++state.sequence, ctimeNs: 1n }); }
function report(targets: readonly WindowsAclTarget[]): WindowsAclReport {
  return { version: 1, currentSid, nodes: targets.map(target => ({ path: target.path, directory: target.directory,
    attributes: target.directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS",
    ownerSid: target.readAcl ? "S-1-5-32-544" : null, daclPresent: target.readAcl, canonical: target.readAcl,
    aces: target.readAcl ? [{ sid: "S-1-5-32-544", qualifier: "AccessAllowed", mask: 0x1f01ff, flags: target.directory ? 3 : 0 }] : [] })) };
}
const node = (value: WindowsAclReport, path = directory): WindowsAclFact => value.nodes.find(item => item.path === path)!;
const prepare = () => prepareWindowsCodeInstallation(input);
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" }); vi.stubEnv("SystemRoot", "C:\\Windows");
  state.nodes.clear(); state.aliases.clear(); state.sequence = 9007199254740991n;
  for (const path of ["C:\\", "C:\\Windows", "C:\\Program Files", "C:\\Program Files\\Git", directory, "C:\\products", workspace]) add(path);
  add(git, false); input = { directory, writableWorkspaceRoots: [workspace] }; change = () => undefined;
  state.spawnSync.mockReset().mockImplementation((_exe, _argv, options) => {
    const value = report(JSON.parse(options.input).paths); change(value); return { status: 0, signal: null, stdout: JSON.stringify(value) };
  });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture); vi.unstubAllEnvs(); });
describe("protected read-only code installation", () => {
  it("admits normal Program Files CREATOR OWNER InheritOnly while auditing every existing descendant", () => {
    change = value => node(value).aces.push({ sid: "S-1-3-0", qualifier: "AccessAllowed", mask: 0x10000000, flags: 11 });
    const prepared = prepare(); expect(Object.isFrozen(prepared)).toBe(true); assertWindowsCodeInstallation(prepared, directory);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    const [executable, argv, options] = state.spawnSync.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(argv[4]).not.toContain(directory); expect(options).toMatchObject({ shell: false, windowsHide: true });
    expect(JSON.parse(options.input).paths).toContainEqual({ path: git, directory: false, readAcl: true });
  });
  it.each([0, 1, 2, 3])("rejects effective mutation rights despite ordinary inheritance flags %i", flags => {
    change = value => node(value).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags });
    expect(prepare).toThrow(/modify or replace/);
  });
  it("does not trust CREATOR OWNER when its ACE actually applies to the installation", () => {
    change = value => node(value).aces.push({ sid: "S-1-3-0", qualifier: "AccessAllowed", mask: 0x10000000, flags: 3 });
    expect(prepare).toThrow(/modify or replace/);
  });
  it("rejects an unsafe existing executable underneath an admitted inherit-only parent", () => {
    change = value => {
      node(value).aces.push({ sid: "S-1-3-0", qualifier: "AccessAllowed", mask: 0x10000000, flags: 11 });
      node(value, git).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 16 });
    }; expect(prepare).toThrow(/modify or replace/);
  });
  it("allows unrelated ancestor sibling creation but rejects replacing the installed child", () => {
    change = value => node(value, "C:\\").aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 4, flags: 0 }); prepare();
    change = value => node(value, "C:\\").aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 64, flags: 0 }); expect(prepare).toThrow(/modify or replace/);
  });
  it("rejects an untrusted owner even when all access rules appear safe", () => {
    change = value => { node(value, git).ownerSid = otherSid; }; expect(prepare).toThrow(/untrusted owner/);
  });
  it("does not let a deny excuse an unsafe allow", () => {
    change = value => node(value).aces.push({ sid: otherSid, qualifier: "AccessDenied", mask: 2, flags: 0 },
      { sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 0 }); expect(prepare).toThrow(/modify or replace/);
  });
  it.each(["new", "removed", "identity", "metadata"])("rejects immutable installation changes: %s", variant => {
    const prepared = prepare();
    if (variant === "new") add(`${directory}\\new.dll`, false);
    if (variant === "removed") state.nodes.delete(git);
    if (variant === "identity") state.nodes.get(git)!.ino++;
    if (variant === "metadata") state.nodes.get(git)!.ctimeNs++;
    expect(() => assertWindowsCodeInstallation(prepared, directory)).toThrow(/inventory or metadata changed/);
  });
  it("rejects mutation while the ACL collector runs", () => {
    change = () => { state.nodes.get(git)!.ctimeNs++; }; expect(prepare).toThrow(/changed during ACL audit/);
  });
  it.each(["hardlink", "symlink", "alias"])("rejects linked or aliased code before ACL collection: %s", variant => {
    if (variant === "hardlink") state.nodes.get(git)!.nlink = 2n;
    if (variant === "symlink") state.nodes.get(git)!.link = true;
    if (variant === "alias") state.aliases.set(git, `${directory}\\other.exe`);
    expect(prepare).toThrow(/linked, aliased/); expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it("binds every write root and detects replacement with exact bigint identities", () => {
    const prepared = prepare(); state.nodes.get(workspace)!.ino++;
    expect(() => assertWindowsCodeInstallation(prepared, directory)).toThrow(/fixed physical identity changed/);
    input = { ...input, writableWorkspaceRoots: [workspace, "C:\\Program Files"] }; expect(prepare).toThrow(/overlaps/);
  });
  it("does not accept serialized brands or caller-selected ACL policies", () => {
    expect(() => assertWindowsCodeInstallation({} as PreparedWindowsCodeInstallation, directory)).toThrow(/locally prepared/);
    expect(() => prepareWindowsCodeInstallation({ ...input, allowInheritOnly: true } as WindowsCodeInstallationInput)).toThrow(/explicit local/);
    const prepared = prepare(); expect(() => assertWindowsCodeInstallation(prepared, workspace)).toThrow(/another directory/);
  });
  it("rejects a changed Windows SID on a later audit", () => {
    const prepared = prepare(); change = value => { value.currentSid = otherSid; };
    expect(() => auditWindowsCodeInstallation(prepared, directory)).toThrow(/identity changed/);
  });
  it.each(["network", "fat", "reparse", "omitted", "null-dacl", "noncanonical"])("rejects unsupported collector facts: %s", variant => {
    change = value => {
      const selected = node(value);
      if (variant === "network") selected.driveType = "Network";
      if (variant === "fat") selected.fileSystem = "FAT32";
      if (variant === "reparse") selected.attributes |= 0x400;
      if (variant === "omitted") value.nodes.pop();
      if (variant === "null-dacl") selected.daclPresent = false;
      if (variant === "noncanonical") selected.canonical = false;
    }; expect(prepare).toThrow(/facts|inventory|DACL/);
  });
  it("fails closed on a collector failure and unsupported platform", () => {
    state.spawnSync.mockReturnValue({ status: 1, signal: null, stdout: JSON.stringify({ errorCode: "audit_failure" }) });
    expect(prepare).toThrow(/audit_failure/);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" }); expect(prepare).toThrow(/native win-x64/);
  });
});
