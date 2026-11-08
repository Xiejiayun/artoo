import { describe, expect, it } from "vitest";
import { parseWindowsProcessDiagnostic, windowsProcessDiagnostic, withWindowsProcessDiagnostic, windowsNativeFailureDetail,
  WindowsNativeFailureDetailV1Schema, markWindowsNativeFailure, readWindowsNativeFailure } from "./windows-process-diagnostic.js";

const fixture = () => ({ version: 1 as const, failureCode: "create_process", nativeError: 5, terminationReason: "create_process",
  nativeTerminationReason: "create_process", rootCreated: false, rootStarted: false, rootWaitObserved: false, noTargetCreated: true,
  stdoutEof: true, stderrEof: true, jobEmptyObserved: true, helperSpawnObserved: true, helperExitObserved: true,
  helperCloseObserved: true, helperExitCode: 0, helperSignal: null, cleanupConfirmed: true });

describe("Windows process diagnostic shape, never execution authority", () => {
  it("projects an immutable allowlist without argv, environment, paths or invocation token", () => {
    const diagnostic = windowsProcessDiagnostic({ ...fixture(), args: ["controlled-private-argument"], env: { KEY: "controlled-private-value" },
      token: "controlled-token", cwd: "C:/controlled-private-path" } as ReturnType<typeof fixture>);
    expect(diagnostic).toEqual(fixture()); expect(Object.isFrozen(diagnostic)).toBe(true);
    const text = withWindowsProcessDiagnostic("Windows target did not start", diagnostic);
    expect(text).toContain('"nativeError":5'); expect(text).not.toContain("controlled-");
  });
  it.each([
    { version: 2 }, { nativeError: "controlled-private-value" }, { nativeError: -1 }, { nativeError: 0x100000000 },
    { failureCode: "create_process controlled-private-value" }, { helperSignal: "not-a-signal" }, { cleanupConfirmed: "true" },
    { env: { KEY: "controlled-private-value" } },
  ])("rejects malformed or extended diagnostics without exposing their contents", change => {
    const input = { ...fixture(), ...change };
    expect(() => parseWindowsProcessDiagnostic(input)).toThrow("Invalid Windows process diagnostic");
    expect(withWindowsProcessDiagnostic("Original failure", input)).toBe("Original failure [Windows process diagnostic rejected]");
  });
  it("preserves partial unknown observations without turning them into confirmed closure", () => {
    const diagnostic = parseWindowsProcessDiagnostic({ ...fixture(), rootCreated: false, rootWaitObserved: true,
      noTargetCreated: false, helperCloseObserved: false, cleanupConfirmed: false });
    expect(diagnostic).toMatchObject({ rootWaitObserved: true, noTargetCreated: false, cleanupConfirmed: false });
    expect(withWindowsProcessDiagnostic("Synchronous admission failure", undefined)).toBe("Synchronous admission failure");
  });
});

const nativeFrame = (payload: Record<string, unknown> = {}, frame: Record<string, unknown> = {}) => ({
  version: 1, kind: "native_failure_diagnostic", payload: { version: 1, phase: "guardian_response_read",
    code: "operation_cancelled", nativeError: null, ...payload }, ...frame,
});
const nativeLine = (payload: Record<string, unknown> = {}, frame: Record<string, unknown> = {}) => JSON.stringify(nativeFrame(payload, frame)) + "\n";

