// Controlled filesystem/ACL authorities only; no native, SQLite, HTTP or product execution.
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationInstallationPlan, PreparedApplicationInstallation } from "./application-installation.js";
type Node = { directory: boolean; ino: bigint; bytes: Buffer; ctimeNs: bigint; mtimeNs: bigint; nlink: bigint; link?: boolean; dev?: bigint };
const controlled = vi.hoisted(() => ({
  nodes: new Map<string, Node>(), handles: new Map<number, { path: string; node: Node; mode: string }>(),
  next: 0n, fd: 0, events: [] as string[], backend: Object.freeze({}), backendValid: true, code: new Map<object, { directory: string; snapshot: string }>(),
  storage: new Map<object, { directory: string; ino: bigint }>(), readers: new Set<object>(), uuid: 0, fixedUuid: "",
  maxWrite: 65_536, zeroWrite: false, writeError: null as Error | null, flushError: null as Error | null,
  closeError: null as Error | null, closeErrorSuffix: "", codeError: null as Error | null,
  readCloseError: null as Error | null,
  afterOpen: (_path: string, _node: Node, _mode: string) => {},
  afterRead: (_path: string, _node: Node, _position: number, _count: number) => {},
  statPatch: (_path: string, _surface: "path" | "handle"): Partial<{ ctimeNs: bigint }> => ({}),
  afterClose: (_path: string, _node: Node, _mode: string) => {}, afterCode: (_directory: string) => {},
  codePrepare: vi.fn(), codeAssert: vi.fn(), codeAudit: vi.fn(), storagePrepare: vi.fn(), storageAssert: vi.fn(), storageAudit: vi.fn(),
  readerRevoke: vi.fn(), forbidden: vi.fn(),
}));
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => controlled.fixedUuid || `10000000-0000-4000-8000-${String(++controlled.uuid).padStart(12, "0")}` }));
vi.mock("node:child_process", () => ({ spawn: controlled.forbidden, spawnSync: controlled.forbidden, exec: controlled.forbidden,
  execFile: controlled.forbidden, execFileSync: controlled.forbidden, fork: controlled.forbidden }));
