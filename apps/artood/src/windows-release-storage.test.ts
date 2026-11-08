// Controlled policy regressions. Real NTFS/PowerShell/process qualification is a separate fixture.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  spawnSync: vi.fn(), readFileSync: vi.fn(), sequence: 0n,
  nodes: new Map<string, { directory: boolean; ino: bigint; ctimeNs: bigint; mtimeNs?: bigint; size?: bigint; link?: boolean; nlink?: bigint }>(),
  aliases: new Map<string, string>(),
}));
vi.mock("node:child_process", () => ({ spawnSync: state.spawnSync }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:fs", () => ({
  readFileSync: state.readFileSync,
  lstatSync: vi.fn((path: string, options?: { bigint?: boolean }) => {
    const node = state.nodes.get(path); if (!node) throw Object.assign(new Error("Missing controlled file"), { code: "ENOENT" });
    return { isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => !!node.link,
      nlink: options?.bigint ? node.nlink ?? 1n : Number(node.nlink ?? 1n), dev: 1n, ino: node.ino,
      ctimeNs: node.ctimeNs, mtimeNs: node.mtimeNs ?? 1n, size: node.size ?? 0n };
  }),
  readdirSync: vi.fn((path: string) => [...state.nodes.keys()].filter(value => value.startsWith(`${path}\\`)
    && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1))),
  realpathSync: { native: vi.fn((path: string) => state.aliases.get(path) ?? path) },
}));
import { assertWindowsReleaseStorage, auditWindowsReleaseStorage, prepareWindowsReleaseStorage,
  type PreparedWindowsReleaseStorage, type WindowsReleaseStorageInput } from "./windows-release-storage.js";
import { collectWindowsAclFacts, type WindowsAclFact, type WindowsAclReport, type WindowsAclTarget } from "./windows-local-acl.js";
import { recordWindowsStartupPhase, withWindowsStartupDiagnostics, WindowsStartupDiagnosticSchema,
  type WindowsStartupDiagnostic } from "./windows-startup-diagnostics.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const currentSid = "S-1-5-21-100-200-300-1001", otherSid = "S-1-5-21-100-200-300-1002";
const directory = "C:\\Users\\node\\.artoo\\releases", workspace = "C:\\products\\one";
let input: WindowsReleaseStorageInput, change: (report: WindowsAclReport) => void;
function add(path: string, directory = true): void { state.nodes.set(path, { directory, ino: ++state.sequence, ctimeNs: 1n }); }
function defaultReport(targets: readonly WindowsAclTarget[]): WindowsAclReport {
  return { version: 1, currentSid, nodes: targets.map(target => ({ path: target.path, directory: target.directory,
    attributes: target.directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS",
    ownerSid: target.readAcl ? currentSid : null, daclPresent: target.readAcl, canonical: target.readAcl,
    aces: target.readAcl ? [{ sid: currentSid, qualifier: "AccessAllowed", mask: 0x1f01ff, flags: target.directory ? 3 : 0 }] : [] })) };
}
function node(report: WindowsAclReport, path = directory): WindowsAclFact { return report.nodes.find(item => item.path === path)!; }
function prepare(): PreparedWindowsReleaseStorage { return prepareWindowsReleaseStorage(input); }
const changedPrefix = "Windows release storage: storage changed during ACL audit ";
function auditRejection(): Error {
  let caught: unknown;
  try { prepare(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message.startsWith(changedPrefix)).toBe(true);
  return error;
}
const pathHash = (value: string): string => createHash("sha256").update(value).digest("hex");
async function startupRejection(work: () => unknown) {
  const events: WindowsStartupDiagnostic[] = []; let original: unknown;
  const pending = withWindowsStartupDiagnostics(value => events.push(value), async () => {
    recordWindowsStartupPhase("source_store_audit");
    try { work(); } catch (error) { original = error; throw error; }
  });
  await expect(pending).rejects.toBe(original);
  expect(events.at(-1)).toMatchObject({ phase: "source_store_audit", status: "failed", error_code: "startup_stage_failed" });
  expect(events.every(value => WindowsStartupDiagnosticSchema.safeParse(value).success)).toBe(true);
  expect(events.slice(0, -1).every(value => value.storage_failure === undefined)).toBe(true);
  for (const secret of [directory, currentSid, otherSid, pathHash(directory)])
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(secret).slice(1, -1));
  return { error: original as Error, failure: events.at(-1)!, events };
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  state.nodes.clear(); state.aliases.clear(); state.sequence = 9007199254740991n;
  vi.mocked(lstatSync).mockClear(); vi.mocked(readdirSync).mockClear(); vi.mocked(realpathSync.native).mockClear();
  state.readFileSync.mockReset().mockImplementation(() => { throw new Error("Diagnostic must not read file contents"); });
  for (const path of ["C:\\", "C:\\Windows", "C:\\Users", "C:\\Users\\node", "C:\\Users\\node\\.artoo", directory,
    "C:\\products", workspace]) add(path);
  input = { directory, writableWorkspaceRoots: [workspace] }; change = () => undefined;
  state.spawnSync.mockReset().mockImplementation((_exe, _argv, options) => {
    const report = defaultReport(JSON.parse(options.input).paths); change(report);
    return { status: 0, signal: null, stdout: JSON.stringify(report) };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture); vi.unstubAllEnvs();
});

