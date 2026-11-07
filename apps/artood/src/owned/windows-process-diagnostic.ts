import { z } from "zod";

/** Serializable diagnostics only. Shape validation never grants process or cleanup authority. */
export const WINDOWS_NATIVE_FAILURE_CODES = Object.freeze(["native_spawn_failed", "native_timeout", "native_nonzero_exit",
  "native_protocol_failed", "native_qualification_failed", "native_closure_unconfirmed"] as const);
export type WindowsNativeFailureCode = typeof WINDOWS_NATIVE_FAILURE_CODES[number];
interface WindowsNativeFailure { readonly code: WindowsNativeFailureCode; readonly detail?: WindowsNativeFailureDetailV1 }
const nativeFailures = new WeakMap<Error, WindowsNativeFailure>();

/** Local failure tags only; copied fields and exception text cannot supply a category. */
export function markWindowsNativeFailure(error: Error, code: WindowsNativeFailureCode, detail?: WindowsNativeFailureDetailV1): Error {
  if (!(WINDOWS_NATIVE_FAILURE_CODES as readonly string[]).includes(code)) throw new Error("Invalid native failure category");
  if (!nativeFailures.has(error)) {
    let projected: WindowsNativeFailureDetailV1 | undefined;
    try { if (detail !== undefined) projected = WindowsNativeFailureDetailV1Schema.parse(detail); }
    catch { /* Invalid optional diagnostics cannot change the original failure. */ }
    nativeFailures.set(error, Object.freeze({ code, ...(projected ? { detail: projected } : {}) }));
  }
  return error;
}
/** Prefer a specific nested failure over its qualification wrapper, with a fixed traversal bound. */
export function readWindowsNativeFailure(error: unknown): WindowsNativeFailure | undefined {
  const seen = new Set<object>(); let failure: WindowsNativeFailure | undefined, current = error;
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (current === null || typeof current !== "object" && typeof current !== "function" || seen.has(current)) break;
      // Select one record: never combine a wrapper's detail with a deeper cause's code.
      seen.add(current); failure = nativeFailures.get(current as Error) ?? failure;
      // Unknown failures can be proxies or have accessors; never evaluate cause getters or prototypes.
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (!cause || !Object.hasOwn(cause, "value")) break;
      current = cause.value;
    }
  } catch { /* Diagnostics cannot replace the original failure, even for a revoked proxy. */ }
  return failure;
}
export function readWindowsNativeFailureCode(error: unknown): WindowsNativeFailureCode | undefined {
  return readWindowsNativeFailure(error)?.code;
}

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

// Match the fixed emitter in native/windows-process-host/NativeFailureDiagnostic.cs.
// Unknown future categories are rejected rather than copied as arbitrary strings.
const nativeDiagnosticPhases = [
  "guardian_bootstrap", "guardian_lifetime", "guardian_observe", "guardian_peer_open",
  "guardian_client_read", "guardian_request_handle", "guardian_client_reply",
  "guardian_relay_input", "guardian_relay_send", "guardian_relay_output",
  "guardian_connect", "guardian_server_identity", "guardian_request_write",
  "guardian_response_read", "guardian_response_binding", "supervisor_run",
  "supervisor_qualify", "supervisor_peer_open", "supervisor_query_read",
  "supervisor_query_qualify", "supervisor_query_reply", "unknown_phase",
] as const;
const nativeDiagnosticCodes = [
  "guardian_activation_binding", "guardian_attach_epoch", "guardian_attach_identity_changed",
  "guardian_attach_identity", "guardian_audit_bound", "guardian_bootstrap_parent",
  "guardian_bootstrap_supervisor", "guardian_bootstrap", "guardian_client_pid",
  "guardian_command_line_bound", "guardian_command_line_buffer", "guardian_command_line_missing",
  "guardian_command_line_parse", "guardian_command_line_query", "guardian_complete_transfer_frame_bound",
  "guardian_control_store_overlap", "guardian_directory_alias", "guardian_directory_final_path",
  "guardian_directory_handle", "guardian_directory_reparse", "guardian_endpoint", "guardian_enrollment",
  "guardian_exact_host", "guardian_exact_process_wait", "guardian_exact_server_identity",
  "guardian_exact_supervisor_required", "guardian_frame_limit", "guardian_image_query",
  "guardian_job_query", "guardian_local_directory_required", "guardian_lost", "guardian_parent_query",
  "guardian_peer_eof", "guardian_pipe_acl", "guardian_pipe_create", "guardian_process_open",
  "guardian_process_sid", "guardian_process_times", "guardian_process_token", "guardian_relay_image",
  "guardian_relay_parent", "guardian_relay_version", "guardian_request_rejected", "guardian_request",
  "guardian_reservation_binding", "guardian_root_epoch", "guardian_root_identity", "guardian_server_operation_binding",
  "guardian_server_pid", "guardian_slot_epoch", "guardian_terminal_ack_binding", "guardian_terminal_ack",
  "guardian_terminal_changed", "guardian_terminal_incomplete", "guardian_terminal_missing", "guardian_terminal_root",
  "guardian_terminal_unenrolled_root", "guardian_transfer_binding", "guardian_transfer_daemon_changed", "guardian_transfer_replay",
  "supervisor_attribute_size", "supervisor_attributes", "supervisor_client_pid", "supervisor_command_bound",
  "supervisor_control", "supervisor_created_handle_identity", "supervisor_daemon_create", "supervisor_daemon_resume",
  "supervisor_environment_duplicate", "supervisor_environment", "supervisor_exact_kernel_parent", "supervisor_file_acl_bound",
  "supervisor_file_acl_type", "supervisor_file_acl", "supervisor_file_alias", "supervisor_file_bytes_changed",
  "supervisor_file_external_writer", "supervisor_file_handle", "supervisor_file_identity_changed", "supervisor_file_owner",
  "supervisor_file_pin", "supervisor_file_reparse_or_links", "supervisor_fixed_launch", "supervisor_handle_list",
  "supervisor_input_bound", "supervisor_input_generation", "supervisor_input_queue", "supervisor_input_write",
  "supervisor_interrupt_generation", "supervisor_original_child_peer", "supervisor_original_current_daemon_handle",
  "supervisor_original_daemon_wait", "supervisor_original_launch_binding", "supervisor_pipe_acl", "supervisor_pipe_create",
  "supervisor_pipe_server_identity", "supervisor_pipe_server_pid", "supervisor_qualifier_mode", "supervisor_qualifier_parent",
  "supervisor_qualify_input", "supervisor_qualify_peer", "supervisor_restart_before_original_exit", "supervisor_stdio_create",
  "supervisor_stop_wait_unconfirmed", "supervisor_system_root", "supervisor_terminate_current", "empty_guardian_frame",
  "operation_cancelled", "timeout", "access_denied", "invalid_json", "win32_error", "io_error", "unexpected_error",
] as const;
const nativeDiagnosticPayload = z.object({ version: z.literal(1), phase: z.enum(nativeDiagnosticPhases), code: z.enum(nativeDiagnosticCodes),
  nativeError: z.number().int().min(0).max(65535).nullable() }).strict().readonly();