vi.mock("node:fs", () => {
  const facts = (node: Node) => ({ ...node, dev: node.dev ?? 1n, size: BigInt(node.bytes.length),
    isFile: () => !node.directory, isDirectory: () => node.directory, isSymbolicLink: () => !!node.link });
  const missing = () => Object.assign(Error("Controlled missing file"), { code: "ENOENT" });
  return {
    lstatSync: (path: string) => { const node = controlled.nodes.get(path); if (!node) throw missing(); return { ...facts(node), ...controlled.statPatch(path, "path") }; },
    realpathSync: { native: (path: string) => path },
    mkdirSync: (path: string) => {
      if (controlled.nodes.has(path)) throw Object.assign(Error("Controlled existing directory"), { code: "EEXIST" });
      const parent = path.slice(0, path.lastIndexOf("\\")); if (!controlled.nodes.get(parent)?.directory) throw missing();
      controlled.nodes.set(path, { directory: true, ino: ++controlled.next, bytes: Buffer.alloc(0), ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
      controlled.events.push("mkdir:" + path);
    },
    readdirSync: (directory: string) => [...controlled.nodes.keys()].filter(file => file.startsWith(directory + "\\")
      && !file.slice(directory.length + 1).includes("\\")).map(file => file.slice(directory.length + 1)),
    openSync: (path: string, mode: string) => {
      if (mode === "wx") {
        if (controlled.nodes.has(path)) throw Object.assign(Error("Controlled existing file"), { code: "EEXIST" });
        controlled.nodes.set(path, { directory: false, ino: ++controlled.next, bytes: Buffer.alloc(0), ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
      } else if (mode !== "r") return controlled.forbidden();
      const node = controlled.nodes.get(path); if (!node || node.directory) throw missing();
      const fd = ++controlled.fd; controlled.handles.set(fd, { path, node, mode }); controlled.events.push(`open:${mode}:${path}`);
      controlled.afterOpen(path, node, mode); return fd;
    },
    fstatSync: (fd: number) => { const { path, node } = controlled.handles.get(fd)!; return { ...facts(node), ...controlled.statPatch(path, "handle") }; },
    closeSync: (fd: number) => {
      const { path, node, mode } = controlled.handles.get(fd)!; controlled.handles.delete(fd);
      controlled.events.push(`close:${mode}:${path}`); controlled.afterClose(path, node, mode);
      if (controlled.closeError && path.endsWith(controlled.closeErrorSuffix) && mode === "wx") throw controlled.closeError;
      if (controlled.readCloseError && path.includes("\\code\\") && mode === "r") throw controlled.readCloseError;
    },
    readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => {
      const { path, node } = controlled.handles.get(fd)!, count = node.bytes.copy(output, offset, position, position + length);
      controlled.afterRead(path, node, position, count); return count;
    },
    writeSync: (fd: number, input: Uint8Array, offset: number, length: number, position: number) => {
      const { path, node } = controlled.handles.get(fd)!; controlled.events.push("write:" + path);
      if (path.includes("\\code\\") && controlled.writeError) throw controlled.writeError;
      if (path.includes("\\code\\") && controlled.zeroWrite) return 0;
      const count = Math.min(length, controlled.maxWrite), next = Buffer.alloc(Math.max(node.bytes.length, position + count));
      node.bytes.copy(next); Buffer.from(input.buffer, input.byteOffset, input.byteLength).copy(next, position, offset, offset + count); node.bytes = next; return count;
    },
    fsyncSync: (fd: number) => { const { path } = controlled.handles.get(fd)!; controlled.events.push("flush:" + path);
      if (path.includes("\\code\\") && controlled.flushError) throw controlled.flushError; },
  };
});
vi.mock("./windows-local-acl.js", () => ({
  assertNativeWindows: () => {},
  assertCanonicalWindowsPath: (path: string) => { if (!/^[A-Z]:\\/u.test(path) || path.includes("/")) throw Error("noncanonical"); },
  physicalWindowsDirectory: (path: string) => { const n = controlled.nodes.get(path); if (!n?.directory || n.link) throw Error("physical directory"); return path; },
  windowsPathsOverlap: (a: string, b: string) => { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\"); },
}));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: controlled.codePrepare,
  assertWindowsCodeInstallation: controlled.codeAssert, auditWindowsCodeInstallation: controlled.codeAudit }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.storagePrepare,
  assertWindowsReleaseStorage: controlled.storageAssert, auditWindowsReleaseStorage: controlled.storageAudit }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (value: object) => {
  if (value !== controlled.backend || !controlled.backendValid) throw Error("original backend required"); } }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: (value: object) => {
  if (value !== controlled.backend) throw Error("original backend required");
  return { directory: "C:\\native", manifestSha256: "sha256:" + "a".repeat(64), writableWorkspaceRoots: ["C:\\work"] };
} }));
vi.mock("./application-artifact-admission.js", () => ({ assertApplicationClientReader: (value: object) => {
  if (!controlled.readers.has(value)) throw Error("original reader required"); }, revokeApplicationClientReader: controlled.readerRevoke }));
import { createApplicationInstallationOwner, describeApplicationInstallation, assertApplicationInstallation,
  auditApplicationInstallation, invalidateApplicationInstallation, bindApplicationInstallationClientReader } from "./application-installation.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { ApplicationClientReader } from "./application-artifact-admission.js";
