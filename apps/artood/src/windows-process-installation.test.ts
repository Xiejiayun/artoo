// Controlled policy tests. Filesystem/PowerShell/backend preparation are simulated;
// this suite does not establish real NTFS ACL protection or native process qualification.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  spawnSync: vi.fn(), prepareBackend: vi.fn(),
  nodes: new Map<string, { directory: boolean; bytes?: Buffer; link?: boolean; nlink?: number }>(),
  aliases: new Map<string, string>(),
  binding: undefined as undefined | { directory: string; manifestSha256: string; assertLocalInstallation: () => void },
  permit: Object.freeze({ controlled: "not a production branded backend" }),
}));
vi.mock("node:child_process", () => ({ spawnSync: state.spawnSync }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    const node = state.nodes.get(path); if (!node) throw Object.assign(new Error("Missing controlled file"), { code: "ENOENT" });
    return { isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => !!node.link,
      nlink: node.nlink ?? 1, size: node.bytes?.length ?? 0 };
  },
  readFileSync: (path: string) => { const node = state.nodes.get(path); if (!node?.bytes) throw new Error("Missing controlled bytes"); return Buffer.from(node.bytes); },
  readdirSync: (path: string) => [...state.nodes.keys()].filter(value => value.startsWith(`${path}\\`)
    && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1)),
  realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
}));
vi.mock("./owned/windows-owned-process.js", () => ({ prepareWindowsProcessBackend: state.prepareBackend,
  assertWindowsProcessBackend: (backend: unknown) => {
    if (backend !== state.permit || !state.binding) throw new Error("Unprepared controlled backend");
    state.binding.assertLocalInstallation();
  },
}));

import { describeWindowsProcessInstallation, prepareWindowsProcessInstallation, type WindowsProcessInstallation } from "./windows-process-installation.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const system = "C:\\Windows", directory = "C:\\LocalAppData\\Artoo\\Host", workspace = "C:\\workspaces\\product";
const currentSid = "S-1-5-21-100-200-300-1001", otherSid = "S-1-5-21-100-200-300-1002";
const administrator = "S-1-5-32-544", authenticatedUsers = "S-1-5-11";
const files = ["manifest.json", "Artoo.WindowsProcessHost.exe"];
type Ace = { sid: string; qualifier: string; mask: number; inheritOnly: boolean };
type NodeFact = { path: string; role: string; directory: boolean; attributes: number; volumeRoot: string;
  driveType: string; fileSystem: string; ownerSid: string | null; daclPresent: boolean; canonical: boolean; aces: Ace[] };
type Report = { version: number; currentSid: string; nodes: NodeFact[] };
let report: Report, input: WindowsProcessInstallation;
const allow = (sid: string, mask: number, inheritOnly = false): Ace => ({ sid, qualifier: "AccessAllowed", mask, inheritOnly });
const fact = (path: string, role: string, directory = true): NodeFact => ({ path, role, directory,
  attributes: directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS",
  ownerSid: role === "workspace" ? null : currentSid, daclPresent: role !== "workspace", canonical: role !== "workspace",
  aces: role === "workspace" ? [] : [allow(currentSid, 0x1f01ff), allow(administrator, 0x1f01ff), allow(authenticatedUsers, 0x1200a9)] });
