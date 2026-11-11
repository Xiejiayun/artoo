# Immutable GitHub release bootstrap. No npm registry or administrator access required.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Code,
  [string]$Workspace
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$artooVersion = '{{PACKAGE_VERSION}}'
$artooHash = '{{PACKAGE_SHA256}}'
$artooSize = '{{PACKAGE_SIZE}}'
if ($artooVersion -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $artooHash -notmatch '^[a-f0-9]{64}$' -or $artooSize -notmatch '^\d+$') { throw 'This installer was not rendered by the release publisher.' }
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This installer supports Windows x64 only.' }
if ($Code -notmatch '^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$') { throw 'Use the current connection command from Artoo Web.' }
$artooUri = [Uri]$Server
$artooLoopback = @('localhost', '127.0.0.1') -contains $artooUri.Host
[Net.IPAddress]$artooAddress = $null
if ([Net.IPAddress]::TryParse($artooUri.DnsSafeHost, [ref]$artooAddress)) {
  $artooLoopback = $artooAddress.Equals([Net.IPAddress]::Loopback) -or $artooAddress.Equals([Net.IPAddress]::IPv6Loopback)
}
if (-not $artooUri.IsAbsoluteUri -or ($artooUri.Scheme -ne 'https' -and -not ($artooUri.Scheme -eq 'http' -and $artooLoopback)) -or $artooUri.UserInfo -or $artooUri.Query -or $artooUri.Fragment -or $artooUri.AbsolutePath -ne '/') { throw 'Server must be an HTTPS website origin (HTTP is allowed only on localhost).' }

function Set-ArtooPrivateDirectory([string]$Path) {
  [IO.Directory]::CreateDirectory($Path) | Out-Null
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directories must not be links.' }
  $artooOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $artooAcl = [Security.AccessControl.DirectorySecurity]::new()
  $artooAcl.SetOwner($artooOwner)
  $artooAcl.SetAccessRuleProtection($true, $false)
  foreach ($artooSid in @($artooOwner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $artooAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($artooSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  # Windows PowerShell exposes the Framework method; PowerShell 7 uses the
  # matching extension method. Neither requests unrelated audit privileges.
  if ($PSVersionTable.PSVersion.Major -ge 7) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $artooAcl) }
  else { [IO.Directory]::SetAccessControl($Path, $artooAcl) }
}
function Get-ArtooDownload([string]$Url, [string]$Path) {
  if (-not $Url.StartsWith('https://', [StringComparison]::Ordinal)) { throw 'HTTPS download required.' }
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -MaximumRedirection 5
}
function Assert-ArtooHash([string]$Path, [string]$Expected) {
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'Downloaded file hash mismatch. No package was executed.' }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$artooBase = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.artoo'
if ($env:ARTOO_HOME) {
  if (-not [IO.Path]::IsPathRooted($env:ARTOO_HOME)) { throw 'ARTOO_HOME must be an absolute private directory.' }
  $artooBase = [IO.Path]::GetFullPath($env:ARTOO_HOME)
}
Set-ArtooPrivateDirectory $artooBase
$artooBootstrap = Join-Path $artooBase 'bootstrap'
Set-ArtooPrivateDirectory $artooBootstrap
# Keep unique staging paths for failure diagnosis; never replace an existing installation.
$artooStage = Join-Path $artooBootstrap ([Guid]::NewGuid().ToString('N'))
Set-ArtooPrivateDirectory $artooStage
$artooNode = $null
$artooExistingNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($artooExistingNode) {
  $artooProbe = & $artooExistingNode.Source -p "Number(process.versions.node.split('.')[0]) >= 24 && process.platform === 'win32' && process.arch === 'x64' ? process.execPath : ''" 2>$null
  if ($LASTEXITCODE -eq 0 -and $artooProbe) { $artooNode = [string]$artooProbe }
}
if (-not $artooNode) {
  Write-Host 'Installing a private Node.js 24 runtime from nodejs.org...'
  $artooChecksums = Join-Path $artooStage 'node-SHASUMS256.txt'
  Get-ArtooDownload 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' $artooChecksums
  $artooNodeMatch = [regex]::Matches([IO.File]::ReadAllText($artooChecksums), '(?m)^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-x64\.zip)\s*$')
  if ($artooNodeMatch.Count -ne 1) { throw 'Could not identify the official Node.js 24 Windows x64 archive.' }
  $artooNodeName = $artooNodeMatch[0].Groups[2].Value
  $artooNodeVersion = $artooNodeMatch[0].Groups[3].Value
  $artooNodeArchive = Join-Path $artooStage $artooNodeName
  Get-ArtooDownload "https://nodejs.org/dist/$artooNodeVersion/$artooNodeName" $artooNodeArchive
  Assert-ArtooHash $artooNodeArchive $artooNodeMatch[0].Groups[1].Value
  Expand-Archive -LiteralPath $artooNodeArchive -DestinationPath $artooStage
  $artooNode = Join-Path (Join-Path $artooStage "node-$artooNodeVersion-win-x64") 'node.exe'
}
$artooNodeVersionOutput = & $artooNode --version
if ($LASTEXITCODE -ne 0) { throw 'Node.js could not start on this computer.' }
Write-Host "Using Node.js $artooNodeVersionOutput"
$artooArchive = Join-Path $artooStage 'artood.tgz'
$artooRelease = "https://github.com/Xiejiayun/artoo/releases/download/artood-v$artooVersion"
Write-Host "Downloading Artoo $artooVersion from its GitHub release..."
Get-ArtooDownload "$artooRelease/jiayunxie-artood-$artooVersion.tgz" $artooArchive
if ((Get-Item -LiteralPath $artooArchive).Length -ne [long]$artooSize) { throw 'Downloaded package size mismatch. No package was executed.' }
Assert-ArtooHash $artooArchive $artooHash
$artooTar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $artooTar -PathType Leaf)) { throw 'Windows tar.exe is required (Windows 10 or later).' }
& $artooTar -xzf $artooArchive -C $artooStage
if ($LASTEXITCODE -ne 0) { throw 'Package extraction failed.' }
$artooPackage = Join-Path $artooStage 'package'
& $artooNode (Join-Path $artooPackage 'bin\verify.mjs') --package-directory $artooPackage | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Package integrity verification failed.' }
$artooConnectArgs = @('connect', '--server', $artooUri.GetLeftPart([UriPartial]::Authority), '--code', $Code)
if ($Workspace) { $artooConnectArgs += @('--workspace', $Workspace) }
& $artooNode (Join-Path $artooPackage 'bin\artood.mjs') @artooConnectArgs
if ($LASTEXITCODE -ne 0) { throw 'Artoo did not finish connecting. Follow the message above; saved credentials are retained.' }
