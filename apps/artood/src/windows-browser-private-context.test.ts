// Controlled filesystem/ACL facts only. Never starts PowerShell, a native helper, browser or provider.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { WindowsAclReport, WindowsAclTarget } from "./windows-local-acl.js";

interface NodeFact { directory: boolean; ino: bigint; bytes: Buffer; ctime: bigint; mtime?: bigint; size?: bigint; link?: boolean; nlink?: bigint }
const state = vi.hoisted(() => ({
  backend: Object.freeze({ controlled: "parent authority" }), roots: [] as string[], describe: vi.fn(), spawn: vi.fn(),
  nodes: new Map<string, NodeFact>(), handles: new Map<number, NodeFact>(), aliases: new Map<string, string>(),
  counter: 0n, nextFd: 10, reads: 0, writes: 0, opens: 0, closes: 0,
  pathCtimeDelta: 0n, handleCtimeDelta: 0n, readLog: [] as { position: number; count: number }[],
  onRead: undefined as (() => void) | undefined, onOpen: undefined as (() => void) | undefined,
  afterRead: undefined as ((position: number, count: number) => void) | undefined,
}));
vi.mock("node:child_process", () => ({ spawnSync: state.spawn }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: state.describe }));
vi.mock("node:fs", () => {
  const stats = (node: NodeFact, source: "path" | "handle") => ({ isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => !!node.link,
    dev: 1n, ino: node.ino, ctimeNs: node.ctime + (source === "path" ? state.pathCtimeDelta : state.handleCtimeDelta),
    mtimeNs: node.mtime ?? node.ctime, nlink: node.nlink ?? 1n, size: node.size ?? BigInt(node.bytes.length) });
  const find = (path: string) => { const node = state.nodes.get(path); if (!node) throw new Error("Missing controlled path"); return node; };
  return {
    constants: { O_RDONLY: 0 },
    lstatSync: (path: string) => stats(find(path), "path"), realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
    openSync: (path: string) => { state.onOpen?.(); const fd = state.nextFd++; state.handles.set(fd, find(path)); state.opens++; return fd; },
    fstatSync: (fd: number) => stats(state.handles.get(fd)!, "handle"),
    closeSync: (fd: number) => { state.closes++; state.handles.delete(fd); },
    readSync: (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      state.reads++; state.onRead?.(); const node = state.handles.get(fd)!;
      const count = position >= node.bytes.length ? 0 : node.bytes.copy(target, offset, position, Math.min(position + length, node.bytes.length));
      state.readLog.push({ position, count }); state.afterRead?.(position, count); return count;
    },
    writeFileSync: (path: string, bytes: Buffer, options: { flag: string; mode: number }) => {
      if (options.flag !== "wx" || options.mode !== 0o400 || state.nodes.has(path)) throw new Error("Controlled exclusive write denied");
      state.writes++; state.nodes.set(path, { directory: false, ino: ++state.counter, bytes: Buffer.from(bytes), ctime: 1n });
    },
  };
});
import { collectWindowsAclFacts } from "./windows-local-acl.js";
import { readWindowsBrowserPrivateContext, writeWindowsBrowserPrivateContext } from "./windows-browser-private-context.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, arch = Object.getOwnPropertyDescriptor(process, "arch")!;
const sid = "S-1-5-21-100-200-300-1001", outsider = "S-1-5-21-100-200-300-1002";
const directory = "C:\\node\\temp\\private", file = `${directory}\\command-0.json`, workspace = "C:\\work\\product";
const checksum = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const backend = () => state.backend as unknown as PreparedWindowsProcessBackend;
let change: (report: WindowsAclReport) => void;
function add(path: string, bytes?: Buffer) {
  state.nodes.set(path, { directory: bytes === undefined, ino: ++state.counter, bytes: bytes ?? Buffer.alloc(0), ctime: 1n });
}
function existing() { const bytes = Buffer.from('{"private":"test-fixture"}'); add(file, bytes); return checksum(bytes); }
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...arch, value: "x64" });
  vi.stubEnv("SystemRoot", "C:\\Windows"); vi.spyOn(performance, "now").mockReturnValue(100);
  state.nodes.clear(); state.handles.clear(); state.aliases.clear(); state.counter = 9007199254740991n;
  state.nextFd = 10; state.reads = 0; state.writes = 0; state.opens = 0; state.closes = 0; state.onRead = undefined; state.onOpen = undefined;
  state.pathCtimeDelta = 0n; state.handleCtimeDelta = 0n; state.readLog = []; state.afterRead = undefined;
  for (const path of ["C:\\", "C:\\Windows", "C:\\node", "C:\\node\\temp", directory, "C:\\work", workspace, "C:\\work-two"]) add(path);
  state.roots = [workspace]; change = () => undefined;
  state.describe.mockReset().mockImplementation(value => {
    if (value !== state.backend) throw new Error("Not a genuine controlled backend");
    return { directory: "C:\\protected\\host", manifestSha256: `sha256:${"d".repeat(64)}`, writableWorkspaceRoots: [...state.roots] };
  });
  state.spawn.mockReset().mockImplementation((_executable, _args, options) => {
    const targets = JSON.parse(options.input).paths as WindowsAclTarget[];
    const report: WindowsAclReport = { version: 1, currentSid: sid, nodes: targets.map(target => ({ path: target.path, directory: target.directory,
      attributes: target.directory ? 16 : 32, volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS", ownerSid: sid,
      daclPresent: true, canonical: true, aces: [{ sid, qualifier: "AccessAllowed", mask: 0x1f01ff, flags: target.directory ? 3 : 0 }] })) };
    change(report); return { stdout: JSON.stringify(report), status: 0, signal: null };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch); });

