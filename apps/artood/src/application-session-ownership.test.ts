// Controlled filesystem and local ACL authority only. No native collector or
// real directory is created; these cases exercise the production owner state.
import { win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedApplicationSession } from "./application-session-ownership.js";

type Entry = { directory: boolean; ino: bigint; dev: bigint; ctimeNs: bigint; mtimeNs: bigint; size: bigint; link?: boolean };
const controlled = vi.hoisted(() => ({
  entries: new Map<string, Entry>(), next: 0n,
  storage: new Map<object, { directory: string; ino: bigint }>(),
  prepare: vi.fn(), assert: vi.fn(), audit: vi.fn(), mkdir: vi.fn(), remove: vi.fn(),
  aclFailure: null as Error | null, removeFailure: null as Error | null,
}));
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    const value = controlled.entries.get(path);
    if (!value) throw Object.assign(Error("controlled missing directory"), { code: "ENOENT" });
    return { ...value, isDirectory: () => value.directory, isSymbolicLink: () => !!value.link };
  },
  realpathSync: { native: (path: string) => path },
  readdirSync: (path: string) => [...controlled.entries.keys()].filter(value => win32.dirname(value) === path).map(value => win32.basename(value)),
  mkdirSync: controlled.mkdir,
  rmdirSync: controlled.remove,
}));
vi.mock("./windows-local-acl.js", () => ({
  assertNativeWindows: () => {},
  assertCanonicalWindowsPath: (path: string) => {
    if (!/^[A-Z]:\\/u.test(path) || path.includes("/") || win32.normalize(path) !== path) throw Error("noncanonical path");
  },
  physicalWindowsDirectory: (path: string) => {
    const value = controlled.entries.get(path);
    if (!value?.directory || value.link) throw Error("physical directory required");
    return path;
  },
}));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.prepare,
  assertWindowsReleaseStorage: controlled.assert, auditWindowsReleaseStorage: controlled.audit }));

import { acquireApplicationSession, assertApplicationSession, releaseApplicationSession } from "./application-session-ownership.js";

const control = "C:\\protected\\generation\\control", lock = control + "\\.application-session", roots = ["C:\\work"];
function add(path: string, directory = true) {
  controlled.entries.set(path, { directory, ino: ++controlled.next, dev: 1n, ctimeNs: 1n, mtimeNs: 1n, size: 0n });
}
const acquire = () => acquireApplicationSession({ controlDirectory: control, writableWorkspaceRoots: roots });
const held = (token: PreparedApplicationSession) => assertApplicationSession(token, control, roots);
beforeEach(() => {
  controlled.entries.clear(); controlled.storage.clear(); controlled.aclFailure = null; controlled.removeFailure = null;
  add(control); add(roots[0]!);
  controlled.prepare.mockReset().mockImplementation(({ directory }: { directory: string }) => {
    if (controlled.aclFailure) throw controlled.aclFailure;
    const token = Object.freeze({}); controlled.storage.set(token, { directory, ino: controlled.entries.get(directory)!.ino }); return token;
  });
  controlled.assert.mockReset().mockImplementation((token: object, directory: string) => {
    const original = controlled.storage.get(token);
    if (!original || original.directory !== directory || controlled.entries.get(directory)?.ino !== original.ino)
      throw Error("original storage boundary changed");
  });
  controlled.audit.mockReset().mockImplementation((token: object, directory: string) => {
    controlled.assert(token, directory); if (controlled.aclFailure) throw controlled.aclFailure;
  });
  controlled.mkdir.mockReset().mockImplementation((path: string) => {
    if (controlled.entries.has(path)) throw Object.assign(Error("controlled existing owner"), { code: "EEXIST" });
    add(path);
  });
  controlled.remove.mockReset().mockImplementation((path: string) => {
    if (controlled.removeFailure) throw controlled.removeFailure;
    if ([...controlled.entries.keys()].some(value => win32.dirname(value) === path)) throw Error("directory not empty");
    if (!controlled.entries.delete(path)) throw Error("original directory missing");
  });
});

