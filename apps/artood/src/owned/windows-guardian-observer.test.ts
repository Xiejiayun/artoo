// Controlled transport/OS tests only. Native stdin, Job and daemon-loss coverage
// belongs to windows-guardian-real.mjs against the separately built helper.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), consume: vi.fn(), files: new Map<string, Buffer>(),
  bundle: "C:\\controlled-helper", system: "C:\\Windows" }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn, spawnSync: mock.spawnSync }));
vi.mock("./windows-runtime-guardian.js", () => ({ consumeWindowsGuardianSlot: mock.consume }));
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>(); return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    const directory = path === mock.bundle || path === mock.system, bytes = mock.files.get(path);
    if (!directory && !bytes) throw new Error("Missing controlled path");
    return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
      nlink: 1, ino: directory ? 1 : 2, dev: 1, size: bytes?.length ?? 0, mtimeMs: 1 };
  },
  readFileSync: (path: string) => { const bytes = mock.files.get(path); if (!bytes) throw new Error("Missing controlled file"); return Buffer.from(bytes); },
  readdirSync: () => ["Host.exe", "manifest.json"],
  realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
}));

import { invokeWindowsGuardianNativeSync, isWindowsOwnedClosureReceipt, prepareWindowsProcessBackend,
  startWindowsGuardianObserverSync, WindowsOwnedCleanupError, type PreparedWindowsProcessBackend } from "./windows-owned-process.js";
import type { PreparedWindowsGuardianSlot } from "./windows-runtime-guardian.js";
import { readWindowsNativeFailureCode, readWindowsNativeFailure } from "./windows-process-diagnostic.js";
import { createSourceCommandDiagnostics, type SourceCommandDiagnostic } from "../source-command-diagnostics.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const slot = Object.freeze({}) as PreparedWindowsGuardianSlot;
let manifestSha256: string;
function prepare(audit: () => void = () => undefined) {
  return prepareWindowsProcessBackend({ directory: mock.bundle, manifestSha256, assertLocalInstallation: audit });
}
function input() { return { executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-Command", "fixed-controlled-script"], cwd: "C:\\product",
  env: { SystemRoot: mock.system }, timeoutMs: 15000, maxOutputBytes: 65536, cleanupTimeoutMs: 5000,
  normalExitPolicy: "require-empty" as const, normalExitGraceMs: 250, guardianSlot: slot, inputBytes: Buffer.from("测试\nUTF8") }; }
type Frame = { version: number; kind: string; sequence: number; token: string | null; payload: Record<string, unknown> };
function success(options: { input: string }, change?: (frames: Frame[]) => void) {
  const request = JSON.parse(options.input) as { token: string };
  const body: Array<[string, Record<string, unknown>]> = [
    ["ready", { protocol: "artoo.windows-job-process.v1", atomicJobList: true, capabilities: ["artoo.windows-runtime-guardian.v1"] }],
    ["created", { pid: 42, creationTime: "123456", jobMember: true }], ["started", { pid: 42 }],
    ["output", { stream: "stdout", data: Buffer.from("facts").toString("base64") }],
    ["root_exit", { code: 0 }], ["pipe_eof", { stream: "stdout" }], ["pipe_eof", { stream: "stderr" }],
    ["complete", { rootCreated: true, rootStarted: true, rootPid: 42, rootCreationTime: "123456", atomicJobMember: true,
      rootWaitObserved: true, rootExitCode: 0, stdoutEof: true, stderrEof: true, stdoutCreated: true, stderrCreated: true,
      jobCreated: true, jobEmptyObserved: true, noTargetCreated: false, terminationReason: null, failureCode: null,
      nativeError: null, outputBytesObserved: 5, outputBytesCaptured: 5, cleanupConfirmed: true }],
  ];
  const frames: Frame[] = body.map(([kind, payload], sequence) => ({ version: 1, kind, sequence, token: sequence ? request.token : null, payload }));
  change?.(frames);
  return { pid: 41, status: 0, signal: null, stdout: Buffer.from(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"), stderr: Buffer.alloc(0) };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.spawnSync.mockReset(); mock.consume.mockReset(); mock.files.clear();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); vi.stubEnv("SystemRoot", mock.system);
  const executable = Buffer.from("CONTROLLED TEST BYTES; NOT EXECUTABLE");
  mock.files.set(`${mock.bundle}\\Host.exe`, executable);
  const manifest = Buffer.from(JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64",
    executable: "Host.exe", capabilities: ["artoo.windows-runtime-guardian.v1"],
    files: [{ path: "Host.exe", size: executable.length, sha256: sha(executable) }] }));
  mock.files.set(`${mock.bundle}\\manifest.json`, manifest); manifestSha256 = sha(manifest);
  mock.consume.mockReturnValue({ version: 1, controlled: true });
  mock.spawnSync.mockImplementation((_file, _args, options) => success(options));
});
afterEach(() => { vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform); });

