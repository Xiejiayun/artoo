import { WINDOWS_BROWSER_ARGUMENT_PARSER } from "./windows-browser-exit.js";
import { WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT } from "./windows-browser-native-snapshot.js";
import { WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT } from "./windows-browser-native-retry.js";

/** Fixed protected source. The private pipe is the boundary; session IDs only correlate frames. */
export const WINDOWS_BROWSER_SESSION_SCRIPT = WINDOWS_BROWSER_ARGUMENT_PARSER + WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT + WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
# First-use module progress is not part of the private wire protocol. Warnings fail
# closed instead of becoming unstructured diagnostics containing local details.
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
function Write-ArtooObserverPhase([string]$phase) {
  if (@('script_started', 'native_binding', 'root_handle', 'root_query', 'root_identity', 'ancestry_snapshot', 'ancestry_identities', 'ancestry_confirmation', 'final_query', 'final_identity', 'observation_result') -cnotcontains $phase) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
  [Console]::Error.WriteLine('ARTOO_BROWSER_PHASE|' + $phase)
}
function Read-ArtooSessionLine([IO.TextReader]$reader, [int]$limit) {
  $text = [Text.StringBuilder]::new()
  while ($true) {
    $character = $reader.Read()
    if ($character -eq -1) {
      if ($text.Length -eq 0) { return $null }
      throw 'ARTOO_BROWSER_OBSERVATION:observer_parent_eof'
    }
    if ($character -eq 10) { return $text.ToString() }
    if ($text.Length -ge $limit) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
    [void]$text.Append([char]$character)
  }
}
function ConvertFrom-ArtooSessionRequest([string]$line) {
  # Requests have only flat string/unsigned-integer fields. Validate that narrow wire
  # grammar before ConvertFrom-Json, which can otherwise fold duplicate object keys.
  $text = $line.Trim([char[]]@([char]32, [char]9, [char]13))
  if ($text.Length -lt 2 -or $text[0] -ne [char]123 -or $text[$text.Length - 1] -ne [char]125) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
  $pattern = '\G[ \t\r]*"(?<key>[a-z_]+)"[ \t\r]*:[ \t\r]*(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"|(?:0|[1-9][0-9]*))[ \t\r]*(?<delimiter>[,}])'
  $matcher = [Text.RegularExpressions.Regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant, [TimeSpan]::FromMilliseconds(1000))
  $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $position = 1
  while ($true) {
    $match = $matcher.Match($text, $position)
    if (!$match.Success -or $match.Index -ne $position -or !$keys.Add($match.Groups['key'].Value)) {
      throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
    }
    $position += $match.Length
    if ($match.Groups['delimiter'].Value -ceq '}') {
      if ($position -ne $text.Length) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
      break
    }
  }
  $request = ConvertFrom-Json -InputObject $text -ErrorAction Stop
  if ($null -eq $request -or $request.GetType() -ne [System.Management.Automation.PSCustomObject] -or @($request.PSObject.Properties).Count -ne $keys.Count) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
  return $request
}
function Read-ArtooSessionRequest {
  $line = Read-ArtooSessionLine ([Console]::In) 65536
  if ($null -eq $line) { throw 'ARTOO_BROWSER_OBSERVATION:observer_parent_eof' }
  return ConvertFrom-ArtooSessionRequest $line
}
function Test-ArtooSessionId($value) {
  return $value -is [string] -and [Text.RegularExpressions.Regex]::IsMatch($value, '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z')
}
function Assert-ArtooSessionKeys($request, [string[]]$keys) {
  $actual = @($request.PSObject.Properties.Name)
  if ($actual.Count -ne $keys.Count) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
  foreach ($name in $actual) {
    if ($keys -cnotcontains $name) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
  }
}
function Assert-ArtooSessionInteger($value, [long]$minimum, [long]$maximum) {
  if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt $minimum -or $value -gt $maximum) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
}
function Assert-ArtooSessionBase($request, [string]$sessionId, [long]$sequence, [string]$operation) {
  Assert-ArtooSessionInteger $request.version 1 1
  Assert-ArtooSessionInteger $request.seq 0 9007199254740991
  if ($request.session -isnot [string] -or $request.session -cne $sessionId -or $request.seq -ne $sequence -or
    $request.operation -isnot [string] -or $request.operation -cne $operation) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
}
function Assert-ArtooSessionPath($value) {
  if ($value -isnot [string] -or $value.Length -lt 1 -or $value.Length -gt 32767 -or $value.IndexOf([char]0) -ge 0 -or ![IO.Path]::IsPathRooted($value)) {
    throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed'
  }
}
function New-ArtooSessionFrame([string]$sessionId, [long]$sequence, [string]$operation) {
  return [ordered]@{ version = 1; session = $sessionId; seq = $sequence; operation = $operation; status = 'ok' }
}
function Write-ArtooSessionFrame($frame) {
  $encoded = ConvertTo-Json -Compress -Depth 4 -InputObject $frame
  if ($encoded.Length -gt 65536) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
  [Console]::Out.WriteLine($encoded)
  [Console]::Out.Flush()
}
function Initialize-ArtooSessionProvider {
  # This is the protected interpreter's built-in module, not a PSModulePath search.
  Import-Module -Name (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop
  Write-ArtooObserverPhase 'root_query'
  $warm = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID.ToString([Globalization.CultureInfo]::InvariantCulture)) -Property ProcessId -ErrorAction Stop)
  if ($warm.Count -ne 1 -or $warm[0].ProcessId -ne $PID) { throw 'ARTOO_BROWSER_OBSERVATION:os_query_failed' }
}
function Assert-ArtooSessionRootIdentity([Type]$api, $root, [string]$executable, [string]$profilePath) {
  Assert-ArtooProcessLive $api $root 'root_process_exited'
  Assert-ArtooRootImage $api $root $executable
  Write-ArtooObserverPhase 'root_query'
  $identity = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $root.Pid.ToString([Globalization.CultureInfo]::InvariantCulture)) -Property ProcessId,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop)
  Write-ArtooObserverPhase 'root_identity'
  if ($identity.Count -ne 1 -or $identity[0].ProcessId -ne $root.Pid) { throw 'ARTOO_BROWSER_OBSERVATION:root_identity_missing_or_duplicate' }
  if ($null -eq $identity[0].CreationDate) { throw 'ARTOO_BROWSER_OBSERVATION:root_creation_missing' }
  if ($identity[0].ExecutablePath -ine $executable) { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_mismatch' }
  if (!(Test-ArtooBrowserProfile ([string]$identity[0].CommandLine) $profilePath)) { throw 'ARTOO_BROWSER_OBSERVATION:root_profile_mismatch' }
  Assert-ArtooCimCreation $root $identity[0].CreationDate
  Assert-ArtooProcessLive $api $root 'root_process_exited'
}
function Get-ArtooSessionFinalProcesses([string]$executable, [string]$profilePath) {
  Write-ArtooObserverPhase 'final_query'
  $inventory = @(Get-CimInstance Win32_Process -Filter ('ExecutablePath = ' + (ConvertTo-ArtooWqlLiteral $executable)) -Property ProcessId,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop)
  Write-ArtooObserverPhase 'final_identity'
  $owned = [Collections.Generic.List[object]]::new()
  foreach ($item in $inventory) {
    if ($item.ExecutablePath -ine $executable -or !(Test-ArtooBrowserProfile ([string]$item.CommandLine) $profilePath)) { continue }
    if ($owned.Count -ge 128) { throw 'ARTOO_BROWSER_OBSERVATION:final_observation_bound_exceeded' }
    if ($null -eq $item.CreationDate) { throw 'ARTOO_BROWSER_OBSERVATION:final_creation_missing' }
    $owned.Add([pscustomobject]@{ pid = [int]$item.ProcessId; created_utc = $item.CreationDate.ToUniversalTime().ToString('o') })
  }
  return ,$owned
}
function Get-ArtooSessionFailureCode($failure) {
  $allowed = @('command_line_unavailable', 'root_missing_or_duplicate', 'root_executable_mismatch', 'root_creation_missing',
    'root_profile_mismatch', 'root_identity_missing_or_duplicate', 'root_creation_changed', 'ancestry_cycle', 'observation_bound_exceeded',
    'process_creation_missing', 'descendant_creation_missing', 'descendant_precedes_parent', 'final_observation_bound_exceeded',
    'final_creation_missing', 'os_query_failed', 'native_binding_failed', 'native_pointer_width_unsupported', 'snapshot_create_failed',
    'snapshot_first_failed', 'snapshot_next_failed', 'snapshot_duplicate_pid', 'snapshot_bound_exceeded', 'snapshot_close_failed',
    'process_open_failed', 'process_open_access_denied', 'process_open_invalid_parameter', 'process_open_invalid_handle',
    'process_open_resource_unavailable', 'process_open_other_error', 'process_identity_failed', 'process_wait_failed',
    'process_handle_close_failed', 'root_executable_read_failed', 'root_process_exited', 'selected_process_exited', 'ancestry_changed',
    'historical_pid_reappeared', 'historical_identity_unknown', 'historical_creation_changed', 'ancestry_parent_changed',
    'observer_retry_exhausted', 'observer_deadline', 'observer_protocol_failed', 'observer_parent_eof', 'observer_cleanup_failed')
  for ($depth = 0; $depth -lt 4 -and $null -ne $failure.InnerException; $depth++) { $failure = $failure.InnerException }
  $match = [Text.RegularExpressions.Regex]::Match($failure.Message, '\AARTOO_BROWSER_OBSERVATION:([a-z_]+)\z')
  if ($match.Success -and $allowed -ccontains $match.Groups[1].Value) { return $match.Groups[1].Value }
  return 'os_query_failed'
}
function Invoke-ArtooBrowserObserverSession {
  $sessionId = $null; [long]$sequence = 0; $operation = 'ready'
  $api = $null; $root = $null; $failureCode = $null; $sessionExitCode = 1
  $boundParentPid = $null; $history = $null
  try {
    Write-ArtooObserverPhase 'script_started'
    $configuration = Read-ArtooSessionRequest
    if (Test-ArtooSessionId $configuration.session) { $sessionId = [string]$configuration.session }
    if ($null -eq $sessionId) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
    Assert-ArtooSessionKeys $configuration @('version', 'session', 'seq', 'operation', 'executable', 'profile')
    Assert-ArtooSessionBase $configuration $sessionId 0 'configure'
    Assert-ArtooSessionPath $configuration.executable
    Assert-ArtooSessionPath $configuration.profile
    $executable = [string]$configuration.executable; $profilePath = [string]$configuration.profile
    Write-ArtooObserverPhase 'native_binding'
    $api = New-ArtooBrowserNativeApi
    Initialize-ArtooSessionProvider
    Write-ArtooSessionFrame (New-ArtooSessionFrame $sessionId 0 'ready')

    $sequence = 1; $operation = 'bind'
    $request = Read-ArtooSessionRequest
    Assert-ArtooSessionKeys $request @('version', 'session', 'seq', 'operation', 'parent_pid')
    Assert-ArtooSessionBase $request $sessionId $sequence $operation
    Assert-ArtooSessionInteger $request.parent_pid 1 4294967295
    Write-ArtooObserverPhase 'root_handle'
    $root = Open-ArtooProcessIdentity $api ([uint32]$request.parent_pid)
    Assert-ArtooSessionRootIdentity $api $root $executable $profilePath
    $boundParentPid = $root.Pid
    $frame = New-ArtooSessionFrame $sessionId $sequence $operation
    $frame['parent_pid'] = $root.Pid
    Write-ArtooSessionFrame $frame

    $sequence = 2; $operation = 'initial'
    $request = Read-ArtooSessionRequest
    Assert-ArtooSessionKeys $request @('version', 'session', 'seq', 'operation')
    Assert-ArtooSessionBase $request $sessionId $sequence $operation
    # One budget includes root revalidation and every stable-snapshot attempt.
    $budget = [Diagnostics.Stopwatch]::StartNew()
    $history = New-ArtooObservationHistory $boundParentPid
    Assert-ArtooSessionRootIdentity $api $root $executable $profilePath
    $owned = Get-ArtooStableOwnedIdentities $api $root $history $budget
    $frame = New-ArtooSessionFrame $sessionId $sequence $operation
    $frame['parent_pid'] = $root.Pid; $frame['processes'] = @($owned.ToArray())
    $frame['exit_history'] = [ordered]@{ version = 1; pids = @(Get-ArtooObservationExitPids $history) }
    Write-ArtooSessionFrame $frame

    $sequence = 3; $operation = 'final'
    while ($true) {
      $request = Read-ArtooSessionRequest
      Assert-ArtooSessionKeys $request @('version', 'session', 'seq', 'operation')
      Assert-ArtooSessionBase $request $sessionId $sequence $operation
      $owned = Get-ArtooSessionFinalProcesses $executable $profilePath
      $frame = New-ArtooSessionFrame $sessionId $sequence $operation
      $frame['processes'] = @($owned.ToArray())
      if ($owned.Count -eq 0) {
        # A failed close must never leave an apparently successful empty-final frame.
        $held = $root; $root = $null
        try { $released = Close-ArtooProcessHandle $api $held.Handle }
        catch { throw 'ARTOO_BROWSER_OBSERVATION:observer_cleanup_failed' }
        if (!$released) { throw 'ARTOO_BROWSER_OBSERVATION:observer_cleanup_failed' }
        Write-ArtooObserverPhase 'observation_result'
        Write-ArtooSessionFrame $frame
        $sessionExitCode = 0
        break
      }
      Write-ArtooSessionFrame $frame
      if ($sequence -eq 9007199254740991) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
      $sequence++
    }
  } catch { $failureCode = Get-ArtooSessionFailureCode $_.Exception }
  finally {
    if ($null -ne $root) {
      $held = $root; $root = $null
      try { $released = Close-ArtooProcessHandle $api $held.Handle }
      catch { $released = $false }
      if (!$released) { $failureCode = 'observer_cleanup_failed'; $sessionExitCode = 1 }
    }
  }
  if ($null -ne $failureCode) {
    $sessionExitCode = 1
    # Before a canonical configure session exists, EOF/exit is the only safe response.
    if ($null -ne $sessionId) {
      $frame = New-ArtooSessionFrame $sessionId $sequence $operation
      $frame['status'] = 'error'; $frame['error_code'] = $failureCode
      try {
        if ($operation -ceq 'initial' -and $null -ne $history -and $null -ne $boundParentPid) {
          # Cleanup clears $root. Preserve the original binding for negative evidence;
          # it never supplies process identities or changes the failing exit status.
          $frame['parent_pid'] = $boundParentPid
          $frame['exit_history'] = [ordered]@{ version = 1; pids = @(Get-ArtooObservationExitPids $history) }
          if ($failureCode -ceq 'descendant_precedes_parent' -and $null -ne $history.AncestryFailure) {
            $frame['ancestry_failure'] = $history.AncestryFailure
          }
          if ($failureCode -ceq 'observation_bound_exceeded' -and $null -ne $history.BoundFailure) {
            $frame['observation_bound_failure'] = $history.BoundFailure
          }
        }
        Write-ArtooSessionFrame $frame
      } catch { }
    }
  }
  return [int]$sessionExitCode
}
exit (Invoke-ArtooBrowserObserverSession)
`;