describe("clean-only original application session ownership", () => {
  it("requires the real frozen local token and its original control/write-root binding", () => {
    const token = acquire(); expect(Object.isFrozen(token)).toBe(true); expect(() => held(token)).not.toThrow();
    for (const forged of [{}, structuredClone(token), JSON.parse(JSON.stringify(token))]) {
      expect(() => held(forged as PreparedApplicationSession)).toThrow("Original matching application session required");
      expect(() => releaseApplicationSession(forged as PreparedApplicationSession)).toThrow("Original application session required");
    }
    expect(() => assertApplicationSession(token, "C:\\other\\control", roots)).toThrow("Original matching");
    expect(() => assertApplicationSession(token, control, ["C:\\other"])).toThrow("Original matching");
    releaseApplicationSession(token); expect(controlled.remove).toHaveBeenCalledExactlyOnceWith(lock);
    expect(() => held(token)).toThrow(); expect(() => releaseApplicationSession(token)).toThrow();
  });

  it("rejects a concurrent acquisition without replacing or releasing the first owner", () => {
    const first = acquire(), original = { ...controlled.entries.get(lock)! };
    expect(() => acquire()).toThrow("existing owner"); expect(controlled.entries.get(lock)).toEqual(original);
    expect(controlled.remove).not.toHaveBeenCalled(); held(first); releaseApplicationSession(first);
    const second = acquire(); expect(second).not.toBe(first); held(second); releaseApplicationSession(second);
  });

  it("retains an old owner directory without inspecting or adopting a recorded PID", () => {
    add(lock); add(lock + "\\old-pid.json", false);
    const original = [...controlled.entries]; expect(() => acquire()).toThrow("existing owner");
    expect([...controlled.entries]).toEqual(original); expect(controlled.remove).not.toHaveBeenCalled();
  });

  it("captures the configured write roots before caller mutation", () => {
    const input = { controlDirectory: control, writableWorkspaceRoots: [...roots] }, token = acquireApplicationSession(input);
    input.controlDirectory = "C:\\other\\control"; input.writableWorkspaceRoots[0] = "C:\\other";
    held(token); releaseApplicationSession(token);
  });

  it.each(["control", "lock"] as const)("never removes a replaced original %s directory", changed => {
    const token = acquire(), path = changed === "control" ? control : lock;
    controlled.entries.set(path, { ...controlled.entries.get(path)!, ino: ++controlled.next });
    expect(() => held(token)).toThrow(); expect(() => releaseApplicationSession(token)).toThrow();
    expect(controlled.remove).not.toHaveBeenCalled(); expect(controlled.entries.has(lock)).toBe(true);
  });

  it("retains unexpected contents instead of recursively removing a nonempty lock", () => {
    const token = acquire(); add(lock + "\\unexpected.json", false);
    expect(() => held(token)).toThrow("ownership changed"); expect(() => releaseApplicationSession(token)).toThrow();
    expect(controlled.remove).not.toHaveBeenCalled(); expect(controlled.entries.has(lock + "\\unexpected.json")).toBe(true);
  });

  it("does not refresh a failed immutable directory baseline after metadata is restored", () => {
    const token = acquire(), original = { ...controlled.entries.get(lock)! };
    controlled.entries.get(lock)!.ctimeNs++;
    expect(() => held(token)).toThrow("ownership changed"); controlled.entries.set(lock, original);
    expect(() => held(token)).toThrow(); expect(() => releaseApplicationSession(token)).toThrow();
    expect(controlled.remove).not.toHaveBeenCalled();
  });

  it("does not create ownership when the initial ACL admission rejects", () => {
    const failure = Error("controlled initial ACL rejection"); controlled.aclFailure = failure;
    expect(() => acquire()).toThrow(failure); expect(controlled.mkdir).not.toHaveBeenCalled();
  });

  it("retains ownership permanently after release ACL rejection even if permissions are later repaired", () => {
    const token = acquire(), failure = Error("controlled release ACL rejection"); controlled.aclFailure = failure;
    expect(() => releaseApplicationSession(token)).toThrow(failure); controlled.aclFailure = null;
    expect(() => releaseApplicationSession(token)).toThrow(); expect(() => held(token)).toThrow();
    expect(controlled.remove).not.toHaveBeenCalled(); expect(controlled.entries.has(lock)).toBe(true);
  });

  it("makes a failed original directory removal terminal without a retry", () => {
    const token = acquire(), failure = Error("controlled directory removal failure"); controlled.removeFailure = failure;
    expect(() => releaseApplicationSession(token)).toThrow(failure); controlled.removeFailure = null;
    expect(() => releaseApplicationSession(token)).toThrow(); expect(() => held(token)).toThrow();
    expect(controlled.remove).toHaveBeenCalledExactlyOnceWith(lock); expect(controlled.entries.has(lock)).toBe(true);
  });
});
