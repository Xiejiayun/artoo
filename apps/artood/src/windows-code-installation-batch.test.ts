// Controlled filesystem/ACL facts; this is not live NTFS or collector timing qualification.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawnSync: vi.fn(), sequence: 0n, auditLimit: 65536,
  nodes: new Map<string, { directory: boolean; ino: bigint; ctimeNs: bigint; mtimeNs?: bigint; size?: bigint; link?: boolean; nlink?: bigint }>(),
  aliases: new Map<string, string>() }));
vi.mock("node:child_process", () => ({ spawnSync: state.spawnSync }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:fs", () => ({
  lstatSync: (path: string, options?: { bigint?: boolean }) => {
    const node = state.nodes.get(path); if (!node) throw Object.assign(Error("Missing controlled file"), { code: "ENOENT" });
    return { isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => !!node.link,
      nlink: options?.bigint ? node.nlink ?? 1n : Number(node.nlink ?? 1n), dev: 1n, ino: node.ino,
      ctimeNs: node.ctimeNs, mtimeNs: node.mtimeNs ?? 1n, size: node.size ?? 0n };
  },
  readdirSync: (path: string) => [...state.nodes.keys()].filter(value => value.startsWith(`${path}\\`)
    && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1)),
  realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
}));
vi.mock("./windows-local-acl.js", async original => {
  const actual = await original<typeof import("./windows-local-acl.js")>();
  return { ...actual, get MAX_WINDOWS_AUDIT_PATHS() { return state.auditLimit; } };
});
import { prepareWindowsCodeInstallation, auditWindowsCodeInstallation, auditWindowsCodeInstallationBatch,
  type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import type { WindowsAclFact, WindowsAclReport, WindowsAclTarget } from "./windows-local-acl.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const currentSid = "S-1-5-21-100-200-300-1001", otherSid = "S-1-5-21-100-200-300-1002";
const directory = "C:\\Program Files\\Git\\bin", git = `${directory}\\git.exe`, workspace = "C:\\products\\one";
let change: (report: WindowsAclReport) => void;
function add(path: string, directory = true): void { state.nodes.set(path, { directory, ino: ++state.sequence, ctimeNs: 1n }); }
function report(targets: readonly WindowsAclTarget[]): WindowsAclReport {
  return { version: 1, currentSid, nodes: targets.map(target => ({ path: target.path, directory: target.directory,
    attributes: target.directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS",
    ownerSid: target.readAcl ? "S-1-5-32-544" : null, daclPresent: target.readAcl, canonical: target.readAcl,
    aces: target.readAcl ? [{ sid: "S-1-5-32-544", qualifier: "AccessAllowed", mask: 0x1f01ff, flags: target.directory ? 3 : 0 }] : [] })) };
}
const node = (value: WindowsAclReport, path = directory): WindowsAclFact => value.nodes.find(item => item.path === path)!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" }); vi.stubEnv("SystemRoot", "C:\\Windows");
  state.nodes.clear(); state.aliases.clear(); state.sequence = 9007199254740991n; state.auditLimit = 65536;
  for (const path of ["C:\\", "C:\\Windows", "C:\\Program Files", "C:\\Program Files\\Git", directory, "C:\\products", workspace]) add(path);
  add(git, false); change = () => undefined;
  state.spawnSync.mockReset().mockImplementation((_exe, _argv, options) => {
    const value = report(JSON.parse(options.input).paths); change(value); return { status: 0, signal: null, stdout: JSON.stringify(value) };
  });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture); vi.unstubAllEnvs(); });