const nativeDiagnosticFrame = z.object({ version: z.literal(1), kind: z.literal("native_failure_diagnostic"),
  payload: nativeDiagnosticPayload }).strict();
export const WindowsNativeFailureDetailV1Schema = z.object({ version: z.literal(1),
  helper_mode: z.enum(["guardian_client_sync", "guardian_observer_sync"]),
  helper_exit_code: z.number().int().min(-0x80000000).max(0xffffffff).nullable(),
  stderr_status: z.enum(["empty", "accepted", "rejected", "unavailable"]),
  native_diagnostics: z.array(nativeDiagnosticPayload).max(4).readonly(),
  observer: z.unknown().transform((value, context) => {
    try { return parseWindowsProcessDiagnostic(value); }
    catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid observer diagnostic" }); return z.NEVER; }
  }).optional(),
}).strict().superRefine((value, context) => {
  if ((value.stderr_status === "accepted") !== (value.native_diagnostics.length > 0))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid native diagnostic status" });
  if (value.observer !== undefined && value.helper_mode !== "guardian_observer_sync")
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Observer facts require observer helper mode" });
}).readonly();
export type WindowsNativeFailureDetailV1 = z.infer<typeof WindowsNativeFailureDetailV1Schema>;

/** Safe projection only. Neither parsed rows nor an exit status certify helper/target closure. */
export function windowsNativeFailureDetail(helperMode: WindowsNativeFailureDetailV1["helper_mode"], exitCode: unknown, stderr: unknown,
  observer?: WindowsProcessDiagnosticV1): WindowsNativeFailureDetailV1 | undefined {
  try {
    let status: WindowsNativeFailureDetailV1["stderr_status"] = "unavailable";
    let rows: Array<z.infer<typeof nativeDiagnosticPayload>> = [];
    if (Buffer.isBuffer(stderr)) {
      status = stderr.length === 0 ? "empty" : "rejected";
      if (stderr.length > 0 && stderr.length <= 65536) try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stderr);
        if (!text.endsWith("\n")) throw new Error("Incomplete native diagnostic");
        const lines = text.slice(0, -1).split("\n");
        if (lines.length > 4) throw new Error("Native diagnostic count exceeded");
        rows = lines.map(line => nativeDiagnosticFrame.parse(JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line)).payload);
        status = "accepted";
      } catch { rows = []; /* Never salvage text or a partial subset of untrusted output. */ }
    }
    let projectedObserver: WindowsProcessDiagnosticV1 | undefined;
    try { if (observer !== undefined) projectedObserver = windowsProcessDiagnostic(observer); }
    catch { /* Preserve original failure even if its optional projection is unavailable. */ }
    return WindowsNativeFailureDetailV1Schema.parse({ version: 1, helper_mode: helperMode,
      helper_exit_code: Number.isSafeInteger(exitCode) && (exitCode as number) >= -0x80000000 && (exitCode as number) <= 0xffffffff ? exitCode : null,
      stderr_status: status, native_diagnostics: rows, ...(projectedObserver ? { observer: projectedObserver } : {}) });
  } catch { return undefined; /* Optional observations must never replace the original exception. */ }
}
