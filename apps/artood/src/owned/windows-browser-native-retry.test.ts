import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT } from "./windows-browser-native-snapshot.js";
import { WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT } from "./windows-browser-native-retry.js";
import { parseWindowsBrowserAncestryFailure, parseWindowsBrowserBoundFailure, type WindowsBrowserAncestryFailureV1,
  type WindowsBrowserBoundFailureV1 } from "./windows-browser-negative-evidence.js";

type Edge = [number, number];
interface Fixture {
  name: string; snapshots: Edge[][]; error?: string; ids?: number[]; history?: number[]; attempts: number;
  opens?: Array<{ attempt: number; pid: number; error?: string; creation?: string }>;
  exited?: Array<{ pid: number; snapshot: number; untilSnapshot?: number }>;
  closeFail?: number; closeThrow?: number; rootExitAt?: number; budgetCalls?: number; seedUnknown?: number;
  snapshotError?: { snapshot: number; error: string };
  pending?: number[];
  rootCreation?: string; recordingFailure?: boolean;
  diagnostic?: Partial<WindowsBrowserAncestryFailureV1>;
  boundDiagnostic?: Partial<WindowsBrowserBoundFailureV1>; boundRecordingFailure?: boolean;
}
const snapshot = (...descendants: Edge[]): Edge[] => [[101, 42], ...descendants];
const child = [202, 101] as Edge, peer = [303, 101] as Edge, added = [404, 101] as Edge;
const overfullSnapshot = snapshot(...Array.from({ length: 128 }, (_, i): Edge => [1000 + i, 101]));
const cases: Fixture[] = [
  { name: "complete stable pair", snapshots: [snapshot(child), snapshot(child)], ids: [101, 202], history: [202], attempts: 1 },
  { name: "corroborated disappearance retains its exit-only PID", snapshots: [snapshot(child, peer), snapshot(peer), snapshot(peer), snapshot(peer)],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }], ids: [101, 303], history: [202, 303], attempts: 2 },
  { name: "87 with still-present PID exhausts bounded observation without becoming disappearance",
    snapshots: Array.from({ length: 6 }, () => snapshot(child)),
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "observer_retry_exhausted", history: [202], pending: [202], attempts: 3 },
  { name: "87 still present at confirmation waits for global absence and then a separate stable attempt",
    snapshots: [snapshot(child), snapshot(child), snapshot(), snapshot(), snapshot(), snapshot()],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }], ids: [101], history: [202], pending: [], attempts: 3 },
  { name: "absence first established by the second census still requires the next stable attempt",
    snapshots: [snapshot(child), snapshot(child), snapshot(child), snapshot(), snapshot(), snapshot()],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }], ids: [101], history: [202], pending: [], attempts: 3 },
  { name: "absence in the last available attempt cannot stand in for a later stable pair",
    snapshots: [snapshot(child), snapshot(child), snapshot(child), snapshot(child), snapshot(), snapshot()],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "observer_retry_exhausted", history: [202], pending: [], attempts: 3 },
  { name: "pending PID outside the current root subtree is still globally present",
    snapshots: [snapshot(child, [303, 202]), ...Array.from({ length: 5 }, () => snapshot([303, 202]))],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }], exited: [{ pid: 202, snapshot: 2 }],
    error: "observer_retry_exhausted", history: [202, 303], pending: [303], attempts: 3 },
  ...["process_open_access_denied", "process_open_invalid_handle", "process_open_resource_unavailable", "process_open_other_error"].map(error => ({
    name: `hard native failure ${error}`, snapshots: [snapshot(child)], opens: [{ attempt: 1, pid: 202, error }], error, history: [202], attempts: 1,
  })),
  { name: "new second-snapshot child gains a real identity before retry", snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer), snapshot(child, peer)],
    ids: [101, 202, 303], history: [202, 303], attempts: 2 },
  { name: "87 corroborating inventory records its newly seen root descendants", snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, added), snapshot(child, added), snapshot(child, added)],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }], ids: [101, 202, 404], history: [202, 303, 404], attempts: 2 },
  { name: "a further 87 in the corroborating inventory remains pending without a fourth census",
    snapshots: [snapshot(child), snapshot(child, peer), ...Array.from({ length: 5 }, () => snapshot(child, added))],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }, { attempt: 1, pid: 404, error: "process_open_invalid_parameter" }],
    error: "observer_retry_exhausted", history: [202, 303, 404], pending: [404], attempts: 3 },
  { name: "a further corroborating 87 can disappear before a separate stable attempt",
    snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, added), ...Array.from({ length: 4 }, () => snapshot(child))],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }, { attempt: 1, pid: 404, error: "process_open_invalid_parameter" }],
    ids: [101, 202], history: [202, 303, 404], pending: [], attempts: 3 },
  { name: "second-census 87 still present in corroboration can wait within the original attempts",
    snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer), ...Array.from({ length: 4 }, () => snapshot(child))],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }],
    ids: [101, 202], history: [202, 303], pending: [], attempts: 3 },
  { name: "PID reappearance after an observed absence is rejected", snapshots: [snapshot(child), snapshot(), snapshot(child)],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }], error: "historical_pid_reappeared", history: [202], attempts: 2 },
  ...[snapshot(child), snapshot([202, 909])].map(reappearance => ({
    name: `a carried pending PID cannot reappear after global absence (${reappearance[1]![1]})`,
    snapshots: [snapshot(child), snapshot(child), snapshot(), snapshot(), reappearance],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "historical_pid_reappeared", history: [202], pending: [], attempts: 3,
  })),
  { name: "a single absence followed by immediate reappearance never completes pending observation",
    snapshots: [snapshot(child), snapshot(child), snapshot(), snapshot(child)],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "historical_pid_reappeared", history: [202], pending: [], attempts: 2 },
  { name: "known creation is never overwritten by a later PID instance", snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer)],
    opens: [{ attempt: 2, pid: 202, creation: "134383440000005000" }], error: "historical_creation_changed", history: [202, 303], attempts: 2 },
  { name: "a carried unidentified PID cannot be upgraded by a later open", snapshots: [snapshot(child)], seedUnknown: 202,
    error: "historical_identity_unknown", history: [202], attempts: 1 },
  { name: "same PID changed parent is a hard identity failure", snapshots: [snapshot(child), snapshot(added, [202, 404])],
    error: "ancestry_parent_changed", history: [202, 404], attempts: 1 },
  { name: "pending 87 does not exempt a changed parent from hard failure",
    snapshots: [snapshot(child), snapshot(child), snapshot(added, [202, 404])],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "ancestry_parent_changed", history: [202, 404], pending: [202], attempts: 2 },
  { name: "child cannot predate its selected parent", snapshots: [snapshot(child, [303, 202])],
    opens: [{ attempt: 1, pid: 303, creation: "134383440000000100" }], error: "descendant_precedes_parent", history: [202, 303], attempts: 1,
    diagnostic: { attempt: 1, census: "first", parent_pid: 202, child_pid: 303, parent_filetime: "134383440000002020", child_filetime: "134383440000000100", delta_ticks: "-1920" } },
  ...["first", "second", "corroborating"].map(census => ({
    name: `negative creation evidence preserves ${census} census and 100ns precision`,
    snapshots: census === "first" ? [snapshot(child)] : census === "second" ? [snapshot(), snapshot(child)] : [snapshot(), snapshot(peer), snapshot(child)],
    opens: [{ attempt: 1, pid: 202, creation: "134383439999999999" }, ...(census === "corroborating" ? [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }] : [])],
    error: "descendant_precedes_parent", history: census === "corroborating" ? [202, 303] : [202], attempts: 1,
    diagnostic: { attempt: 1, census: census as WindowsBrowserAncestryFailureV1["census"], parent_pid: 101, child_pid: 202,
      root_filetime: "134383440000000000", parent_filetime: "134383440000000000", child_filetime: "134383439999999999", delta_ticks: "-1" },
  })),
  { name: "negative evidence keeps Int64 maximum precision", rootCreation: "9223372036854775807", snapshots: [snapshot(child)],
    opens: [{ attempt: 1, pid: 202, creation: "9223372036854775806" }], error: "descendant_precedes_parent", history: [202], attempts: 1,
    diagnostic: { root_filetime: "9223372036854775807", parent_filetime: "9223372036854775807", child_filetime: "9223372036854775806", delta_ticks: "-1" } },
  { name: "negative evidence reports the original later attempt", snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer, added)],
    opens: [{ attempt: 2, pid: 404, creation: "134383439999999999" }], error: "descendant_precedes_parent", history: [202, 303, 404], attempts: 2,
    diagnostic: { attempt: 2, census: "first", parent_pid: 101, child_pid: 404, delta_ticks: "-1" } },
  { name: "recording failure cannot replace the original creation-order rejection", recordingFailure: true, snapshots: [snapshot(child)],
    opens: [{ attempt: 1, pid: 202, creation: "134383439999999999" }], error: "descendant_precedes_parent", history: [202], attempts: 1 },
  { name: "HANDLE close failure still supersedes creation-order rejection", closeFail: 202, snapshots: [snapshot(child)],
    opens: [{ attempt: 1, pid: 202, creation: "134383439999999999" }], error: "process_handle_close_failed", history: [202], attempts: 1,
    diagnostic: { census: "first", parent_pid: 101, child_pid: 202, delta_ticks: "-1" } },
  { name: "root exit never renews observation", snapshots: [snapshot(child)], rootExitAt: 1,
    error: "root_process_exited", history: [202], attempts: 1 },
  { name: "root exit while absence is pending forbids further observation",
    snapshots: [snapshot(child), snapshot(child), snapshot(child)], rootExitAt: 3,
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "root_process_exited", history: [202], pending: [202], attempts: 2 },
  { name: "an incomplete census cannot clear pending absence",
    snapshots: [snapshot(child), snapshot()], snapshotError: { snapshot: 2, error: "snapshot_next_failed" },
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "snapshot_next_failed", history: [202], pending: [202], attempts: 1 },
  { name: "failed HANDLE cleanup forbids another attempt", snapshots: [snapshot(child), snapshot(child, peer)], closeFail: 202,
    error: "process_handle_close_failed", history: [202, 303], attempts: 1 },
  { name: "a throwing HANDLE close still attempts every remaining acquired HANDLE", snapshots: [snapshot(child, peer), snapshot(child, peer, added)], closeThrow: 303,
    error: "process_handle_close_failed", history: [202, 303, 404], attempts: 1 },
  ...[{ closeFail: 303 }, { closeThrow: 303 }].map(closeFailure => ({
    name: `pending observation cannot retry after HANDLE cleanup ${"closeThrow" in closeFailure ? "throws" : "fails"}`,
    snapshots: [snapshot(child, peer, added), snapshot(child, peer, added)], ...closeFailure,
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "process_handle_close_failed", history: [202, 303, 404], pending: [202], attempts: 1,
  })),
  { name: "three complete attempts are the limit", snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer), snapshot(child, peer, added), snapshot(child, peer, added), snapshot(child, peer, added, [505, 101])],
    error: "observer_retry_exhausted", history: [202, 303, 404, 505], attempts: 3 },
  { name: "one shared absolute budget spans attempts", snapshots: [snapshot(child), snapshot(child, peer)], budgetCalls: 7,
    error: "observer_deadline", history: [202, 303], attempts: 2 },
  { name: "pending observation cannot renew the shared absolute budget",
    snapshots: [snapshot(child), snapshot(child)], budgetCalls: 7,
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    error: "observer_deadline", history: [202], pending: [202], attempts: 2 },
  { name: "signalled descendant remains in history after stable retry", snapshots: [snapshot(child), snapshot(), snapshot(), snapshot()], exited: [{ pid: 202, snapshot: 2 }],
    ids: [101], history: [202], attempts: 2 },
  { name: "an exited PID cannot become live again even with the same reported creation", snapshots: [snapshot(child), snapshot(child), snapshot(child)],
    exited: [{ pid: 202, snapshot: 2, untilSnapshot: 2 }], error: "historical_creation_changed", history: [202], attempts: 2 },
  { name: "a live orphan is retained even outside the next root subtree", snapshots: [snapshot(child, [303, 202]), snapshot([303, 202]), snapshot([303, 202]), snapshot([303, 202])], exited: [{ pid: 202, snapshot: 2 }],
    ids: [101], history: [202, 303], attempts: 2 },
  { name: "new descendants observed under a pending parent stay in exit history when orphaned",
    snapshots: [snapshot(child), snapshot(child, [303, 202]), ...Array.from({ length: 4 }, () => snapshot([303, 202]))],
    opens: [{ attempt: 1, pid: 202, error: "process_open_invalid_parameter" }],
    ids: [101], history: [202, 303], pending: [], attempts: 3 },
  { name: "a previously known PID that later returns 87 is not reopened or reassigned",
    snapshots: [snapshot(child), snapshot(child, peer), snapshot(child, peer), snapshot(peer), snapshot(peer), snapshot(peer)],
    opens: [{ attempt: 2, pid: 202, error: "process_open_invalid_parameter" }],
    ids: [101, 303], history: [202, 303], pending: [], attempts: 3 },
  { name: "current plus historical IDs cannot exceed 128", snapshots: [snapshot(...Array.from({ length: 127 }, (_, i): Edge => [1000 + i, 101])),
    snapshot(...Array.from({ length: 127 }, (_, i): Edge => [1001 + i, 101]))], error: "observation_bound_exceeded",
    history: Array.from({ length: 127 }, (_, i) => 1000 + i), attempts: 1,
    boundDiagnostic: { source: "history_union", attempt: 1, census: "second" } },
  { name: "pending history cannot evade the 128 PID union bound",
    snapshots: [snapshot(...Array.from({ length: 127 }, (_, i): Edge => [1000 + i, 101])),
      snapshot(...Array.from({ length: 127 }, (_, i): Edge => [1001 + i, 101]))],
    opens: [{ attempt: 1, pid: 1000, error: "process_open_invalid_parameter" }], error: "observation_bound_exceeded",
    history: Array.from({ length: 127 }, (_, i) => 1000 + i), pending: [1000], attempts: 1,
    boundDiagnostic: { source: "history_union", attempt: 1, census: "second" } },
  { name: "first subtree bound records no new history or verified identities", snapshots: [overfullSnapshot],
    error: "observation_bound_exceeded", history: [], attempts: 1,
    boundDiagnostic: { source: "current_subtree", attempt: 1, census: "first" } },
  { name: "second subtree bound still closes acquired identities", snapshots: [snapshot(child), overfullSnapshot],
    error: "observation_bound_exceeded", history: [202], attempts: 1,
    boundDiagnostic: { source: "current_subtree", attempt: 1, census: "second" } },
  { name: "later subtree bound retains its original attempt", snapshots: [snapshot(child), snapshot(child, peer), overfullSnapshot],
    error: "observation_bound_exceeded", history: [202, 303], attempts: 2,
    boundDiagnostic: { source: "current_subtree", attempt: 2, census: "first" } },
  { name: "corroborating subtree bound retains pending history", snapshots: [snapshot(child), snapshot(child, peer), overfullSnapshot],
    opens: [{ attempt: 1, pid: 303, error: "process_open_invalid_parameter" }], error: "observation_bound_exceeded", history: [202, 303], pending: [303], attempts: 1,
    boundDiagnostic: { source: "current_subtree", attempt: 1, census: "corroborating" } },
  { name: "bound diagnostic recording cannot replace rejection", snapshots: [overfullSnapshot], boundRecordingFailure: true,
    error: "observation_bound_exceeded", history: [], attempts: 1 },
];
const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
function powershell(script: string): string {
  return execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
    { input: script, windowsHide: true, timeout: 20000, maxBuffer: 512 * 1024, encoding: "utf8" }).trim();
}