const installFile = () => report.nodes.find(node => node.path === `${directory}\\Artoo.WindowsProcessHost.exe`)!;
function prepare() { return prepareWindowsProcessInstallation(input); }

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  vi.stubEnv("SystemRoot", system);
  state.nodes.clear(); state.aliases.clear(); state.binding = undefined;
  for (const path of ["C:\\", system, "C:\\LocalAppData", "C:\\LocalAppData\\Artoo", directory, "C:\\workspaces", workspace]) {
    state.nodes.set(path, { directory: true });
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64" }));
  state.nodes.set(`${directory}\\manifest.json`, { directory: false, bytes: manifest });
  state.nodes.set(`${directory}\\Artoo.WindowsProcessHost.exe`, { directory: false, bytes: Buffer.from("controlled, not an executable") });
  input = { directory, manifestSha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}`, writableWorkspaceRoots: [workspace] };
  report = { version: 1, currentSid, nodes: [
    ...["C:\\", "C:\\LocalAppData", "C:\\LocalAppData\\Artoo"].map(path => fact(path, "ancestor")),
    fact(directory, "installation"), ...files.map(name => fact(`${directory}\\${name}`, "installation", false)),
    ...["C:\\", "C:\\workspaces", workspace].map(path => fact(path, "workspace")),
  ] };
  state.spawnSync.mockReset().mockImplementation(() => ({ status: 0, signal: null, stdout: JSON.stringify(report), stderr: "" }));
  state.prepareBackend.mockReset().mockImplementation(binding => {
    state.binding = binding; binding.assertLocalInstallation(); return state.permit;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture);
  vi.unstubAllEnvs();
});

describe("controlled Windows installation admission policy", () => {
  it("describes only an original collector-qualified backend and rechecks its current installation", () => {
    const backend = prepare(), description = describeWindowsProcessInstallation(backend);
    expect(description).toEqual(input);
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description.writableWorkspaceRoots)).toBe(true);
    expect(() => describeWindowsProcessInstallation(structuredClone(backend))).toThrow(/locally qualified/);
    report.currentSid = otherSid;
    expect(() => describeWindowsProcessInstallation(backend)).toThrow();
  });
  it("admits the locally queried current SID without an administrator-owned installation", () => {
    expect(prepare()).toBe(state.permit);
    expect(state.binding?.directory).toBe(directory); expect(state.binding?.manifestSha256).toBe(input.manifestSha256);
    const [executable, argv, options] = state.spawnSync.mock.calls[0]!;
    expect(executable).toBe(`${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
    expect(argv.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(argv[4]).toContain("WindowsIdentity]::GetCurrent()"); expect(argv[4]).toContain("Get-Acl -LiteralPath $Path");
    expect(argv[4]).not.toContain(directory); expect(argv[4]).not.toContain(currentSid);
    expect(JSON.parse(options.input)).toEqual({ version: 1, directory, workspaceRoots: [workspace] });
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    expect(Object.keys(options.env).sort()).toEqual(["PATH", "PSModulePath", "SystemRoot", "WINDIR"]);
    expect(argv).not.toContain("-ExecutionPolicy");
  });

  it.each([2, 4, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000])("rejects another principal's installation write mask %i", mask => {
    installFile().aces.push(allow(otherSid, mask));
    expect(prepare).toThrow(/another principal can modify or replace/);
  });

  it("allows only sibling directory creation on a protected existing ancestor, as on C drive defaults", () => {
    report.nodes.find(node => node.path === "C:\\" && node.role === "ancestor")!.aces.push(allow(authenticatedUsers, 4));
    expect(prepare()).toBe(state.permit);
  });
  it.each([2, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000])("rejects parent replacement/control mask %i", mask => {
    report.nodes.find(node => node.path === "C:\\" && node.role === "ancestor")!.aces.push(allow(otherSid, mask));
    expect(prepare).toThrow(/another principal can modify or replace/);
  });

  it("rejects an untrusted owner even when its explicit DACL is read-only", () => {
    installFile().ownerSid = otherSid; installFile().aces = [allow(otherSid, 0x1200a9)];
    expect(prepare).toThrow(/untrusted owner/);
  });
  it("does not excuse a dangerous allow by accepting a deny entry as an attestation", () => {
    installFile().aces.unshift({ sid: otherSid, qualifier: "AccessDenied", mask: 2, inheritOnly: false }, allow(otherSid, 2));
    expect(prepare).toThrow(/another principal can modify or replace/);
  });
  it("ignores an inherit-only ancestor ACE but audits a descendant's effective allow", () => {
    report.nodes[0]!.aces.push(allow(otherSid, 0x10000000, true)); expect(prepare()).toBe(state.permit);
    installFile().aces.push(allow(otherSid, 2)); expect(() => state.binding!.assertLocalInstallation()).toThrow(/another principal/);
  });
  it.each(["daclPresent", "canonical"] as const)("rejects absent/noncanonical DACL: %s", flag => {
    installFile()[flag] = false; expect(prepare).toThrow(/unsupported DACL/);
  });

  it.each(["network", "filesystem", "reparse"])("rejects unsupported physical storage: %s", failure => {
    const node = report.nodes[0]!;
    if (failure === "network") node.driveType = "Network";
    if (failure === "filesystem") node.fileSystem = "ReFS";
    if (failure === "reparse") node.attributes |= 0x400;
    expect(prepare).toThrow(/physical NTFS path facts/);
  });
  it("rejects a root or installation alias before invoking the ACL collector", () => {
    state.aliases.set(directory, "C:\\somewhere-else"); expect(prepare).toThrow(/physical path/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it.each(["C:\\", directory, "C:\\LocalAppData"])("rejects overlap with all configured agent write roots: %s", root => {
    input = { ...input, writableWorkspaceRoots: [workspace, root] };
    expect(prepare).toThrow(/overlaps an agent writable root/); expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it("does not let a caller provide trusted SIDs or a qualification callback", () => {
    expect(() => prepareWindowsProcessInstallation({ ...input, currentSid: otherSid } as WindowsProcessInstallation)).toThrow(/explicit local bundle/);
    expect(() => prepareWindowsProcessInstallation({ ...input, assertLocalInstallation: () => true } as WindowsProcessInstallation)).toThrow(/explicit local bundle/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it("rejects an empty write-root set", () => {
    input = { ...input, writableWorkspaceRoots: [] }; expect(prepare).toThrow(/all agent write roots/);
  });
  it("requires native Windows x64", () => {
    Object.defineProperty(process, "arch", { ...architecture, value: "ia32" }); expect(prepare).toThrow(/native win-x64/);
    Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
    Object.defineProperty(process, "platform", { ...platform, value: "linux" }); expect(prepare).toThrow(/native win-x64/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });

  it("re-audits real authority through the private callback supplied to the backend", () => {
    prepare(); expect(state.spawnSync).toHaveBeenCalledOnce();
    installFile().aces.push(allow(otherSid, 0x40000));
    expect(() => state.binding!.assertLocalInstallation()).toThrow(/another principal/);
    expect(state.spawnSync).toHaveBeenCalledTimes(2);
  });
  it("binds the local identity across subsequent checks", () => {
    prepare(); report.currentSid = otherSid;
    expect(() => state.binding!.assertLocalInstallation()).toThrow(/collector identity/);
  });
  it("snapshots local write roots instead of trusting a later mutated caller array", () => {
    const roots = [workspace]; input = { ...input, writableWorkspaceRoots: roots }; prepare(); roots[0] = directory;
    state.binding!.assertLocalInstallation();
    expect(JSON.parse(state.spawnSync.mock.calls.at(-1)![2].input).workspaceRoots).toEqual([workspace]);
  });
  it("rejects omitted installation members and missing workspace components", () => {
    report.nodes = report.nodes.filter(node => node.path !== `${directory}\\Artoo.WindowsProcessHost.exe`);
    expect(prepare).toThrow(/omitted/);
  });
  it("rejects a file added while the collector is executing", () => {
    state.spawnSync.mockImplementation(() => {
      state.nodes.set(`${directory}\\extra.dll`, { directory: false, bytes: Buffer.from("new file") });
      return { status: 0, signal: null, stdout: JSON.stringify(report), stderr: "" };
    });
    expect(prepare).toThrow(/inventory changed/);
  });
  it.each(["timeout", "failure", "malformed"])("fails closed on collector %s", mode => {
    state.spawnSync.mockReturnValue(mode === "malformed" ? { status: 0, signal: null, stdout: "not json" }
      : { status: 1, signal: null, error: mode === "timeout" ? new Error("timeout") : undefined,
        stdout: JSON.stringify({ version: 1, errorCode: "acl_read_failed", path: directory }) });
    expect(prepare).toThrow(/collector|acl_read_failed/);
  });
});
