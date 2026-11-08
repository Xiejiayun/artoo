import { WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT } from "./windows-browser-native-snapshot.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeObservedWindowsProcesses, renderWindowsBrowserObservationRequest, WINDOWS_BROWSER_OWNED_PROCESS_SNAPSHOT, windowsObservationFailureCode } from "./windows-browser-exit.js";

describe("protected Windows ancestry and root identity observations", () => {
  it.runIf(process.platform === "win32")("binds the exact CIM root to its held native identity before opening descendants", () => {
    const identity = { ProcessId: 101, ExecutablePath: "C:\\Chrome\\chrome.exe", CommandLine: "chrome.exe --user-data-dir=C:\\Profile\\owned", creation: "134383440000000000" };
    const cases = [
      { name: "exact root", identity: [identity], expected: [101, 202] },
      { name: "CIM root disappeared", identity: [], error: "root_identity_missing_or_duplicate" },
      { name: "duplicate CIM root", identity: [identity, identity], error: "root_identity_missing_or_duplicate" },
      { name: "wrong CIM PID", identity: [{ ...identity, ProcessId: 909 }], error: "root_identity_missing_or_duplicate" },
      { name: "missing CIM creation", identity: [{ ...identity, creation: null }], error: "root_creation_missing" },
      { name: "changed CIM creation", identity: [{ ...identity, creation: "134383440000000010" }], error: "root_creation_changed" },
      { name: "wrong CIM executable", identity: [{ ...identity, ExecutablePath: "C:\\Other\\chrome.exe" }], error: "root_executable_mismatch" },
      { name: "wrong CIM profile", identity: [{ ...identity, CommandLine: "chrome.exe --user-data-dir=C:\\Profile\\other" }], error: "root_profile_mismatch" },
      { name: "unreadable CIM command", identity: [{ ...identity, CommandLine: null }], error: "command_line_unavailable" },
      { name: "native root exited during CIM", identity: [identity], exitDuringQuery: true, error: "root_process_exited" },
      { name: "native executable differs", identity: [identity], nativeImage: "C:\\Other\\chrome.exe", error: "root_executable_mismatch", queries: 0 },
    ];
    const request = renderWindowsBrowserObservationRequest({ parent_pid: 101, executable: identity.ExecutablePath, profile: "C:\\Profile\\owned" });
    // Keep the actual argument parser and root orchestration. The OS-facing
    // functions are explicitly replaced by controlled observations below.
    const production = WINDOWS_BROWSER_OWNED_PROCESS_SNAPSHOT.replace(WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT, "").replace("__REQUEST__", request);
    const encodedProgram = Buffer.from(production, "utf8").toString("base64"), fixture = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
    const script = WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
function Write-ArtooObserverPhase([string]$phase) {}
function New-ArtooBrowserNativeApi { return [object] }
function Open-ArtooProcessIdentity([Type]$api, [uint32]$processId) {
  return [pscustomobject]@{ Handle = [IntPtr]::new(101); Pid = $processId; Creation = 134383440000000009L }
}
function Assert-ArtooProcessLive([Type]$api, $identity, [string]$failureCode) {
  if ($script:rootExited) { throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode) }
}
function Assert-ArtooRootImage([Type]$api, $identity, [string]$expected) {
  if ($script:active.nativeImage -and $script:active.nativeImage -ine $expected) { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_mismatch' }
}
function Get-ArtooOwnedIdentities([Type]$api, $root) {
  $script:descendantsRead++
  $owned = [Collections.Generic.List[object]]::new()
  foreach ($id in @(101, 202)) { $owned.Add([pscustomobject]@{ pid = $id; created_utc = '2026-11-05T00:00:00.0000000Z' }) }
  return ,$owned
}
function Close-ArtooProcessHandle([Type]$api, [IntPtr]$handle) { $script:rootCloses++; return $true }
function Get-CimInstance([string]$ClassName, [string]$Filter, [string[]]$Property, [string]$ErrorAction) {
  if ($ClassName -cne 'Win32_Process' -or $ErrorAction -cne 'Stop') { throw 'Unexpected provider request' }
  $script:queries.Add([pscustomobject]@{ filter = $Filter; properties = @($Property) })
  if ($script:active.exitDuringQuery) { $script:rootExited = $true }
  foreach ($record in $script:active.identity) {
    $created = if ($null -eq $record.creation) { $null } else { [DateTime]::FromFileTimeUtc([long]$record.creation) }
    [pscustomobject]@{ ProcessId = $record.ProcessId; ExecutablePath = $record.ExecutablePath; CommandLine = $record.CommandLine; CreationDate = $created }
  }
}
$cases = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')))
$production = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedProgram}'))
$results = [Collections.Generic.List[object]]::new()
foreach ($case in $cases) {
  $script:active = $case; $script:rootExited = $false; $script:rootCloses = 0; $script:descendantsRead = 0
  $script:queries = [Collections.Generic.List[object]]::new()
  $errorCode = $null; $value = $null
  try { $value = ConvertFrom-Json (Invoke-Expression $production) }
  catch { $errorCode = $_.Exception.Message }
  $results.Add([pscustomobject]@{ name = $case.name; result = $value; error = $errorCode; root_closes = $script:rootCloses;
    descendants_read = $script:descendantsRead; queries = @($script:queries.ToArray()) })
}
ConvertTo-Json -Compress -Depth 10 -InputObject @($results.ToArray())
`;
    const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
    const output = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
      { input: script, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: "utf8" });
    const results = JSON.parse(output.trim()) as Array<{ name: string; error: string | null; result: { parent_pid: number; processes: Array<{ pid: number }> } | null; root_closes: number; descendants_read: number; queries: Array<{ filter: string; properties: string[] }> }>;
    expect(results).toHaveLength(cases.length);
    for (const [index, result] of results.entries()) {
      const fixtureCase = cases[index]!;
      expect(result.name).toBe(fixtureCase.name); expect(result.root_closes).toBe(1);
      expect(result.queries).toHaveLength(fixtureCase.queries ?? 1);
      if (result.queries.length) expect(result.queries[0]).toEqual({ filter: "ProcessId = 101", properties: ["ProcessId", "ExecutablePath", "CommandLine", "CreationDate"] });
      if (fixtureCase.error) { expect(result.error).toBe(`ARTOO_BROWSER_OBSERVATION:${fixtureCase.error}`); expect(result.result).toBeNull(); expect(result.descendants_read).toBe(0); }
      else { expect(result.error).toBeNull(); expect(result.result?.parent_pid).toBe(101); expect(result.result?.processes.map(item => item.pid)).toEqual(fixtureCase.expected); expect(result.descendants_read).toBe(1); }
    }
    expect(output).not.toContain("--user-data-dir");
  });

  it.each(["root_creation_changed", "root_identity_missing_or_duplicate"])("admits only the closed root-race diagnostic %s", code => {
    expect(windowsObservationFailureCode(JSON.stringify({ error_code: code }))).toBe(code);
    expect(windowsObservationFailureCode(JSON.stringify({ error_code: code, private: "secret" }))).toBeUndefined();
  });

  it.each([
    { source: "Protected Windows process observation failed (deadline)", reason: "deadline" },
    { source: "Protected Windows process observation failed (root_creation_changed)", reason: "root_creation_changed" },
    { source: "private command with credentials", reason: "unavailable" },
  ])("retains a safe initial-observation cause after eventual process exit: $reason", async ({ source, reason }) => {
    const absent = () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); };
    await expect(closeObservedWindowsProcesses({ parentPid: 101, parentClosed: () => true,
      observe: async () => { throw new Error(source); }, terminateParent: async () => {}, finalAudit: async () => [] },
    { probe: absent, now: () => 0, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 }))
      .rejects.toThrow(`failures=initial_observation:${reason}`);
  });

  it("distinguishes final-audit failure from a successful initial observation without leaking its contents", async () => {
    const absent = () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); };
    await expect(closeObservedWindowsProcesses({ parentPid: 101, parentClosed: () => true,
      observe: async () => [101], terminateParent: async () => {}, finalAudit: async () => { throw new Error("private query output"); } },
    { probe: absent, now: () => 0, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 }))
      .rejects.toThrow("failures=final_audit");
  });
});