describe("bounded Windows snapshot retries", () => {
  it.runIf(process.platform === "win32")("uses complete controlled snapshots and monotonic identity history without native process calls", () => {
    const encoded = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$script:originalBudget = ${"${function:Assert-ArtooObservationBudget}"}
function Write-ArtooObserverPhase([string]$phase) {}
function Assert-ArtooObservationBudget([Diagnostics.Stopwatch]$budget) {
  $script:budgetCalls++
  [void]$script:budgetObjects.Add($budget.GetHashCode())
  if ($script:active.budgetCalls -and $script:budgetCalls -ge $script:active.budgetCalls) { throw 'ARTOO_BROWSER_OBSERVATION:observer_deadline' }
  & $script:originalBudget $budget
}
function Get-ArtooProcessSnapshot([Type]$api) {
  if ($script:snapshotIndex -ge $script:active.snapshots.Count) { throw 'Unexpected controlled snapshot read' }
  $edges = $script:active.snapshots[$script:snapshotIndex]; $script:snapshotIndex++
  $script:snapshotAttempts.Add($script:history.Attempts)
  if ($script:active.snapshotError -and $script:active.snapshotError.snapshot -eq $script:snapshotIndex) {
    throw ('ARTOO_BROWSER_OBSERVATION:' + $script:active.snapshotError.error)
  }
  $inventory = [Collections.Generic.Dictionary[uint32,uint32]]::new()
  foreach ($edge in $edges) { $inventory.Add([uint32]$edge[0], [uint32]$edge[1]) }
  return ,$inventory
}
function Open-ArtooProcessIdentity([Type]$api, [uint32]$processId) {
  $script:openCalls++
  $rule = @($script:active.opens | Where-Object { $_.attempt -eq $script:history.Attempts -and $_.pid -eq $processId })
  if ($rule.Count -gt 1) { throw 'Ambiguous controlled open rule' }
  $script:openTrace.Add([pscustomobject]@{ pid = $processId; attempt = $script:history.Attempts; snapshot = $script:snapshotIndex;
    error = $(if ($rule.Count -eq 1 -and $rule[0].error) { [string]$rule[0].error } else { $null }) })
  if ($rule.Count -eq 1 -and $rule[0].error) { throw ('ARTOO_BROWSER_OBSERVATION:' + $rule[0].error) }
  [long]$created = if ($rule.Count -eq 1 -and $rule[0].creation) { [long]$rule[0].creation } else { 134383440000000000L + [long]$processId * 10 }
  $script:successfulOpens++
  return [pscustomobject]@{ Handle = [IntPtr]::new($processId); Pid = $processId; Creation = $created }
}
function Assert-ArtooProcessLive([Type]$api, $identity, [string]$failureCode) {
  if ($identity.Pid -eq 101) {
    if ($script:active.rootExitAt -and $script:snapshotIndex -ge $script:active.rootExitAt) { throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode) }
  } elseif (@($script:active.exited | Where-Object { $_.pid -eq $identity.Pid -and $script:snapshotIndex -ge $_.snapshot -and (!$_.untilSnapshot -or $script:snapshotIndex -le $_.untilSnapshot) }).Count -gt 0) {
    throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode)
  }
}
function Close-ArtooProcessHandle([Type]$api, [IntPtr]$handle) {
  $script:closedHandles.Add($handle.ToInt64())
  if ($script:active.closeThrow -and $handle.ToInt64() -eq $script:active.closeThrow) { throw 'Controlled native close exception' }
  return !$script:active.closeFail -or $handle.ToInt64() -ne $script:active.closeFail
}
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
$results = [Collections.Generic.List[object]]::new()
foreach ($case in $cases) {
  $script:active = $case; $script:snapshotIndex = 0; $script:openCalls = 0; $script:successfulOpens = 0; $script:budgetCalls = 0
  $script:closedHandles = [Collections.Generic.List[long]]::new(); $script:budgetObjects = [Collections.Generic.HashSet[int]]::new()
  $script:openTrace = [Collections.Generic.List[object]]::new(); $script:snapshotAttempts = [Collections.Generic.List[int]]::new()
  $script:history = New-ArtooObservationHistory 101
  if ($case.recordingFailure) {
    $script:history.PSObject.Properties.Remove('AncestryFailure')
    $script:history | Add-Member -MemberType ScriptProperty -Name AncestryFailure -Value { return $null } -SecondValue { throw 'Controlled diagnostic recording failure' }
  }
  if ($case.boundRecordingFailure) {
    $script:history.PSObject.Properties.Remove('BoundFailure')
    $script:history | Add-Member -MemberType ScriptProperty -Name BoundFailure -Value { return $null } -SecondValue { throw 'Controlled bound diagnostic recording failure' }
  }
  if ($case.seedUnknown) {
    [void]$script:history.Seen.Add([uint32]$case.seedUnknown); [void]$script:history.Uncertain.Add([uint32]$case.seedUnknown)
    $script:history.FirstAttempt.Add([uint32]$case.seedUnknown, 0)
  }
  [long]$rootCreated = if ($case.rootCreation) { [long]$case.rootCreation } else { 134383440000000000L }
  $root = [pscustomobject]@{ Handle = [IntPtr]::new(101); Pid = [uint32]101; Creation = $rootCreated }
  $budget = [Diagnostics.Stopwatch]::StartNew(); $value = $null; $errorCode = $null
  try { $value = Get-ArtooStableOwnedIdentities ([object]) $root $script:history $budget }
  catch { $errorCode = Get-ArtooRetryExceptionCode $_.Exception }
  $results.Add([pscustomobject]@{ name = $case.name; error = $errorCode; attempts = $script:history.Attempts;
    pids = @($value | ForEach-Object { $_.Pid }); history = @(Get-ArtooObservationExitPids $script:history);
    snapshots = $script:snapshotIndex; successful_opens = $script:successfulOpens; closes = @($script:closedHandles.ToArray());
    open_trace = @($script:openTrace.ToArray()); snapshot_attempts = @($script:snapshotAttempts.ToArray());
    pending = @($script:history.PendingMissing); uncertain = @($script:history.Uncertain); absent = @($script:history.Absent);
    budget_objects = $script:budgetObjects.Count; budget_running = $budget.IsRunning; ancestry_failure = $script:history.AncestryFailure;
    bound_failure = $script:history.BoundFailure })
}
ConvertTo-Json -Compress -Depth 8 -InputObject @($results.ToArray())
`;
    const results = JSON.parse(powershell(script)) as Array<{ name: string; error: string | null; attempts: number; pids: number[]; history: number[];
      snapshots: number; successful_opens: number; closes: number[]; budget_objects: number; budget_running: boolean;
      open_trace: Array<{ pid: number; attempt: number; snapshot: number; error: string | null }>;
      snapshot_attempts: number[]; pending: number[]; uncertain: number[]; absent: number[]; ancestry_failure: unknown; bound_failure: unknown }>;
    expect(results).toHaveLength(cases.length);
    for (const [index, result] of results.entries()) {
      const fixtureCase = cases[index]!;
      expect(result.name).toBe(fixtureCase.name); expect(result.error, fixtureCase.name).toBe(fixtureCase.error ?? null);
      expect(result.attempts, fixtureCase.name).toBe(fixtureCase.attempts);
      if (fixtureCase.diagnostic) {
        const evidence = parseWindowsBrowserAncestryFailure(result.ancestry_failure, { parentPid: 101, pids: result.history });
        expect(evidence, fixtureCase.name).toMatchObject({ version: 1, root_pid: 101, root_type: "System.Int64",
          parent_type: "System.Int64", child_type: "System.Int64", ...fixtureCase.diagnostic });
      } else expect(result.ancestry_failure, fixtureCase.name).toBeNull();
      if (fixtureCase.boundDiagnostic) {
        const evidence = parseWindowsBrowserBoundFailure(result.bound_failure, { parentPid: 101, pids: result.history });
        expect(evidence, fixtureCase.name).toEqual({ version: 1, count: 128, root_pid: 101, ...fixtureCase.boundDiagnostic });
      } else expect(result.bound_failure, fixtureCase.name).toBeNull();
      expect(result.history.sort((a, b) => a - b), fixtureCase.name).toEqual(fixtureCase.history);
      if (fixtureCase.ids) expect(result.pids.sort((a, b) => a - b)).toEqual(fixtureCase.ids);
      else expect(result.pids.filter(value => value !== null)).toEqual([]);
      expect(result.successful_opens).toBe(result.closes.length); expect(result.closes).not.toContain(101);
      expect(result.budget_objects).toBe(1); expect(result.budget_running).toBe(true);
      expect(result.snapshots).toBeLessThanOrEqual(fixtureCase.snapshots.length);
      expect(result.snapshots, fixtureCase.name).toBe(fixtureCase.snapshots.length);
      expect(result.attempts, fixtureCase.name).toBeLessThanOrEqual(3);
      expect(result.snapshot_attempts).toHaveLength(result.snapshots);
      for (const attempt of new Set(result.snapshot_attempts)) {
        expect(result.snapshot_attempts.filter(value => value === attempt).length, fixtureCase.name).toBeLessThanOrEqual(3);
      }
      for (const [openIndex, opened] of result.open_trace.entries()) {
        if (opened.error !== "process_open_invalid_parameter") continue;
        expect(result.open_trace.slice(openIndex + 1).some(later => later.pid === opened.pid), fixtureCase.name).toBe(false);
        expect(result.uncertain, fixtureCase.name).toContain(opened.pid);
        expect(result.history, fixtureCase.name).toContain(opened.pid);
        expect(result.pids, fixtureCase.name).not.toContain(opened.pid);
      }
      if (fixtureCase.pending) expect(result.pending.sort((a, b) => a - b), fixtureCase.name).toEqual(fixtureCase.pending);
      if (fixtureCase.ids) {
        expect(result.pending, fixtureCase.name).toEqual([]);
        for (const pid of result.uncertain) expect(result.absent, fixtureCase.name).toContain(pid);
        expect(result.snapshot_attempts.filter(attempt => attempt === result.attempts), fixtureCase.name).toHaveLength(2);
      }
    }
  });
  it.runIf(process.platform === "win32")("classifies fixed native errors without inferring disappearance", () => {
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$values = @(5, 87, 6, 8, 14, 0, 12345) | ForEach-Object { Get-ArtooProcessOpenFailureCode $_ }
ConvertTo-Json -Compress -InputObject @($values)
`;
    expect(JSON.parse(powershell(script))).toEqual(["process_open_access_denied", "process_open_invalid_parameter", "process_open_invalid_handle",
      "process_open_resource_unavailable", "process_open_resource_unavailable", "process_open_other_error", "process_open_other_error"]);
  });
  it.runIf(process.platform === "win32")("preserves actual native OpenProcess last-error for the documented invalid PID zero", () => {
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$api = New-ArtooBrowserNativeApi
try { [void](Open-ArtooProcessIdentity $api 0); throw 'Unexpected native open success' }
catch { [Console]::Out.WriteLine((Get-ArtooRetryExceptionCode $_.Exception)) }
`;
    expect(powershell(script)).toBe("process_open_invalid_parameter");
  });
});
