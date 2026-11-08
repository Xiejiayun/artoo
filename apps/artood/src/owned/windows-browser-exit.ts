import { execFile } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
import { WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT } from "./windows-browser-native-snapshot.js";

// This protected parser follows Windows backslash/quote argument rules. Matching an
// entire argument avoids treating a profile-looking string inside another value as ownership.
export const WINDOWS_BROWSER_ARGUMENT_PARSER = String.raw`
function Get-ArtooWindowsArguments([string]$line) {
  $values = [Collections.Generic.List[string]]::new()
  $position = 0
  while ($position -lt $line.Length) {
    while ($position -lt $line.Length -and [char]::IsWhiteSpace($line[$position])) { $position++ }
    if ($position -ge $line.Length) { break }
    $value = [Text.StringBuilder]::new()
    $quoted = $false
    while ($position -lt $line.Length) {
      $slashes = 0
      while ($position -lt $line.Length -and $line[$position] -eq [char]92) { $slashes++; $position++ }
      if ($slashes -gt 0) {
        $beforeQuote = $position -lt $line.Length -and $line[$position] -eq [char]34
        $literalSlashes = if ($beforeQuote) { [int][Math]::Floor($slashes / 2) } else { $slashes }
        for ($count = 0; $count -lt $literalSlashes; $count++) { [void]$value.Append([char]92) }
        if ($beforeQuote -and ($slashes % 2) -eq 1) { [void]$value.Append([char]34); $position++; continue }
      }
      if ($position -ge $line.Length) { break }
      if ($line[$position] -eq [char]34) {
        if ($quoted -and ($position + 1) -lt $line.Length -and $line[$position + 1] -eq [char]34) {
          [void]$value.Append([char]34); $position += 2
        } else { $quoted = !$quoted; $position++ }
        continue
      }
      if (!$quoted -and [char]::IsWhiteSpace($line[$position])) { break }
      [void]$value.Append($line[$position]); $position++
    }
    $values.Add($value.ToString())
  }
  $values.ToArray()
}
function Test-ArtooBrowserProfile([string]$line, [string]$profile) {
  if ([string]::IsNullOrWhiteSpace($line)) { throw 'ARTOO_BROWSER_OBSERVATION:command_line_unavailable' }
  $arguments = @(Get-ArtooWindowsArguments $line)
  $expected = '--user-data-dir=' + $profile
  return @($arguments | Where-Object { $_ -ieq $expected }).Count -gt 0
}
function ConvertTo-ArtooWqlLiteral([string]$value) {
  return "'" + $value.Replace('\', '\\').Replace("'", "\'") + "'"
}
`;