describe("parent-authorized private Windows browser context", () => {
  it("writes outside all configured roots, audits ACLs, and binds a stable read independently of JSON", () => {
    const envelope = { version: 1, windows_browser_process: { installation: { writableWorkspaceRoots: ["untrusted serialized roots"] } } };
    const hash = writeWindowsBrowserPrivateContext(backend(), file, envelope, 1334);
    expect(hash).toBe(checksum(Buffer.from(JSON.stringify(envelope))));
    expect(JSON.parse(readWindowsBrowserPrivateContext(file, hash, 1334).toString("utf8"))).toEqual(envelope);
    expect(state.writes).toBe(1); expect(state.opens).toBe(2); expect(state.closes).toBe(2);
    expect(state.handles.size).toBe(0);
    for (const call of state.spawn.mock.calls) expect(call[2].timeout).toBe(1234);
  });
  it("does not accept a copied backend as a source of all roots", () => {
    expect(() => writeWindowsBrowserPrivateContext({} as PreparedWindowsProcessBackend, file, {}, 1334)).toThrow(/genuine/);
    expect(state.writes).toBe(0); expect(state.spawn).not.toHaveBeenCalled();
  });
  it("uses the complete real scope even when the serialized roots omit a second writable TEMP root", () => {
    state.roots = [workspace, "C:\\node\\temp"];
    expect(() => writeWindowsBrowserPrivateContext(backend(), file, { installation: { writableWorkspaceRoots: [workspace] } }, 1334)).toThrow(/overlaps/);
    expect(state.writes).toBe(0); expect(state.spawn).not.toHaveBeenCalled();
  });
  it("accepts sibling roots without using a string-prefix overlap test", () => {
    state.roots = [workspace, "C:\\work-two"];
    expect(() => writeWindowsBrowserPrivateContext(backend(), file, {}, 1334)).not.toThrow();
  });
  it.each(["", "not-a-digest", `sha256:${"z".repeat(64)}`])("rejects missing/invalid independent hash before file access: %s", hash => {
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/independent/);
    expect(state.opens).toBe(0); expect(state.spawn).not.toHaveBeenCalled();
  });
  it("rejects attacker-replaced content even with matching shape and installation fields", () => {
    const hash = existing(); state.nodes.get(file)!.bytes = Buffer.from('{"private":"tampered-data"}');
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/parent binding/);
    expect(state.handles.size).toBe(0);
  });
  it("rejects an oversized context before open, allocation, read or JSON parse", () => {
    const hash = existing(); state.nodes.get(file)!.size = BigInt(32 * 1024 * 1024 + 1);
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/byte bound/);
    expect(state.opens).toBe(0); expect(state.reads).toBe(0);
  });
  it.each(["symlink", "hardlink", "alias"])("rejects %s before reading", kind => {
    const hash = existing();
    if (kind === "symlink") state.nodes.get(file)!.link = true;
    if (kind === "hardlink") state.nodes.get(file)!.nlink = 2n;
    if (kind === "alias") state.aliases.set(directory, "C:\\other");
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/linked|aliased/);
    expect(state.reads).toBe(0);
  });
  it.each([
    [file, 0x1, 0], [directory, 0x2, 0], [directory, 0x1, 11], ["C:\\node", 0x40, 0],
  ] as const)("rejects unsafe read/write/replacement ACL at %s", (target, mask, flags) => {
    const hash = existing(); change = report => report.nodes.find(node => node.path === target)!.aces.push({ sid: outsider, qualifier: "AccessAllowed", mask, flags });
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/another principal/);
    expect(state.reads).toBe(0);
  });
  it("rejects an untrusted owner and leaves directory/file ACLs unchanged", () => {
    const hash = existing(); change = report => { report.nodes.find(node => node.path === file)!.ownerSid = outsider; };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/untrusted/); expect(state.writes).toBe(0);
  });
  it("rejects an inode exchange between ACL audit and open", () => {
    const hash = existing(), original = state.nodes.get(file)!;
    state.onOpen = () => { state.nodes.set(file, { ...original, ino: original.ino + 1n }); };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/opened file/); expect(state.reads).toBe(0); expect(state.closes).toBe(1);
  });
  it("uses the original handle and rejects content changing between the two reads", () => {
    const hash = existing(); state.onRead = () => { if (state.reads === 3) state.nodes.get(file)!.bytes[0] = 32; };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/parent binding/); expect(state.opens).toBe(1); expect(state.closes).toBe(1);
  });
  it("detects replacement of the path after opening the original handle", () => {
    const hash = existing(), original = state.nodes.get(file)!;
    state.onRead = () => { state.nodes.set(file, { ...original, ino: original.ino + 1n }); };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed/); expect(state.closes).toBe(1);
  });
  it.each(["open", "first read"] as const)("accepts a ctime-only update at %s with two bounded reads of the original file", timing => {
    const hash = existing(), node = state.nodes.get(file)!, original = Buffer.from(node.bytes); node.mtime = node.ctime;
    const update = () => { node.ctime = 2n; };
    if (timing === "open") state.onOpen = update;
    else state.afterRead = (_position, count) => { if (count && state.reads === 1) update(); };
    expect(readWindowsBrowserPrivateContext(file, hash)).toEqual(original);
    expect(state.readLog).toEqual([{ position: 0, count: original.length }, { position: original.length, count: 0 },
      { position: 0, count: original.length }, { position: original.length, count: 0 }]);
    expect(state.opens).toBe(1); expect(state.closes).toBe(1); expect(state.handles.size).toBe(0);
  });
  it.each(["handle", "path"] as const)("rejects ctime instability on the second pass reported by the %s", source => {
    const hash = existing();
    state.afterRead = (_position, count) => { if (count && state.reads === 3) {
      if (source === "handle") state.handleCtimeDelta = 1n; else state.pathCtimeDelta = 1n;
    } };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed while reading/);
    expect(state.readLog.filter(read => read.position === 0)).toHaveLength(2); expect(state.closes).toBe(1);
  });
  it("rejects a same-inode same-length mutation after the second EOF even with mtime held fixed", () => {
    const hash = existing(), node = state.nodes.get(file)!, originalInode = node.ino; node.mtime = node.ctime;
    state.afterRead = (_position, count) => {
      if (state.reads === 4 && count === 0) { node.bytes[0] = 32; node.ctime = 2n; }
    };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed while reading/);
    expect(node.ino).toBe(originalInode); expect(node.bytes[0]).toBe(32); expect(node.mtime).toBe(1n);
    expect(state.readLog.map(read => read.count)).toEqual([node.bytes.length, 0, node.bytes.length, 0]);
    expect(state.closes).toBe(1); expect(state.handles.size).toBe(0);
  });
  it("rejects growth while consuming at most the admitted size plus one byte", () => {
    const hash = existing(), node = state.nodes.get(file)!, length = node.bytes.length;
    state.afterRead = () => { if (state.reads === 1) node.bytes = Buffer.concat([node.bytes, Buffer.from("growth")]); };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/size changed while reading/);
    expect(state.readLog.reduce((sum, read) => sum + read.count, 0)).toBe(length + 1); expect(state.closes).toBe(1);
  });
  it("rejects shrinkage detected at the first EOF", () => {
    const hash = existing(), node = state.nodes.get(file)!;
    state.afterRead = () => { if (state.reads === 1) node.bytes = node.bytes.subarray(0, 1); };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed while reading/);
    expect(state.readLog).toHaveLength(2); expect(state.closes).toBe(1);
  });
  it.each(["open", "first read"] as const)("does not rebind mtime changes at %s", timing => {
    const hash = existing(), node = state.nodes.get(file)!;
    const update = () => { node.mtime = 2n; };
    if (timing === "open") state.onOpen = update; else state.afterRead = update;
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/opened file|identity changed while reading/);
    expect(state.closes).toBe(1);
  });
  it("rejects a hardlink acquired while the original handle is open", () => {
    const hash = existing(); state.afterRead = () => { state.nodes.get(file)!.nlink = 2n; };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed while reading/); expect(state.closes).toBe(1);
  });
  it.each([1, 2])("keeps ctime strict within ACL audit %s", auditedPass => {
    const hash = existing(), node = state.nodes.get(file)!; node.mtime = node.ctime;
    let calls = 0; change = () => { if (++calls === auditedPass) node.ctime = 2n; };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/private path changed during ACL audit/);
    expect(state.closes).toBe(auditedPass === 1 ? 0 : 1);
  });
  it.each(["acl", "sid"])("rejects post-read %s changes instead of returning previously read bytes", kind => {
    const hash = existing(); let calls = 0;
    change = report => {
      if (++calls !== 2) return;
      if (kind === "sid") report.currentSid = outsider;
      else report.nodes.find(node => node.path === file)!.aces.push({ sid: outsider, qualifier: "AccessAllowed", mask: 2, flags: 0 });
    };
    expect(() => readWindowsBrowserPrivateContext(file, hash)).toThrow(/identity changed|another principal/); expect(state.closes).toBe(1);
  });
  it("does not write when the original operation deadline is exhausted", () => {
    vi.mocked(performance.now).mockReturnValue(1334);
    expect(() => writeWindowsBrowserPrivateContext(backend(), file, {}, 1334)).toThrow(/deadline/);
    expect(state.writes).toBe(0); expect(state.spawn).not.toHaveBeenCalled();
  });
});

describe("local ACL audit budget", () => {
  const targets = [{ path: directory, directory: true, readAcl: true }];
  it.each([0, -1, 60001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid local timeout %s before process creation", timeout => {
    expect(() => collectWindowsAclFacts(targets, timeout)).toThrow(/audit timeout/); expect(state.spawn).not.toHaveBeenCalled();
  });
  it("keeps the existing default and accepts only a bounded explicit local timeout", () => {
    collectWindowsAclFacts(targets); expect(state.spawn.mock.calls[0]![2].timeout).toBe(60000);
    collectWindowsAclFacts(targets, 7); expect(state.spawn.mock.calls[1]![2].timeout).toBe(7);
  });
});
