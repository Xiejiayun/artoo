// Real temporary files and original prepared profiles; deterministic race hooks
// instrument only filesystem observations. No verifier/process/browser executes.
import * as fs from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocallyPreparedVerificationProfile, assertLocallyPreparedVerificationProfiles,
  prepareVerificationProfiles, readVerificationCapabilitiesBatch, readWindowsVerificationBackends,
  type VerificationProfile } from "./verification.js";

vi.mock("node:fs", async load => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync),
    readSync: vi.fn(actual.readSync), lstatSync: vi.fn(actual.lstatSync), fstatSync: vi.fn(actual.fstatSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const changedStat = (stat: Stats, changes: Partial<Stats>): Stats => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) as Stats;
function setPlatform(value: string) { Object.defineProperty(process, "platform", { ...platform, value }); }
function resetIO() {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(actual.fstatSync);
}
beforeEach(() => { setPlatform("win32"); resetIO(); });
afterEach(() => {
  resetIO(); Object.defineProperty(process, "platform", platform);
  const prefix = `${actual.realpathSync.native(tmpdir())}${sep}artoo-profile-batch-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(prefix) || actual.realpathSync.native(root) !== root) throw Error("Unexpected batch fixture cleanup path");
    actual.rmSync(root, { recursive: true, force: true });
  }
});
const write = (path: string, value: string) => { actual.writeFileSync(path, value); actual.readFileSync(path); };
function fixture(count = 3) {
  const root = actual.realpathSync.native(actual.mkdtempSync(join(tmpdir(), "artoo-profile-batch-"))); roots.push(root);
  const executable = join(root, "a-verifier.exe"), shared = join(root, "b-shared.txt");
  write(executable, "inert executable fixture"); write(shared, "alpha");
  const raw: VerificationProfile[] = Array.from({ length: count }, (_, index) => {
    const workspace = join(root, `workspace-${index}`), evidence = join(root, `evidence-${index}`), config = join(root, `z-config-${index}.json`);
    actual.mkdirSync(workspace); actual.mkdirSync(evidence); write(config, JSON.stringify({ index }));
    return { id: `profile-${index}`, project_id: "project", workspace_root: workspace, required_files: [], subject_paths: ["product"],
      commands: [{ id: "verify", argv: [executable, shared, config], timeout_ms: 1000,
        observation: { format: "static-web-acceptance.v1", evidence_root: evidence } }] };
  });
  const profiles = prepareVerificationProfiles(raw); resetIO();
  return { root, executable, shared, raw, profiles };
}
function observe(hooks: {
  beforeStat?: (path: unknown) => void;
  stats?: (path: string, stat: Stats, source: "path" | "handle") => Stats;
  afterRead?: (path: string, count: number, position: number) => void;
  afterClose?: (path: string) => void;
} = {}) {
  const handles = new Map<number, string>(), reads: { path: string; count: number; position: number }[] = [], closed: string[] = [];
  vi.mocked(fs.openSync).mockImplementation(((...args: unknown[]) => {
    const fd = Reflect.apply(actual.openSync, actual, args) as number; handles.set(fd, String(args[0])); return fd;
  }) as typeof fs.openSync);
  vi.mocked(fs.closeSync).mockImplementation((fd: number) => {
    const path = handles.get(fd)!; actual.closeSync(fd); handles.delete(fd); closed.push(path); hooks.afterClose?.(path);
  });
  vi.mocked(fs.lstatSync).mockImplementation(((...args: unknown[]) => {
    hooks.beforeStat?.(args[0]);
    const stat = Reflect.apply(actual.lstatSync, actual, args) as Stats;
    return hooks.stats ? hooks.stats(String(args[0]), stat, "path") : stat;
  }) as typeof fs.lstatSync);
  vi.mocked(fs.fstatSync).mockImplementation(((...args: unknown[]) => {
    const stat = Reflect.apply(actual.fstatSync, actual, args) as Stats;
    return hooks.stats ? hooks.stats(handles.get(args[0] as number)!, stat, "handle") : stat;
  }) as typeof fs.fstatSync);
  vi.mocked(fs.readSync).mockImplementation(((...args: unknown[]) => {
    const count = Reflect.apply(actual.readSync, actual, args) as number, path = handles.get(args[0] as number)!;
    reads.push({ path, count, position: args[4] as number }); hooks.afterRead?.(path, count, args[4] as number); return count;
  }) as typeof fs.readSync);
  return { reads, closed, handles };
}

describe("fresh synchronous Windows trusted-file batches", () => {
  it("hashes each shared physical file twice, independent configs separately, and reads all bytes again on the next call", () => {
    const f = fixture(4), observed = observe(), input = Object.freeze([...f.profiles]);
    const unique = new Map(f.profiles.flatMap(profile => profile.trustedFiles.map(file => [file.path, file.size] as const)));
    assertLocallyPreparedVerificationProfiles(input);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(2 * [...unique.values()].reduce((sum, size) => sum + size, 0));
    for (const path of unique.keys()) expect(observed.reads.filter(read => read.path === path && read.position === 0)).toHaveLength(2);
    expect(observed.handles.size).toBe(0); expect(input.every((profile, index) => profile === f.profiles[index])).toBe(true);
    const bytes = observed.reads.reduce((sum, read) => sum + read.count, 0);
    assertLocallyPreparedVerificationProfiles(input);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(bytes * 2);
    write(f.shared, "bravo"); expect(() => assertLocallyPreparedVerificationProfiles(input)).toThrow(/verifier changed/);
  });

  it("keeps single-profile/manual and POSIX reads independent, including duplicate order", () => {
    const f = fixture(2), observed = observe(), bytes = f.profiles.reduce((sum, profile) => sum + profile.trustedFiles.reduce((sum, fact) => sum + fact.size, 0), 0);
    for (const profile of f.profiles) assertLocallyPreparedVerificationProfile(profile);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(bytes * 2);
    expect(observed.closed).toHaveLength(6); observed.reads.length = 0; observed.closed.length = 0;
    assertLocallyPreparedVerificationProfiles([f.profiles[0]!]);
    expect(observed.closed).toHaveLength(3);
    observed.reads.length = 0; setPlatform("linux"); assertLocallyPreparedVerificationProfiles(f.profiles);
    expect(observed.reads.reduce((sum, read) => sum + read.count, 0)).toBe(bytes);
    setPlatform("win32"); observed.reads.length = 0;
    assertLocallyPreparedVerificationProfiles([f.profiles[1]!, f.profiles[0]!, f.profiles[1]!]);
    expect(observed.reads.filter(read => read.path === f.shared && read.position === 0)).toHaveLength(2);
  });

  it("rejects cloned originals and conflicting prepared pins for the same path", () => {
    const f = fixture(2);
    expect(() => assertLocallyPreparedVerificationProfiles([f.profiles[0]!, structuredClone(f.profiles[1]!)])).toThrow(/locally prepared/);
    write(f.shared, "bravo"); const other = prepareVerificationProfiles([f.raw[1]!])[0]!; write(f.shared, "alpha");
    expect(() => assertLocallyPreparedVerificationProfiles([f.profiles[0]!, other])).toThrow(/conflicting protected verifier bindings/);
  });

  it.each(["bytes", "replacement", "ctime", "hardlink", "symlink"] as const)("rejects later-profile %s changes after a shared read", kind => {
    const f = fixture(2), before = actual.lstatSync(f.shared); let changed = false;
    const observed = observe({
      beforeStat: path => {
        if (path !== f.profiles[1]!.workspace_root || changed) return; changed = true;
        if (kind === "bytes") write(f.shared, "bravo");
        if (kind === "replacement") { actual.renameSync(f.shared, join(f.root, "previous.txt")); write(f.shared, "alpha"); }
        if (kind === "hardlink") actual.linkSync(f.shared, join(f.root, "linked.txt"));
      },
      stats: (path, stat, source) => path === f.shared && changed
        ? changedStat(stat, { ...(kind === "bytes" ? { mtimeMs: before.mtimeMs } : {}),
          ...(["bytes", "ctime"].includes(kind) ? { ctimeMs: before.ctimeMs + 1 } : {}),
          ...(kind === "symlink" && source === "path" ? { isSymbolicLink: () => true } : {}) }) : stat,
    });
    expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow(/changed during trusted profile batch/);
    expect(changed).toBe(true); expect(observed.handles.size).toBe(0);
    expect(observed.reads.filter(read => read.path === f.shared && read.position === 0)).toHaveLength(2);
  });

  it.each(["path", "handle"] as const)("rejects ctime drift on the reused %s even with identical bytes", source => {
    const f = fixture(2), before = actual.lstatSync(f.shared); let later = false;
    const observed = observe({ beforeStat: path => { if (path === f.profiles[1]!.workspace_root) later = true; },
      stats: (path, stat, origin) => path === f.shared && later && origin === source ? changedStat(stat, { ctimeMs: before.ctimeMs + 1 }) : stat });
    expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow(/changed during trusted profile batch/);
    expect(observed.handles.size).toBe(0);
  });

  it("rechecks all earlier files at batch end after the final profile's last new file was read", () => {
    const f = fixture(2), last = f.raw[1]!.commands[0]!.argv[2]!, before = actual.lstatSync(f.shared); let changed = false;
    const observed = observe({ afterRead: (path, count) => { if (path === last && count && !changed) { write(f.shared, "bravo"); changed = true; } },
      stats: (path, stat) => path === f.shared && changed ? changedStat(stat, { mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs + 1 }) : stat });
    expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow(/changed during trusted profile batch/);
    expect(changed).toBe(true); expect(observed.handles.size).toBe(0);
  });

  it.each(["workspace", "evidence"] as const)("keeps every profile's %s check before sharing any trusted bytes", kind => {
    const f = fixture(2), path = kind === "workspace" ? f.profiles[1]!.workspace_root : f.raw[1]!.commands[0]!.observation!.evidence_root!;
    const observed = observe({ stats: (name, stat) => name === path ? changedStat(stat, { isSymbolicLink: () => true }) : stat });
    expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow(/workspace identity|evidence.*physical|evidence.*link/i);
    expect(observed.handles.size).toBe(0);
  });

  it.each(["replacement", "ctime"] as const)("rejects %s during the final metadata handle's successful close", kind => {
    const f = fixture(2), last = f.raw[1]!.commands[0]!.argv[2]!, contents = actual.readFileSync(last, "utf8");
    let closes = 0, changed = false;
    const observed = observe({ afterClose: path => {
      // This distinct final file closes once after hashing, then once after its
      // end-of-batch metadata check. No later file can mask this final window.
      if (path === last && ++closes === 2) {
        changed = true;
        if (kind === "replacement") { actual.renameSync(last, join(f.root, "previous-config.json")); write(last, contents); }
      }
    }, stats: (path, stat) => path === last && changed && kind === "ctime" ? changedStat(stat, { ctimeMs: stat.ctimeMs + 1 }) : stat });
    expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow(/changed during trusted profile batch/);
    expect(changed).toBe(true); expect(observed.handles.size).toBe(0);
    expect(actual.readFileSync(last, "utf8")).toBe(contents);
  });

  it("does not return a successful batch when closing an original read or a reused handle fails", () => {
    for (const reuse of [false, true]) {
      const f = fixture(2); let closes = 0;
      const observed = observe({ afterClose: path => { if (path === f.shared && ++closes === (reuse ? 2 : 1)) throw Error("controlled close failure"); } });
      expect(() => assertLocallyPreparedVerificationProfiles(f.profiles)).toThrow("controlled close failure");
      expect(observed.handles.size).toBe(0); resetIO();
    }
  });

  it("preserves empty/absent-capability/unbound-backend behavior without acquiring authority", () => {
    const f = fixture(2), clones = f.profiles.map(profile => structuredClone(profile));
    expect(() => assertLocallyPreparedVerificationProfiles([])).not.toThrow();
    expect(readVerificationCapabilitiesBatch(clones)).toEqual([undefined, undefined]);
    expect(readWindowsVerificationBackends(clones)).toEqual([undefined, undefined]);
    expect(Object.isFrozen(readVerificationCapabilitiesBatch([]))).toBe(true);
    expect(fs.readSync).not.toHaveBeenCalled();
  });
});
