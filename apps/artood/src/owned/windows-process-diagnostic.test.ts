import { describe, expect, it } from "vitest";
import { parseWindowsProcessDiagnostic, windowsProcessDiagnostic, withWindowsProcessDiagnostic } from "./windows-process-diagnostic.js";

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