const sha = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function add(path: string, text?: string) {
  controlled.nodes.set(path, { directory: text === undefined, ino: ++controlled.next, bytes: Buffer.from(text ?? ""), ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
}
const pin = (path: string) => { const bytes = controlled.nodes.get(path)!.bytes; return { path, bytes: bytes.length, sha256: sha(bytes) }; };
const options = () => ({ parent: "C:\\protected", nodeId: "node1", allowedRoots: ["C:\\work"], node: pin("C:\\node\\node.exe"), backend: controlled.backend as PreparedWindowsProcessBackend });
const owner = () => createApplicationInstallationOwner(options());
function plan(target: ReturnType<typeof owner>): ApplicationInstallationPlan {
  const payload = Buffer.from("export const fixed = 1;\n"), profile = Buffer.from(JSON.stringify({ version: 1,
    installation: { version: 1, generation_id: target.generationId } }));
  return { version: 1, directories: ["runtime"], files: [
    { path: "service.json", bytes: profile.length, sha256: sha(profile), content: profile },
    { path: "runtime/entry.js", bytes: payload.length, sha256: sha(payload), content: payload },
  ], profile: { path: win32.join(target.directory, "service.json"), bytes: profile.length, sha256: sha(profile) } };
}
const snapshot = (directory: string) => JSON.stringify([...controlled.nodes].filter(([p]) => p === directory || p.startsWith(directory + "\\"))
  .sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => [p, String(n.ino), String(n.ctimeNs), String(n.mtimeNs), n.bytes.toString("base64")]));
beforeEach(() => {
  controlled.nodes.clear(); controlled.handles.clear(); controlled.events.length = 0; controlled.code.clear(); controlled.storage.clear(); controlled.readers.clear();
  controlled.fixedUuid = ""; controlled.backendValid = true; controlled.maxWrite = 65_536; controlled.zeroWrite = false; controlled.writeError = null; controlled.flushError = null;
  controlled.closeError = null; controlled.closeErrorSuffix = ""; controlled.codeError = null; controlled.afterClose = () => {}; controlled.afterCode = () => {};
  controlled.readCloseError = null; controlled.afterOpen = () => {}; controlled.afterRead = () => {}; controlled.statPatch = () => ({});
  for (const p of ["C:", "C:\\protected", "C:\\node", "C:\\native", "C:\\work", "C:\\sources"]) add(p);
  add("C:\\node\\node.exe", "fixed-node"); add("C:\\sources\\entry.js", "export const fixed = 1;\n");
  controlled.forbidden.mockReset().mockImplementation(() => { throw Error("real process forbidden"); });
  controlled.codePrepare.mockReset().mockImplementation(({ directory }: { directory: string }) => {
    controlled.events.push("code-admit:" + directory); if (controlled.codeError) throw controlled.codeError;
    const token = Object.freeze({}); controlled.code.set(token, { directory, snapshot: snapshot(directory) }); controlled.afterCode(directory); return token;
  });
  controlled.codeAssert.mockReset().mockImplementation((token: object, directory: string) => {
    const expected = controlled.code.get(token); if (!expected || expected.directory !== directory || snapshot(directory) !== expected.snapshot) throw Error("original code changed");
  });
  controlled.codeAudit.mockReset().mockImplementation(controlled.codeAssert);
  controlled.storagePrepare.mockReset().mockImplementation(({ directory }: { directory: string }) => {
    const token = Object.freeze({}); controlled.storage.set(token, { directory, ino: controlled.nodes.get(directory)!.ino }); return token;
  });
  controlled.storageAssert.mockReset().mockImplementation((token: object, directory: string) => {
    const expected = controlled.storage.get(token); if (!expected || expected.directory !== directory || controlled.nodes.get(directory)?.ino !== expected.ino) throw Error("original storage boundary changed");
  });
  controlled.storageAudit.mockReset().mockImplementation(controlled.storageAssert);
  controlled.readerRevoke.mockReset().mockImplementation((reader: object) => { controlled.readers.delete(reader); });
});
describe("single-generation fixed application installation", () => {
  it("does not open an original read handle when its bounded buffer allocation fails", () => {
    const selected = options(), original = Error("controlled allocation failure"), allocate = Buffer.alloc;
    const replacement = vi.spyOn(Buffer, "alloc").mockImplementation(size => {
      if (size === selected.node.bytes + 1) throw original; return allocate(size);
    });
    let caught: unknown;
    try { createApplicationInstallationOwner(selected); } catch (error) { caught = error; } finally { replacement.mockRestore(); }
    expect(caught).toBe(original); expect(controlled.handles.size).toBe(0);
    expect(controlled.events.some(event => event.startsWith("open:r:"))).toBe(false);
  });
  it("closes all exclusive writers before strict admission and only exposes a post-evidence token", () => {
    const target = owner(), selected = plan(target), token = target.install(selected), binding = describeApplicationInstallation(token);
    expect(binding.backend).toBe(controlled.backend); expect(binding.profile).toEqual(selected.profile);
    expect(binding.code).toBe(controlled.codePrepare.mock.results[0]!.value); expect(binding.nodeCode).toBe(controlled.codePrepare.mock.results[1]!.value);
    expect(controlled.codePrepare.mock.calls.map(([p]) => p.directory)).toEqual([target.directory, "C:\\node"]);
    const first = controlled.events.findIndex(e => e.startsWith("code-admit:"));
    expect(controlled.events.findIndex(e => e === `close:wx:${target.directory}\\runtime\\entry.js`)).toBeLessThan(first);
    expect(controlled.events.findIndex(e => e.endsWith("\\ADMITTED.json") && e.startsWith("close:wx:"))).toBeGreaterThan(first);
    expect(target.describeAttempt().phase).toBe("admitted"); expect(controlled.handles.size).toBe(0);
    expect(() => target.install(selected)).toThrow("attempt already used"); expect(controlled.codePrepare).toHaveBeenCalledTimes(2);
    expect(controlled.forbidden).not.toHaveBeenCalled();
  });
  it("handles actual partial writes without truncating output", () => {
    const target = owner(); controlled.maxWrite = 3; const selected = plan(target); target.install(selected);
    expect(controlled.nodes.get(selected.profile.path)!.bytes).toEqual((selected.files[0] as { content: Uint8Array }).content);
    expect(controlled.events.filter(e => e === "write:" + selected.profile.path).length).toBeGreaterThan(1);
  });
  it.each(["zero", "write", "flush", "close"])("permanently fails a %s writer and never admits its code", variant => {
    const target = owner(), original = Error("controlled " + variant); controlled.zeroWrite = variant === "zero";
    if (variant === "write") controlled.writeError = original; if (variant === "flush") controlled.flushError = original;
    if (variant === "close") { controlled.closeError = original; controlled.closeErrorSuffix = "entry.js"; }
    expect(() => target.install(plan(target))).toThrow(); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(() => target.install(plan(target))).toThrow("attempt already used");
    expect([...controlled.nodes.keys()].some(path => path.endsWith("\\FAILED.json"))).toBe(true);
  });
  it("retains both original operation and close failures", () => {
    const target = owner(), original = Error("original write"), close = Error("original close");
    controlled.writeError = original; controlled.closeError = close; controlled.closeErrorSuffix = "entry.js";
    try { target.install(plan(target)); throw Error("must reject"); } catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([original, close]); }
    expect(target.describeAttempt().phase).toBe("failed");
  });
  it.each(["ADMITTED.json", "PLAN.json"])("does not mint authority when the original %s evidence close fails", suffix => {
    const target = owner(); controlled.closeError = Error("evidence close failed"); controlled.closeErrorSuffix = suffix;
    expect(() => target.install(plan(target))).toThrow("evidence close failed"); expect(target.describeAttempt().phase).toBe("failed");
    expect(() => target.install(plan(target))).toThrow("attempt already used");
  });
  it("keeps failure terminal when its failure record also cannot close", () => {
    const target = owner(), original = Error("strict ctime rejected"); controlled.codeError = original;
    controlled.closeError = Error("failed evidence close"); controlled.closeErrorSuffix = "FAILED.json";
    expect(() => target.install(plan(target))).toThrow(original); expect(target.describeAttempt()).toMatchObject({ phase: "failed", failureRecordError: expect.stringContaining("failed evidence close") });
    expect(controlled.codePrepare).toHaveBeenCalledTimes(1);
  });
  it.each(["extra-file", "extra-directory", "replacement", "ctime"])("rejects %s after the original strict admission without a new baseline", change => {
    const target = owner(); controlled.afterCode = directory => {
      if (directory !== target.directory) return;
      if (change === "extra-file") add(directory + "\\extra.js", "x");
      if (change === "extra-directory") add(directory + "\\unexpected");
      if (change === "replacement") { const p = directory + "\\runtime\\entry.js", old = controlled.nodes.get(p)!; add(p, old.bytes.toString()); }
      if (change === "ctime") controlled.nodes.get(directory + "\\runtime\\entry.js")!.ctimeNs++;
    };
    expect(() => target.install(plan(target))).toThrow(); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare.mock.calls.filter(([p]) => p.directory === target.directory)).toHaveLength(1);
  });
  it("binds copied sources to independent expected pins and retains captured generated bytes", () => {
    const target = owner(), selected = plan(target), from = pin("C:\\sources\\entry.js");
    const changed = { ...selected, files: [selected.files[0]!, { path: "runtime/entry.js", bytes: from.bytes, sha256: from.sha256, source: from }] };
    controlled.afterClose = (file, _node, mode) => { if (file.endsWith("\\PLAN.json") && mode === "wx") ((selected.files[0] as { content: Uint8Array }).content).fill(0); };
    const token = target.install(changed); expect(describeApplicationInstallation(token).profile.sha256).toBe(selected.profile.sha256);
  });
  it("rejects source drift, altered profile expectations and malformed complete sets before writing code", () => {
    for (const change of ["source", "profile", "case", "directories"] as const) {
      const target = owner(), selected = plan(target); let value = selected;
      if (change === "source") { const from = pin("C:\\sources\\entry.js"); controlled.nodes.get(from.path)!.bytes = Buffer.from("changed");
        value = { ...selected, files: [selected.files[0]!, { path: "runtime/entry.js", bytes: from.bytes, sha256: from.sha256, source: from }] }; }
      if (change === "profile") value = { ...selected, profile: { ...selected.profile, sha256: "sha256:" + "b".repeat(64) } };
      if (change === "case") value = { ...selected, files: [...selected.files, { ...selected.files[0]!, path: "SERVICE.json" }] };
      if (change === "directories") value = { ...selected, directories: ["runtime", "extra"] };
      expect(() => target.install(value)).toThrow(); expect(target.describeAttempt().phase).toBe("failed");
      expect(controlled.events.some(e => e.startsWith("open:wx:" + target.directory))).toBe(false);
    }
  });
  it("never reuses an existing or previously claimed generation", () => {
    const target = owner(); controlled.fixedUuid = target.generationId; expect(() => owner()).toThrow("already claimed");
    expect(controlled.events.filter(e => e === "mkdir:" + win32.dirname(target.directory))).toHaveLength(1);
  });
  it("does not write even a failure marker into an existing generation from another process", () => {
    controlled.fixedUuid = "30000000-0000-4000-8000-000000000001";
    const root = "C:\\protected\\" + controlled.fixedUuid; add(root); add(root + "\\control"); add(root + "\\control\\CLAIM.json", "retained original claim");
    const before = snapshot(root); expect(() => owner()).toThrow("existing directory"); expect(snapshot(root)).toBe(before);
    expect(controlled.events.some(event => event.startsWith("open:wx:" + root))).toBe(false);
  });
  it("rejects forged tokens and revokes readers and all subsequent admission after failure", () => {
    const target = owner(), token = target.install(plan(target)), reader = Object.freeze({}) as ApplicationClientReader;
    expect(() => describeApplicationInstallation({} as PreparedApplicationInstallation)).toThrow("original admitted");
    controlled.readers.add(reader); bindApplicationInstallationClientReader(token, reader); invalidateApplicationInstallation(token);
    invalidateApplicationInstallation(token); expect(controlled.readerRevoke).toHaveBeenCalledExactlyOnceWith(reader);
    expect(() => describeApplicationInstallation(token)).toThrow(); expect(() => assertApplicationInstallation(token)).toThrow(); expect(() => auditApplicationInstallation(token)).toThrow();
    expect(target.describeAttempt().phase).toBe("failed");
  });
  it("invalidates an admitted generation after original code integrity failure", () => {
    const target = owner(), token = target.install(plan(target)); controlled.nodes.get(target.directory + "\\service.json")!.ctimeNs++;
    expect(() => auditApplicationInstallation(token)).toThrow("original code changed"); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare).toHaveBeenCalledTimes(2);
  });
  it("rejects original writer close-time metadata changes without a new read baseline", () => {
    const target = owner(); controlled.afterClose = (file, node, mode) => {
      if (mode === "wx" && file.endsWith("entry.js")) node.ctimeNs++;
    };
    expect(() => target.install(plan(target))).toThrow("metadata changed through original close");
    expect(target.describeAttempt().phase).toBe("failed"); expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it("binds original created directory identities throughout writing", () => {
    const target = owner(); controlled.afterClose = (file, _node, mode) => {
      if (mode === "wx" && file.endsWith("entry.js")) add(target.directory);
    };
    expect(() => target.install(plan(target))).toThrow("generation directory replaced");
    expect(target.describeAttempt().phase).toBe("failed"); expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it("rechecks the original code token after the last mandatory evidence close", () => {
    const target = owner(); controlled.afterClose = (file, _node, mode) => {
      if (mode === "wx" && file.endsWith("ADMITTED.json")) add(target.directory + "\\late.js", "late");
    };
    expect(() => target.install(plan(target))).toThrow("original code changed"); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare.mock.calls.filter(([p]) => p.directory === target.directory)).toHaveLength(1);
  });
  it.each(["storage", "backend"])("rechecks the original %s authority after the mandatory evidence writer closes", kind => {
    const target = owner(); controlled.afterClose = (file, _node, mode) => {
      if (mode !== "wx" || !file.endsWith("ADMITTED.json")) return;
      if (kind === "backend") controlled.backendValid = false;
      else { for (const [token, saved] of controlled.storage) if (saved.directory === target.storageDirectory) controlled.storage.delete(token); }
    };
    expect(() => target.install(plan(target))).toThrow(kind === "backend" ? "original backend required" : "original storage boundary changed");
    expect(target.describeAttempt().phase).toBe("failed"); expect(() => target.install(plan(target))).toThrow("attempt already used");
    expect([...controlled.nodes.keys()].some(path => path.endsWith("\\FAILED.json"))).toBe(true);
  });
  it("retains an interrupted claim and does not reopen it in a new owner", () => {
    controlled.fixedUuid = "20000000-0000-4000-8000-000000000001";
    controlled.closeError = Error("claim close failed"); controlled.closeErrorSuffix = "CLAIM.json";
    expect(() => owner()).toThrow("claim close failed"); expect(() => owner()).toThrow("generation already claimed");
    expect([...controlled.nodes.keys()].some(path => path.endsWith("\\FAILED.json"))).toBe(true);
    expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it("captures local settings before the caller can replace them", () => {
    const selected = options(), target = createApplicationInstallationOwner(selected);
    selected.nodeId = "other"; selected.backend = {} as PreparedWindowsProcessBackend; selected.allowedRoots.length = 0;
    const binding = describeApplicationInstallation(target.install(plan(target)));
    expect(binding.nodeId).toBe("node1"); expect(binding.backend).toBe(controlled.backend); expect(binding.allowedRoots).toEqual(["C:\\work"]);
  });
  it("prepares each new member once before publishing the complete immutable baseline and original ACL tokens", () => {
    const target = owner(), selected = plan(target), opened = new Set<string>();
    controlled.afterOpen = (path, node, mode) => {
      if (mode === "r" && path.startsWith(target.directory + "\\") && !opened.has(path)) { opened.add(path); node.ctimeNs++; }
    };
    const token = target.install(selected); expect(describeApplicationInstallation(token).profile).toEqual(selected.profile);
    expect(opened.size).toBe(2); expect(controlled.codePrepare).toHaveBeenCalledTimes(2);
    const admission = controlled.events.findIndex(event => event.startsWith("code-admit:"));
    for (const file of selected.files) {
      const path = win32.join(target.directory, ...file.path.split("/"));
      expect(controlled.events.findIndex(event => event === "close:r:" + path)).toBeLessThan(admission);
      expect(controlled.nodes.get(path)!.ctimeNs).toBe(2n);
    }
    auditApplicationInstallation(token); expect(controlled.codePrepare).toHaveBeenCalledTimes(2);
  });
  it.each(["path", "handle", "data", "eof", "close"])("rejects ctime drift at the prepared %s boundary without admission or retry", boundary => {
    const target = owner(), selected = plan(target), entry = win32.join(target.directory, "runtime/entry.js");
    let active = false, handles = 0;
    controlled.afterOpen = (path, _node, mode) => { if (path === entry && mode === "r") active = true; };
    controlled.statPatch = (path, surface) => {
      if (path !== entry || !active) return {};
      if (surface === "handle") handles++;
      return boundary === "path" && surface === "path" || boundary === "handle" && surface === "handle" && handles > 1 ? { ctimeNs: 9n } : {};
    };
    controlled.afterRead = (path, node, _position, count) => {
      if (path === entry && (boundary === "data" && count > 0 || boundary === "eof" && count === 0)) node.ctimeNs++;
    };
    controlled.afterClose = (path, node, mode) => { if (path === entry && mode === "r" && boundary === "close") node.ctimeNs++; };
    expect(() => target.install(selected)).toThrow("prepared read"); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(controlled.handles.size).toBe(0);
    const count = controlled.events.filter(event => event === "open:r:" + entry).length;
    expect(() => target.install(selected)).toThrow("attempt already used");
    expect(controlled.events.filter(event => event === "open:r:" + entry)).toHaveLength(count);
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed).toMatchObject({ phase_before_failure: "writers-closed", diagnostic: { path: entry, changed_fields: ["ctimeNs"] } });
    expect(failed.diagnostic.baseline.ctimeNs).toBe("1");
  });
  it.each(["dev", "ino", "nlink", "mtime", "size", "hash"])("keeps original writer %s facts and expected bytes binding during preparation", field => {
    const target = owner(), selected = plan(target);
    controlled.afterOpen = (path, node, mode) => {
      if (mode !== "r" || !path.startsWith(target.directory + "\\")) return;
      node.ctimeNs++;
      if (field === "dev") node.dev = 2n;
      if (field === "ino") node.ino++;
      if (field === "nlink") node.nlink++;
      if (field === "mtime") node.mtimeNs++;
      if (field === "size") node.bytes = Buffer.concat([node.bytes, Buffer.from("x")]);
      if (field === "hash") node.bytes = Buffer.alloc(node.bytes.length, 120);
    };
    expect(() => target.install(selected)).toThrow(field === "hash" ? "prepared read changed" : "preparation writer identity changed");
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.handles.size).toBe(0);
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed.diagnostic.writer.ctimeNs).toBe("1"); expect(failed.diagnostic.handle.ctimeNs).toBe("2");
    expect(failed.diagnostic.changed_fields).toContain(field === "mtime" ? "mtimeNs" : field === "hash" ? "sha256" : field);
  });
  it("does not publish a successful prefix when the final member or its original close fails", () => {
    const target = owner(), selected = plan(target), entry = win32.join(target.directory, "runtime/entry.js");
    controlled.afterOpen = (path, node, mode) => { if (mode === "r" && path === selected.profile.path) node.bytes = Buffer.alloc(node.bytes.length, 120); };
    expect(() => target.install(selected)).toThrow("prepared read changed through original close");
    expect(controlled.events.filter(event => event === "close:r:" + entry)).toHaveLength(1);
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(() => target.install(selected)).toThrow("attempt already used");
    expect(controlled.events.some(event => event.includes("ADMITTED.json"))).toBe(false);
  });
  it("retains the original preparation close error without committing any baseline or token", () => {
    const target = owner(), original = Error("original preparation close failed"); controlled.readCloseError = original;
    expect(() => target.install(plan(target))).toThrow(original); expect(controlled.codePrepare).not.toHaveBeenCalled();
    expect(target.describeAttempt().phase).toBe("failed"); expect(controlled.handles.size).toBe(0);
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed.diagnostic.operation).toBe("prepare-original-close");
  });
  it("retains strict source reads instead of granting them the fresh-member preparation transition", () => {
    const target = owner(), selected = plan(target), source = pin("C:\\sources\\entry.js");
    controlled.afterOpen = (path, node, mode) => { if (path === source.path && mode === "r") node.ctimeNs++; };
    expect(() => target.install({ ...selected, files: [selected.files[0]!, { path: "runtime/entry.js", bytes: source.bytes, sha256: source.sha256, source }] }))
      .toThrow("read identity or metadata changed");
    expect(controlled.codePrepare).not.toHaveBeenCalled();
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed).toMatchObject({ phase_before_failure: "claimed", diagnostic: { path: source.path, operation: "read-first-handle", changed_fields: ["ctimeNs"] } });
  });
  it("records the changed writer field before the first preparation handle is opened", () => {
    const target = owner(), selected = plan(target), entry = win32.join(target.directory, "runtime/entry.js");
    controlled.afterClose = (path, _node, mode) => {
      if (path === selected.profile.path && mode === "wx") controlled.nodes.get(entry)!.mtimeNs++;
    };
    expect(() => target.install(selected)).toThrow("preparation writer identity changed");
    expect(controlled.events).not.toContain("open:r:" + entry); expect(controlled.codePrepare).not.toHaveBeenCalled();
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed.diagnostic).toMatchObject({ path: entry, operation: "prepare-before-open", changed_fields: ["mtimeNs"],
      writer: { mtimeNs: "1" }, before: { mtimeNs: "2" } });
  });
  it("records a strict source size mismatch before opening that source", () => {
    const target = owner(), selected = plan(target), source = pin("C:\\sources\\entry.js");
    controlled.nodes.get(source.path)!.bytes = Buffer.from("different size");
    expect(() => target.install({ ...selected, files: [selected.files[0]!, { path: "runtime/entry.js", bytes: source.bytes, sha256: source.sha256, source }] }))
      .toThrow("source or installed size mismatch");
    expect(controlled.events).not.toContain("open:r:" + source.path);
    const failed = JSON.parse(controlled.nodes.get(win32.join(win32.dirname(target.directory), "control/FAILED.json"))!.bytes.toString());
    expect(failed.diagnostic).toMatchObject({ path: source.path, operation: "read-before-open", changed_fields: ["size"], expected_bytes: source.bytes });
  });
  it("keeps later strict verification on the permanent preparation baseline", () => {
    const target = owner(), selected = plan(target), counts = new Map<string, number>();
    controlled.afterOpen = (path, node, mode) => {
      if (mode !== "r" || !path.startsWith(target.directory + "\\")) return;
      const count = (counts.get(path) ?? 0) + 1; counts.set(path, count); if (count === 2) node.ctimeNs++;
    };
    expect(() => target.install(selected)).toThrow("read identity or metadata changed");
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(target.describeAttempt().phase).toBe("failed");
  });
  it("observes cancellation before admission and does not adopt a fresh backend object", () => {
    const controller = new AbortController(), target = createApplicationInstallationOwner({ ...options(), signal: controller.signal });
    controlled.afterClose = (file, _node, mode) => { if (mode === "wx" && file.endsWith("entry.js")) controller.abort(); };
    expect(() => target.install(plan(target))).toThrow("cancelled"); expect(target.describeAttempt().phase).toBe("failed");
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(() => createApplicationInstallationOwner({ ...options(), backend: {} as PreparedWindowsProcessBackend })).toThrow("original backend");
  });
});
