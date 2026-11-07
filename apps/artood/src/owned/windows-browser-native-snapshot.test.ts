import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT } from "./windows-browser-native-snapshot.js";

function powershell(script: string): unknown {
  // Controlled fixture interpretation, not the production observer's timing gate.
  const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  const output = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
    { input: script, windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf8" });
  return JSON.parse(output.trim());
}

describe.runIf(process.platform === "win32")("protected native browser ancestry observation", () => {
  it("retains complete current ancestry and closes every acquired handle across native races and failures", () => {
    const tree = [[101, 1], [202, 101], [303, 202], [404, 1]];
    const bounded = [[101, 1], ...Array.from({ length: 127 }, (_, index) => [1000 + index, 101])];
    const cases = [
      { name: "differently named descendants", first: tree, second: tree, expected: [101, 202, 303] },
      { name: "PID moved to unrelated parent", first: tree, second: [[101, 1], [202, 999], [303, 202]], error: "ancestry_changed" },
      { name: "same count replaced PID", first: tree, second: [[101, 1], [202, 101], [999, 202]], error: "ancestry_changed" },
      { name: "new descendant", first: tree, second: [...tree, [505, 101]], error: "ancestry_changed" },
      { name: "changed edge within same subtree", first: tree, second: [[101, 1], [202, 101], [303, 101]], error: "ancestry_changed" },
      { name: "root parent changed", first: tree, second: [[101, 9], [202, 101], [303, 202]], error: "ancestry_changed" },
      { name: "root missing from second snapshot", first: tree, second: [[202, 101], [303, 202]], error: "root_missing_or_duplicate" },
      { name: "first descendant inaccessible", first: tree, second: tree, openFails: 202, error: "process_open_failed" },
      { name: "later descendant inaccessible", first: tree, second: tree, openFails: 303, error: "process_open_failed" },
      { name: "child exited before identity", first: tree, second: tree, exited: 202, error: "selected_process_exited" },
      { name: "child exited during confirmation", first: tree, second: tree, lateExited: 303, error: "selected_process_exited" },
      { name: "root exited during confirmation", first: tree, second: tree, lateExited: 101, error: "root_process_exited" },
      { name: "child predates parent by 100ns", first: tree, second: tree, older: 202, error: "descendant_precedes_parent" },
      { name: "ancestry cycle", first: [[101, 202], [202, 101]], second: tree, error: "ancestry_cycle" },
      { name: "128 members", first: bounded, second: bounded, expected: bounded.map(item => item[0]!) },
      { name: "129 members", first: [...bounded, [3000, 101]], second: bounded, error: "observation_bound_exceeded" },
      { name: "unrelated changes", first: tree, second: [...tree.slice(0, 3), [999, 1]], expected: [101, 202, 303] },
      { name: "a close failure attempts every handle", first: tree, second: tree, closeFails: 303, error: "process_handle_close_failed" },
      { name: "root only", first: [[101, 1]], second: [[101, 1]], expected: [101] },
    ];
    const fixture = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
function Write-ArtooObserverPhase([string]$phase) {}
# Explicit controlled platform observations: no native API or process is invoked.
# The production tree selection, identity ordering, requalification and finally
# logic remain unchanged; only OS-facing functions below are replaced.
function Get-ArtooProcessSnapshot([Type]$api) {
  $script:snapshotCalls++
  $pairs = if ($script:snapshotCalls -eq 1) { $script:active.first } else { $script:active.second }
  $value = [Collections.Generic.Dictionary[uint32,uint32]]::new()
  foreach ($pair in $pairs) { $value.Add([uint32]$pair[0], [uint32]$pair[1]) }
  return ,$value
}
function Open-ArtooProcessIdentity([Type]$api, [uint32]$processId) {
  if ($script:active.openFails -eq $processId) { throw 'ARTOO_BROWSER_OBSERVATION:process_open_failed' }
  $script:opened.Add($processId)
  [long]$created = 134383440000000009L + [long]$processId
  if ($script:active.older -eq $processId) { $created = 134383440000000109L }
  return [pscustomobject]@{ Handle = [IntPtr]::new($processId); Pid = $processId; Creation = $created }
}
function Assert-ArtooProcessLive([Type]$api, $identity, [string]$failureCode) {
  if ($script:active.exited -eq $identity.Pid -or ($script:snapshotCalls -ge 2 -and $script:active.lateExited -eq $identity.Pid)) {
    throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode)
  }
}
function Close-ArtooProcessHandle([Type]$api, [IntPtr]$handle) {
  $script:closeAttempts.Add([uint32]$handle.ToInt64())
  return $script:active.closeFails -ne $handle.ToInt64()
}
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')))
$results = [Collections.Generic.List[object]]::new()
foreach ($case in $cases) {
  $script:active = $case; $script:snapshotCalls = 0
  $script:opened = [Collections.Generic.List[uint32]]::new(); $script:closeAttempts = [Collections.Generic.List[uint32]]::new()
  $root = Open-ArtooProcessIdentity ([object]) 101
  $failure = $null; $observed = $null
  try { $observed = Get-ArtooOwnedIdentities ([object]) $root }
  catch { $failure = $_.Exception.Message }
  finally { [void](Close-ArtooProcessHandle ([object]) $root.Handle) }
  $results.Add([pscustomobject]@{ name = $case.name; error = $failure; ids = @($observed | ForEach-Object { $_.Pid });
    opened = @($script:opened.ToArray()); close_attempts = @($script:closeAttempts.ToArray()); snapshots = $script:snapshotCalls })
}
ConvertTo-Json -Compress -Depth 6 -InputObject @($results.ToArray())
`;
    const results = powershell(script) as Array<{ name: string; error: string | null; ids: number[]; opened: number[]; close_attempts: number[]; snapshots: number }>;
    expect(results).toHaveLength(cases.length);
    for (const [index, result] of results.entries()) {
      const fixtureCase = cases[index]!;
      expect(result.name).toBe(fixtureCase.name);
      expect([...result.close_attempts].sort((a, b) => a - b)).toEqual([...result.opened].sort((a, b) => a - b));
      if (fixtureCase.error) expect(result.error).toBe(`ARTOO_BROWSER_OBSERVATION:${fixtureCase.error}`);
      else { expect(result.error).toBeNull(); expect(result.ids.slice().sort((a, b) => a - b)).toEqual(fixtureCase.expected!.slice().sort((a, b) => a - b)); expect(result.snapshots).toBe(2); }
    }
  });

  it("compares full FILETIME values without floating-point loss and permits only exact CIM microsecond truncation", () => {
    const cases = [
      { native: "134383440000000000", cim: "134383440000000000", passes: true },
      { native: "134383440000000001", cim: "134383440000000000", passes: true },
      { native: "134383440000000009", cim: "134383440000000000", passes: true },
      { native: "134383440000000009", cim: "134383440000000009", passes: true },
      { native: "134383440000000009", cim: "134383440000000010", passes: false },
      { native: "134383440000000000", cim: "134383439999999990", passes: false },
      { native: "134383440000000009", cim: "134383440000000008", passes: false },
      { native: "134383440000000010", cim: "134383440000000000", passes: false },
    ];
    const fixture = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')))
$results = @($cases | ForEach-Object {
  try { Assert-ArtooCimCreation ([pscustomobject]@{ Creation = [long]$_.native }) ([DateTime]::FromFileTimeUtc([long]$_.cim)); $true }
  catch { if ($_.Exception.Message -cne 'ARTOO_BROWSER_OBSERVATION:root_creation_changed') { throw }; $false }
})
ConvertTo-Json -Compress -InputObject $results
`;
    expect(powershell(script)).toEqual(cases.map(item => item.passes));
  });

  it("binds the real public Win32 metadata, reads its own exact HANDLE and completes a full Toolhelp enumeration", () => {
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
function Write-ArtooObserverPhase([string]$phase) {}
$api = New-ArtooBrowserNativeApi
$root = Open-ArtooProcessIdentity $api ([uint32]$PID)
try {
  Assert-ArtooProcessLive $api $root 'root_process_exited'
  $inventory = Get-ArtooProcessSnapshot $api
  if (!$inventory.ContainsKey([uint32]$PID)) { throw 'Self process missing from Toolhelp snapshot' }
  $image = [Text.StringBuilder]::new(32768); [uint32]$length = $image.Capacity
  if (!$api::QueryFullProcessImageNameW($root.Handle, 0, $image, [ref]$length)) { throw 'Self image read failed' }
  Assert-ArtooRootImage $api $root $image.ToString()
  ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ self_present = $true; creation_positive = $root.Creation -gt 0;
    pointer_width = [IntPtr]::Size; native_metadata_checked = $true })
} finally { if (!(Close-ArtooProcessHandle $api $root.Handle)) { throw 'Self HANDLE close failed' } }
`;
    expect(powershell(script)).toEqual({ self_present: true, creation_positive: true, pointer_width: process.arch === "ia32" ? 4 : 8, native_metadata_checked: true });
  });
});
