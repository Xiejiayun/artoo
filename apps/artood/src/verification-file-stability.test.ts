import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subjectManifest, type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";

vi.mock("node:fs", async load => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync),
    readSync: vi.fn(actual.readSync), lstatSync: vi.fn(actual.lstatSync), fstatSync: vi.fn(actual.fstatSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, nativePlatform = process.platform;
const roots: string[] = [];
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(actual.fstatSync);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const root of roots.splice(0)) actual.rmSync(root, { recursive: true, force: true });
});

function fixture(contents = "alpha") {
  const root = actual.realpathSync.native(actual.mkdtempSync(join(tmpdir(), "artoo-verification-file-stability-")));
  roots.push(root);
  const workspace = join(root, "workspace"), file = join(workspace, "subject.txt"); actual.mkdirSync(workspace);
  actual.writeFileSync(file, contents);
  // subjectManifest only consumes this source description. It conveys no local
  // prepared-profile, execution, review or Windows capability authority.
  const profile: PreparedVerificationProfile = { id: "manifest", project_id: "project", workspace_root: workspace,
    commands: [], required_files: ["subject.txt"], subject_paths: ["subject.txt"], digest: sha("profile"), trustedFiles: [] };
  return { root, workspace, file, contents, profile };
}
function setPlatform(value: string) { Object.defineProperty(process, "platform", { ...platform, value }); }
function changedStat(stat: Stats, changes: Partial<Stats>): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) as Stats;
}

/** Real file IO with explicitly injected timing/metadata for deterministic races. */
function observeFile(f: ReturnType<typeof fixture>, hooks: {
  beforeOpen?: () => void;
  stats?: (stat: Stats, source: "path" | "handle") => Stats;
  afterRead?: (count: number, position: number) => void;
} = {}) {
  let descriptor: number | undefined;
  const reads: { fd: number; position: number; count: number }[] = [];
  vi.mocked(fs.openSync).mockImplementation(((...args: unknown[]) => {
    if (args[0] === f.file) hooks.beforeOpen?.();
    const fd = Reflect.apply(actual.openSync, actual, args) as number;
    if (args[0] === f.file) descriptor = fd;
    return fd;
  }) as typeof fs.openSync);
  vi.mocked(fs.lstatSync).mockImplementation(((...args: unknown[]) => {
    const stat = Reflect.apply(actual.lstatSync, actual, args) as Stats;
    return args[0] === f.file && hooks.stats ? hooks.stats(stat, "path") : stat;
  }) as typeof fs.lstatSync);
  vi.mocked(fs.fstatSync).mockImplementation(((...args: unknown[]) => {
    const stat = Reflect.apply(actual.fstatSync, actual, args) as Stats;
    return args[0] === descriptor && hooks.stats ? hooks.stats(stat, "handle") : stat;
  }) as typeof fs.fstatSync);
  vi.mocked(fs.readSync).mockImplementation(((...args: unknown[]) => {
    const count = Reflect.apply(actual.readSync, actual, args) as number;
    if (args[0] === descriptor) {
      reads.push({ fd: descriptor!, position: args[4] as number, count });
      hooks.afterRead?.(count, args[4] as number);
    }
    return count;
  }) as typeof fs.readSync);
  return { reads, closed: () => descriptor !== undefined && vi.mocked(fs.closeSync).mock.calls.filter(([fd]) => fd === descriptor).length === 1 };
}

