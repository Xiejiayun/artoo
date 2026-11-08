// Fixed documented Win32 calls, emitted in memory with public .NET Framework APIs.
// No Add-Type, compiler child, assembly file, NT API, or task-supplied native source.
export const WINDOWS_BROWSER_NATIVE_OBSERVER_SCRIPT = String.raw`
function New-ArtooBrowserNativeApi {
  $name = [Reflection.AssemblyName]::new('ArtooBrowserProcessObservationV1')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule($name.Name)
  $builder = $module.DefineType('ArtooBrowserProcessNativeV1', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $refLong = [long].MakeByRefType()
  $specifications = @(
    @{ Name = 'CreateToolhelp32Snapshot'; Return = [IntPtr]; Args = [Type[]]@([uint32], [uint32]) },
    @{ Name = 'Process32FirstW'; Return = [bool]; Args = [Type[]]@([IntPtr], [IntPtr]) },
    @{ Name = 'Process32NextW'; Return = [bool]; Args = [Type[]]@([IntPtr], [IntPtr]) },
    @{ Name = 'OpenProcess'; Return = [IntPtr]; Args = [Type[]]@([uint32], [bool], [uint32]) },
    @{ Name = 'GetProcessId'; Return = [uint32]; Args = [Type[]]@([IntPtr]) },
    @{ Name = 'GetProcessTimes'; Return = [bool]; Args = [Type[]]@([IntPtr], $refLong, $refLong, $refLong, $refLong) },
    @{ Name = 'QueryFullProcessImageNameW'; Return = [bool]; Args = [Type[]]@([IntPtr], [uint32], [Text.StringBuilder], [uint32].MakeByRefType()) },
    @{ Name = 'WaitForSingleObject'; Return = [uint32]; Args = [Type[]]@([IntPtr], [uint32]) },
    @{ Name = 'CloseHandle'; Return = [bool]; Args = [Type[]]@([IntPtr]) }
  )
  $importType = [Runtime.InteropServices.DllImportAttribute]
  $constructor = $importType.GetConstructor([Type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@('EntryPoint', 'SetLastError', 'ExactSpelling', 'CallingConvention', 'CharSet', 'PreserveSig' | ForEach-Object { $importType.GetField($_) })
  foreach ($specification in $specifications) {
    # DefineMethod plus the complete public DllImportAttribute installs all import
    # flags together. Framework DefinePInvokeMethod's default mapping ignores a
    # later attempt to replace SetLastError/ExactSpelling through that attribute.
    $method = $builder.DefineMethod($specification.Name,
      [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
      $specification.Return, $specification.Args)
    $values = [object[]]@($specification.Name, $true, $true, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode, $true)
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($constructor, [object[]]@('kernel32.dll'), $fields, $values)
    $method.SetCustomAttribute($attribute)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $api = $builder.CreateType()
  # In particular, do not infer ERROR_NO_MORE_FILES unless the generated P/Invoke
  # metadata really preserves the native last error. Check public metadata first.
  foreach ($specification in $specifications) {
    $attributes = @($api.GetMethod($specification.Name).GetCustomAttributes($importType, $false))
    if ($attributes.Count -ne 1 -or $attributes[0].Value -cne 'kernel32.dll' -or
      $attributes[0].EntryPoint -cne $specification.Name -or !$attributes[0].SetLastError -or
      !$attributes[0].ExactSpelling -or !$attributes[0].PreserveSig -or
      $attributes[0].CallingConvention -ne [Runtime.InteropServices.CallingConvention]::Winapi -or
      $attributes[0].CharSet -ne [Runtime.InteropServices.CharSet]::Unicode) {
      throw 'ARTOO_BROWSER_OBSERVATION:native_binding_failed'
    }
  }
  return $api
}
function Close-ArtooProcessHandle([Type]$api, [IntPtr]$handle) { return $api::CloseHandle($handle) }
function Get-ArtooProcessSnapshot([Type]$api) {
  # PROCESSENTRY32W has the documented default Windows alignment: PID at byte 8;
  # PPID at 32/24 and total size 568/556 for 64/32-bit pointers respectively.
  if ([IntPtr]::Size -eq 8) { $size = 568; $parentOffset = 32 }
  elseif ([IntPtr]::Size -eq 4) { $size = 556; $parentOffset = 24 }
  else { throw 'ARTOO_BROWSER_OBSERVATION:native_pointer_width_unsupported' }
  $snapshot = $api::CreateToolhelp32Snapshot(2, 0)
  if ($snapshot -eq [IntPtr]::Zero -or $snapshot -eq [IntPtr]::new(-1)) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_create_failed' }
  $buffer = [IntPtr]::Zero
  try {
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    [Runtime.InteropServices.Marshal]::WriteInt32($buffer, $size)
    $success = $api::Process32FirstW($snapshot, $buffer)
    if (!$success) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_first_failed' }
    $inventory = [Collections.Generic.Dictionary[uint32,uint32]]::new()
    while ($success) {
      $observedPid = [uint32]([long][Runtime.InteropServices.Marshal]::ReadInt32($buffer, 8) -band 0xffffffffL)
      $parent = [uint32]([long][Runtime.InteropServices.Marshal]::ReadInt32($buffer, $parentOffset) -band 0xffffffffL)
      if ($inventory.ContainsKey($observedPid)) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_duplicate_pid' }
      if ($inventory.Count -ge 65536) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_bound_exceeded' }
      $inventory.Add($observedPid, $parent)
      $success = $api::Process32NextW($snapshot, $buffer)
      $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if (!$success -and $lastError -ne 18) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_next_failed' }
    }
    return ,$inventory
  } finally {
    $closed = Close-ArtooProcessHandle $api $snapshot
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    if (!$closed) { throw 'ARTOO_BROWSER_OBSERVATION:snapshot_close_failed' }
  }
}
function Get-ArtooProcessOpenFailureCode([int]$nativeError) {
  switch ($nativeError) {
    5 { return 'process_open_access_denied' }
    87 { return 'process_open_invalid_parameter' }
    6 { return 'process_open_invalid_handle' }
    8 { return 'process_open_resource_unavailable' }
    14 { return 'process_open_resource_unavailable' }
    default { return 'process_open_other_error' }
  }
}
function Open-ArtooProcessIdentity([Type]$api, [uint32]$processId) {
  # PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, read-only and non-inheritable.
  $handle = $api::OpenProcess(0x00101000, $false, $processId)
  $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($handle -eq [IntPtr]::Zero) { throw ('ARTOO_BROWSER_OBSERVATION:' + (Get-ArtooProcessOpenFailureCode $nativeError)) }
  try {
    [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0
    if ($api::GetProcessId($handle) -ne $processId -or
      !$api::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user) -or $created -le 0) {
      throw 'ARTOO_BROWSER_OBSERVATION:process_identity_failed'
    }
    return [pscustomobject]@{ Handle = $handle; Pid = $processId; Creation = $created }
  } catch {
    if (!(Close-ArtooProcessHandle $api $handle)) { throw 'ARTOO_BROWSER_OBSERVATION:process_handle_close_failed' }
    throw
  }
}
function Assert-ArtooProcessLive([Type]$api, $identity, [string]$failureCode) {
  $status = $api::WaitForSingleObject($identity.Handle, 0)
  if ($status -ne 0 -and $status -ne 258) { throw 'ARTOO_BROWSER_OBSERVATION:process_wait_failed' }
  if ($status -ne 258) { throw ('ARTOO_BROWSER_OBSERVATION:' + $failureCode) }
}
function Assert-ArtooRootImage([Type]$api, $identity, [string]$expected) {
  $image = [Text.StringBuilder]::new(32768); [uint32]$length = $image.Capacity
  if (!$api::QueryFullProcessImageNameW($identity.Handle, 0, $image, [ref]$length)) { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_read_failed' }
  if ($image.ToString() -ine $expected) { throw 'ARTOO_BROWSER_OBSERVATION:root_executable_mismatch' }
}
function Assert-ArtooCimCreation($root, [DateTime]$creation) {
  $cim = $creation.ToUniversalTime().ToFileTimeUtc()
  # Do not use PowerShell '/' here: floating-point division loses FILETIME bits.
  [long]$nativeRemainder = 0; [long]$cimRemainder = 0
  $nativeMicros = [Math]::DivRem([long]$root.Creation, [long]10, [ref]$nativeRemainder)
  $cimMicros = [Math]::DivRem([long]$cim, [long]10, [ref]$cimRemainder)
  if ($cim -ne $root.Creation -and !($cimRemainder -eq 0 -and $cimMicros -eq $nativeMicros)) { throw 'ARTOO_BROWSER_OBSERVATION:root_creation_changed' }
}
function Stop-ArtooObservationBound($history, [uint32]$rootId, [string]$source, [int]$count, [string]$census) {
  try {
    # Count is the observation collection at rejection, not verified process ownership.
    # Diagnostic recording must never replace the original bound failure.
    if ($null -ne $history -and $null -eq $history.BoundFailure) {
      $history.BoundFailure = [ordered]@{
        version = 1; source = $source; count = $count; attempt = $history.Attempts; census = $census; root_pid = $rootId
      }
    }
  } finally { throw 'ARTOO_BROWSER_OBSERVATION:observation_bound_exceeded' }
}
function Select-ArtooProcessTree($inventory, [uint32]$rootId, $history = $null, [string]$diagnosticCensus = '') {
  if (!$inventory.ContainsKey($rootId)) { throw 'ARTOO_BROWSER_OBSERVATION:root_missing_or_duplicate' }
  $selected = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[uint32]]::new()
  $selected.Add([pscustomobject]@{ Pid = $rootId; Parent = $inventory[$rootId] }); [void]$seen.Add($rootId)
  for ($index = 0; $index -lt $selected.Count; $index++) {
    foreach ($entry in $inventory.GetEnumerator()) {
      if ($entry.Value -ne $selected[$index].Pid) { continue }
      if ($entry.Key -eq 0 -or !$seen.Add($entry.Key)) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_cycle' }
      if ($selected.Count -ge 128) { Stop-ArtooObservationBound $history $rootId 'current_subtree' $selected.Count $diagnosticCensus }
      $selected.Add([pscustomobject]@{ Pid = $entry.Key; Parent = $entry.Value })
    }
  }
  return ,$selected
}
function Get-ArtooOwnedIdentities([Type]$api, $root) {
  Assert-ArtooProcessLive $api $root 'root_process_exited'
  Write-ArtooObserverPhase 'ancestry_snapshot'
  $selected = Select-ArtooProcessTree (Get-ArtooProcessSnapshot $api) $root.Pid
  Write-ArtooObserverPhase 'ancestry_identities'
  $identities = [Collections.Generic.Dictionary[uint32,object]]::new(); $identities.Add($root.Pid, $root)
  $descendants = [Collections.Generic.List[object]]::new()
  try {
    for ($index = 1; $index -lt $selected.Count; $index++) {
      $edge = $selected[$index]
      $child = Open-ArtooProcessIdentity $api $edge.Pid
      $descendants.Add($child)
      Assert-ArtooProcessLive $api $child 'selected_process_exited'
      if ($child.Creation -lt $identities[$edge.Parent].Creation) { throw 'ARTOO_BROWSER_OBSERVATION:descendant_precedes_parent' }
      $identities.Add($edge.Pid, $child)
    }
    Write-ArtooObserverPhase 'ancestry_confirmation'
    $current = Select-ArtooProcessTree (Get-ArtooProcessSnapshot $api) $root.Pid
    if ($current.Count -ne $selected.Count) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_changed' }
    $currentParents = [Collections.Generic.Dictionary[uint32,uint32]]::new()
    foreach ($entry in $current) { $currentParents.Add($entry.Pid, $entry.Parent) }
    foreach ($entry in $selected) {
      if (!$currentParents.ContainsKey($entry.Pid) -or $currentParents[$entry.Pid] -ne $entry.Parent) { throw 'ARTOO_BROWSER_OBSERVATION:ancestry_changed' }
      $code = if ($entry.Pid -eq $root.Pid) { 'root_process_exited' } else { 'selected_process_exited' }
      Assert-ArtooProcessLive $api $identities[$entry.Pid] $code
    }
    $result = [Collections.Generic.List[object]]::new()
    foreach ($entry in $selected) {
      $result.Add([pscustomobject]@{ pid = $entry.Pid; created_utc = [DateTime]::FromFileTimeUtc($identities[$entry.Pid].Creation).ToString('o') })
    }
    return ,$result
  } finally {
    $closeFailed = $false
    for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
      if (!(Close-ArtooProcessHandle $api $descendants[$index].Handle)) { $closeFailed = $true }
    }
    if ($closeFailed) { throw 'ARTOO_BROWSER_OBSERVATION:process_handle_close_failed' }
  }
}
`;