describe("synchronous Windows code-installation audit batches", () => {
  const secondDirectory = "C:\\Program Files\\Git\\share", secondWorkspace = "C:\\products\\two";
  function pair(second = secondDirectory, files = 0) {
    add(second); add(secondWorkspace); add(`${second}\\tool.dll`, false);
    for (const root of [directory, second]) for (let index = 0; index < files; index++) add(`${root}\\file-${index}.dll`, false);
    const first = prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: [workspace] });
    const other = prepareWindowsCodeInstallation({ directory: second, writableWorkspaceRoots: [workspace, secondWorkspace] });
    state.spawnSync.mockClear();
    return [{ code: first, directory }, { code: other, directory: second }] as const;
  }
  const collected = (): WindowsAclTarget[][] => state.spawnSync.mock.calls.map(([, , options]) => JSON.parse(options.input).paths);

  it("collects small installations and shared ancestors once while retaining both write scopes", () => {
    const entries = pair(); auditWindowsCodeInstallationBatch(entries);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    const targets = collected()[0]!;
    expect(new Set(targets.map(target => target.path)).size).toBe(targets.length);
    for (const path of [directory, secondDirectory, git, `${secondDirectory}\\tool.dll`, workspace, secondWorkspace])
      expect(targets.some(target => target.path === path)).toBe(true);
    state.nodes.get(secondWorkspace)!.ino++;
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/fixed physical identity changed/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });

  it("ORs shared readAcl requirements without borrowing a weaker token policy", () => {
    const entries = pair("C:\\products\\second-code");
    auditWindowsCodeInstallationBatch(entries);
    expect(collected()[0]!.find(target => target.path === "C:\\products")).toMatchObject({ readAcl: true });
    change = value => { node(value, "C:\\products").ownerSid = otherSid; };
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/untrusted owner/);
  });

  it("applies the member mutation mask when that same path is another token's ancestor", () => {
    const entries = pair(`${directory}\\nested`);
    change = value => node(value, directory).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 4, flags: 0 });
    expect(() => auditWindowsCodeInstallationBatch([entries[1], entries[0]])).toThrow(/modify or replace/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });

  it("keeps code InheritOnly semantics and checks every existing descendant", () => {
    const entries = pair();
    change = value => node(value, secondDirectory).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 0x10000000, flags: 11 });
    auditWindowsCodeInstallationBatch(entries);
    change = value => node(value, `${secondDirectory}\\tool.dll`).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 16 });
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/modify or replace/);
  });

  it.each(["directory", "forged", "policy"])("rejects a bad second %s binding before collection", variant => {
    const entries = pair();
    const second = variant === "directory" ? { ...entries[1], directory: workspace }
      : variant === "forged" ? { ...entries[1], code: {} as PreparedWindowsCodeInstallation }
      : { ...entries[1], skip: true };
    expect(() => auditWindowsCodeInstallationBatch([entries[0], second])).toThrow(/another directory|locally prepared|exact local/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["added", "removed", "identity", "ctime", "mtime", "size"])("keeps the second immutable inventory binding during collection: %s", variant => {
    const entries = pair(), file = `${secondDirectory}\\tool.dll`;
    change = () => {
      if (variant === "added") add(`${secondDirectory}\\new.dll`, false);
      else if (variant === "removed") state.nodes.delete(file);
      else if (variant === "identity") state.nodes.get(file)!.ino++;
      else if (variant === "ctime") state.nodes.get(file)!.ctimeNs++;
      else if (variant === "mtime") state.nodes.get(file)!.mtimeNs = 2n;
      else state.nodes.get(file)!.size = 1n;
    };
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/changed during ACL audit/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    change = () => undefined;
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/inventory or metadata changed/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });

  it("rejects changed admitted code before collecting a new batch, including after an await", async () => {
    const entries = pair();
    await Promise.resolve();
    state.nodes.get(`${secondDirectory}\\tool.dll`)!.ctimeNs++;
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/inventory or metadata changed/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });

  it("keeps fixed workspace identities across collection", () => {
    const entries = pair(); change = () => { state.nodes.get(secondWorkspace)!.ino++; };
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/fixed physical identity changed/);
  });

  it("shares only this invocation's facts and rechecks after an await", async () => {
    const entries = pair(); auditWindowsCodeInstallationBatch([entries[0], entries[0], entries[1]]);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    await Promise.resolve();
    change = value => node(value, secondDirectory).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 0 });
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/modify or replace/);
    expect(state.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("groups before collection when the union exceeds the original path bound", () => {
    const entries = pair(secondDirectory, 8); state.auditLimit = 20;
    auditWindowsCodeInstallationBatch(entries);
    const groups = collected(); expect(groups).toHaveLength(2);
    expect(groups.every(targets => targets.length <= 20)).toBe(true);
    for (const { directory: root } of entries) for (let index = 0; index < 8; index++)
      expect(groups.flat().some(target => target.path === `${root}\\file-${index}.dll`)).toBe(true);
    for (const [, , options] of state.spawnSync.mock.calls) expect(options).toMatchObject({ timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  });

  it("rejects a single token above its original path bound without collecting or repartitioning it", () => {
    const entries = pair(secondDirectory, 8); state.auditLimit = 10;
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/inventory exceeds its bound/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });

  it("preserves a legal large single-token request instead of splitting it into small collectors", () => {
    for (let index = 0; index < 600; index++) add(`${directory}\\file-${index}.dll`, false);
    const entries = pair(); auditWindowsCodeInstallationBatch(entries);
    const groups = collected(); expect(groups).toHaveLength(2);
    expect(groups.filter(targets => targets.length > 512)).toHaveLength(1);
    expect(groups.find(targets => targets.length > 512)!.filter(target => target.path.startsWith(`${directory}\\file-`))).toHaveLength(600);
    state.spawnSync.mockClear(); auditWindowsCodeInstallation(entries[0].code, directory);
    expect(state.spawnSync).toHaveBeenCalledOnce(); expect(collected()[0]!.length).toBeGreaterThan(512);
  });

  it("combines a Chrome-sized inventory above 256 targets within the bounded shared response", () => {
    for (let index = 0; index < 300; index++) add(`${directory}\\file-${index}.dll`, false);
    const entries = pair(); auditWindowsCodeInstallationBatch(entries);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    expect(collected()[0]!.length).toBeGreaterThan(256); expect(collected()[0]!.length).toBeLessThanOrEqual(512);
    expect(collected()[0]!.some(target => target.path === `${secondDirectory}\\tool.dll`)).toBe(true);
  });

  it("keeps a later large group's readAcl=false facts from replacing a small group's required ACL", () => {
    for (let index = 0; index < 600; index++) add(`${directory}\\file-${index}.dll`, false);
    const entries = pair("C:\\products\\second-code"), ordered = [entries[1], entries[0]];
    auditWindowsCodeInstallationBatch(ordered);
    const groups = collected(); expect(groups).toHaveLength(2);
    expect(groups[0]!.find(target => target.path === "C:\\products")).toMatchObject({ readAcl: true });
    expect(groups[1]!.find(target => target.path === "C:\\products")).toMatchObject({ readAcl: false });
    state.spawnSync.mockClear();
    change = value => { const selected = node(value, "C:\\products"); if (selected.daclPresent) selected.ownerSid = otherSid; };
    expect(() => auditWindowsCodeInstallationBatch(ordered)).toThrow(/untrusted owner/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });

  it("keeps all inventories open across groups and catches an earlier installation's late mutation", () => {
    const entries = pair(secondDirectory, 8); state.auditLimit = 20; let calls = 0;
    change = () => { if (++calls === 2) state.nodes.get(git)!.ctimeNs++; };
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/changed during ACL audit/);
    expect(state.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("rejects differing Windows SIDs between groups and retains the original token identity", () => {
    const entries = pair(secondDirectory, 8); state.auditLimit = 20; let calls = 0;
    change = value => { if (++calls === 2) value.currentSid = otherSid; };
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/identity changed/);
    expect(state.spawnSync).toHaveBeenCalledTimes(2);
    change = value => { value.currentSid = otherSid; };
    expect(() => auditWindowsCodeInstallation(entries[0].code, directory)).toThrow(/identity changed/);
  });

  it("propagates collector failure without retrying original requests", () => {
    const entries = pair();
    state.spawnSync.mockReturnValue({ status: 1, signal: null, stdout: JSON.stringify({ errorCode: "audit_failure" }) });
    expect(() => auditWindowsCodeInstallationBatch(entries)).toThrow(/audit_failure/);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });

  it("rejects empty or non-array batches without creating authority", () => {
    expect(() => auditWindowsCodeInstallationBatch([])).toThrow(/explicit nonempty/);
    expect(() => auditWindowsCodeInstallationBatch({} as never)).toThrow(/explicit nonempty/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
});