describe("manifest stable reads (controlled metadata/race injection, not native process qualification)", () => {
  it("accepts a Windows access/change-time update confined to the first read with two matching bounded reads", () => {
    setPlatform("win32"); const f = fixture(), before = actual.lstatSync(f.file); let read = false;
    const observed = observeFile(f, {
      stats: stat => changedStat(stat, { ctimeMs: before.ctimeMs + (read ? 1 : 0), atimeMs: before.atimeMs + (read ? 1 : 0) }),
      afterRead: count => { if (count) read = true; },
    });
    expect(subjectManifest(f.profile).files.get("subject.txt")).toEqual({ path: "subject.txt", checksum: sha(f.contents), size: 5 });
    expect(observed.reads.filter(read => read.position === 0)).toHaveLength(2);
    expect(new Set(observed.reads.map(read => read.fd)).size).toBe(1);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(10);
    expect(observed.closed()).toBe(true);
  });

  it("keeps empty files bounded and confirms both Windows reads reach EOF", () => {
    setPlatform("win32"); const f = fixture(""), observed = observeFile(f);
    expect(subjectManifest(f.profile).files.get("subject.txt")).toEqual({ path: "subject.txt", checksum: sha(""), size: 0 });
    expect(observed.reads.map(read => [read.position, read.count])).toEqual([[0, 0], [0, 0]]);
    expect(observed.closed()).toBe(true);
  });

  it("preserves POSIX rejection of a ctime change despite identical bytes", () => {
    setPlatform("linux"); const f = fixture(), before = actual.lstatSync(f.file); let read = false;
    const observed = observeFile(f, { stats: stat => changedStat(stat, { ctimeMs: before.ctimeMs + (read ? 1 : 0) }),
      afterRead: count => { if (count) read = true; } });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(observed.reads.filter(item => item.position === 0)).toHaveLength(1);
    expect(observed.closed()).toBe(true);
  });

  it("rejects same-length content changes even when mtime is held fixed and only ctime changes", () => {
    setPlatform("win32"); const f = fixture(), before = actual.lstatSync(f.file); let changed = false;
    const observed = observeFile(f, {
      stats: stat => changedStat(stat, { mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs + (changed ? 1 : 0) }),
      afterRead: count => { if (count && !changed) { changed = true; actual.writeFileSync(f.file, "bravo"); } },
    });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(observed.reads.filter(read => read.position === 0)).toHaveLength(2);
    expect(observed.closed()).toBe(true);
  });

  it("rejects a same-inode same-length write after the second read reaches EOF with mtime held fixed", () => {
    setPlatform("win32"); const f = fixture(), before = actual.lstatSync(f.file); let passes = 0, changed = false;
    const observed = observeFile(f, {
      stats: stat => changedStat(stat, { mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs + (changed ? 1 : 0) }),
      afterRead: (count, position) => {
        if (position === 0) passes++;
        // Both digests have already consumed the original bytes. Only the
        // rebound metadata check can reject this final-read mutation window.
        if (passes === 2 && count === 0) { actual.writeFileSync(f.file, "bravo"); changed = true; }
      },
    });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(changed).toBe(true); expect(actual.readFileSync(f.file, "utf8")).toBe("bravo");
    expect(actual.lstatSync(f.file).ino).toBe(before.ino);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(10);
    expect(passes).toBe(2); expect(observed.closed()).toBe(true);
  });

  it.each(["handle", "path"] as const)("rejects second-read ctime instability reported by the %s even with unchanged bytes", source => {
    setPlatform("win32"); const f = fixture(), before = actual.lstatSync(f.file); let passes = 0;
    const observed = observeFile(f, {
      stats: (stat, origin) => changedStat(stat, { ctimeMs: before.ctimeMs + (passes >= 2 && origin === source ? 1 : 0) }),
      afterRead: (_count, position) => { if (position === 0) passes++; },
    });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(actual.readFileSync(f.file, "utf8")).toBe(f.contents);
    expect(passes).toBe(2); expect(observed.closed()).toBe(true);
  });

  it.each(["before open", "during read"] as const)("rejects same-content path replacement %s", timing => {
    setPlatform("win32"); const f = fixture(); let replaced = false;
    const replace = () => {
      if (replaced) return; replaced = true;
      actual.renameSync(f.file, join(f.root, "previous.txt")); actual.writeFileSync(f.file, f.contents);
    };
    const observed = observeFile(f, timing === "before open" ? { beforeOpen: replace } : { afterRead: count => { if (count) replace(); } });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(replaced).toBe(true); expect(observed.closed()).toBe(true);
  });

  it("rejects a hard link created while the file is being read", () => {
    setPlatform("win32"); const f = fixture(); let linked = false;
    const observed = observeFile(f, { afterRead: count => {
      if (count && !linked) { linked = true; actual.linkSync(f.file, join(f.root, "linked.txt")); }
    } });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(linked).toBe(true); expect(observed.closed()).toBe(true);
  });

  it("rejects an existing hard link before opening it", () => {
    setPlatform("win32"); const f = fixture(); actual.linkSync(f.file, join(f.root, "linked.txt"));
    expect(() => subjectManifest(f.profile)).toThrow(/bounded regular file without links/);
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it("rejects a named-path symlink reported after opening the regular file (simulated metadata)", () => {
    setPlatform("win32"); const f = fixture(); let read = false;
    const observed = observeFile(f, { afterRead: count => { if (count) read = true; },
      stats: (stat, source) => read && source === "path" ? changedStat(stat, { isSymbolicLink: () => true }) : stat });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(observed.closed()).toBe(true);
  });

  it("still rejects mtime changes when the content and file identity remain the same", () => {
    setPlatform("win32"); const f = fixture(), before = actual.lstatSync(f.file); let read = false;
    const observed = observeFile(f, { afterRead: count => { if (count) read = true; },
      stats: stat => changedStat(stat, { mtimeMs: before.mtimeMs + (read ? 1 : 0) }) });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(observed.reads.filter(item => item.position === 0)).toHaveLength(1);
    expect(observed.closed()).toBe(true);
  });

  it("rejects growth after reading at most the initial size plus one byte", () => {
    setPlatform("win32"); const f = fixture(); let grew = false;
    const observed = observeFile(f, { afterRead: count => {
      if (count && !grew) { grew = true; actual.appendFileSync(f.file, "larger than the admitted read"); }
    } });
    expect(() => subjectManifest(f.profile)).toThrow(/file changed while reading/);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(f.contents.length + 1);
    expect(observed.closed()).toBe(true);
  });
});

describe.runIf(nativePlatform === "win32")("native Windows filesystem (no injected IO; not node/provider acceptance)", () => {
  it("hashes newly written source and protected verifier files and still detects changed protected bytes", async () => {
    // Load a separate module graph with the actual filesystem, so this native
    // regression does not rely on the controlled race hooks above.
    vi.doUnmock("node:fs"); vi.resetModules();
    const native = await import("./verification.js"), f = fixture(), script = join(f.root, "verify.mjs");
    actual.writeFileSync(script, "process.exit(0)\n");
    const raw: VerificationProfile = { ...f.profile, commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }] };
    // Remove manifest-only metadata before entering the real profile preparation boundary.
    const { id, project_id, workspace_root, commands, required_files, subject_paths } = raw;
    const profile = native.prepareVerificationProfiles([{ id, project_id, workspace_root, commands, required_files, subject_paths }])[0]!;
    for (const contents of ["fresh first", "fresh second", ""]) {
      actual.writeFileSync(f.file, contents);
      expect(native.subjectManifest(profile).files.get("subject.txt")).toEqual({ path: "subject.txt", checksum: sha(contents), size: Buffer.byteLength(contents) });
    }
    const manifest = native.subjectManifest(profile);
    expect(() => native.assertVerificationSubject(profile, manifest.digest)).not.toThrow();
    actual.writeFileSync(script, "process.exit(1)\n");
    expect(() => native.assertVerificationSubject(profile, manifest.digest)).toThrow(/administrator verifier changed/);
  });
});