// Bounded observations, not a Windows Job Object or complete lifetime containment.
export const WINDOWS_BROWSER_OWNED_PROCESS_SNAPSHOT = WINDOWS_BROWSER_ARGUMENT_PARSER + WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
Write-ArtooObserverPhase 'definitions_ready'
$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REQUEST__'))
Write-ArtooObserverPhase 'request_decoded'
$request = ConvertFrom-Json $requestJson
Write-ArtooObserverPhase 'request_parsed'
$parentId = [uint32]$request.parent_pid
Write-ArtooObserverPhase 'native_binding'
$api = New-ArtooBrowserNativeApi
Write-ArtooObserverPhase 'root_handle'
$root = Open-ArtooProcessIdentity $api $parentId
try {
  Assert-ArtooProcessLive $api $root 'root_process_exited'
  Assert-ArtooRootImage $api $root ([string]$request.executable)
  # Keep the root HANDLE live across the slower exact query. Native snapshots and
  # selected descendant HANDLEs are collected only after the query has completed.
  Write-ArtooObserverPhase 'root_query'
  $identity = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $parentId.ToString([Globalization.CultureInfo]::InvariantCulture)) -Property ProcessId,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop)
  Write-ArtooObserverPhase 'root_identity'
  if ($identity.Count -ne 1 -or $identity[0].ProcessId -ne $parentId) { throw 'ARTOO_BROWSER_OBSERVATION:root_identity_missing_or_duplicate' }
  if ($null -eq $identity[0].CreationDate) { throw 'ARTOO_BROWSER_OBSERVATION:root_creation_missing' }
  if ($identity[0].ExecutablePath -ine [string]$request.executable) { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_mismatch' }
  if (!(Test-ArtooBrowserProfile ([string]$identity[0].CommandLine) ([string]$request.profile))) { throw 'ARTOO_BROWSER_OBSERVATION:root_profile_mismatch' }
  Assert-ArtooCimCreation $root $identity[0].CreationDate
  Assert-ArtooProcessLive $api $root 'root_process_exited'
  $owned = Get-ArtooOwnedIdentities $api $root
  $result = [pscustomobject]@{ parent_pid = $parentId; processes = @($owned.ToArray()) }
} finally {
  if (!(Close-ArtooProcessHandle $api $root.Handle)) { throw 'ARTOO_BROWSER_OBSERVATION:process_handle_close_failed' }
}
Write-ArtooObserverPhase 'observation_result'
ConvertTo-Json -Compress -Depth 3 -InputObject $result
`;
const FINAL_PROCESS_SNAPSHOT = WINDOWS_BROWSER_ARGUMENT_PARSER + String.raw`
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REQUEST__')))
# The root can already be gone. Only exact executable/profile matches leave this read-only inventory.
# WQL string literals escape backslashes and single quotes. The node supplies the protected physical path.
Write-ArtooObserverPhase 'final_query'
$inventory = @(Get-CimInstance Win32_Process -Filter ('ExecutablePath = ' + (ConvertTo-ArtooWqlLiteral ([string]$request.executable))) -Property ProcessId,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop)
Write-ArtooObserverPhase 'final_identity'
$owned = [Collections.Generic.List[object]]::new()
foreach ($item in $inventory) {
  if ($item.ExecutablePath -ine [string]$request.executable -or !(Test-ArtooBrowserProfile ([string]$item.CommandLine) ([string]$request.profile))) { continue }
  if ($owned.Count -ge 128) { throw 'ARTOO_BROWSER_OBSERVATION:final_observation_bound_exceeded' }
  if ($null -eq $item.CreationDate) { throw 'ARTOO_BROWSER_OBSERVATION:final_creation_missing' }
  $owned.Add([pscustomobject]@{ pid = [int]$item.ProcessId; created_utc = $item.CreationDate.ToUniversalTime().ToString('o') })
}
ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ processes = @($owned.ToArray()) })
`;
const execFileAsync = promisify(execFile);
const observationFailureCodes = new Set(["command_line_unavailable", "root_missing_or_duplicate", "root_executable_mismatch", "root_creation_missing",
  "root_profile_mismatch", "root_identity_missing_or_duplicate", "root_creation_changed", "ancestry_cycle", "observation_bound_exceeded", "process_creation_missing", "descendant_creation_missing",
  "descendant_precedes_parent", "final_observation_bound_exceeded", "final_creation_missing", "os_query_failed", "native_binding_failed", "native_pointer_width_unsupported",
  "snapshot_create_failed", "snapshot_first_failed", "snapshot_next_failed", "snapshot_duplicate_pid", "snapshot_bound_exceeded", "snapshot_close_failed",
  "process_open_failed", "process_open_access_denied", "process_open_invalid_parameter", "process_open_invalid_handle", "process_open_resource_unavailable", "process_open_other_error",
  "historical_pid_reappeared", "historical_identity_unknown", "historical_creation_changed", "ancestry_parent_changed", "observer_retry_exhausted",
  "process_identity_failed", "process_wait_failed", "process_handle_close_failed", "root_executable_read_failed",
  "root_process_exited", "selected_process_exited", "ancestry_changed", "observer_input_failed", "observer_process_failed", "observer_output_invalid",
  "observer_protocol_failed", "observer_parent_eof", "observer_cleanup_failed", "observer_cleanup_unconfirmed", "observer_cancelled", "observer_deadline"]);

/** Only this closed diagnostic vocabulary may escape the protected observer. */
export function windowsObservationFailureCode(stdout: unknown): string | undefined {
  if (typeof stdout !== "string" || stdout.length > 256) return;
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value === "object" && value !== null && Object.keys(value).length === 1 && "error_code" in value
      && typeof value.error_code === "string" && observationFailureCodes.has(value.error_code)) return value.error_code;
  } catch { /* Raw process output, paths and command lines never become diagnostics. */ }
}

function safeObservationReason(error: unknown): string {
  if (error instanceof WindowsProcessObservationError) return `${error.code}@${error.phase}`;
  if (error instanceof WindowsBrowserSessionObservationError) return `${error.code}@${error.phase}`;
  const message = error instanceof Error ? error.message : "";
  const match = /^Protected Windows process observation failed \(([a-z_]+)\)$/.exec(message);
  return match && (match[1] === "deadline" || observationFailureCodes.has(match[1]!)) ? match[1]! : "unavailable";
}

const observationPhases = new Set(["process_start", "script_started", "definitions_ready", "request_decoded", "request_parsed", "native_binding", "root_handle", "root_query", "root_identity",
  "ancestry_snapshot", "ancestry_identities", "ancestry_confirmation", "final_query", "final_identity", "observation_result"]);

/** Trusted in-process diagnostics; arbitrary error.message strings cannot grant this classification. */
export class WindowsBrowserSessionObservationError extends Error {
  readonly #initialExitHistory?: Readonly<{ parentPid: number; pids: readonly number[] }>;
  constructor(readonly code: string, readonly phase: string, initialExitHistory?: { parentPid: number; pids: readonly number[] }) {
    if (!observationFailureCodes.has(code) || !observationPhases.has(phase)) throw new Error("Invalid protected observer diagnostic");
    super(`Protected Windows browser session failed (${code}) [last_phase=${phase}]`);
    if (initialExitHistory !== undefined) {
      const { parentPid, pids } = initialExitHistory;
      if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0xffffffff || !Array.isArray(pids)
        || pids.length > 127 || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || pid === parentPid)
        || new Set(pids).size !== pids.length) throw new Error("Invalid protected observer exit history");
      this.#initialExitHistory = Object.freeze({ parentPid, pids: Object.freeze([...pids]) });
    }
  }
  /** Negative evidence only. A matching root does not recover the failed observation. */
  static cleanupOnlyHistory(error: unknown, parentPid: number): readonly number[] | undefined {
    if (!(error instanceof WindowsBrowserSessionObservationError) || !(#initialExitHistory in error)) return;
    const history = error.#initialExitHistory;
    return history?.parentPid === parentPid ? history.pids : undefined;
  }
}

/** Fixed diagnostics only; neither a phase marker nor a timeout authorizes cleanup. */
export function windowsObservationPhase(line: string): string | undefined {
  if (line.length > 100) return;
  const match = /^ARTOO_BROWSER_PHASE\|([a-z_]+)$/.exec(line);
  return match && match[0] === line && observationPhases.has(match[1]!) ? match[1] : undefined;
}

class WindowsProcessObservationError extends Error {
  constructor(readonly code: string, readonly phase: string, readonly elapsedMs: number, phaseReceivedMs: ReadonlyMap<string, number>) {
    super(`Protected Windows process observation failed (${code}) [last_phase=${phase}, elapsed_ms=${elapsedMs}, phase_received_ms=${[...phaseReceivedMs].map(([label, elapsed]) => `${label}:${elapsed}`).join(";") || "none"}]`);
  }
}

async function processSnapshot(script: string, request: object, timeoutMs: number): Promise<{ parent_pid?: unknown; processes?: unknown }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Invalid Windows observation deadline");
  const source = String.raw`
