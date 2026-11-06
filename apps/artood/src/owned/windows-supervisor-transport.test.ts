// Controlled transport only. These fixtures do not prove a native parent chain,
// daemon restart, protected file ACL or original Win32 Job membership.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ spawn: vi.fn(), consume: vi.fn(), files: new Map<string, Buffer>(), bundle: "C:\\controlled-supervisor", system: "C:\\Windows" }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn, spawnSync: vi.fn() }));
vi.mock("./windows-runtime-guardian.js", () => ({ consumeWindowsGuardianSlot: mock.consume }));
vi.mock("node:path", async original => { const value = await original<typeof import("node:path")>(); return { ...value, ...value.win32, default: value.win32 }; });
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => { const directory = path === mock.bundle || path === mock.system, bytes = mock.files.get(path);
    if (!directory && !bytes) throw new Error("Missing controlled path");
    return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false, nlink: 1, ino: directory ? 1 : 2, dev: 1, size: bytes?.length ?? 0, mtimeMs: 1 }; },
  readFileSync: (path: string) => { const bytes = mock.files.get(path); if (!bytes) throw new Error("Missing controlled file"); return Buffer.from(bytes); },
  readdirSync: () => ["Host.exe", "manifest.json"], realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
}));
import { invokeWindowsGuardianNative, prepareWindowsProcessBackend, startWindowsOwnedProcess,
  type WindowsOwnedProcess } from "./windows-owned-process.js";
import type { PreparedWindowsGuardianSlot } from "./windows-runtime-guardian.js";

const caps = ["artoo.windows-runtime-guardian.v1", "artoo.windows-daemon-supervisor.v1", "artoo.windows-job-member-observation.v1"];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
class Helper extends EventEmitter {
  readonly pid = 101;
  readonly stdout = new EventEmitter(); readonly stderr = new EventEmitter(); readonly writes: Record<string, unknown>[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, callback) => { this.writes.push(JSON.parse(Buffer.from(chunk).toString("utf8"))); callback(); } });
  readonly kill = vi.fn(() => true); sequence = 0;
  send(kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    this.stdout.emit("data", Buffer.from(JSON.stringify({ version: 1, kind, sequence: this.sequence++, token: this.writes.find(row => row.kind === "launch")?.token ?? null, payload, ...overrides }) + "\n"));
  }
  qualify() { this.stdout.emit("data", Buffer.from(JSON.stringify({ version: 1, kind: "supervisor_qualified", payload: { controlled: true } }) + "\n")); }
  close(code = 0, eof = true) { if (eof) { this.stdout.emit("end"); this.stderr.emit("end"); } this.emit("exit", code, null); this.emit("close", code, null); }
}
const helpers: Helper[] = [], runs: WindowsOwnedProcess[] = [];
function backend(capabilities = caps) {
  const executable = Buffer.from("CONTROLLED BYTES; NOT EXECUTABLE"); mock.files.set(`${mock.bundle}\\Host.exe`, executable);
  const manifest = Buffer.from(JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64", executable: "Host.exe", capabilities,
    files: [{ path: "Host.exe", size: executable.length, sha256: sha(executable) }] }));
  mock.files.set(`${mock.bundle}\\manifest.json`, manifest);
  return prepareWindowsProcessBackend({ directory: mock.bundle, manifestSha256: sha(manifest), assertLocalInstallation: () => undefined });
}
function begin(capabilities = caps, guardianSlot?: PreparedWindowsGuardianSlot) {
  const run = startWindowsOwnedProcess(backend(capabilities), { executable: "C:\\tools\\node.exe", args: ["fixed-worker.mjs"], cwd: "C:\\product",
    env: { SystemRoot: mock.system }, timeoutMs: 20000, cleanupTimeoutMs: 1000, maxOutputBytes: 65536, normalExitPolicy: "require-empty", normalExitGraceMs: 250, guardianSlot });
  runs.push(run); const helper = helpers.at(-1)!; helper.emit("spawn");
  helper.send("ready", { protocol: "artoo.windows-job-process.v1", atomicJobList: true, capabilities,
    hostIdentity: { pid: helper.pid, creationTime: "100" } });
  helper.send("created", { pid: 202, creationTime: "200", jobMember: true }); helper.send("started", { pid: 202, creationTime: "200" });
  return { run, helper };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("SystemRoot", mock.system); mock.files.clear(); helpers.length = 0; runs.length = 0;
  mock.spawn.mockReset().mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper; });
  mock.consume.mockReset().mockReturnValue(undefined);
});
afterEach(async () => {
  for (const helper of helpers) { helper.close(2); helper.stdin.destroy(); }
  await Promise.all(runs.map(run => run.closed.catch(() => undefined)));
  try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform); }
});

