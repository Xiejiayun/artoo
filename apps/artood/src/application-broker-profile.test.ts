// Controlled filesystem and ACL collector. Live NTFS evidence is recorded separately.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationBrokerInstallation } from "./application-broker-process.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
type Node = { directory: boolean; ino: bigint; bytes: Buffer; ctimeNs: bigint; mtimeNs: bigint; nlink: bigint; link?: boolean };
const state = vi.hoisted(() => ({ nodes: new Map<string, Node>(), handles: new Map<number, { path: string; node: Node }>(),
  aliases: new Map<string, string>(), next: 0n, fd: 0, opened: [] as string[], backend: Object.freeze({}),
  nativeRoots: [] as string[], aclUnsafe: "" as string, prepare: vi.fn(), collect: vi.fn(),
  afterRead: (_path: string, _node: Node) => {}, afterClose: (_path: string, _node: Node) => {}, beforePrepare: () => {},
}));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:child_process", () => ({ spawnSync: state.collect, spawn: () => { throw Error("No asynchronous process may start in this controlled check"); } }));
vi.mock("node:fs", () => {
  const facts = (node: Node) => ({ ...node, dev: 1n, size: BigInt(node.bytes.length),
    isFile: () => !node.directory, isDirectory: () => node.directory, isSymbolicLink: () => !!node.link });
  return {
    lstatSync: (path: string) => { const node = state.nodes.get(path); if (!node) throw Error("Missing controlled file"); return facts(node); },
    realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
    readdirSync: (path: string) => [...state.nodes.keys()].filter(value => value.startsWith(`${path}\\`)
      && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1)),
    openSync: (path: string, mode: string) => {
      if (mode !== "r" || path.endsWith("data.sqlite")) throw Error("Database or write open attempted");
      const node = state.nodes.get(path); if (!node) throw Error("Missing controlled file");
      state.opened.push(path); const fd = ++state.fd; state.handles.set(fd, { path, node }); return fd;
    },
    fstatSync: (fd: number) => facts(state.handles.get(fd)!.node),
    closeSync: (fd: number) => { const { path, node } = state.handles.get(fd)!; state.handles.delete(fd); state.afterClose(path, node); },
    readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => {
      const { path, node } = state.handles.get(fd)!;
      const count = node.bytes.copy(output, offset, position, position + length);
      if (count) state.afterRead(path, node);
      return count;
    },
  };
});
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: (backend: unknown) => {
  if (backend !== state.backend) throw Error("Original native installation required");
  return { directory: "C:\\node\\native", manifestSha256: `sha256:${"a".repeat(64)}`, writableWorkspaceRoots: state.nativeRoots };
} }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (backend: unknown) => {
  if (backend !== state.backend) throw Error("Original native backend required");
} }));
vi.mock("./application-broker-process.js", () => ({ prepareApplicationBrokerProcess: state.prepare }));
import { checkApplicationBrokerProfileFile } from "./application-broker-profile.js";
import type { WindowsAclTarget } from "./windows-local-acl.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const file = "C:\\node\\settings\\profile.json", configuration = "C:\\node\\settings\\broker.json";
const database = "C:\\node\\store\\data.sqlite", entry = "C:\\node\\broker\\application-broker.mjs", node = "C:\\node\\runtime\\node.exe";
const allowedRoots = ["C:\\products\\one", "C:\\products\\two"], sid = "S-1-5-21-100-200-300-1001";
const scope = { product_id: "p1", data_generation: "d1", service_generation: 1, artifact_digest: `sha256:${"b".repeat(64)}` };
function add(path: string, bytes?: string): void {
  state.nodes.set(path, { directory: bytes === undefined, bytes: Buffer.from(bytes ?? ""), ino: ++state.next,
    ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
}
function pin(path: string) { const bytes = state.nodes.get(path)!.bytes; return { path, bytes: bytes.length,
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }; }
function saveProfile(change: Record<string, unknown> = {}) {
  add(file, JSON.stringify({ version: 1, format: "artoo.application-broker-profile.v1", node_id: "node1",
    writable_workspace_roots: allowedRoots, node: pin(node), entry: pin(entry), configuration: pin(configuration),
    storage_directory: "C:\\node\\store", ...change }));
}
function saveConfiguration(change: Record<string, unknown> = {}) {
  add(configuration, JSON.stringify({ version: 1, protocol: "artoo.application-broker.v1", databasePath: database,
    mode: "open", maximumAccess: "read", scope,
    schemaJson: JSON.stringify({ version: 1, tables: [{ name: "items", columns: [{ name: "value", type: "text", max_bytes: 64, nullable: false }] }] }),
    ...change })); saveProfile();
}
const options = () => ({ file, nodeId: "node1", allowedRoots: [...allowedRoots], backend: state.backend as PreparedWindowsProcessBackend });
const check = () => checkApplicationBrokerProfileFile(options());
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  state.nodes.clear(); state.handles.clear(); state.aliases.clear(); state.opened = []; state.next = 9007199254740991n;
  state.nativeRoots = [...allowedRoots]; state.aclUnsafe = ""; state.afterRead = () => {}; state.afterClose = () => {}; state.beforePrepare = () => {};
  for (const path of ["C:\\", "C:\\Windows", "C:\\node", "C:\\node\\settings", "C:\\node\\runtime", "C:\\node\\broker", "C:\\node\\native",
    "C:\\node\\store", "C:\\products", ...allowedRoots]) add(path);
  add(node, "controlled Node image"); add(entry, "controlled trusted broker bytes"); add(database, "unopened sentinel bytes"); saveConfiguration();
  state.collect.mockReset().mockImplementation((_program, _args, options) => {
    const targets = JSON.parse(options.input).paths as WindowsAclTarget[];
    return { status: 0, signal: null, stdout: JSON.stringify({ version: 1, currentSid: sid,
      nodes: targets.map(target => ({ ...target, attributes: target.directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS",
        ownerSid: sid, daclPresent: true, canonical: true, aces: [{ sid: target.path === state.aclUnsafe ? "S-1-1-0" : sid,
          qualifier: "AccessAllowed", mask: 2, flags: target.directory ? 3 : 0 }] })) }) };
  });
  state.prepare.mockReset().mockImplementation((input: ApplicationBrokerInstallation) => {
    state.beforePrepare(); input.native.assertLocalInstallation(); input.assertLocalAdmission(); return Object.freeze({});
  });
});
afterEach(() => {
  expect(state.handles.size).toBe(0);
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture); vi.unstubAllEnvs();
});

