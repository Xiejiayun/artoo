/** Serializable diagnostics only. Shape validation never grants process or cleanup authority. */
export interface WindowsProcessDiagnosticV1 {
  readonly version: 1;
  readonly failureCode: string | null;
  readonly nativeError: number | null;
  readonly terminationReason: string | null;
  readonly nativeTerminationReason: string | null;
  readonly rootCreated: boolean;
  readonly rootStarted: boolean;
  readonly rootWaitObserved: boolean;
  readonly noTargetCreated: boolean;
  readonly stdoutEof: boolean;
  readonly stderrEof: boolean;
  readonly jobEmptyObserved: boolean;
  readonly helperSpawnObserved: boolean;
  readonly helperExitObserved: boolean;
  readonly helperCloseObserved: boolean;
  readonly helperExitCode: number | null;
  readonly helperSignal: string | null;
  readonly cleanupConfirmed: boolean;
}
const flags = ["rootCreated", "rootStarted", "rootWaitObserved", "noTargetCreated", "stdoutEof", "stderrEof", "jobEmptyObserved",
  "helperSpawnObserved", "helperExitObserved", "helperCloseObserved", "cleanupConfirmed"] as const;
const reasons = ["failureCode", "terminationReason", "nativeTerminationReason"] as const;
const codes = ["nativeError", "helperExitCode"] as const;
const keys = ["version", ...reasons, ...codes, "helperSignal", ...flags] as const;

/** Exact allowlist excludes argv, environment, paths, output and invocation tokens. */
export function parseWindowsProcessDiagnostic(input: unknown): WindowsProcessDiagnosticV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Windows process diagnostic");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !(keys as readonly string[]).includes(key))
    || value.version !== 1 || flags.some(key => typeof value[key] !== "boolean")
    || reasons.some(key => value[key] !== null && (typeof value[key] !== "string" || !/^[a-z_]{1,64}$/.test(value[key] as string)))
    || codes.some(key => value[key] !== null && (!Number.isSafeInteger(value[key])
      || (value[key] as number) < (key === "nativeError" ? 0 : -0x80000000) || (value[key] as number) > 0xffffffff))
    || value.helperSignal !== null && (typeof value.helperSignal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(value.helperSignal))) {
    throw new Error("Invalid Windows process diagnostic fields");
  }
  // An unconfirmed receipt can contain partial/conflicting observations after a
  // protocol failure. Preserve those facts; this parser never certifies closure.
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]]))) as unknown as WindowsProcessDiagnosticV1;
}

/** Project only the allowlisted fields from the bridge's receipt, never serialize the source object. */
export function windowsProcessDiagnostic(receipt: WindowsProcessDiagnosticV1): WindowsProcessDiagnosticV1 {
  return parseWindowsProcessDiagnostic(Object.fromEntries(keys.map(key => [key, receipt[key]])));
}

/** Preserve the failure category/message even if an optional diagnostic is malformed. */
export function withWindowsProcessDiagnostic(message: string, diagnostic: unknown): string {
  if (diagnostic === undefined) return message;
  try { return `${message} [windows_process_diagnostic.v1 ${JSON.stringify(parseWindowsProcessDiagnostic(diagnostic))}]`; }
  catch { return `${message} [Windows process diagnostic rejected]`; }
}

export function withWindowsProcessErrorDiagnostic(message: string, error: unknown): string {
  const diagnostic = error && typeof error === "object" && "diagnostic" in error ? error.diagnostic : undefined;
  return withWindowsProcessDiagnostic(message, diagnostic);
}
