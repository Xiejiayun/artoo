// Controlled writer/audit integration. This does not execute PowerShell or claim native qualification.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 } from "@artoo/domain";
const fake = vi.hoisted(() => ({
  nodes: new Map<string, { directory: boolean; ino: bigint; size: bigint; ctimeNs: bigint; mtimeNs: bigint; bytes?: Buffer }>(),
  descriptors: new Map<number, string>(), sequence: 10n, fd: 3, closeFails: false,
  closeMtime: undefined as bigint | undefined, replaceOnClose: false, spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: fake.spawn }));
vi.mock("node:os", () => ({ release: () => "10.0.26300" }));
vi.mock("node:fs", () => {
  const stat = (path: string) => {
    const node = fake.nodes.get(path); if (!node) throw Object.assign(new Error("Missing controlled file"), { code: "ENOENT" });
    return { ...node, dev: 42n, nlink: 1n, isFile: () => !node.directory, isDirectory: () => node.directory, isSymbolicLink: () => false };
  };
  return {
    lstatSync: vi.fn(stat), fstatSync: vi.fn((fd: number) => stat(fake.descriptors.get(fd)!)),
    realpathSync: { native: vi.fn((path: string) => path) },
    readdirSync: vi.fn((path: string) => [...fake.nodes.keys()].filter(value => value.startsWith(path + "\\")
      && !value.slice(path.length + 1).includes("\\")).map(value => value.slice(path.length + 1))),
    readFileSync: vi.fn(() => { throw new Error("Unscheduled path read"); }),
    openSync: vi.fn((path: string, flags: string) => {
      if (flags !== "wx" || fake.nodes.has(path)) throw new Error("Exclusive creation rejected");
      fake.nodes.set(path, { directory: false, ino: ++fake.sequence, size: 0n, ctimeNs: 100n, mtimeNs: 90n });
      const fd = ++fake.fd; fake.descriptors.set(fd, path); return fd;
    }),
    writeFileSync: vi.fn((fd: number, bytes: Buffer) => {
      const node = fake.nodes.get(fake.descriptors.get(fd)!)!; node.bytes = Buffer.from(bytes); node.size = BigInt(bytes.length);
    }), fsyncSync: vi.fn(), closeSync: vi.fn((fd: number) => {
      if (fake.closeFails) throw new Error("Original close failed");
      const node = fake.nodes.get(fake.descriptors.get(fd)!)!;
      if (fake.closeMtime !== undefined) node.mtimeNs = fake.closeMtime;
      if (fake.replaceOnClose) node.ino = ++fake.sequence;
      fake.descriptors.delete(fd);
    }),
  };
});
import { auditWindowsReleaseStorage, prepareWindowsReleaseStorage, writeWindowsReleaseDispatch } from "./windows-release-storage.js";
import { type WindowsAclReport, type WindowsAclTarget } from "./windows-local-acl.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const directory = "C:\\Users\\node\\.artoo\\store", workspace = "C:\\products\\one", sid = "S-1-5-21-100-200-300-1001";
const payload = "sha256:" + "a".repeat(64), operation = "sealed-dispatch-operation";
const recordPath = directory + "\\attestations\\dispatch-" + createHash("sha256").update(operation).digest("hex") + ".json";
let change: (report: WindowsAclReport) => void;
function report(targets: readonly WindowsAclTarget[]): WindowsAclReport {
  return { version: 1, currentSid: sid, nodes: targets.map(target => {
    const file = fake.nodes.get(target.path)!;
    const snapshot = target.sealed ? { dev: "42", ino: file.ino.toString(), size: file.size.toString(), mtimeNs: file.mtimeNs.toString(),
      ctimeNs: file.ctimeNs.toString(), birthtimeNs: "80", attributes: 32, links: 1, sha256: target.sealed.sha256,
      securitySha256: "sha256:" + "b".repeat(64), eas: [], streams: [{ name: "::$DATA", size: file.size.toString(), allocation: "4096" }] } : undefined;
    return { path: target.path, directory: target.directory, attributes: target.directory ? 16 : 32,
      volumeRoot: "C:\\", driveType: "Fixed", fileSystem: "NTFS", ownerSid: target.readAcl ? sid : null,
      daclPresent: target.readAcl, canonical: target.readAcl,
      aces: target.readAcl ? [{ sid, qualifier: "AccessAllowed" as const, mask: 0x1f01ff, flags: target.directory ? 3 : 0 }] : [],
      ...(snapshot ? { sealed: { version: 1 as const, before: snapshot, after: structuredClone(snapshot) } } : {}),
    };
  }) };
}
function metadataChange(value: WindowsAclReport): void {
  const observation = value.nodes.find(node => node.path === recordPath)!.sealed!;
  fake.nodes.get(recordPath)!.ctimeNs = 200n; observation.after.ctimeNs = "200";
  observation.after.eas.push({ name: "$KERNEL.PURGE.SEC.FILEHASH", flags: 0, bytes: 148,
    sha256: "sha256:" + "c".repeat(64), containsExpectedSha256: true });
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" }); vi.stubEnv("SystemRoot", "C:\\Windows");
  fake.nodes.clear(); fake.descriptors.clear(); fake.sequence = 10n; fake.fd = 3; fake.closeFails = false;
  fake.closeMtime = undefined; fake.replaceOnClose = false; change = () => undefined;
  for (const path of ["C:\\", "C:\\Windows", "C:\\Users", "C:\\Users\\node", "C:\\Users\\node\\.artoo", directory,
    directory + "\\attestations", "C:\\products", workspace]) fake.nodes.set(path, { directory: true, ino: ++fake.sequence, size: 0n, ctimeNs: 100n, mtimeNs: 90n });
  fake.spawn.mockReset().mockImplementation((_exe, _args, options) => {
    const value = report(JSON.parse(options.input).paths); change(value); return { status: 0, signal: null, stdout: JSON.stringify(value) };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", architecture); vi.unstubAllEnvs();
});
const prepare = () => prepareWindowsReleaseStorage({ directory, writableWorkspaceRoots: [workspace] });
describe("locally sealed Windows dispatch storage", () => {
  it("keeps ordinary collectors free of Add-Type and seals only original exclusive canonical writes", () => {
    const authority = prepare(); expect(fake.spawn.mock.calls[0]![1].at(-1)).not.toContain("Add-Type");
    writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    expect(fake.nodes.get(recordPath)!.bytes!.toString()).toBe(`{"action":"start","operation_id":"${operation}","payload_digest":"${payload}","version":1}`);
    expect(fake.nodes.get(recordPath)!.bytes!.toString()).toBe(canonicalProductSourceTransferValueV1({ version: 1,
      operation_id: operation, payload_digest: payload, action: "start" }));
    expect(fake.descriptors.size).toBe(0); auditWindowsReleaseStorage(authority, directory);
    expect(fake.spawn.mock.calls.at(-1)![1].at(-1)).toContain("Add-Type");
    expect(() => writeWindowsReleaseDispatch(authority, directory, operation, payload, "start")).toThrow(/already sealed/);
  });
  it("accepts captured ctime and EA diagnostics only for an original writer-sealed record", () => {
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start"); change = metadataChange;
    expect(() => auditWindowsReleaseStorage(authority, directory)).not.toThrow();
  });
  it("keeps compiler directory selection out of inherited environment and never falls back after compiler failure", () => {
    vi.stubEnv("TEMP", "C:\\untrusted-temp"); vi.stubEnv("TMP", "C:\\untrusted-temp");
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    auditWindowsReleaseStorage(authority, directory);
    const [, args, options] = fake.spawn.mock.calls.at(-1)!;
    expect(options.env.TEMP).toBeUndefined(); expect(options.env.TMP).toBeUndefined();
    expect(args.at(-1)).not.toContain("C:\\untrusted-temp");
    expect(args.at(-1)).toContain("[Environment+SpecialFolder]::UserProfile");
    expect(JSON.parse(options.input).paths.find((target: WindowsAclTarget) => target.sealed).sealed).not.toHaveProperty("compileDirectory");
    fake.spawn.mockClear().mockReturnValueOnce({ status: 1, signal: null, stdout: "", stderr: "controlled compiler failure" });
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/fixed local collector/);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
  it("binds final LastWriteTime only after successful original close without adopting a replacement", () => {
    const authority = prepare(); fake.closeMtime = 190n;
    writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    expect(() => auditWindowsReleaseStorage(authority, directory)).not.toThrow();
    const targets = JSON.parse(fake.spawn.mock.calls.at(-1)![2].input).paths as WindowsAclTarget[];
    expect(targets.find(target => target.path === recordPath)!.sealed!.mtimeNs).toBe("190");
    fake.replaceOnClose = true;
    expect(() => writeWindowsReleaseDispatch(authority, directory, operation + "-replacement", payload, "start")).toThrow(/identity changed on close/);
  });
  it.each(["unbound-ea", "unknown-ea", "user-ea", "outer-ctime", "before-handle-ctime", "ctime-only"] as const)("accepts %s diagnostics when all semantic invariants match", variant => {
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    change = value => {
      metadataChange(value); const observation = value.nodes.find(item => item.path === recordPath)!.sealed!;
      if (variant === "unbound-ea") observation.after.eas[0]!.containsExpectedSha256 = false;
      if (variant === "unknown-ea") observation.after.eas[0]!.name = "$KERNEL.OTHER";
      if (variant === "user-ea") observation.after.eas[0]!.name = "USER.DATA";
      if (variant === "outer-ctime") fake.nodes.get(recordPath)!.ctimeNs = 300n;
      if (variant === "before-handle-ctime") observation.before.ctimeNs = "150";
      if (variant === "ctime-only") observation.after.eas = [];
    };
    expect(() => auditWindowsReleaseStorage(authority, directory)).not.toThrow();
  });
  it.each(["content", "identity", "mtime", "security", "untrusted-owner", "untrusted-dacl", "attributes", "ads", "collector-missing"] as const)("rejects %s despite diagnostic changes and retains the original seal", variant => {
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    change = value => {
      metadataChange(value); const node = value.nodes.find(item => item.path === recordPath)!, observation = node.sealed!;
      if (variant === "content") observation.before.sha256 = observation.after.sha256 = "sha256:" + "d".repeat(64);
      if (variant === "identity") observation.after.ino = "999";
      if (variant === "mtime") observation.after.mtimeNs = "999";
      if (variant === "security") observation.after.securitySha256 = "sha256:" + "d".repeat(64);
      if (variant === "untrusted-owner") node.ownerSid = "S-1-5-21-100-200-300-9999";
      if (variant === "untrusted-dacl") node.aces.push({ sid: "S-1-5-21-100-200-300-9999", qualifier: "AccessAllowed", mask: 0x1f01ff, flags: 0 });
      if (variant === "attributes") observation.after.attributes = 64;
      if (variant === "ads") observation.after.streams.push({ name: ":hidden:$DATA", size: "0", allocation: "0" });
      if (variant === "collector-missing") delete node.sealed;
    };
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/sealed|untrusted owner|another principal can modify/);
    expect(() => writeWindowsReleaseDispatch(authority, directory, operation, payload, "start")).toThrow(/already sealed/);
  });
  it("never admits an unregistered existing dispatch or a directory ctime change", () => {
    const authority = prepare(); fake.nodes.set(recordPath, { directory: false, ino: ++fake.sequence, size: 1n, ctimeNs: 100n, mtimeNs: 90n });
    change = () => { fake.nodes.get(recordPath)!.ctimeNs = 200n; };
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/storage changed during ACL audit/);
    change = () => { fake.nodes.get(directory)!.ctimeNs += 100n; };
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/storage changed during ACL audit/);
  });
  it("retains the captured native interval when later outer metadata differs", () => {
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start");
    change = value => {
      metadataChange(value); fake.nodes.get(recordPath)!.ctimeNs = 300n;
      value.nodes.find(item => item.path === recordPath)!.sealed!.after.securitySha256 = "sha256:" + "d".repeat(64);
    };
    let failure: unknown;
    try { auditWindowsReleaseStorage(authority, directory); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('"sealed_observation_v1":{"validated":true');
    expect((failure as Error).message).toContain('"ctime_ns":"200"');
    expect((failure as Error).message).toContain('"ctimeNs":"300"');
    expect((failure as Error).message).toContain('$KERNEL.PURGE.SEC.FILEHASH');
  });
  it("cannot register an unsuccessful close or forge a storage authority", () => {
    const authority = prepare(); fake.closeFails = true;
    expect(() => writeWindowsReleaseDispatch(authority, directory, operation, payload, "start")).toThrow(/Original close failed/);
    fake.closeFails = false; change = () => { fake.nodes.get(recordPath)!.ctimeNs = 200n; };
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/storage changed during ACL audit/);
    expect(() => writeWindowsReleaseDispatch({} as typeof authority, directory, operation, payload, "start")).toThrow(/locally prepared/);
  });
  it("rejects an independently changed sealed identity before launching any collector", () => {
    const authority = prepare(); writeWindowsReleaseDispatch(authority, directory, operation, payload, "start"); fake.spawn.mockClear();
    fake.nodes.get(recordPath)!.ino++;
    expect(() => auditWindowsReleaseStorage(authority, directory)).toThrow(/sealed dispatch identity changed/); expect(fake.spawn).not.toHaveBeenCalled();
  });
});