describe("registered synchronous collectors (controlled OS boundary)", () => {
  it("observes the existing closed API receipt once without exposing enrollment tickets or target inputs", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const epochId = "00000000-0000-4000-8000-000000000001", slotId = "00000000-0000-4000-8000-000000000002";
    mock.consume.mockReturnValue({ version: 1, epochId, slotId, ticket: "private-ticket" });
    const value = await diagnostics.run({ type: "product.source.review.v1", id: "private-command-id" },
      () => startWindowsGuardianObserverSync(prepare(), input()));
    expect(rows.filter(row => row.status === "observed")).toHaveLength(1);
    expect(rows.find(row => row.status === "observed")?.observer_timing).toEqual({ version: 1,
      scope: "startWindowsGuardianObserverSync.inclusive.v1", epoch_id: epochId, slot_id: slotId,
      elapsed_ms: Math.floor(value.receipt.elapsedMs), cleanup_confirmed: true });
    expect(isWindowsOwnedClosureReceipt(value.receipt)).toBe(true);
    expect(mock.spawnSync).toHaveBeenCalledTimes(1); expect(mock.consume).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).not.toContain("private-"); expect(JSON.stringify(rows)).not.toContain("C:\\");
    expect(JSON.stringify(rows)).not.toContain("fixed-controlled-script"); expect(JSON.stringify(rows)).not.toContain(value.receipt.token);
  });

  it("retains separate nested slot observations without treating inclusive intervals as exclusive durations", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const epochId = "00000000-0000-4000-8000-000000000001";
    const innerSlot = "00000000-0000-4000-8000-000000000002", outerSlot = "00000000-0000-4000-8000-000000000003";
    mock.consume.mockReturnValueOnce({ version: 1, epochId, slotId: innerSlot }).mockReturnValueOnce({ version: 1, epochId, slotId: outerSlot });
    let backend: PreparedWindowsProcessBackend | undefined, inner: ReturnType<typeof startWindowsGuardianObserverSync> | undefined;
    backend = prepare(() => { if (backend) inner = startWindowsGuardianObserverSync(backend, input()); });
    const outer = await diagnostics.run({ type: "product.source.review.v1", id: "private-nested-command" },
      () => startWindowsGuardianObserverSync(backend!, input()));
    const samples = rows.flatMap(row => row.observer_timing ? [row.observer_timing] : []);
    expect(samples.map(sample => sample.slot_id)).toEqual([innerSlot, outerSlot]);
    expect(samples.map(sample => sample.elapsed_ms)).toEqual([Math.floor(inner!.receipt.elapsedMs), Math.floor(outer.receipt.elapsedMs)]);
    expect(samples.every(sample => sample.scope === "startWindowsGuardianObserverSync.inclusive.v1")).toBe(true);
    expect(mock.spawnSync).toHaveBeenCalledTimes(2); expect(mock.consume).toHaveBeenCalledTimes(2);
  });

  it("cannot convert unconfirmed closure into success when the optional timing sink fails", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => {
      rows.push(row); if (row.status === "observed") throw Error("private-sink-failure");
    });
    mock.consume.mockReturnValue({ version: 1, epochId: "00000000-0000-4000-8000-000000000001", slotId: "00000000-0000-4000-8000-000000000002" });
    mock.spawnSync.mockImplementation((_file, _args, options) => success(options, frames => { frames.at(-1)!.payload.jobEmptyObserved = false; }));
    let caught: unknown;
    try { await diagnostics.run({ type: "product.source.review.v1", id: "private-failed-command" }, () => startWindowsGuardianObserverSync(prepare(), input())); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WindowsOwnedCleanupError);
    expect(readWindowsNativeFailureCode(caught)).toBe("native_protocol_failed");
    expect(rows.find(row => row.status === "observed")?.observer_timing?.cleanup_confirmed).toBe(false);
    expect(rows.at(-1)).toMatchObject({ status: "failed", native_failure_code: "native_protocol_failed" });
    expect(mock.spawnSync).toHaveBeenCalledTimes(1); expect(mock.consume).toHaveBeenCalledTimes(1);
  });

  it("binds UTF8 stdin and an observer slot to a fixed helper without leaking control into the target env", () => {
    const backend = prepare(), value = startWindowsGuardianObserverSync(backend, input());
    expect(value.stdout.toString()).toBe("facts"); expect(value.receipt.cleanupConfirmed).toBe(true);
    expect(isWindowsOwnedClosureReceipt(value.receipt)).toBe(true); expect(isWindowsOwnedClosureReceipt({ ...value.receipt })).toBe(false);
    expect(mock.consume).toHaveBeenCalledWith(backend, slot, "C:\\product", "observer");
    const [executable, args, options] = mock.spawnSync.mock.calls[0]!;
    expect(executable).toBe(`${mock.bundle}\\Host.exe`); expect(args).toEqual(["--stdio-sync-v1"]);
    const request = JSON.parse(options.input);
    expect(Buffer.from(request.inputBase64, "base64")).toEqual(input().inputBytes);
    expect(request.env).toEqual({ SystemRoot: mock.system }); expect(options.windowsHide).toBe(true); expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it("rejects a copied or missing observer authority before helper creation", () => {
    mock.consume.mockImplementation(() => { throw new Error("Original slot required"); });
    expect(() => startWindowsGuardianObserverSync(prepare(), input())).toThrow("Original slot required"); expect(mock.spawnSync).not.toHaveBeenCalled();
  });
  it("cannot select detached execution when original observer consumption returns no enrollment", () => {
    mock.consume.mockReturnValue(undefined);
    expect(() => startWindowsGuardianObserverSync(prepare(), input())).toThrow("Original registered observer slot required");
    expect(mock.spawnSync).not.toHaveBeenCalled();
  });
  it.each(["binding", "job", "eof", "truncated", "helper"] as const)("does not infer closure after %s evidence loss", fault => {
    mock.spawnSync.mockImplementation((_file, _args, options) => {
      const result = success(options, frames => {
        if (fault === "binding") frames[1]!.token = "other-token";
        if (fault === "job") frames.at(-1)!.payload.jobEmptyObserved = false;
        if (fault === "eof") frames.at(-1)!.payload.stdoutEof = false;
      });
      if (fault === "truncated") result.stdout = result.stdout.subarray(0, -1);
      if (fault === "helper") result.status = 2;
      return result;
    });
    let error: unknown; try { startWindowsGuardianObserverSync(prepare(), input()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WindowsOwnedCleanupError);
    expect((error as WindowsOwnedCleanupError).receipt.cleanupConfirmed).toBe(false);
    expect(readWindowsNativeFailureCode(error)).toBe(fault === "helper" ? "native_nonzero_exit" : "native_protocol_failed");
    const detail = readWindowsNativeFailure(error)?.detail;
    expect(detail).toMatchObject({ helper_mode: "guardian_observer_sync", helper_exit_code: fault === "helper" ? 2 : 0,
      stderr_status: "empty", observer: { cleanupConfirmed: false } });
    expect(isWindowsOwnedClosureReceipt(detail?.observer)).toBe(false);
    expect(detail?.observer).not.toHaveProperty("token"); expect(detail?.observer).not.toHaveProperty("rootPid");
  });
  it("preserves a real target failure after confirmed closure for the fixed collector to reject", () => {
    mock.spawnSync.mockImplementation((_file, _args, options) => success(options, frames => {
      frames[4]!.payload.code = 7; frames.at(-1)!.payload.rootExitCode = 7;
    }));
    const result = startWindowsGuardianObserverSync(prepare(), input());
    expect(result.receipt.rootExitCode).toBe(7); expect(result.receipt.cleanupConfirmed).toBe(true);
  });
  it("rechecks immutable bytes when a synchronous installation audit reenters the fixed control relay", () => {
    let backend: PreparedWindowsProcessBackend | undefined;
    backend = prepare(() => {
      if (!backend) return;
      mock.files.set(`${mock.bundle}\\Host.exe`, Buffer.from("CHANGED BYTES"));
      invokeWindowsGuardianNativeSync(backend, "command", { controlled: true });
    });
    expect(() => startWindowsGuardianObserverSync(backend!, input())).toThrow(/qualification/);
    expect(mock.spawnSync).not.toHaveBeenCalled();
  });
  it("requires exactly one relay response and actual synchronous helper success", () => {
    const backend = prepare(), response = Buffer.from(JSON.stringify({ version: 1, kind: "guardian_result", payload: { accepted: true } }) + "\n");
    mock.spawnSync.mockReturnValue({ pid: 41, status: 0, signal: null, stdout: response, stderr: Buffer.alloc(0) });
    expect(invokeWindowsGuardianNativeSync(backend, "command", {})).toEqual({ accepted: true });
    mock.spawnSync.mockReturnValue({ pid: 41, status: 0, signal: null, stdout: Buffer.concat([response, response]), stderr: Buffer.alloc(0) });
    expect(() => invokeWindowsGuardianNativeSync(backend, "command", {})).toThrow(/framing/);
    mock.spawnSync.mockReturnValue({ pid: 41, status: null, signal: null, error: new Error("timeout"), stdout: response, stderr: Buffer.alloc(0) });
    expect(() => invokeWindowsGuardianNativeSync(backend, "command", {})).toThrow(/closure/);
  });
  it.each(["throw", "spawn", "timeout", "nonzero", "protocol", "output_limit", "null_status", "signal", "unknown_error"] as const)("classifies %s relay failure without accepting its response", fault => {
    const backend = prepare();
    const response = Buffer.from(JSON.stringify({ version: 1, kind: "guardian_result", payload: { accepted: true } }) + "\n");
    mock.spawnSync.mockReturnValue({ pid: fault === "spawn" ? 0 : 41,
      status: fault === "nonzero" ? 2 : fault === "timeout" || fault === "null_status" || fault === "signal" ? null : 0,
      signal: fault === "signal" ? "SIGTERM" : null, stdout: fault === "protocol" ? Buffer.from("private-response-not-json\n") : response,
      stderr: Buffer.from("private-stderr-never-projected"),
      ...(fault === "spawn" || fault === "timeout" || fault === "output_limit" || fault === "unknown_error"
        ? { error: Object.assign(new Error("private-process-error"), { code: fault === "timeout" ? "ETIMEDOUT" : fault === "output_limit" ? "ENOBUFS" : fault === "unknown_error" ? "EIO" : "ENOENT" }) } : {}) });
    if (fault === "throw") mock.spawnSync.mockImplementation(() => { throw new Error("private-spawn-detail"); });
    let error: unknown;
    try { invokeWindowsGuardianNativeSync(backend, "command", {}); } catch (caught) { error = caught; }
    const codes = { throw: "native_spawn_failed", spawn: "native_spawn_failed", timeout: "native_timeout", nonzero: "native_nonzero_exit",
      protocol: "native_protocol_failed", output_limit: "native_protocol_failed", null_status: "native_closure_unconfirmed",
      signal: "native_closure_unconfirmed", unknown_error: "native_closure_unconfirmed" };
    expect(error).toBeInstanceOf(Error); expect(readWindowsNativeFailureCode(error)).toBe(codes[fault]);
    expect(readWindowsNativeFailure(error)?.detail).toMatchObject({ helper_mode: "guardian_client_sync",
      helper_exit_code: fault === "throw" || fault === "timeout" || fault === "null_status" || fault === "signal" ? null : fault === "nonzero" ? 2 : 0,
      stderr_status: fault === "throw" ? "unavailable" : "rejected", native_diagnostics: [] });
    expect(JSON.stringify(readWindowsNativeFailure(error))).not.toContain("private-");
    expect(mock.spawnSync.mock.calls[0]![2]).toMatchObject({ timeout: 10000, maxBuffer: 131072, shell: false });
  });
  it("keeps fixed relay diagnostics on a nonzero helper without accepting success-looking stdout", () => {
    const backend = prepare(), native = { version: 1, phase: "guardian_response_read", code: "operation_cancelled", nativeError: null };
    mock.spawnSync.mockReturnValue({ pid: 41, status: 2, signal: null,
      stdout: Buffer.from(JSON.stringify({ version: 1, kind: "guardian_result", payload: { accepted: true } }) + "\n"),
      stderr: Buffer.from(JSON.stringify({ version: 1, kind: "native_failure_diagnostic", payload: native }) + "\n") });
    let error: unknown; try { invokeWindowsGuardianNativeSync(backend, "command", {}); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect(readWindowsNativeFailure(error)).toEqual({ code: "native_nonzero_exit", detail: {
      version: 1, helper_mode: "guardian_client_sync", helper_exit_code: 2, stderr_status: "accepted", native_diagnostics: [native] } });
  });
  it("retains observer identity and allowed closure facts when its native helper fails", () => {
    const native = { version: 1, phase: "guardian_response_binding", code: "guardian_request_rejected", nativeError: null };
    mock.spawnSync.mockImplementation((_file, _args, options) => ({ ...success(options), status: 2,
      stderr: Buffer.from(JSON.stringify({ version: 1, kind: "native_failure_diagnostic", payload: native }) + "\n") }));
    let error: unknown; try { startWindowsGuardianObserverSync(prepare(), input()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WindowsOwnedCleanupError);
    const detail = readWindowsNativeFailure(error)?.detail;
    expect(detail).toMatchObject({ helper_mode: "guardian_observer_sync", helper_exit_code: 2, stderr_status: "accepted",
      native_diagnostics: [native], observer: { helperExitCode: 2, cleanupConfirmed: false } });
    expect(JSON.stringify(detail)).not.toContain((error as WindowsOwnedCleanupError).receipt.token);
    expect((error as WindowsOwnedCleanupError).receipt.cleanupConfirmed).toBe(false);
  });
  it("retains a timed-out nested control cause across the installation qualification wrapper", () => {
    let backend: PreparedWindowsProcessBackend | undefined;
    backend = prepare(() => { if (backend) invokeWindowsGuardianNativeSync(backend, "command", { controlled: true }); });
    mock.spawnSync.mockReturnValue({ pid: 41, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      error: Object.assign(new Error("private-timeout-detail"), { code: "ETIMEDOUT" }) });
    let error: unknown;
    try { startWindowsGuardianObserverSync(backend!, input()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("lacks synchronous local installation qualification");
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(readWindowsNativeFailureCode((error as Error).cause)).toBe("native_timeout");
    expect(readWindowsNativeFailureCode(error)).toBe("native_timeout");
    expect(readWindowsNativeFailure(error)?.detail).toMatchObject({ helper_mode: "guardian_client_sync", helper_exit_code: null,
      stderr_status: "empty", native_diagnostics: [] });
    expect(mock.consume).not.toHaveBeenCalled(); expect(mock.spawnSync).toHaveBeenCalledTimes(1);
    expect(mock.spawnSync.mock.calls[0]![1]).toEqual(["--guardian-client-v1"]);
  });
  it("retains valid but unconfirmed native closure as failure instead of misclassifying it as protocol corruption", () => {
    mock.spawnSync.mockImplementation((_file, _args, options) => success(options, frames => { frames.at(-1)!.payload.cleanupConfirmed = false; }));
    let error: unknown;
    try { startWindowsGuardianObserverSync(prepare(), input()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WindowsOwnedCleanupError);
    expect((error as WindowsOwnedCleanupError).receipt.cleanupConfirmed).toBe(false);
    expect(readWindowsNativeFailureCode(error)).toBe("native_closure_unconfirmed");
  });
});
