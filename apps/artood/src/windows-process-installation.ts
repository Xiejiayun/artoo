import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { win32 } from "node:path";
import { assertWindowsProcessBackend, prepareWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

export interface WindowsProcessInstallation {
  readonly directory: string;
  readonly manifestSha256: string;
  /** All locally configured agent write roots, not only verification-profile roots. */
  readonly writableWorkspaceRoots: readonly string[];
}

// Only the complete installation collector below can register this description.
// Serialized descriptions remain configuration, never prepared execution authority.
const preparedInstallations = new WeakMap<PreparedWindowsProcessBackend, Readonly<WindowsProcessInstallation>>();
export function describeWindowsProcessInstallation(backend: PreparedWindowsProcessBackend): Readonly<WindowsProcessInstallation> {
  const installation = preparedInstallations.get(backend);
  if (!installation) throw new Error("Windows browser requires a locally qualified process installation");
  assertWindowsProcessBackend(backend);
  return installation;
}

const MAX_PATHS = 4096, MAX_INPUT_BYTES = 1024 * 1024, MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const trustedSystemSids = ["S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"];
// Write/append/data/EA/attributes/delete-child/delete/DACL/owner plus generic write/all.
const INSTALL_WRITE_MASK = 0x500d0156;
// Adding an unrelated sibling directory cannot replace an existing protected component.
// This matters on the normal Windows drive root, where Authenticated Users have AddSubdirectory.
const ANCESTOR_REPLACEMENT_MASK = INSTALL_WRITE_MASK & ~0x4;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const key = (path: string) => path.toLowerCase();
function fail(reason: string): never { throw new Error(`Windows process installation: ${reason}`); }

// Fixed local collector: no task text, SID, command, executable or policy is interpolated.
// The only stdin fields are the locally configured installation and agent workspace paths.
const AUDIT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
$script:failureCode = 'system_audit_failed'
$script:failurePath = ''
function Reject([string]$Code, [string]$Path) {
  $script:failureCode = $Code; $script:failurePath = $Path
  throw [System.InvalidOperationException]::new($Code)
}
function Inspect([string]$Path, [string]$Role, [bool]$MustBeDirectory) {
  if ($script:nodes.Count -ge 4096) { Reject 'audit_path_limit' $Path }
  $script:failurePath = $Path
  $attributes = [System.IO.File]::GetAttributes($Path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Reject 'reparse_component' $Path }
  $directory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
  if ($MustBeDirectory -and -not $directory) { Reject 'directory_required' $Path }
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Path))
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { Reject 'local_ntfs_required' $Path }
  $owner = $null; $present = $false; $canonical = $false
  $aces = [System.Collections.Generic.List[object]]::new()
  if ($Role -ne 'workspace') {
    try { $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path }
    catch { Reject 'acl_read_failed' $Path }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $canonical = $acl.AreAccessRulesCanonical
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $present = (($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0) -and ($null -ne $raw.DiscretionaryAcl)
    if (-not $present) { Reject 'null_dacl' $Path }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($aces.Count -ge 256) { Reject 'acl_entry_limit' $Path }
      if (-not ($ace -is [System.Security.AccessControl.CommonAce]) -or $ace.IsCallback) { Reject 'unsupported_acl_entry' $Path }
      $qualifier = $ace.AceQualifier.ToString()
      if ($qualifier -ne 'AccessAllowed' -and $qualifier -ne 'AccessDenied') { Reject 'unsupported_acl_entry' $Path }
      [void]$aces.Add(@{ sid = $ace.SecurityIdentifier.Value; qualifier = $qualifier;
        mask = ([int64]$ace.AccessMask -band [int64]4294967295);
        # AceFlags is byte-backed; Windows PowerShell 5 needs integers for bitwise operations.
        inheritOnly = (([int]$ace.AceFlags -band [int][System.Security.AccessControl.AceFlags]::InheritOnly) -ne 0) })
    }
  }
  [void]$script:nodes.Add(@{ path = $Path; role = $Role; directory = $directory; attributes = [int64]$attributes;
    volumeRoot = $drive.RootDirectory.FullName; driveType = $drive.DriveType.ToString(); fileSystem = $drive.DriveFormat;
    ownerSid = $owner; daclPresent = $present; canonical = $canonical; aces = $aces.ToArray() })
  return $directory
}
function Components([string]$Path, [string]$Role, [bool]$IncludeLast) {
  $current = $Path.Substring(0, 3)
  $parts = $Path.Substring(3).Split([char[]]'\', [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($parts.Length -eq 0) { if ($IncludeLast) { [void](Inspect $current $Role $true) }; return }
  [void](Inspect $current $Role $true)
  for ($index = 0; $index -lt $parts.Length; $index++) {
    $current = [System.IO.Path]::Combine($current, $parts[$index])
    if ($IncludeLast -or $index -lt ($parts.Length - 1)) { [void](Inspect $current $Role $true) }
  }
}
function Installation([string]$Path, [int]$Depth) {
  if ($Depth -gt 64) { Reject 'installation_depth_limit' $Path }
  $directory = Inspect $Path 'installation' ($Depth -eq 0)
  if ($directory) {
    foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($Path)) { Installation $child ($Depth + 1) }
  }
}
try {
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 1048576) { Reject 'audit_input_limit' '' }
  $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $inputText
  $names = @($request.PSObject.Properties.Name | Sort-Object)
  if (($names -join ',') -ne 'directory,version,workspaceRoots' -or $request.version -ne 1) { Reject 'invalid_audit_request' '' }
  $script:nodes = [System.Collections.Generic.List[object]]::new()
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  try { $currentSid = $identity.User.Value } finally { $identity.Dispose() }
  Components $request.directory 'ancestor' $false
  Installation $request.directory 0
  foreach ($workspace in $request.workspaceRoots) { Components $workspace 'workspace' $true }
  $result = @{ version = 1; currentSid = $currentSid; nodes = $script:nodes.ToArray() }
  $json = Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $result -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  exit 0
} catch {
  $json = Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{ version = 1; errorCode = $script:failureCode; path = $script:failurePath } -Compress
  [Console]::Out.WriteLine($json)
  exit 1
}
`;

interface AuditAce { sid: string; qualifier: "AccessAllowed" | "AccessDenied"; mask: number; inheritOnly: boolean }
interface AuditNode {
  path: string; role: "ancestor" | "installation" | "workspace"; directory: boolean; attributes: number;
  volumeRoot: string; driveType: string; fileSystem: string;
  ownerSid: string | null; daclPresent: boolean; canonical: boolean; aces: AuditAce[];
}
interface AuditReport { version: 1; currentSid: string; nodes: AuditNode[] }
function isSid(value: unknown): value is string { return typeof value === "string" && /^S-1-(?:\d+-)+\d+$/.test(value) && value.length <= 184; }
function components(path: string): string[] {
  const root = win32.parse(path).root, parts = path.slice(root.length).split("\\").filter(Boolean), result = [root];
  for (const part of parts) result.push(win32.join(result.at(-1)!, part));
  return result;
}
function physicalDirectory(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f]/u.test(value)
    || !/^[a-zA-Z]:\\/.test(value) || !/^[a-zA-Z]:\\$/.test(win32.parse(value).root)
    || value !== win32.resolve(value)) fail("an existing absolute physical local directory is required");
  for (const part of components(value)) {
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`directory link or non-directory component: ${part}`);
  }
  if (realpathSync.native(value) !== value) fail(`directory is not its physical path: ${value}`);
  return value;
}
function overlaps(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const suffix = win32.relative(parent, child);
    return suffix === "" || suffix !== ".." && !suffix.startsWith("..\\") && !win32.isAbsolute(suffix);
  };
  return inside(left, right) || inside(right, left);
}
function installationPaths(directory: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const walk = (path: string, depth: number): void => {
    if (result.size >= MAX_PATHS || depth > 64) fail("installation inventory exceeds its bound");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail(`installation link or unsupported file: ${path}`);
    result.set(key(path), stat.isDirectory());
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(win32.join(path, name), depth + 1);
  };
  walk(directory, 0); return result;
}
function validateReport(value: unknown, directory: string, roots: readonly string[], installed: Map<string, boolean>, previousSid?: string): string {
  if (!value || typeof value !== "object") fail("invalid local ACL collector response");
  const report = value as AuditReport;
  if (report.version !== 1 || !isSid(report.currentSid) || !Array.isArray(report.nodes) || report.nodes.length > MAX_PATHS
    || previousSid !== undefined && report.currentSid !== previousSid) fail("local ACL collector identity or bounds changed");
  const trusted = new Set([...trustedSystemSids, report.currentSid]);
  const expectedAncestors = new Set(components(directory).slice(0, -1).map(key));
  const expectedWorkspace = new Set(roots.flatMap(components).map(key));
  const seenAncestors = new Set<string>(), seenWorkspace = new Set<string>(), seenInstallation = new Set<string>();
  for (const node of report.nodes) {
    if (!node || typeof node !== "object" || typeof node.path !== "string" || node.path !== win32.resolve(node.path)
      || typeof node.directory !== "boolean" || !Number.isSafeInteger(node.attributes) || node.attributes < 0
      || node.attributes & 0x400 || node.driveType !== "Fixed" || node.fileSystem !== "NTFS"
      || key(node.volumeRoot ?? "") !== key(win32.parse(node.path).root)) fail("local physical NTFS path facts are invalid");
    const identity = key(node.path);
    if (node.role === "workspace") {
      if (!node.directory || !expectedWorkspace.has(identity)) fail("unexpected workspace component in local ACL response");
      seenWorkspace.add(identity); continue;
    }
    if (node.role === "ancestor") {
      if (!node.directory || !expectedAncestors.has(identity) || seenAncestors.has(identity)) fail("unexpected installation ancestor");
      seenAncestors.add(identity);
    } else if (node.role === "installation") {
      if (installed.get(identity) !== node.directory || seenInstallation.has(identity)) fail("installation ACL inventory mismatch");
      seenInstallation.add(identity);
    } else fail("unknown local ACL path role");
    if (!node.ownerSid || !trusted.has(node.ownerSid) || node.daclPresent !== true || node.canonical !== true
      || !Array.isArray(node.aces) || node.aces.length > 256) fail(`untrusted owner or unsupported DACL: ${node.path}`);
    const dangerous = node.role === "ancestor" ? ANCESTOR_REPLACEMENT_MASK : INSTALL_WRITE_MASK;
    for (const ace of node.aces) {
      if (!ace || !isSid(ace.sid) || !["AccessAllowed", "AccessDenied"].includes(ace.qualifier)
        || !Number.isSafeInteger(ace.mask) || ace.mask < 0 || ace.mask > 0xffffffff || typeof ace.inheritOnly !== "boolean") fail("invalid local DACL entry");
      // Conservative: a DENY does not excuse a dangerous ALLOW to a non-trusted SID.
      // InheritOnly entries do not apply to this object; every existing descendant is audited itself.
      if (ace.qualifier === "AccessAllowed" && !ace.inheritOnly && !trusted.has(ace.sid) && (ace.mask & dangerous) !== 0) {
        fail(`another principal can modify or replace the installation: ${node.path}`);
      }
    }
  }
  if (seenAncestors.size !== expectedAncestors.size || seenWorkspace.size !== expectedWorkspace.size
    || seenInstallation.size !== installed.size) fail("local ACL collector omitted an installation or workspace component");
  return report.currentSid;
}

/** Local trusted-team admission. No caller assertion, SID or remote metadata can grant this authority. */
export function prepareWindowsProcessInstallation(input: WindowsProcessInstallation): PreparedWindowsProcessBackend {
  if (process.platform !== "win32" || process.arch !== "x64") fail("native win-x64 on Windows 10 or later is required");
  const windowsMajor = Number(release().split(".")[0]);
  if (!Number.isInteger(windowsMajor) || windowsMajor < 10) fail("native win-x64 on Windows 10 or later is required");
  if (!input || typeof input !== "object" || Object.keys(input).some(name => !["directory", "manifestSha256", "writableWorkspaceRoots"].includes(name))
    || !/^sha256:[a-f0-9]{64}$/.test(input.manifestSha256) || !Array.isArray(input.writableWorkspaceRoots)
    || input.writableWorkspaceRoots.length === 0 || input.writableWorkspaceRoots.length > 128) fail("explicit local bundle, hash and all agent write roots are required");
  const directory = physicalDirectory(input.directory), manifestSha256 = input.manifestSha256;
  const roots = Object.freeze([...new Set(input.writableWorkspaceRoots.map(physicalDirectory))]);
  for (const root of roots) if (overlaps(directory, root)) fail("installation overlaps an agent writable root");
  const configuredSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!configuredSystemRoot || !win32.isAbsolute(configuredSystemRoot)) fail("the node lacks its local Windows system root");
  // SystemRoot is trusted node environment, but Windows may spell it differently in the env block.
  const systemRoot = physicalDirectory(realpathSync.native(configuredSystemRoot));
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const manifestPath = win32.join(directory, "manifest.json"), manifest = lstatSync(manifestPath);
  if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.nlink !== 1 || manifest.size > MAX_INPUT_BYTES
    || sha(readFileSync(manifestPath)) !== manifestSha256) fail("manifest differs from the local immutable binding");
  const request = JSON.stringify({ version: 1, directory, workspaceRoots: roots });
  if (Buffer.byteLength(request) > MAX_INPUT_BYTES) fail("local ACL request exceeds its bound");
  let admittedSid: string | undefined;
  const assertLocalInstallation = (): void => {
    physicalDirectory(directory);
    for (const root of roots) { physicalDirectory(root); if (overlaps(directory, root)) fail("installation overlaps an agent writable root"); }
    const installed = installationPaths(directory);
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", AUDIT_SCRIPT], {
      cwd: systemRoot, shell: false, windowsHide: true, input: request, encoding: "utf8", timeout: 15000,
      maxBuffer: MAX_AUDIT_BYTES, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32"),
        PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") },
    });
    let response: unknown;
    try { response = JSON.parse(result.stdout ?? ""); } catch { fail("the fixed local ACL collector did not return valid facts"); }
    if (result.error || result.status !== 0 || result.signal !== null) {
      const failed = response as { errorCode?: unknown; path?: unknown };
      const code = typeof failed.errorCode === "string" && /^[a-z_]{1,64}$/.test(failed.errorCode) ? failed.errorCode : "collector_failed";
      fail(`${code}${typeof failed.path === "string" ? `: ${failed.path}` : ""}`);
    }
    admittedSid = validateReport(response, directory, roots, installed, admittedSid);
    // Keep path/inventory changes outside the authority boundary even when the collector returned.
    physicalDirectory(directory); roots.forEach(physicalDirectory);
    const after = installationPaths(directory);
    if (after.size !== installed.size || [...after].some(([path, isDirectory]) => installed.get(path) !== isDirectory)) fail("installation inventory changed during ACL audit");
  };
  let preparationFailure: unknown;
  try {
    const backend = prepareWindowsProcessBackend({ directory, manifestSha256, assertLocalInstallation: () => {
      try { assertLocalInstallation(); }
      catch (error) { preparationFailure = error; throw error; }
    } });
    preparedInstallations.set(backend, Object.freeze({ directory, manifestSha256, writableWorkspaceRoots: roots }));
    return backend;
  } catch (error) {
    // The generic backend deliberately hides arbitrary caller callback errors. This fixed local
    // admission can preserve its own safe initial failure (path/classification, never argv/env).
    throw preparationFailure ?? error;
  }
}
