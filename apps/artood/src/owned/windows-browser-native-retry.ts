/** Fixed worker helpers. Retry/history are read-only observations, never termination authority. */
export const WINDOWS_BROWSER_NATIVE_RETRY_SCRIPT = String.raw`
function New-ArtooObservationHistory([uint32]$rootPid) {
  $seen = [Collections.Generic.HashSet[uint32]]::new(); [void]$seen.Add($rootPid)
  return [pscustomobject]@{
    RootPid = $rootPid; Seen = $seen
    Creation = [Collections.Generic.Dictionary[uint32,long]]::new()
    FirstAttempt = [Collections.Generic.Dictionary[uint32,int]]::new()
    Parents = [Collections.Generic.Dictionary[uint32,uint32]]::new()
    Uncertain = [Collections.Generic.HashSet[uint32]]::new()
    PendingMissing = [Collections.Generic.HashSet[uint32]]::new()
    Absent = [Collections.Generic.HashSet[uint32]]::new()
    Exited = [Collections.Generic.HashSet[uint32]]::new()
    Attempts = 0
  }
}
function Get-ArtooObservationExitPids($history) {
  $pids = [Collections.Generic.List[uint32]]::new()
  foreach ($value in $history.Seen) { if ($value -ne $history.RootPid) { $pids.Add($value) } }
  $pids.Sort()
  return $pids.ToArray()
}
function Assert-ArtooObservationBudget([Diagnostics.Stopwatch]$budget) {
  if (!$budget.IsRunning -or $budget.ElapsedMilliseconds -ge 5000) { throw 'ARTOO_BROWSER_OBSERVATION:observer_deadline' }
}
function Get-ArtooRetryExceptionCode($failure) {
  for ($depth = 0; $depth -lt 4 -and $null -ne $failure.InnerException; $depth++) { $failure = $failure.InnerException }
  $match = [Text.RegularExpressions.Regex]::Match($failure.Message, '\AARTOO_BROWSER_OBSERVATION:([a-z_]+)\z')
  if ($match.Success) { return $match.Groups[1].Value }
  return 'os_query_failed'
}
function Register-ArtooObservationSnapshot($inventory, $root, $history) {
  $selected = Select-ArtooProcessTree $inventory $root.Pid
  # Capture the entire selected subtree before interpreting any individual error.
  # This includes the fresh inventory used to corroborate an OpenProcess 87.
  foreach ($entry in $selected) {
    if (!$history.Seen.Contains($entry.Pid)) {
      if ($history.Seen.Count -ge 128) { throw 'ARTOO_BROWSER_OBSERVATION:observation_bound_exceeded' }
      [void]$history.Seen.Add($entry.Pid)
      $history.FirstAttempt.Add($entry.Pid, $history.Attempts)
    }
  }
  foreach ($value in $history.Seen) {
    if (!$inventory.ContainsKey($value)) {
      if ($value -eq $root.Pid) { throw 'ARTOO_BROWSER_OBSERVATION:root_missing_or_duplicate' }
      [void]$history.Absent.Add($value)
      continue
    }
    if ($history.Absent.Contains($value)) { throw 'ARTOO_BROWSER_OBSERVATION:historical_pid_reappeared' }
    if ($value -ne $root.Pid -and $history.Uncertain.Contains($value) -and
      !$history.PendingMissing.Contains($value) -and $history.FirstAttempt[$value] -lt $history.Attempts) {
      throw 'ARTOO_BROWSER_OBSERVATION:historical_identity_unknown'
    }
    if ($history.Parents.ContainsKey($value)) {
      if ($history.Parents[$value] -ne $inventory[$value]) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_parent_changed' }
    } else { $history.Parents.Add($value, $inventory[$value]) }
  }
  return ,$selected
}
function Read-ArtooObservationIdentities([Type]$api, $root, $inventory, $history, $attempt, [Diagnostics.Stopwatch]$budget) {
  # Previously seen live orphans are checked too. A changed identity outside the
  # current root subtree must not disappear merely because its parent has exited.
  foreach ($value in $history.Seen) {
    if ($value -eq $root.Pid -or !$inventory.ContainsKey($value) -or $attempt.Identities.ContainsKey($value)) { continue }
    Assert-ArtooObservationBudget $budget
    Assert-ArtooProcessLive $api $root 'root_process_exited'
    if ($history.Uncertain.Contains($value)) {
      # An earlier failed open is never repaired by assigning a later process's
      # creation time to that unidentified historical PID.
      if ($history.PendingMissing.Contains($value)) { $attempt.Retry = $true; continue }
      throw 'ARTOO_BROWSER_OBSERVATION:historical_identity_unknown'
    }
    $child = $null
    try { $child = Open-ArtooProcessIdentity $api $value }
    catch {
      if ((Get-ArtooRetryExceptionCode $_.Exception) -cne 'process_open_invalid_parameter') { throw }
      [void]$history.Uncertain.Add($value); [void]$attempt.Missing.Add($value)
      # Only this actual native failure admits bounded absence observation. Other
      # unidentified historical PIDs still fail closed, including across attempts.
      [void]$history.PendingMissing.Add($value)
      $attempt.Retry = $true
      continue
    }
    $attempt.Held.Add($child)
    if ($history.Creation.ContainsKey($value)) {
      if ($history.Creation[$value] -ne $child.Creation) { throw 'ARTOO_BROWSER_OBSERVATION:historical_creation_changed' }
    } else {
      if ($history.FirstAttempt[$value] -ne $history.Attempts) { throw 'ARTOO_BROWSER_OBSERVATION:historical_identity_unknown' }
      $history.Creation.Add($value, [long]$child.Creation)
    }
    $attempt.Identities.Add($value, $child)
    try {
      Assert-ArtooProcessLive $api $child 'selected_process_exited'
      if ($history.Exited.Contains($value)) { throw 'ARTOO_BROWSER_OBSERVATION:historical_creation_changed' }
    } catch {
      if ((Get-ArtooRetryExceptionCode $_.Exception) -cne 'selected_process_exited') { throw }
      [void]$history.Exited.Add($value); $attempt.Retry = $true
    }
  }
}
function Assert-ArtooObservationParents($selected, $attempt) {
  foreach ($entry in $selected) {
    if ($entry.Pid -eq $attempt.RootPid) { continue }
    if (!$attempt.Identities.ContainsKey($entry.Pid) -or !$attempt.Identities.ContainsKey($entry.Parent)) {
      $attempt.Retry = $true; continue
    }
    if ($attempt.Identities[$entry.Pid].Creation -lt $attempt.Identities[$entry.Parent].Creation) {
      throw 'ARTOO_BROWSER_OBSERVATION:descendant_precedes_parent'
    }
  }
}
function Confirm-ArtooMissingObservation($inventory, $history, $attempt) {
  foreach ($value in @($history.PendingMissing)) {
    # 87 is not disappearance. Retain unresolved PIDs without reopening them;
    # only a later complete global census proves absence. This whole attempt
    # remains observation-only even when absence is confirmed by its first census.
    $attempt.Retry = $true
    if (!$inventory.ContainsKey($value)) { [void]$history.PendingMissing.Remove($value) }
  }
}
function Get-ArtooStableOwnedIdentities([Type]$api, $root, $history, [Diagnostics.Stopwatch]$budget) {
  if ($history.RootPid -ne $root.Pid -or $history.Attempts -ne 0) { throw 'ARTOO_BROWSER_OBSERVATION:observer_protocol_failed' }
  $history.Creation.Add($root.Pid, [long]$root.Creation)
  $history.FirstAttempt.Add($root.Pid, 0)
  for ($number = 1; $number -le 3; $number++) {
    $history.Attempts = $number
    Assert-ArtooObservationBudget $budget
    Assert-ArtooProcessLive $api $root 'root_process_exited'
    $attempt = [pscustomobject]@{
      RootPid = $root.Pid; Retry = ($history.PendingMissing.Count -gt 0)
      Identities = [Collections.Generic.Dictionary[uint32,object]]::new()
      Held = [Collections.Generic.List[object]]::new()
      Missing = [Collections.Generic.HashSet[uint32]]::new()
    }
    $attempt.Identities.Add($root.Pid, $root)
    $result = $null
    try {
      Write-ArtooObserverPhase 'ancestry_snapshot'
      $firstInventory = Get-ArtooProcessSnapshot $api
      $first = Register-ArtooObservationSnapshot $firstInventory $root $history
      Confirm-ArtooMissingObservation $firstInventory $history $attempt
      Write-ArtooObserverPhase 'ancestry_identities'
      Read-ArtooObservationIdentities $api $root $firstInventory $history $attempt $budget
      Assert-ArtooObservationParents $first $attempt

      Assert-ArtooObservationBudget $budget
      Assert-ArtooProcessLive $api $root 'root_process_exited'
      Write-ArtooObserverPhase 'ancestry_confirmation'
      $secondInventory = Get-ArtooProcessSnapshot $api
      $second = Register-ArtooObservationSnapshot $secondInventory $root $history
      # Resolve pending absence from the complete inventory before reading newly
      # selected members. Still-present failures remain pending, never identities.
      Confirm-ArtooMissingObservation $secondInventory $history $attempt
      $missingBeforeSecond = $attempt.Missing.Count
      Read-ArtooObservationIdentities $api $root $secondInventory $history $attempt $budget
      Assert-ArtooObservationParents $second $attempt

      if ($attempt.Missing.Count -gt $missingBeforeSecond) {
        # A newly seen second-snapshot child may also vanish. This extra complete
        # census is corroboration only, never a shortcut to a successful pair.
        Assert-ArtooObservationBudget $budget
        Assert-ArtooProcessLive $api $root 'root_process_exited'
        $corroboratingInventory = Get-ArtooProcessSnapshot $api
        $corroborating = Register-ArtooObservationSnapshot $corroboratingInventory $root $history
        Confirm-ArtooMissingObservation $corroboratingInventory $history $attempt
        Read-ArtooObservationIdentities $api $root $corroboratingInventory $history $attempt $budget
        Assert-ArtooObservationParents $corroborating $attempt
        # A further 87 stays pending for an already available next attempt.
        # There is no fourth census here, new attempt, or renewed time budget.
        $attempt.Retry = $true
      }

      if ($first.Count -ne $second.Count) { $attempt.Retry = $true }
      else {
        $secondParents = [Collections.Generic.Dictionary[uint32,uint32]]::new()
        foreach ($entry in $second) { $secondParents.Add($entry.Pid, $entry.Parent) }
        foreach ($entry in $first) {
          if (!$secondParents.ContainsKey($entry.Pid)) { $attempt.Retry = $true; continue }
          if ($secondParents[$entry.Pid] -ne $entry.Parent) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_parent_changed' }
        }
      }
      foreach ($entry in $first) {
        if (!$attempt.Identities.ContainsKey($entry.Pid)) { $attempt.Retry = $true; continue }
        $code = if ($entry.Pid -eq $root.Pid) { 'root_process_exited' } else { 'selected_process_exited' }
        try { Assert-ArtooProcessLive $api $attempt.Identities[$entry.Pid] $code }
        catch {
          if ((Get-ArtooRetryExceptionCode $_.Exception) -cne 'selected_process_exited') { throw }
          [void]$history.Exited.Add($entry.Pid); $attempt.Retry = $true
        }
      }
      Assert-ArtooObservationBudget $budget
      Assert-ArtooProcessLive $api $root 'root_process_exited'
      if (!$attempt.Retry) {
        $result = [Collections.Generic.List[object]]::new()
        foreach ($entry in $first) {
          $result.Add([pscustomobject]@{ pid = $entry.Pid; created_utc = [DateTime]::FromFileTimeUtc($attempt.Identities[$entry.Pid].Creation).ToString('o') })
        }
      }
    } finally {
      $closeFailed = $false
      for ($index = $attempt.Held.Count - 1; $index -ge 0; $index--) {
        try { if (!(Close-ArtooProcessHandle $api $attempt.Held[$index].Handle)) { $closeFailed = $true } }
        catch { $closeFailed = $true }
      }
      foreach ($value in $history.Seen) {
        if (!$history.Creation.ContainsKey($value)) { [void]$history.Uncertain.Add($value) }
      }
      if ($closeFailed) { throw 'ARTOO_BROWSER_OBSERVATION:process_handle_close_failed' }
    }
    Assert-ArtooObservationBudget $budget
    Assert-ArtooProcessLive $api $root 'root_process_exited'
    if ($null -ne $result) { return ,$result }
  }
  throw 'ARTOO_BROWSER_OBSERVATION:observer_retry_exhausted'
}
`;
