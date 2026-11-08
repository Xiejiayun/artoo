import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_BROWSER_SESSION_SCRIPT } from "./windows-browser-session-script.js";

const session = "11111111-2222-4333-8444-555555555555";
const otherSession = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const executable = "C:\\Protected\\chrome.exe", profile = "C:\\Private\\browser-profile";
const frame = (seq: number, operation: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, session, seq, operation, ...extra });
const configure = frame(0, "configure", { executable, profile });
const bind = frame(1, "bind", { parent_pid: 101 });
const initial = frame(2, "initial");
const final = (seq = 3) => frame(seq, "final");
const definitions = WINDOWS_BROWSER_SESSION_SCRIPT.replace("\nexit (Invoke-ArtooBrowserObserverSession)\n", "\n");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
function powershell(script: string): unknown {
  const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  const output = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
    { input: script, windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf8" });
  return JSON.parse(output.trim());
}

interface ControlledCase {
  name: string;
  frames: string[];
  expectedOperations: string[];
  expectedExit: 0 | 1;
  expectedError?: string;
  expectedRootCloses: number;
  expectedIdentityChecks: number;
  expectedSnapshots: number;
  expectedInitialErrorHistory?: number[];
  historyPids?: number[];
  finalPids?: number[][];
  nativeFailure?: boolean;
  providerFailure?: boolean;
  openFailure?: boolean;
  identityFailureAt?: number;
  snapshotFailure?: boolean;
  finalFailure?: boolean;
  closeFailure?: boolean;
  writeFailure?: boolean;
  initialWriteFailure?: boolean;
  ancestryFailure?: Record<string, unknown>;
  ancestryError?: boolean;
  expectedAncestryFailure?: boolean;
}

describe.runIf(process.platform === "win32")("protected persistent Windows browser script", () => {
  it("keeps one root handle through the strict protocol and releases it on every terminal path", () => {
    const success: ControlledCase = { name: "empty final closes before its response", frames: [configure, bind, initial, final()],
      expectedOperations: ["ready:ok", "bind:ok", "initial:ok", "final:ok"], expectedExit: 0,
      expectedRootCloses: 1, expectedIdentityChecks: 2, expectedSnapshots: 1 };
    const beforeBind: ControlledCase = { name: "EOF before bind", frames: [configure],
      expectedOperations: ["ready:ok", "bind:error"], expectedExit: 1, expectedError: "observer_parent_eof",
      expectedRootCloses: 0, expectedIdentityChecks: 0, expectedSnapshots: 0 };
    const afterBind: ControlledCase = { name: "EOF before initial", frames: [configure, bind],
      expectedOperations: ["ready:ok", "bind:ok", "initial:error"], expectedExit: 1, expectedError: "observer_parent_eof",
      expectedRootCloses: 1, expectedIdentityChecks: 1, expectedSnapshots: 0 };
    const afterInitial: ControlledCase = { name: "EOF before final", frames: [configure, bind, initial],
      expectedOperations: ["ready:ok", "bind:ok", "initial:ok", "final:error"], expectedExit: 1, expectedError: "observer_parent_eof",
      expectedRootCloses: 1, expectedIdentityChecks: 2, expectedSnapshots: 1 };
    const ancestryFailure = { version: 1, attempt: 1, census: "first", root_pid: 101, parent_pid: 101, child_pid: 202,
      root_filetime: "134383440000000009", parent_filetime: "134383440000000009", child_filetime: "134383440000000008",
      root_type: "System.Int64", parent_type: "System.Int64", child_type: "System.Int64", delta_ticks: "-1" };
    const cases: ControlledCase[] = [
      success,
      { ...afterBind, name: "creation-order rejection includes only its bounded negative evidence", frames: [configure, bind, initial],
        ancestryFailure, ancestryError: true, historyPids: [202], expectedIdentityChecks: 2, expectedSnapshots: 1,
        expectedError: "descendant_precedes_parent", expectedInitialErrorHistory: [202], expectedAncestryFailure: true },
      { ...afterBind, name: "cleanup failure supersedes a recorded creation-order rejection", frames: [configure, bind, initial],
        ancestryFailure, ancestryError: true, closeFailure: true, historyPids: [202], expectedIdentityChecks: 2, expectedSnapshots: 1,
        expectedError: "observer_cleanup_failed", expectedInitialErrorHistory: [202] },
      { ...success, name: "negative evidence cannot appear on successful initial or final frames", ancestryFailure, historyPids: [202] },
      { ...success, name: "history stays separate from current process creation identities", historyPids: [202, 303] },
      { ...success, name: "a nonempty final permits exactly the next final", frames: [configure, bind, initial, final(), final(4)],
        finalPids: [[303], []], expectedOperations: ["ready:ok", "bind:ok", "initial:ok", "final:ok", "final:ok"] },
      beforeBind, afterBind, afterInitial,
      { ...beforeBind, name: "final cannot replace bind", frames: [configure, frame(1, "final")], expectedError: "observer_protocol_failed" },
      { ...afterBind, name: "bind replay cannot replace initial", frames: [configure, bind, bind], expectedError: "observer_protocol_failed" },
      { ...afterInitial, name: "initial cannot repeat", frames: [configure, bind, initial, frame(3, "initial")], expectedError: "observer_protocol_failed" },
      { ...afterInitial, name: "a final sequence cannot skip", frames: [configure, bind, initial, final(4)], expectedError: "observer_protocol_failed" },
      { ...afterInitial, name: "a final sequence cannot replay", frames: [configure, bind, initial, final(), final()], finalPids: [[303]],
        expectedOperations: ["ready:ok", "bind:ok", "initial:ok", "final:ok", "final:error"], expectedError: "observer_protocol_failed" },
      { ...afterBind, name: "wrong session cannot inherit root binding", frames: [configure, bind, frame(2, "initial", { session: otherSession })], expectedError: "observer_protocol_failed" },
      { ...afterBind, name: "unknown request field rejects", frames: [configure, bind, frame(2, "initial", { pid: 101 })], expectedError: "observer_protocol_failed" },
      { ...afterBind, name: "duplicate request key rejects before JSON folding", frames: [configure, bind, initial.replace('"seq":2', '"seq":2,"seq":2')], expectedError: "observer_protocol_failed" },
      { ...beforeBind, name: "an unbound root is not opened for an invalid PID", frames: [configure, frame(1, "bind", { parent_pid: 0 })], expectedError: "observer_protocol_failed" },
      { ...beforeBind, name: "native setup fails before readiness", nativeFailure: true, expectedOperations: ["ready:error"], expectedError: "native_binding_failed" },
      { ...beforeBind, name: "provider setup fails before readiness", providerFailure: true, expectedOperations: ["ready:error"], expectedError: "os_query_failed" },
      { ...beforeBind, name: "root open fails without an acquired handle", frames: [configure, bind], openFailure: true, expectedError: "process_open_failed" },
      { ...beforeBind, name: "binding identity failure releases root", frames: [configure, bind], identityFailureAt: 1,
        expectedRootCloses: 1, expectedIdentityChecks: 1, expectedError: "root_profile_mismatch" },
      { ...afterBind, name: "initial rechecks the held root", frames: [configure, bind, initial], identityFailureAt: 2,
        expectedIdentityChecks: 2, expectedError: "root_profile_mismatch", expectedInitialErrorHistory: [] },
      { ...afterBind, name: "native ancestry failure remains terminal", frames: [configure, bind, initial], snapshotFailure: true,
        expectedIdentityChecks: 2, expectedSnapshots: 1, expectedError: "ancestry_changed", expectedInitialErrorHistory: [] },
      { ...afterBind, name: "initial failure retains only negative history after root cleanup", frames: [configure, bind, initial], snapshotFailure: true,
        historyPids: [202, 303], expectedIdentityChecks: 2, expectedSnapshots: 1, expectedError: "ancestry_changed", expectedInitialErrorHistory: [202, 303] },
      { ...afterBind, name: "failed initial cleanup retains the original history binding", frames: [configure, bind, initial], snapshotFailure: true,
        closeFailure: true, historyPids: [202, 303], expectedIdentityChecks: 2, expectedSnapshots: 1,
        expectedError: "observer_cleanup_failed", expectedInitialErrorHistory: [202, 303] },
      { ...afterBind, name: "failed initial write cannot promote history to successful observation", frames: [configure, bind, initial], initialWriteFailure: true,
        historyPids: [202, 303], expectedIdentityChecks: 2, expectedSnapshots: 1, expectedError: "os_query_failed", expectedInitialErrorHistory: [202, 303] },
      { ...afterInitial, name: "final provider error cannot become empty success", frames: [configure, bind, initial, final()], finalFailure: true,
        expectedError: "os_query_failed" },
      { ...afterInitial, name: "final errors never inherit initial history", frames: [configure, bind, initial, final()], finalFailure: true,
        historyPids: [202, 303], expectedError: "os_query_failed" },
      { ...afterInitial, name: "failed root close prevents empty success", frames: [configure, bind, initial, final()], closeFailure: true,
        expectedError: "observer_cleanup_failed" },
      { ...afterBind, name: "failed cleanup supersedes an earlier identity error", frames: [configure, bind, initial], identityFailureAt: 2, closeFailure: true,
        expectedIdentityChecks: 2, expectedError: "observer_cleanup_failed", expectedInitialErrorHistory: [] },
      { ...afterInitial, name: "failed final write does not return success", frames: [configure, bind, initial, final()], writeFailure: true,
        expectedError: "os_query_failed" },
      { ...beforeBind, name: "unknown configure fields fail before native setup", frames: [frame(0, "configure", { executable, profile, extra: "private-value" })],
        expectedOperations: ["ready:error"], expectedError: "observer_protocol_failed" },
      { ...beforeBind, name: "invalid configure nonce is never reflected", frames: [frame(0, "configure", { executable, profile, session: "private-session" })],
        expectedOperations: [], expectedError: undefined },
      { ...beforeBind, name: "malformed configure has no established nonce", frames: ['{"session":"private-value",'],
        expectedOperations: [], expectedError: undefined },
    ];
    // Controlled functions below model API results. They invoke no native API or
    // browser; the real metadata, identity, precision and tree tests remain separate.
    const script = definitions + String.raw`
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(cases)}')))
function Read-ArtooSessionLine([IO.TextReader]$reader, [int]$limit) {
  if ($script:wire.Count -eq 0) { return $null }
  return $script:wire.Dequeue()
}
function New-ArtooBrowserNativeApi {
  if ($script:active.nativeFailure) { throw 'ARTOO_BROWSER_OBSERVATION:native_binding_failed' }
  return [object]
}
function Initialize-ArtooSessionProvider {
  if ($script:active.providerFailure) { throw 'private-provider-details' }
}
function Open-ArtooProcessIdentity([Type]$api, [uint32]$processId) {
  if ($script:active.openFailure) { throw 'ARTOO_BROWSER_OBSERVATION:process_open_failed' }
  return [pscustomobject]@{ Handle = [IntPtr]::new(17); Pid = $processId; Creation = [long]134383440000000009 }
}
function Assert-ArtooSessionRootIdentity([Type]$api, $root, [string]$executable, [string]$profilePath) {
  $script:identityChecks++
  if ($script:identityChecks -eq 2) {
    $script:rootRevalidationBudget = $budget
    $script:budgetRunningAtRootRevalidation = $budget -is [Diagnostics.Stopwatch] -and $budget.IsRunning
  }
  if ($script:active.identityFailureAt -eq $script:identityChecks) { throw 'ARTOO_BROWSER_OBSERVATION:root_profile_mismatch' }
}
function New-ArtooObservationHistory([uint32]$parentProcessId) {
  $script:historyParent = $parentProcessId
  return [pscustomobject]@{ ParentPid = $parentProcessId; Pids = [Collections.Generic.List[uint32]]::new(); AncestryFailure = $null }
}
function Get-ArtooStableOwnedIdentities([Type]$api, $root, $history, [Diagnostics.Stopwatch]$budget) {
  $script:snapshots++
  $script:sharedInitialBudget = [object]::ReferenceEquals($budget, $script:rootRevalidationBudget) -and $budget.IsRunning
  if ($history.ParentPid -ne $root.Pid) { throw 'Unexpected history binding' }
  foreach ($value in $script:active.historyPids) { $history.Pids.Add([uint32]$value) }
  if ($script:active.ancestryFailure) { $history.AncestryFailure = $script:active.ancestryFailure }
  if ($script:active.ancestryError) { throw 'ARTOO_BROWSER_OBSERVATION:descendant_precedes_parent' }
  if ($script:active.snapshotFailure) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_changed' }
  $identities = [Collections.Generic.List[object]]::new()
  foreach ($value in @(101, 202)) { $identities.Add([pscustomobject]@{ pid = $value; created_utc = '2026-11-05T00:00:00.0000000Z' }) }
  return ,$identities
}
function Get-ArtooObservationExitPids($history) {
  return $history.Pids.ToArray()
}
function Get-ArtooSessionFinalProcesses([string]$executable, [string]$profilePath) {
  if ($script:active.finalFailure) { throw 'private-final-provider-details' }
  $identities = [Collections.Generic.List[object]]::new()
  if ($script:active.finalPids -and $script:finalIndex -lt $script:active.finalPids.Count) {
    foreach ($value in $script:active.finalPids[$script:finalIndex]) { $identities.Add([pscustomobject]@{ pid = $value; created_utc = '2026-11-05T00:00:00.0000000Z' }) }
  }
  $script:finalIndex++
  return ,$identities
}
function Close-ArtooProcessHandle([Type]$api, [IntPtr]$handle) {
  $script:closeAttempts.Add($handle.ToInt64())
  return !$script:active.closeFailure
}
function Write-ArtooSessionFrame($value) {
  if ($script:active.initialWriteFailure -and $value.operation -ceq 'initial' -and $value.status -ceq 'ok') { throw 'private-output-pipe-details' }
  if ($script:active.writeFailure -and $value.operation -ceq 'final' -and $value.status -ceq 'ok') { throw 'private-output-pipe-details' }
  $script:responses.Add([pscustomobject]@{ frame = $value; closes_at_write = $script:closeAttempts.Count })
}
$results = [Collections.Generic.List[object]]::new()
foreach ($case in $cases) {
  $script:active = $case; $script:wire = [Collections.Generic.Queue[string]]::new()
  foreach ($line in $case.frames) { $script:wire.Enqueue($line) }
  $script:identityChecks = 0; $script:snapshots = 0; $script:finalIndex = 0
  $script:historyParent = $null; $script:rootRevalidationBudget = $null
  $script:budgetRunningAtRootRevalidation = $false; $script:sharedInitialBudget = $false
  $script:closeAttempts = [Collections.Generic.List[long]]::new(); $script:responses = [Collections.Generic.List[object]]::new()
  $code = Invoke-ArtooBrowserObserverSession
  $results.Add([pscustomobject]@{ name = $case.name; exit_code = $code; close_attempts = @($script:closeAttempts.ToArray());
    identity_checks = $script:identityChecks; snapshots = $script:snapshots; history_parent = $script:historyParent;
    budget_running_at_root_revalidation = $script:budgetRunningAtRootRevalidation; shared_initial_budget = $script:sharedInitialBudget;
    responses = @($script:responses.ToArray()) })
}
ConvertTo-Json -Compress -Depth 10 -InputObject @($results.ToArray())
`;
    interface Response { frame: { version: number; session: string; seq: number; operation: string; status: string; error_code?: string; parent_pid?: number; processes?: unknown[]; exit_history?: { version: number; pids: number[] }; ancestry_failure?: unknown }; closes_at_write: number }
    interface Result { name: string; exit_code: number; close_attempts: number[]; identity_checks: number; snapshots: number; history_parent: number | null; budget_running_at_root_revalidation: boolean; shared_initial_budget: boolean; responses: Response[] }
    const results = powershell(script) as Result[];
    expect(results).toHaveLength(cases.length);
    for (const [index, fixture] of cases.entries()) {
      const actual = results[index]!;
      expect(actual.name).toBe(fixture.name);
      expect(actual.exit_code, fixture.name).toBe(fixture.expectedExit);
      expect(actual.close_attempts, fixture.name).toEqual(Array(fixture.expectedRootCloses).fill(17));
      expect(actual.identity_checks, fixture.name).toBe(fixture.expectedIdentityChecks);
      expect(actual.snapshots, fixture.name).toBe(fixture.expectedSnapshots);
      expect(actual.history_parent, fixture.name).toBe(fixture.expectedIdentityChecks === 2 ? 101 : null);
      expect(actual.budget_running_at_root_revalidation, fixture.name).toBe(fixture.expectedIdentityChecks === 2);
      expect(actual.shared_initial_budget, fixture.name).toBe(fixture.expectedSnapshots === 1);
      expect(actual.responses.map(item => `${item.frame.operation}:${item.frame.status}`), fixture.name).toEqual(fixture.expectedOperations);
      for (const [responseIndex, response] of actual.responses.entries()) {
        expect(response.frame.version).toBe(1); expect(response.frame.session).toBe(session);
        expect(response.frame.seq, fixture.name).toBe(responseIndex);
        const keys = ["version", "session", "seq", "operation", "status"];
        if (response.frame.status === "error") {
          keys.push("error_code");
          expect(response.frame.error_code, fixture.name).toBe(fixture.expectedError);
          expect(response.closes_at_write, fixture.name).toBe(fixture.expectedRootCloses);
          if (fixture.expectedAncestryFailure) {
            keys.push("ancestry_failure"); expect(response.frame.ancestry_failure).toEqual(ancestryFailure);
          }
          if (fixture.expectedInitialErrorHistory !== undefined) {
            expect(response.frame.operation, fixture.name).toBe("initial");
            keys.push("parent_pid", "exit_history");
            expect(response.frame.parent_pid, fixture.name).toBe(101);
            expect(response.frame.exit_history, fixture.name).toEqual({ version: 1, pids: fixture.expectedInitialErrorHistory });
            expect(response.frame.processes, fixture.name).toBeUndefined();
          }
        } else {
          if (response.frame.operation === "bind" || response.frame.operation === "initial") {
            keys.push("parent_pid"); expect(response.frame.parent_pid).toBe(101);
          }
          if (response.frame.operation === "initial" || response.frame.operation === "final") keys.push("processes");
          if (response.frame.operation === "initial") {
            keys.push("exit_history");
            expect(response.frame.exit_history, fixture.name).toEqual({ version: 1, pids: fixture.historyPids ?? [] });
            expect(response.frame.processes, fixture.name).toEqual([
              { pid: 101, created_utc: "2026-11-05T00:00:00.0000000Z" },
              { pid: 202, created_utc: "2026-11-05T00:00:00.0000000Z" },
            ]);
          }
        }
        expect(Object.keys(response.frame).sort(), fixture.name).toEqual(keys.sort());
        if (response.frame.status === "ok" && response.frame.operation === "final" && response.frame.processes?.length === 0) {
          expect(response.closes_at_write, fixture.name).toBe(1);
          expect(actual.exit_code, fixture.name).toBe(0);
        } else if (response.frame.status === "ok") expect(response.closes_at_write, fixture.name).toBe(0);
      }
      expect(JSON.stringify(actual)).not.toContain("private-");
    }
  });

  it("preserves only the closed native retry and history failure classifications", () => {
    const codes = ["process_open_access_denied", "process_open_invalid_parameter", "process_open_invalid_handle",
      "process_open_resource_unavailable", "process_open_other_error", "historical_pid_reappeared", "historical_identity_unknown",
      "historical_creation_changed", "ancestry_parent_changed", "observer_retry_exhausted", "observer_deadline"];
    const messages = [...codes.map(code => `ARTOO_BROWSER_OBSERVATION:${code}`),
      "ARTOO_BROWSER_OBSERVATION:process_open_gone", "ARTOO_BROWSER_OBSERVATION:process_open_failed:87", "private-native-details"];
    const script = definitions + String.raw`
$messages = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(messages)}')))
$results = [Collections.Generic.List[string]]::new()
foreach ($message in $messages) { $results.Add((Get-ArtooSessionFailureCode ([Exception]::new($message)))) }
ConvertTo-Json -Compress -InputObject @($results.ToArray())
`;
    expect(powershell(script)).toEqual([...codes, "os_query_failed", "os_query_failed", "os_query_failed"]);
  });

  it("bounds line reads and rejects duplicate, nested, noninteger and escaped-key wire requests", () => {
    const valid = [configure, bind, initial, final(), ` \t${initial}\r `];
    const invalid = ["", "{}", "[]", `[${initial}]`, `${initial}${initial}`, initial.replace('"seq":2', '"seq":2,"seq":2'),
      initial.replace('"seq":2', '"seq":2.0'), initial.replace('"seq":2', '"seq":2e0'), initial.replace('"seq":2', '"seq":-2'),
      initial.replace('"seq":2', '"seq":02'), initial.replace('"seq":2', '"seq":{}'), initial.replace('"seq":2', '"seq":[]'),
      initial.replace('"seq":2', '"seq":null'), initial.replace('"seq":2', '"seq":true'), initial.replace('"seq":2', '"se\\u0071":2'),
      initial.replace('"seq":2', '"Seq":2'), initial.replace('"operation":"initial"', '"operation":"unescaped\nnewline"')];
    const script = definitions + String.raw`
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded([...valid, ...invalid])}')))
$parsed = [Collections.Generic.List[bool]]::new()
foreach ($line in $cases) {
  try { $null = ConvertFrom-ArtooSessionRequest $line; $parsed.Add($true) }
  catch { $parsed.Add($false) }
}
$read = [Collections.Generic.List[object]]::new()
foreach ($sample in @(@{ text = "abc" + [char]10; limit = 3 }, @{ text = "abcd" + [char]10; limit = 3 },
  @{ text = ''; limit = 3 }, @{ text = 'ab'; limit = 3 }, @{ text = [string][char]10; limit = 3 })) {
  $reader = [IO.StringReader]::new($sample.text)
  try { $value = Read-ArtooSessionLine $reader $sample.limit; $read.Add([pscustomobject]@{ value = $value; error = $null }) }
  catch { $read.Add([pscustomobject]@{ value = $null; error = Get-ArtooSessionFailureCode $_.Exception }) }
  finally { $reader.Dispose() }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ parsed = @($parsed.ToArray()); read = @($read.ToArray()) })
`;
    const result = powershell(script) as { parsed: boolean[]; read: { value: string | null; error: string | null }[] };
    expect(result.parsed).toEqual([...valid.map(() => true), ...invalid.map(() => false)]);
    expect(result.read).toEqual([
      { value: "abc", error: null }, { value: null, error: "observer_protocol_failed" },
      { value: null, error: null }, { value: null, error: "observer_parent_eof" }, { value: "", error: null },
    ]);
  });

  it("revalidates exact root identity inside the session without weakening creation or profile checks", () => {
    const cases = [
      { name: "exact root", expected: null, queries: 1, liveChecks: 2 },
      { name: "different native image", imageMismatch: true, expected: "root_executable_mismatch", queries: 0, liveChecks: 1 },
      { name: "wrong CIM PID", processId: 102, expected: "root_identity_missing_or_duplicate", queries: 1, liveChecks: 1 },
      { name: "duplicate CIM root", duplicate: true, expected: "root_identity_missing_or_duplicate", queries: 1, liveChecks: 1 },
      { name: "wrong CIM image", image: "C:\\Other\\chrome.exe", expected: "root_executable_mismatch", queries: 1, liveChecks: 1 },
      { name: "missing CIM creation", missingCreation: true, expected: "root_creation_missing", queries: 1, liveChecks: 1 },
      { name: "neighbouring microsecond", creation: "134383440000000010", expected: "root_creation_changed", queries: 1, liveChecks: 1 },
      { name: "embedded profile argument", embeddedProfile: true, expected: "root_profile_mismatch", queries: 1, liveChecks: 1 },
      { name: "root exits across CIM", exitDuringQuery: true, expected: "root_process_exited", queries: 1, liveChecks: 2 },
    ];
    const script = definitions + String.raw`
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(cases)}')))
function Assert-ArtooProcessLive([Type]$api, $identity, [string]$failureCode) {
  $script:liveChecks++
  if ($script:active.exitDuringQuery -and $script:liveChecks -gt 1) { throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode) }
}
function Assert-ArtooRootImage([Type]$api, $identity, [string]$expected) {
  if ($script:active.imageMismatch -or $expected -cne 'C:\Protected\chrome.exe') { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_mismatch' }
}
function Get-CimInstance([string]$ClassName, [string]$Filter, [string[]]$Property, [string]$ErrorAction) {
  if ($ClassName -cne 'Win32_Process' -or $Filter -cne 'ProcessId = 101' -or $ErrorAction -cne 'Stop' -or
    ($Property -join ',') -cne 'ProcessId,ExecutablePath,CommandLine,CreationDate') { throw 'Unexpected provider request' }
  $script:queries++
  $identifier = if ($script:active.processId) { $script:active.processId } else { 101 }
  $image = if ($script:active.image) { $script:active.image } else { 'C:\Protected\chrome.exe' }
  $command = if ($script:active.embeddedProfile) { 'chrome.exe --note="--user-data-dir=C:\Private\browser-profile"' }
    else { '"C:\Protected\chrome.exe" --user-data-dir="C:\Private\browser-profile"' }
  $creation = if ($script:active.missingCreation) { $null }
    elseif ($script:active.creation) { [DateTime]::FromFileTimeUtc([long]$script:active.creation) }
    else { [DateTime]::FromFileTimeUtc([long]134383440000000000) }
  $value = [pscustomobject]@{ ProcessId = $identifier; ExecutablePath = $image; CommandLine = $command; CreationDate = $creation }
  if ($script:active.duplicate) { return @($value, $value) }
  return $value
}
$results = [Collections.Generic.List[object]]::new()
foreach ($case in $cases) {
  $script:active = $case; $script:queries = 0; $script:liveChecks = 0; $failure = $null
  $root = [pscustomobject]@{ Handle = [IntPtr]::new(17); Pid = [uint32]101; Creation = [long]134383440000000009 }
  try { Assert-ArtooSessionRootIdentity ([object]) $root 'C:\Protected\chrome.exe' 'C:\Private\browser-profile' }
  catch { $failure = Get-ArtooSessionFailureCode $_.Exception }
  $results.Add([pscustomobject]@{ name = $case.name; error = $failure; queries = $script:queries; live_checks = $script:liveChecks })
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($results.ToArray())
`;
    const results = powershell(script) as { name: string; error: string | null; queries: number; live_checks: number }[];
    expect(results).toEqual(cases.map(item => ({ name: item.name, error: item.expected, queries: item.queries, live_checks: item.liveChecks })));
  });
});