function Write-ArtooObserverPhase([string]$phase) { [Console]::Error.WriteLine('ARTOO_BROWSER_PHASE|' + $phase) }
Write-ArtooObserverPhase 'script_started'
try {
` + script.replace("__REQUEST__", Buffer.from(JSON.stringify(request), "utf8").toString("base64")) + String.raw`
} catch {
  $code = 'os_query_failed'
  $failure = $_.Exception
  for ($depth = 0; $depth -lt 4 -and $null -ne $failure.InnerException; $depth++) { $failure = $failure.InnerException }
  if ($failure.Message -cmatch '^ARTOO_BROWSER_OBSERVATION:([a-z_]+)$') { $code = $Matches[1] }
  ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ error_code = $code })
  exit 1
}
`;
  // The larger fixed interop script must not exceed CreateProcess's command-line
  // bound. Its private stdin pipe replaces argv transport; no caller supplies script.
  const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  let phase = "process_start", stageBuffer = "", stdout: string;
  // First receipts of fixed labels keep diagnostics bounded. Pipe delivery and
  // event-loop scheduling can coalesce receipts; these are not OS/API durations.
  const phaseReceivedMs = new Map<string, number>();
  const started = performance.now();
  try {
    const pending = execFileAsync(join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
      { windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" });
    const observer = pending.child;
    observer.stderr?.on("data", (data: Buffer) => {
      stageBuffer += data.toString("utf8");
      if (stageBuffer.length > 4096) { stageBuffer = ""; return; }
      const lines = stageBuffer.split(/\r?\n/); stageBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const observed = windowsObservationPhase(line);
        if (observed) {
          phase = observed;
          if (!phaseReceivedMs.has(observed)) phaseReceivedMs.set(observed, Math.ceil(performance.now() - started));
        }
      }
    });
    const inputClosed = observer.stdin ? finished(observer.stdin, { cleanup: true }) : Promise.reject(new Error("Missing observer input pipe"));
    void inputClosed.catch(() => {});
    let inputWriteFailed = false;
    try { observer.stdin?.end(source, "utf8"); }
    catch { inputWriteFailed = true; observer.stdin?.destroy(); }
    // Always observe actual execFile completion before reporting a pipe failure.
    // No additional process is spawned, and the same original timeout covers both.
    const execution = await pending.then(result => ({ result }), error => ({ error }));
    const input = await inputClosed.then(() => ({ ok: true }), () => ({ ok: false }));
    if ("error" in execution) throw execution.error;
    if (!input.ok || inputWriteFailed) throw new WindowsProcessObservationError("observer_input_failed", phase, Math.ceil(performance.now() - started), phaseReceivedMs);
    stdout = execution.result.stdout;
  } catch (error) {
    if (error instanceof WindowsProcessObservationError) throw error;
    // Discard raw argv/stdout/stderr and nested native/PowerShell errors.
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: unknown };
    const code = failure.killed ? "deadline" : windowsObservationFailureCode(failure.stdout) ?? "observer_process_failed";
    throw new WindowsProcessObservationError(code, phase, Math.ceil(performance.now() - started), phaseReceivedMs);
  }
  try { return JSON.parse(stdout.trim()) as { parent_pid?: unknown; processes?: unknown }; }
  catch { throw new WindowsProcessObservationError("observer_output_invalid", phase, Math.ceil(performance.now() - started), phaseReceivedMs); }
}

function processIds(value: unknown, allowEmpty: boolean): number[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 128) throw new Error("Invalid owned Windows browser process observation");
  const ids = value.map((record: unknown) => {
    if (typeof record !== "object" || record === null || !("pid" in record) || !("created_utc" in record)
      || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.created_utc !== "string"
      || !Number.isFinite(Date.parse(record.created_utc))) throw new Error("Invalid owned Windows process identity");
    return record.pid as number;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Ambiguous owned Windows browser process observation");
  return ids;
}

/** Protected root identity and creation-time ancestry; returned PIDs are observation-only. */
export async function snapshotOwnedWindowsProcesses(parentPid: number, executable: string, profile: string): Promise<number[]> {
  const result = await processSnapshot(WINDOWS_BROWSER_OWNED_PROCESS_SNAPSHOT, { parent_pid: parentPid, executable, profile }, 5000);
  const ids = processIds(result.processes, false);
  if (result.parent_pid !== parentPid || !ids.includes(parentPid)) throw new Error("Ambiguous owned Windows browser process observation");
  return ids;
}

/** Late matching helpers are observations only; their IDs never become termination targets. */
export async function auditWindowsBrowserProcesses(executable: string, profile: string, remainingMs: number): Promise<number[]> {
  return processIds((await processSnapshot(FINAL_PROCESS_SNAPSHOT, { executable, profile }, remainingMs)).processes, true);
}

interface OwnedWindowsExit {
  parentPid: number;
  /** Obtained only by protected code from this browser's OS/CDP observation. */
  observe(): Promise<readonly number[]>;
  /** CDP Browser.close, never Playwright's disconnect-only close. */
  requestGracefulClose?(remainingMs: number): Promise<void>;
  /** The direct ChildProcess is the only termination target; receives no helper IDs. */
  terminateParent(remainingMs: number): Promise<void>;
  /** Finish the client connection before the last OS audit, within the confirmation deadline. */
  closeConnection?(remainingMs: number): Promise<void>;
  /** Exact protected executable/profile matches; the original parent may already be gone. */
  finalAudit(remainingMs: number): Promise<readonly number[]>;
  /** True only after the directly spawned ChildProcess emits close. */
  parentClosed(): boolean;
}

/** Internal process primitives for deterministic regression; never wired to task/config input. */
interface ExitPrimitives {
  probe(pid: number): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  connectionTimeoutMs: number;
  confirmationTimeoutMs: number;
  auditTimeoutMs: number;
  terminationTimeoutMs?: number;
}
const realPrimitives: ExitPrimitives = {
  probe(pid) { process.kill(pid, 0); },
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  connectionTimeoutMs: 3000,
  // Both the original process HANDLE and Chromium helpers can remain terminating
  // after their PIDs disappear. Share one fixed confirmation window; actual parent
  // close, every observed ESRCH, and the final OS audit are still all required.
  confirmationTimeoutMs: 20000,
  auditTimeoutMs: 5000,
};

export interface ObservedWindowsExitResult {
  observedProcessCount: number;
  /** Kept for trusted diagnostics even when actual exit independently confirms success. */
  terminationError?: unknown;
  gracefulError?: unknown;
}

/** Process facts authorize profile cleanup; command status and localized prose never do. */
export async function closeObservedWindowsProcesses(owned: OwnedWindowsExit, primitives: ExitPrimitives = realPrimitives): Promise<ObservedWindowsExitResult> {
  if (!Number.isSafeInteger(owned.parentPid) || owned.parentPid < 1) throw new Error("Invalid owned Windows parent PID");
  let observedIds: number[] | undefined;
  const cleanupOnlyIds = new Set<number>();
  let observationFailure: { error: unknown } | undefined, terminationFailure: { error: unknown } | undefined, gracefulFailure: { error: unknown } | undefined;
  const bounded = async (operation: (remainingMs: number) => Promise<unknown>, remainingMs: number, label: string) => {
    const duration = Math.floor(remainingMs);
    if (duration < 1) throw new Error(`${label} deadline elapsed`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(() => operation(duration)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
    })]); } finally { clearTimeout(timer); }
  };
  try {
    const ids = await owned.observe();
    if (!Array.isArray(ids) || !ids.length || ids.length > 256 || !ids.includes(owned.parentPid)
      || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
      throw new Error("Incomplete or invalid owned Windows process observation");
    }
    observedIds = [...ids];
  } catch (error) {
    observationFailure = { error };
    for (const pid of WindowsBrowserSessionObservationError.cleanupOnlyHistory(error, owned.parentPid) ?? []) cleanupOnlyIds.add(pid);
  }
  // Graceful shutdown lets Chromium stop helpers created during close. Both paths
  // share the former termination budget; a successful command is still not exit evidence.
  const terminationBudget = primitives.terminationTimeoutMs ?? 3000, terminationDeadline = primitives.now() + terminationBudget;
  if (observedIds && owned.requestGracefulClose) {
    try { await bounded(owned.requestGracefulClose, Math.min(1000, Math.floor(terminationBudget / 3)), "Graceful browser close"); }
    catch (error) { gracefulFailure = { error }; }
  }
  // Even unavailable observation must attempt to stop only the directly owned parent.
  if (!observedIds || !owned.requestGracefulClose || !owned.parentClosed()) {
    try { await bounded(owned.terminateParent, terminationDeadline - primitives.now(), "Browser parent termination"); }
    catch (error) { terminationFailure = { error }; }
  }
  let confirmationFailure: { error: unknown } | undefined, confirmationPhase = "exit_confirmation";
  let lastPresent: number[] = [];
  try {
    const confirmationStarted = primitives.now();
    let deadline = confirmationStarted + primitives.confirmationTimeoutMs, auditStarted = false;
    if (owned.closeConnection) await bounded(owned.closeConnection,
      Math.min(primitives.connectionTimeoutMs, deadline - primitives.now()), "Browser client disconnect");
    const probe = () => {
      lastPresent = [];
      // Failed initial history is deliberately separate from successful observations:
      // it can block cleanup, but cannot enable graceful success or profile deletion.
      for (const pid of new Set([...(observedIds ?? [owned.parentPid]), ...cleanupOnlyIds])) {
        try { primitives.probe(pid); lastPresent.push(pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      return owned.parentClosed() && lastPresent.length === 0;
    };
    while (true) {
      if (primitives.now() >= deadline) throw new Error("Owned browser parent or observed helpers have not confirmed exit");
      if (probe()) {
        // Waiting for close/PID disappearance must not consume the OS query budget.
        // A PowerShell/CIM audit can take over two seconds; a late helper
        // requires a second exact audit. Start this bounded phase only once, after
        // timely exit confirmation, so helpers and repeated audits cannot renew it.
        if (!auditStarted) {
          if (primitives.now() >= deadline) throw new Error("Owned browser exit confirmation exceeded its deadline");
          deadline = primitives.now() + primitives.auditTimeoutMs;
          auditStarted = true; confirmationPhase = "final_audit";
        }
        let finalIds: readonly number[] | undefined;
        await bounded(async remaining => { finalIds = await owned.finalAudit(remaining); }, deadline - primitives.now(), "Final browser process audit");
        if (primitives.now() >= deadline) throw new Error("Final browser process audit exceeded the confirmation deadline");
        if (!Array.isArray(finalIds) || finalIds.length > 128 || finalIds.some(id => !Number.isSafeInteger(id) || id < 1)
          || new Set(finalIds).size !== finalIds.length) throw new Error("Invalid final browser process observation");
        if (observedIds) {
          observedIds = [...new Set([...observedIds, ...finalIds])];
          if (observedIds.length > 256) throw new Error("Owned browser process observation exceeds its bound");
        }
        // The audit awaited OS I/O. Recheck original and newly observed PIDs synchronously
        // before authorizing deletion, including conservative rejection after PID reuse.
        if (finalIds.length === 0 && probe()) {
          if (primitives.now() >= deadline) throw new Error("Final browser exit confirmation exceeded its deadline");
          break;
        }
      }
      await primitives.sleep(Math.min(25, Math.max(0, deadline - primitives.now())));
    }
  } catch (error) { confirmationFailure = { error }; }
  if (!observedIds || observationFailure || confirmationFailure) {
    throw new AggregateError([observationFailure, terminationFailure, confirmationFailure].flatMap((failure) => failure ? [failure.error] : []),
      `Windows browser process exit remains unconfirmed; its profile is retained (parent=${owned.parentPid}, closed=${owned.parentClosed()}, present=${lastPresent.join(",")}; failures=${[observationFailure ? "initial_observation:" + safeObservationReason(observationFailure.error) : undefined, confirmationFailure ? confirmationPhase : undefined].filter(Boolean).join(",")})`);
  }
  return { observedProcessCount: observedIds.length, ...(terminationFailure ? { terminationError: terminationFailure.error } : {}),
    ...(gracefulFailure ? { gracefulError: gracefulFailure.error } : {}) };
}