describe("offline broker profile fixed local admission", () => {
  it("uses protected installation/storage policies and returns no process token or report", () => {
    expect(check()).toBeUndefined(); expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.opened).not.toContain(database);
    const installed: ApplicationBrokerInstallation = state.prepare.mock.calls[0]![0];
    expect(installed.node).toEqual(pin(node)); expect(installed.configuration).toEqual(pin(configuration));
    expect(state.collect.mock.calls.flatMap(call => (JSON.parse(call[2].input).paths as WindowsAclTarget[]).map(target => target.path))).toContain(database);
    expect(state.collect.mock.calls.length).toBeGreaterThan(5);
  });
  it.each(["node", "roots", "duplicate", "native-roots", "forged-backend"])("requires the exact declared local binding: %s", variant => {
    const input = options();
    if (variant === "node") input.nodeId = "other";
    if (variant === "roots") input.allowedRoots.pop();
    if (variant === "duplicate") saveProfile({ writable_workspace_roots: [allowedRoots[0], allowedRoots[0]] });
    if (variant === "native-roots") state.nativeRoots.pop();
    if (variant === "forged-backend") input.backend = {} as PreparedWindowsProcessBackend;
    expect(() => checkApplicationBrokerProfileFile(input)).toThrow(); expect(state.prepare).not.toHaveBeenCalled();
  });
  it.each(["profile-policy", "caller-policy"])("refuses caller-selected policy or callbacks: %s", variant => {
    const bypass = vi.fn();
    if (variant === "profile-policy") saveProfile({ assertLocalAdmission: "bypass" });
    const input = variant === "caller-policy" ? { ...options(), assertLocalAdmission: bypass } : options();
    expect(() => checkApplicationBrokerProfileFile(input)).toThrow(); expect(bypass).not.toHaveBeenCalled();
  });
  it.each([{ mode: "create" }, { maximumAccess: "write" }, { schemaJson: "{}" }, { scope: { ...scope, artifact_digest: "unmeasured" } }])
    ("rejects unsupported configuration %j", change => { saveConfiguration(change); expect(check).toThrow(); expect(state.prepare).not.toHaveBeenCalled(); });
  it("does not equate a locally declared digest with compiler or product qualification", () => {
    // Any syntactically valid local declaration may be inspected; it is not source evidence.
    saveConfiguration({ scope: { ...scope, artifact_digest: `sha256:${"0".repeat(64)}` } }); expect(check()).toBeUndefined();
  });
  it.each(["outside", "code-overlap", "missing", "hardlink", "symlink", "alias"])("refuses an unsafe database boundary: %s", variant => {
    if (variant === "outside") saveConfiguration({ databasePath: "C:\\node\\elsewhere\\data.sqlite" });
    if (variant === "code-overlap") saveProfile({ storage_directory: "C:\\node\\settings" });
    if (variant === "missing") state.nodes.delete(database);
    if (variant === "hardlink") state.nodes.get(database)!.nlink = 2n;
    if (variant === "symlink") state.nodes.get(database)!.link = true;
    if (variant === "alias") state.aliases.set(database, "C:\\other.sqlite");
    expect(check).toThrow(); expect(state.opened).not.toContain(database);
  });
  it.each([file, node, entry, configuration])("requires the original fixed physical bytes at %s", path => {
    state.nodes.get(path)!.bytes = Buffer.from("changed"); expect(check).toThrow();
  });
  it("rejects unsafe ACL before reading the profile", () => {
    state.aclUnsafe = file; expect(check).toThrow(/modify/); expect(state.opened).toEqual([]);
  });
  it("re-audits ACLs inside the fixed low-level admission callback", () => {
    state.beforePrepare = () => { state.aclUnsafe = database; }; expect(check).toThrow(/modify/);
  });
  it.each([database, entry, allowedRoots[1]!])("detects replacement with adjacent bigint identities at %s", path => {
    state.beforePrepare = () => { state.nodes.get(path)!.ino++; }; expect(check).toThrow(/identity|inventory/);
  });
  it("detects database metadata changes without reading its contents", () => {
    state.beforePrepare = () => { state.nodes.get(database)!.mtimeNs++; }; expect(check).toThrow(/database identity or metadata/);
    expect(state.opened).not.toContain(database);
  });
  it("checks the original open handle and current filename during every read", () => {
    state.afterRead = (path, old) => { if (path === configuration) state.nodes.set(path, { ...old, ino: old.ino + 1n }); };
    expect(check).toThrow(/changed while reading/);
  });
  it("detects growth with a bounded extra byte", () => {
    state.afterRead = (path, current) => { if (path === configuration) current.bytes = Buffer.concat([current.bytes, Buffer.from("x")]); };
    expect(check).toThrow(/changed while reading/);
  });
  it("allows only the initial stable NTFS access-metadata update", () => {
    let updated = false;
    state.afterRead = (path, current) => { if (path === file && !updated) { updated = true; current.ctimeNs++; } };
    expect(check()).toBeUndefined();
  });
  it("rejects ctime changes continuing through the second pass", () => {
    state.afterRead = (path, current) => { if (path === file) current.ctimeNs++; }; expect(check).toThrow(/changed while reading/);
  });
  it("includes the first handle close before binding stable NTFS access metadata", () => {
    let updated = false;
    state.afterClose = (path, current) => { if (path === file && !updated) { updated = true; current.ctimeNs++; } };
    expect(check()).toBeUndefined();
  });
  it("rejects metadata changes continuing through the second handle close", () => {
    state.afterClose = (path, current) => { if (path === file) current.ctimeNs++; }; expect(check).toThrow(/changed/);
  });
  it("never permits file replacement or content metadata changes on the first close", () => {
    state.afterClose = (path, current) => { if (path === file) current.ino++; }; expect(check).toThrow(/changed/);
    state.afterClose = (path, current) => { if (path === file) current.mtimeNs++; }; expect(check).toThrow(/changed/);
  });
  it("rejects byte mutation despite unchanged size and timestamp", () => {
    let changed = false;
    state.afterRead = (path, current) => { if (path === file && !changed) { changed = true; current.bytes[0] = 91; } };
    expect(check).toThrow(/bytes did not stabilize/);
  });
  it("rejects non-Windows before reading or qualifying any input", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" }); expect(check).toThrow(/native win-x64/);
    expect(state.opened).toEqual([]); expect(state.collect).not.toHaveBeenCalled();
  });
});