describe("Windows mutable release-storage authority", () => {
  it("still rejects Program Files-style CREATOR OWNER future-child write rights for mutable storage", () => {
    change = report => node(report).aces.push({ sid: "S-1-3-0", qualifier: "AccessAllowed", mask: 0x10000000, flags: 11 });
    expect(prepare).toThrow(/future children/);
  });
  it("prepares per-user storage, uses fixed local script and keeps serving checks out of PowerShell", () => {
    const prepared = prepare(); expect(Object.isFrozen(prepared)).toBe(true);
    const [executable, argv, options] = state.spawnSync.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(argv.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(argv[4]).toContain("WindowsIdentity]::GetCurrent()"); expect(argv[4]).not.toContain(directory);
    expect(argv[4]).toContain("flags = [int]$ace.AceFlags"); expect(argv).not.toContain("-ExecutionPolicy");
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 60000 });
    expect(Object.keys(options.env).sort()).toEqual(["PATH", "PSModulePath", "SystemRoot", "WINDIR"]);
    assertWindowsReleaseStorage(prepared, directory); assertWindowsReleaseStorage(prepared, directory);
    expect(state.spawnSync).toHaveBeenCalledOnce();
    auditWindowsReleaseStorage(prepared, directory); expect(state.spawnSync).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2, 3, 5, 6, 9, 10, 11, 13, 14])("rejects unsafe future-child inheritance with ACE flags %i", flags => {
    change = report => node(report).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 0x40000000, flags });
    expect(prepare).toThrow(/future children/);
  });
  it("does not confuse safe parent inheritance-only ACEs with effective current-storage rights", () => {
    change = report => node(report, "C:\\").aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 0x10000000, flags: 11 });
    prepare();
  });
  it("admits sibling directory creation on an existing ancestor but rejects DeleteChild", () => {
    change = report => node(report, "C:\\").aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 4, flags: 0 }); prepare();
    change = report => node(report, "C:\\").aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 64, flags: 0 });
    expect(prepare).toThrow(/another principal/);
  });
  it("audits an existing file's explicit ACL even beneath a safe parent", () => {
    const file = `${directory}\\existing.json`; add(file, false);
    change = report => node(report, file).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 0 });
    expect(prepare).toThrow(/another principal/);
  });
  it("does not excuse unsafe allows with a deny", () => {
    change = report => node(report).aces.push({ sid: otherSid, qualifier: "AccessDenied", mask: 2, flags: 0 },
      { sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 0 }); expect(prepare).toThrow(/another principal/);
  });
  it("rejects another owner", () => { change = report => { node(report).ownerSid = otherSid; }; expect(prepare).toThrow(/untrusted owner/); });
  it("binds every allowed root and rejects overlap case-insensitively", () => {
    input = { ...input, writableWorkspaceRoots: [workspace, "C:\\Users\\node"] }; expect(prepare).toThrow(/overlaps/);
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it("freezes the caller's root list and detects physical workspace replacement", () => {
    const roots = [workspace]; input = { ...input, writableWorkspaceRoots: roots }; const prepared = prepare(); roots[0] = directory;
    assertWindowsReleaseStorage(prepared, directory); state.nodes.get(workspace)!.ino++;
    expect(() => assertWindowsReleaseStorage(prepared, directory)).toThrow(/fixed physical identity changed/);
  });
  it("uses exact bigint file IDs and detects adjacent IDs above Number safe range", () => {
    const prepared = prepare(); state.nodes.get(directory)!.ino++;
    expect(() => assertWindowsReleaseStorage(prepared, directory)).toThrow(/fixed physical identity changed/);
  });
  it("allows new state files then re-audits them and pins new layout directories", () => {
    const prepared = prepare(); const operations = `${directory}\\operations`; add(operations); add(`${operations}\\a.json`, false);
    auditWindowsReleaseStorage(prepared, directory); expect(state.spawnSync).toHaveBeenCalledTimes(2);
    state.nodes.get(operations)!.ino++;
    expect(() => assertWindowsReleaseStorage(prepared, directory)).toThrow(/layout identity changed/);
  });
  it("rejects inventory and metadata mutations while ACL collection runs", () => {
    const file = `${directory}\\a.json`; add(file, false);
    change = () => { state.nodes.get(file)!.ctimeNs++; }; expect(prepare).toThrow(/changed during ACL audit/);
  });
  it.each(["added", "removed", "identity", "ctime", "mtime", "size"])("keeps rejecting %s and safely projects the captured change without re-reading it", async field => {
    const file = `${directory}\\a.json`;
    if (field !== "added") add(file, false);
    change = () => {
      if (field === "added") add(file, false);
      else if (field === "removed") state.nodes.delete(file);
      else {
        const selected = state.nodes.get(file)!;
        if (field === "identity") selected.ino++;
        if (field === "ctime") selected.ctimeNs++;
        if (field === "mtime") selected.mtimeNs = 2n;
        if (field === "size") selected.size = 1n;
      }
    };
    const { error, failure, events } = await startupRejection(prepare);
    expect(error.message.startsWith(changedPrefix)).toBe(true);
    expect(JSON.parse(error.message.slice(changedPrefix.length))).toEqual({
      root: { value: directory, truncated: false, sha256: pathHash(directory) },
      first_change: { relative: { value: "a.json", truncated: false, sha256: pathHash("a.json") }, fields: [field] },
    });
    expect(failure.storage_failure).toEqual({ code: "storage_inventory_changed", first_change_fields: [field] });
    expect(JSON.stringify(events)).not.toContain("a.json"); expect(JSON.stringify(events)).not.toContain(pathHash("a.json"));
    // Files occur once per captured inventory; neither diagnostic projection performs another observation.
    const observations = field === "added" || field === "removed" ? 1 : 2;
    expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === file)).toHaveLength(observations);
    expect(vi.mocked(realpathSync.native).mock.calls.filter(([path]) => path === file)).toHaveLength(observations);
    expect(vi.mocked(readdirSync).mock.calls.filter(([path]) => path === directory)).toHaveLength(2);
    expect(state.spawnSync).toHaveBeenCalledOnce(); expect(state.readFileSync).not.toHaveBeenCalled();
  });
  it("reports only the first changed relative item and all of its changed fields", () => {
    const first = `${directory}\\a.json`, later = `${directory}\\z.json`; add(later, false); add(first, false);
    change = () => {
      state.nodes.get(later)!.ctimeNs++;
      const selected = state.nodes.get(first)!; selected.ino++; selected.ctimeNs++; selected.mtimeNs = 2n; selected.size = 1n;
    };
    const error = auditRejection(), details = JSON.parse(error.message.slice(changedPrefix.length));
    expect(details.first_change.relative.value).toBe("a.json");
    expect(details.first_change.fields).toEqual(["identity", "ctime", "mtime", "size"]);
    expect(error.message).not.toContain("z.json"); expect(state.spawnSync).toHaveBeenCalledOnce();
  });
  it.each(["added", "removed"])("still rejects equal-count inventory replacement and reports the first %s item", field => {
    const oldName = field === "added" ? "z.json" : "a.json", newName = field === "added" ? "a.json" : "z.json";
    add(`${directory}\\${oldName}`, false);
    change = () => { state.nodes.delete(`${directory}\\${oldName}`); add(`${directory}\\${newName}`, false); };
    const error = auditRejection(), details = JSON.parse(error.message.slice(changedPrefix.length));
    expect(details.first_change.relative.value).toBe("a.json"); expect(details.first_change.fields).toEqual([field]);
    expect(state.spawnSync).toHaveBeenCalledOnce();
  });
  it("identifies a storage-root metadata change with the relative dot entry", () => {
    change = () => { state.nodes.get(directory)!.ctimeNs++; };
    const error = auditRejection(), details = JSON.parse(error.message.slice(changedPrefix.length));
    expect(details.root.value).toBe(directory); expect(details.first_change.relative.value).toBe(".");
    expect(details.first_change.fields).toEqual(["ctime"]); expect(state.spawnSync).toHaveBeenCalledOnce();
  });
  it("bounds and escapes path diagnostics without contents, ACLs, environment or metadata values", () => {
    const rootParts = ["root" + "根".repeat(90), "中".repeat(90), "末".repeat(90)];
    let root = "C:";
    for (const part of rootParts) { root += `\\${part}`; add(root); }
    input = { ...input, directory: root };
    const relativeParts = ["a" + "文".repeat(90), "件".repeat(90), "診".repeat(90) + "\u202e\u0085.json"];
    let file = root;
    for (const [index, part] of relativeParts.entries()) { file += `\\${part}`; add(file, index < relativeParts.length - 1); }
    const relative = relativeParts.join("\\"), contents = "synthetic_file_content_do_not_emit", environment = "synthetic_env_value_do_not_emit";
    state.readFileSync.mockReturnValue(Buffer.from(contents)); vi.stubEnv("ARTOO_DIAGNOSTIC_TEST_SECRET", environment);
    const later = Array.from({ length: 32 }, (_, index) => `${root}\\z-later-${index}.json`);
    for (const path of later) add(path, false);
    change = () => { for (const path of [file, ...later]) state.nodes.get(path)!.ctimeNs = 98765432109876543210987654321n; };
    const error = auditRejection(), details = JSON.parse(error.message.slice(changedPrefix.length));
    expect(error.message.length).toBeLessThanOrEqual(4096); expect(error.message).toMatch(/^[\x20-\x7e]+$/u);
    expect(Object.keys(details)).toEqual(["root", "first_change"]);
    expect(details.root).toMatchObject({ truncated: true, sha256: pathHash(root) });
    expect(details.first_change.relative).toMatchObject({ truncated: true, sha256: pathHash(relative) });
    expect(details.root.value.length).toBeLessThanOrEqual(240); expect(details.first_change.relative.value.length).toBeLessThanOrEqual(240);
    expect(details.first_change.fields).toEqual(["ctime"]);
    for (const forbidden of [contents, environment, "AccessAllowed", "ownerSid", currentSid, "98765432109876543210987654321", "z-later-"])
      expect(error.message).not.toContain(forbidden);
    expect(state.readFileSync).not.toHaveBeenCalled(); expect(state.spawnSync).toHaveBeenCalledOnce();
  });
  it("rejects hardlinks and aliases before collecting authority", () => {
    const file = `${directory}\\a.json`; add(file, false); state.nodes.get(file)!.nlink = 2n; expect(prepare).toThrow(/linked/);
    state.nodes.delete(file); state.aliases.set(directory, "C:\\elsewhere"); expect(prepare).toThrow(/physical path/);
  });
  it("rejects unsupported names rather than allowing Windows normalization", () => {
    add(`${directory}\\file.`); expect(prepare).toThrow(/unsupported Windows path/);
    state.nodes.delete(`${directory}\\file.`); add(`${directory}\\NUL.txt`, false); expect(prepare).toThrow(/unsupported Windows path/);
  });
  it("refuses caller assertions, empty root sets and forged storage objects", () => {
    expect(() => prepareWindowsReleaseStorage({ ...input, trusted: true } as WindowsReleaseStorageInput)).toThrow(/explicit local/);
    expect(() => prepareWindowsReleaseStorage({ ...input, writableWorkspaceRoots: [] })).toThrow(/explicit local/);
    expect(() => assertWindowsReleaseStorage(Object.freeze({}) as PreparedWindowsReleaseStorage, directory)).toThrow(/locally prepared/);
    const prepared = prepare(); expect(() => assertWindowsReleaseStorage(prepared, workspace)).toThrow(/another directory/);
  });
  it("rejects a changed current SID on the next serialized audit", () => {
    const prepared = prepare(); change = report => { report.currentSid = otherSid; };
    expect(() => auditWindowsReleaseStorage(prepared, directory)).toThrow(/Windows identity changed/);
  });
  it.each(["network", "fat", "reparse", "missing", "duplicate", "noncanonical", "null", "flags"])("rejects invalid real collector facts: %s", variant => {
    change = report => {
      const selected = node(report);
      if (variant === "network") selected.driveType = "Network";
      if (variant === "fat") selected.fileSystem = "FAT32";
      if (variant === "reparse") selected.attributes |= 0x400;
      if (variant === "missing") report.nodes.pop();
      if (variant === "duplicate") report.nodes[report.nodes.length - 1] = report.nodes[0]!;
      if (variant === "noncanonical") selected.canonical = false;
      if (variant === "null") selected.daclPresent = false;
      if (variant === "flags") selected.aces[0]!.flags = 128;
    }; expect(prepare).toThrow(/facts|inventory|DACL/);
  });
  it.each(["error", "nonzero", "signal", "invalid-json", "null-json"])("fails closed and safely classifies collector failure: %s", async variant => {
    state.spawnSync.mockReturnValue({ status: variant === "nonzero" ? 1 : 0, signal: variant === "signal" ? "SIGTERM" : null,
      error: variant === "error" ? new Error("timeout") : undefined,
      stdout: variant === "invalid-json" ? "bad json" : variant === "null-json" ? "null" : JSON.stringify({ errorCode: "audit_failure", path: directory }) });
    const { error, failure, events } = await startupRejection(prepare);
    expect(error.message).toMatch(/audit_failure|facts|response/);
    expect(failure.storage_failure).toEqual({ code: ["error", "nonzero", "signal"].includes(variant) ? "acl_collector_failed" : "acl_facts_rejected" });
    expect(JSON.stringify(events)).not.toContain("audit_failure"); expect(state.spawnSync).toHaveBeenCalledOnce();
  });
  it.each(["binding", "boundary", "owner", "write-rights", "input", "facts"])("projects a real %s rejection without weakening it", async variant => {
    let work: () => unknown = prepare;
    if (variant === "binding") work = () => assertWindowsReleaseStorage(Object.freeze({}) as PreparedWindowsReleaseStorage, directory);
    if (variant === "boundary") { add(`${directory}\\linked.json`, false); state.nodes.get(`${directory}\\linked.json`)!.nlink = 2n; }
    if (variant === "owner") change = report => { node(report).ownerSid = otherSid; };
    if (variant === "write-rights") change = report => { node(report).aces.push({ sid: otherSid, qualifier: "AccessAllowed", mask: 2, flags: 0 }); };
    if (variant === "input") input = { ...input, directory: "C:\\private-input." };
    if (variant === "facts") change = report => { node(report).daclPresent = false; };
    const { error, failure } = await startupRejection(work);
    const expected = {
      binding: ["storage_binding_rejected", /locally prepared/], boundary: ["storage_boundary_rejected", /linked/],
      owner: ["storage_acl_rejected", /untrusted owner/], "write-rights": ["storage_acl_rejected", /another principal/],
      input: ["acl_input_rejected", /unsupported Windows path/], facts: ["acl_facts_rejected", /DACL/],
    } as const;
    expect(error.message).toMatch(expected[variant as keyof typeof expected][1]);
    expect(failure.storage_failure).toEqual({ code: expected[variant as keyof typeof expected][0] });
  });
  it("retains an unknown filesystem error object and projects only its local observation category", async () => {
    const original = Object.freeze(Object.assign(new Error("private-filesystem-error-and-path"), { code: "private-filesystem-code" }));
    vi.mocked(lstatSync).mockImplementationOnce(() => { throw original; });
    const { error, failure, events } = await startupRejection(prepare);
    expect(error).toBe(original); expect(error.message).toBe("private-filesystem-error-and-path");
    expect(failure.storage_failure).toEqual({ code: "filesystem_observation_failed" });
    expect(JSON.stringify(events)).not.toContain("private-"); expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it("does not authorize non-Windows execution", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" }); expect(prepare).toThrow(/native win-x64/);
  });
  it("rejects duplicate collector targets before spawning", () => {
    const target = { path: directory, directory: true, readAcl: true };
    expect(() => collectWindowsAclFacts([target, target])).toThrow(/duplicate/); expect(state.spawnSync).not.toHaveBeenCalled();
  });
});