describe("fixed supervisor qualification transport", () => {
  it("uses exact native mode and scrubbed helper env, and waits for successful original closure", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted"); vi.stubEnv("DOTNET_STARTUP_HOOKS", "untrusted");
    let done = false; const result = invokeWindowsGuardianNative(backend(), "supervisor", { version: 1, kind: "qualify" }).then(value => { done = true; return value; });
    const helper = helpers[0]!; helper.emit("spawn"); helper.qualify(); await Promise.resolve(); expect(done).toBe(false);
    expect(mock.spawn.mock.calls[0]![1]).toEqual(["--daemon-supervisor-qualify-v1"]);
    expect(mock.spawn.mock.calls[0]![2]).toMatchObject({ windowsHide: true, shell: false, detached: false,
      env: { SystemRoot: mock.system, WINDIR: mock.system, PATH: `${mock.system}\\System32` } });
    expect(Object.keys(mock.spawn.mock.calls[0]![2].env).sort()).toEqual(["PATH", "SystemRoot", "WINDIR"]);
    expect(helper.writes).toEqual([{ version: 1, kind: "qualify" }]); helper.close(); expect(await result).toEqual({ controlled: true });
  });
  it.each(["nonzero", "missing-eof", "wrong-frame"])("rejects qualification after %s", async fault => {
    const result = invokeWindowsGuardianNative(backend(), "supervisor", { version: 1, kind: "qualify" });
    const rejected = expect(result).rejects.toThrow(); const helper = helpers[0]!; helper.emit("spawn");
    if (fault === "wrong-frame") helper.send("guardian_result", {}); else helper.qualify();
    helper.close(fault === "nonzero" ? 2 : 0, fault !== "missing-eof"); await rejected;
  });
  it("rejects caller-supplied identities and legacy bundles before spawn", async () => {
    await expect(invokeWindowsGuardianNative(backend(), "supervisor", { version: 1, kind: "qualify", daemonPid: 123 })).rejects.toThrow("fixed local request");
    await expect(invokeWindowsGuardianNative(backend([caps[0]!]), "supervisor", { version: 1, kind: "qualify" })).rejects.toThrow("does not advertise daemon supervisor");
    expect(mock.spawn).not.toHaveBeenCalled();
  });
});

describe("Guardian host lifetime selection (controlled boundary)", () => {
  it("keeps ordinary unregistered hosts in their daemon lifetime", () => {
    begin(); expect(mock.spawn.mock.calls[0]![2].detached).toBe(false);
  });
  it("selects survival only after consuming an original slot and binds that enrollment to launch", () => {
    const slot = Object.freeze({}) as PreparedWindowsGuardianSlot, enrollment = { version: 1, controlled: true };
    mock.consume.mockReturnValue(enrollment);
    const { helper } = begin(caps, slot);
    expect(mock.consume).toHaveBeenCalledWith(expect.anything(), slot, "C:\\product");
    expect(mock.spawn.mock.calls[0]![2].detached).toBe(true);
    expect(helper.writes.find(value => value.kind === "launch")?.guardian).toEqual(enrollment);
  });
  it("rejects a supplied but unauthenticated slot before creating any host", () => {
    mock.consume.mockImplementation(() => { throw new Error("Original unused registered slot required"); });
    expect(() => begin(caps, {} as PreparedWindowsGuardianSlot)).toThrow("Original unused registered slot required");
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it("keeps a native command relay non-detached", async () => {
    const result = invokeWindowsGuardianNative(backend(), "command", { controlled: true });
    const helper = helpers[0]!; helper.emit("spawn"); helper.send("guardian_result", { controlled: true });
    expect(mock.spawn.mock.calls[0]![2].detached).toBe(false);
    helper.close(); expect(await result).toEqual({ controlled: true });
  });
});

describe("original Job membership transport", () => {
  it("binds exact requested identities, true/false membership and unavailable facts to its native owner", async () => {
    const { run, helper } = begin(); expect(run.hostIdentity).toEqual({ pid: 101, creationTime: "100" });
    expect(await run.started).toEqual({ pid: 202, creationTime: "200" });
    const members = [{ pid: 301, creationTime: "300" }, { pid: 302, creationTime: "301" }, { pid: 303, creationTime: "302" }];
    const pending = run.observeMembers!(members); const request = helper.writes.at(-1)!;
    helper.send("job_members", { requestId: request.requestId, observedElapsedMs: 10, members: [
      { ...members[0], status: "observed", jobMember: true }, { ...members[1], status: "observed", jobMember: false },
      { ...members[2], status: "unavailable", reason: "identity_changed" }] });
    expect((await pending).members).toEqual([
      { ...members[0], status: "observed", jobMember: true }, { ...members[1], status: "observed", jobMember: false },
      { ...members[2], status: "unavailable", reason: "identity_changed" }]);
  });
  it.each(["request", "identity", "token"])("rejects a member result with changed %s", async fault => {
    const { run, helper } = begin(), members = [{ pid: 301, creationTime: "300" }];
    const pending = run.observeMembers!(members), rejected = expect(pending).rejects.toThrow(); const request = helper.writes.at(-1)!;
    helper.send("job_members", { requestId: fault === "request" ? "other" : request.requestId, observedElapsedMs: 10,
      members: [{ pid: 301, creationTime: fault === "identity" ? "301" : "300", status: "observed", jobMember: true }] }, fault === "token" ? { token: "other" } : {});
    helper.close(2); await rejected;
  });
  it("bounds observation lifetime and refuses new facts after original closure", async () => {
    const { run, helper } = begin();
    const pending = run.observeMembers!([{ pid: 301, creationTime: "300" }], 10), rejected = expect(pending).rejects.toThrow("deadline elapsed");
    await vi.advanceTimersByTimeAsync(10); await rejected; helper.close(2);
    await expect(run.observeMembers!([{ pid: 301, creationTime: "300" }])).rejects.toThrow("Original live Job owner");
  });
  it("does not expose membership observations on legacy bundles", () => {
    const { run } = begin([caps[0]!]); expect(run.observeMembers).toBeUndefined();
  });
});
