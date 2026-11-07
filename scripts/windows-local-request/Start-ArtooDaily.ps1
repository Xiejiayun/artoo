#requires -Version 7.5
# Local installation metadata is trusted configuration, not a signature.
[CmdletBinding(PositionalBinding = $false)]
param([string]$Objective, [string]$ObjectiveFile, [string]$Config, [switch]$BrowserInput)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$PSNativeCommandArgumentPassing = 'Standard'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This entry requires native Windows.' }
if ($args.Count -ne 0) { throw 'Use only -Objective, -ObjectiveFile, -Config and -BrowserInput.' }

function Assert-ArtooShape($Value, [string[]]$Required, [string[]]$Optional = @()) {
    if ($Value -isnot [Collections.IDictionary]) { throw 'Invalid local installation object.' }
    foreach ($artooField in $Required) {
        if (@($Value.Keys) -cnotcontains $artooField) { throw 'Missing local installation field.' }
    }
    foreach ($artooField in $Value.Keys) {
        if ($artooField -cnotin @($Required + $Optional)) { throw 'Unexpected local installation field.' }
    }
}
function Get-ArtooPhysicalFile([object]$Value, [long]$MaximumBytes) {
    if ($Value -isnot [string] -or $Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[\x00-\x1f\x7f]' -or
        $Value.Substring(2).Contains(':') -or -not [IO.Path]::GetFullPath($Value).Equals($Value, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installation paths must be normalized absolute Windows file paths.'
    }
    $artooItem = Get-Item -LiteralPath $Value -Force
    if ($artooItem -isnot [IO.FileInfo] -or $artooItem.Length -gt $MaximumBytes) { throw 'Invalid installation file or size.' }
    $artooCurrent = $artooItem
    while ($null -ne $artooCurrent) {
        if (($artooCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked installation paths are not supported.' }
        if ($artooCurrent.PSObject.Properties['LinkType'] -and $artooCurrent.LinkType) { throw 'Linked installation files are not supported.' }
        $artooCurrent = if ($artooCurrent -is [IO.FileInfo]) { $artooCurrent.Directory } else { $artooCurrent.Parent }
    }
    return $artooItem
}
function Read-ArtooJson([string]$File, [long]$MaximumBytes) {
    $null = Get-ArtooPhysicalFile $File $MaximumBytes
    try {
        $artooBytes = [IO.File]::ReadAllBytes($File)
        if ($artooBytes.Length -gt $MaximumBytes) { throw 'Too large' }
        $artooText = [Text.UTF8Encoding]::new($false, $true).GetString($artooBytes)
        $artooDocument = [System.Text.Json.JsonDocument]::Parse($artooText, [System.Text.Json.JsonDocumentOptions]::new())
        try {
            if ($artooDocument.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'JSON object required' }
        }
        finally { $artooDocument.Dispose() }
        $artooParsed = ConvertFrom-Json -InputObject $artooText -AsHashtable -Depth 100 -NoEnumerate
        if ($artooParsed -isnot [Collections.IDictionary]) { throw 'JSON object required' }
        # A PowerShell function must not flatten a top-level single-item array.
        return ,$artooParsed
    }
    catch { throw 'Invalid local installation JSON.' }
}
function Assert-ArtooPin($Pin, [long]$MaximumBytes) {
    Assert-ArtooShape $Pin @('path', 'bytes', 'sha256')
    if (($Pin.bytes -isnot [int] -and $Pin.bytes -isnot [long]) -or $Pin.bytes -lt 0 -or $Pin.bytes -gt $MaximumBytes -or
        $Pin.sha256 -isnot [string] -or $Pin.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid installation file pin.' }
    $artooItem = Get-ArtooPhysicalFile $Pin.path $MaximumBytes
    if ($artooItem.Length -ne $Pin.bytes) { throw 'Installation file length changed.' }
    $artooHash = (Get-FileHash -LiteralPath $Pin.path -Algorithm SHA256).Hash.ToLowerInvariant()
    $artooAfter = Get-ArtooPhysicalFile $Pin.path $MaximumBytes
    if ($artooHash -cne $Pin.sha256 -or $artooAfter.Length -ne $Pin.bytes -or
        $artooAfter.LastWriteTimeUtc -ne $artooItem.LastWriteTimeUtc) { throw 'Installation file identity changed.' }
    return $artooItem.FullName
}
function Assert-ArtooCredential([object]$Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 8192 -or
        $Value.IndexOfAny([char[]]"`r`n`0") -ge 0) { throw 'The configured Aerial credential is invalid.' }
}

$artooHasObjective = $PSBoundParameters.ContainsKey('Objective')
$artooHasFile = $PSBoundParameters.ContainsKey('ObjectiveFile')
if (($artooHasObjective -and $artooHasFile) -or ($BrowserInput -and ($artooHasObjective -or $artooHasFile))) {
    throw 'Select only one of -Objective, -ObjectiveFile and -BrowserInput.'
}
if (-not $PSBoundParameters.ContainsKey('Config')) {
    $artooLocalData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
    if ([string]::IsNullOrWhiteSpace($artooLocalData)) { throw 'Use -Config or configure the local installation directory.' }
    $Config = Join-Path $artooLocalData 'Artoo\windows-local-request\LOCAL-INSTALLATION.json'
}
$artooEntry = Join-Path $PSScriptRoot 'start.mjs'
$null = Get-ArtooPhysicalFile $artooEntry (4MB)
$artooLocal = Read-ArtooJson $Config (64KB)
Assert-ArtooShape $artooLocal @('version', 'installation', 'runtime', 'authorization')
if (($artooLocal.version -isnot [int] -and $artooLocal.version -isnot [long]) -or $artooLocal.version -ne 1) { throw 'Unsupported local installation version.' }
Assert-ArtooShape $artooLocal.runtime @('private_parent', 'provider_key_env', 'timeout_minutes')
Assert-ArtooShape $artooLocal.authorization @('scope', 'policy_version')
if ($artooLocal.runtime.private_parent -isnot [string] -or $artooLocal.runtime.provider_key_env -isnot [string] -or
    $artooLocal.runtime.provider_key_env -cne 'ARTOO_CODEX_PROVIDER_KEY' -or
    ($artooLocal.runtime.timeout_minutes -isnot [int] -and $artooLocal.runtime.timeout_minutes -isnot [long]) -or
    $artooLocal.runtime.timeout_minutes -lt 5 -or $artooLocal.runtime.timeout_minutes -gt 180 -or
    $artooLocal.authorization.scope -isnot [string] -or $artooLocal.authorization.scope -cne 'github-copilot-via-aerial' -or
    $artooLocal.authorization.policy_version -isnot [string] -or $artooLocal.authorization.policy_version -cnotmatch '^sha256:[a-f0-9]{64}$') {
    throw 'Invalid runtime or provider authorization configuration.'
}
$artooInstallationFile = Assert-ArtooPin $artooLocal.installation (64MB)
$artooInstallation = Read-ArtooJson $artooInstallationFile (64MB)
Assert-ArtooShape $artooInstallation @('format', 'daemon', 'server', 'programs') @('web')
if ($artooInstallation.format -isnot [string] -or $artooInstallation.format -cne 'artoo.windows-single-goal-installation.v1') { throw 'Unsupported installation manifest.' }
Assert-ArtooShape $artooInstallation.daemon @('root', 'manifest', 'tree')
Assert-ArtooShape $artooInstallation.server @('root', 'package_files', 'trees', 'dependencies')
Assert-ArtooShape $artooInstallation.programs @('node', 'codex', 'git', 'browser')
if ($artooInstallation.Contains('web')) { Assert-ArtooShape $artooInstallation.web @('root', 'tree') }
$artooNode = Assert-ArtooPin $artooInstallation.programs.node (512MB)
if ([IO.Path]::GetExtension($artooNode) -ine '.exe') { throw 'The installation must select a native Node executable.' }
# Recheck the named manifest after parsing it; the real entry then verifies all
# runtime files, other executables, private roots and authorization before work.
$null = Assert-ArtooPin $artooLocal.installation (64MB)
if (-not $BrowserInput -and -not $artooHasObjective -and -not $artooHasFile) {
    # Host UI prompts need not reach redirected standard streams. Use the same
    # standard input/output that the directly invoked Node entry will inherit.
    $artooConsoleInputEncoding = [Console]::InputEncoding
    $artooConsoleOutputEncoding = [Console]::OutputEncoding
    try {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
        [Console]::Out.Write('请输入产品需求: ')
        [Console]::Out.Flush()
        $Objective = [Console]::ReadLine()
    }
    finally {
        [Console]::InputEncoding = $artooConsoleInputEncoding
        [Console]::OutputEncoding = $artooConsoleOutputEncoding
    }
}
$artooRequest = if ($artooHasFile) { $ObjectiveFile } else { $Objective }
if (-not $BrowserInput -and [string]::IsNullOrWhiteSpace($artooRequest)) { throw 'Provide a nonempty requirement or objective file path.' }
$artooArguments = @($artooEntry, '--config', $Config, '--stdin-control')
$artooArguments += if ($BrowserInput) { @('--browser-input') } elseif ($artooHasFile) { @('--objective-file', $ObjectiveFile) } else { @('--objective', $Objective) }

$artooSavedEnvironment = @{}
foreach ($artooName in @('ARTOO_CODEX_PROVIDER_KEY', 'NODE_OPTIONS', 'NODE_PATH')) {
    $artooValue = [Environment]::GetEnvironmentVariable($artooName, 'Process')
    $artooSavedEnvironment[$artooName] = @{ present = $null -ne $artooValue; value = $artooValue }
}
$artooValue = $null
$artooKey = $null
$artooExitCode = 1
try {
    # Prevent root Node preloads before start.mjs can validate the installation.
    # PowerShell converts ordinary $null to an empty string for this .NET call.
    # NullString preserves the difference between deleting and setting empty.
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', [System.Management.Automation.Language.NullString]::Value, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_PATH', [System.Management.Automation.Language.NullString]::Value, 'Process')
    if ($artooSavedEnvironment.ARTOO_CODEX_PROVIDER_KEY.present) {
        $artooKey = $artooSavedEnvironment.ARTOO_CODEX_PROVIDER_KEY.value
        Assert-ArtooCredential $artooKey
    }
    else {
        $artooRoaming = [Environment]::GetEnvironmentVariable('APPDATA', 'Process')
        if (-not [string]::IsNullOrWhiteSpace($artooRoaming)) {
            $artooKeyFile = Join-Path $artooRoaming 'aerial\api_key'
            if (Test-Path -LiteralPath $artooKeyFile) {
                $null = Get-ArtooPhysicalFile $artooKeyFile (8194)
                $artooKey = [IO.File]::ReadAllText($artooKeyFile).TrimEnd([char[]]"`r`n")
                Assert-ArtooCredential $artooKey
            }
        }
    }
    if ($null -ne $artooKey) { [Environment]::SetEnvironmentVariable('ARTOO_CODEX_PROVIDER_KEY', $artooKey, 'Process') }
    # Direct invocation preserves the original stdin/stdout/stderr. No pipeline,
    # background controller, second goal submission or replacement cleanup.
    & $artooNode @artooArguments
    $artooExitCode = $LASTEXITCODE
    if ($artooExitCode -isnot [int]) { throw 'The original Node process did not return an exit code.' }
}
finally {
    foreach ($artooName in @('ARTOO_CODEX_PROVIDER_KEY', 'NODE_OPTIONS', 'NODE_PATH')) {
        $artooSaved = $artooSavedEnvironment[$artooName]
        if ($artooSaved.present) { [Environment]::SetEnvironmentVariable($artooName, $artooSaved.value, 'Process') }
        else { [Environment]::SetEnvironmentVariable($artooName, [System.Management.Automation.Language.NullString]::Value, 'Process') }
        $artooSaved.value = $null
    }
    $artooKey = $null
    $artooSavedEnvironment.Clear()
}
exit $artooExitCode