describe("bounded native helper failure observations", () => {
  it("retains only fixed native rows and an actual helper exit, with CRLF support", () => {
    const bytes = Buffer.from(nativeLine().replace(/\n$/, "\r\n") + nativeLine({ phase: "guardian_relay_send", code: "io_error", nativeError: 109 }));
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, bytes)!;
    expect(detail).toEqual({ version: 1, helper_mode: "guardian_client_sync", helper_exit_code: 2, stderr_status: "accepted",
      native_diagnostics: [nativeFrame().payload, nativeFrame({ phase: "guardian_relay_send", code: "io_error", nativeError: 109 }).payload] });
    expect(Object.isFrozen(detail)).toBe(true); expect(Object.isFrozen(detail.native_diagnostics)).toBe(true);
    expect(detail.native_diagnostics.every(Object.isFrozen)).toBe(true);
    expect(windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(nativeLine().repeat(4)))?.native_diagnostics).toHaveLength(4);
  });
  it.each([
    Buffer.from(nativeLine({ phase: "private_secret" })), Buffer.from(nativeLine({ code: "private_secret" })),
    Buffer.from(nativeLine({ path: "private_secret" })), Buffer.from(nativeLine({}, { env: "private_secret" })),
    Buffer.from(nativeLine({ version: 2 })), Buffer.from(nativeLine({ nativeError: -1 })), Buffer.from(nativeLine({ nativeError: 65536 })),
    Buffer.from(nativeLine({}, { kind: "private_secret" })), Buffer.from(nativeLine({}, { version: 2 })),
    Buffer.from(nativeLine().slice(0, -1)), Buffer.from(nativeLine() + "private_secret\n"), Buffer.from(nativeLine().repeat(5)),
    Buffer.from("private_secret\n"), Buffer.from([0xff, 0x0a]), Buffer.alloc(65537, 120),
  ])("rejects malformed, mixed, unbounded or non-allowlisted stderr without copying it", bytes => {
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, bytes)!;
    expect(detail).toMatchObject({ helper_exit_code: 2, stderr_status: "rejected", native_diagnostics: [] });
    expect(JSON.stringify(detail)).not.toContain("private_secret");
  });
  it("distinguishes empty from unavailable observations without inventing an exit or cleanup", () => {
    expect(windowsNativeFailureDetail("guardian_client_sync", null, undefined)).toEqual({ version: 1,
      helper_mode: "guardian_client_sync", helper_exit_code: null, stderr_status: "unavailable", native_diagnostics: [] });
    expect(windowsNativeFailureDetail("guardian_client_sync", undefined, Buffer.alloc(0))).toMatchObject({
      helper_exit_code: null, stderr_status: "empty", native_diagnostics: [] });
    expect(windowsNativeFailureDetail("guardian_client_sync", "private_secret", "private_secret")).toMatchObject({
      helper_exit_code: null, stderr_status: "unavailable", native_diagnostics: [] });
  });
  it("projects observer receipt fields without process identity, control or output", () => {
    const receipt = { ...fixture(), token: "private_secret", rootPid: 4321, rootCreationTime: "private_secret",
      stdout: "private_secret", stderr: "private_secret", env: "private_secret", args: ["private_secret"] };
    const detail = windowsNativeFailureDetail("guardian_observer_sync", 2, Buffer.alloc(0), receipt)!;
    expect(detail.observer).toEqual(fixture()); expect(Object.isFrozen(detail.observer)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("private_secret"); expect(detail).not.toHaveProperty("cleanupConfirmed");
    for (const change of [{ helper_mode: "private_secret" }, { helper_exit_code: 0x100000000 }, { stdout: "private_secret" },
      { helper_mode: "guardian_client_sync" }, { stderr_status: "accepted" }, { native_diagnostics: [nativeFrame().payload] }])
      expect(WindowsNativeFailureDetailV1Schema.safeParse({ ...detail, ...change }).success).toBe(false);
  });
  it("selects a code/detail pair from the same original locally tagged cause", () => {
    const relay = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(nativeLine()))!;
    const observer = windowsNativeFailureDetail("guardian_observer_sync", 3, Buffer.alloc(0), fixture())!;
    const leaf = markWindowsNativeFailure(new Error("private_secret"), "native_nonzero_exit", relay);
    const wrapper = markWindowsNativeFailure(new Error("private_wrapper", { cause: leaf }), "native_qualification_failed", observer);
    expect(readWindowsNativeFailure(wrapper)).toEqual({ code: "native_nonzero_exit", detail: relay });
    markWindowsNativeFailure(leaf, "native_timeout", observer);
    expect(readWindowsNativeFailure(leaf)).toEqual({ code: "native_nonzero_exit", detail: relay });
    const leafWithoutDetail = markWindowsNativeFailure(new Error("private_leaf"), "native_timeout");
    const outer = markWindowsNativeFailure(new Error("private_wrapper", { cause: leafWithoutDetail }), "native_qualification_failed", observer);
    expect(readWindowsNativeFailure(outer)).toEqual({ code: "native_timeout" });
    const copied = Object.assign(new Error("private_secret"), { native_failure_code: "native_nonzero_exit", native_failure_detail: relay });
    expect(readWindowsNativeFailure(copied)).toBeUndefined();
    Object.defineProperty(leaf, "cause", { value: leaf }); expect(readWindowsNativeFailure(leaf)?.detail).toEqual(relay);
  });
  it("never replaces the original error with malformed optional detail", () => {
    const original = new Error("private_secret"), detail = { env: "private_secret" };
    expect(markWindowsNativeFailure(original, "native_timeout", detail as never)).toBe(original);
    expect(readWindowsNativeFailure(original)).toEqual({ code: "native_timeout" });
    expect(windowsNativeFailureDetail("private_secret" as never, 2, Buffer.alloc(0))).toBeUndefined();
  });
});
