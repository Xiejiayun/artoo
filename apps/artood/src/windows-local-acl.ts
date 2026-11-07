// Candidate shared facts collector, derived from the reviewed installation collector.
// Facts alone confer no authority. Callers must check inventory, policy and stable identity.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { readWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";
import { reserveWindowsGuardianSlotSync } from "./owned/windows-runtime-guardian.js";
import { startWindowsGuardianObserverSync } from "./owned/windows-owned-process.js";
import { markWindowsStorageFailure, type WindowsStorageFailureCode } from "./windows-storage-diagnostic.js";

export const MAX_WINDOWS_AUDIT_PATHS = 65536;
const MAX_INPUT_BYTES = 16 * 1024 * 1024, MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export interface WindowsAclTarget { readonly path: string; readonly directory: boolean; readonly readAcl: boolean }
export interface WindowsAclAce { sid: string; qualifier: "AccessAllowed" | "AccessDenied"; mask: number; flags: number }
export interface WindowsAclFact {
  path: string; directory: boolean; attributes: number; volumeRoot: string; driveType: string; fileSystem: string;
  ownerSid: string | null; daclPresent: boolean; canonical: boolean; aces: WindowsAclAce[];
}
export interface WindowsAclReport { version: 1; currentSid: string; nodes: WindowsAclFact[] }
export const TRUSTED_WINDOWS_SYSTEM_SIDS = Object.freeze([
  "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
export const WINDOWS_MUTATION_MASK = 0x500d0156;
export const WINDOWS_ANCESTOR_REPLACEMENT_MASK = WINDOWS_MUTATION_MASK & ~0x4;
export const windowsPathKey = (path: string): string => path.toLowerCase();
function fail(reason: string, code: WindowsStorageFailureCode = "acl_input_rejected"): never {
  throw markWindowsStorageFailure(new Error(`Windows local ACL: ${reason}`), code);
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
$script:failureCode = 'system_audit_failed'; $script:failurePath = ''
function Reject([string]$Code, [string]$Path) {
  $script:failureCode = $Code; $script:failurePath = $Path
  throw [System.InvalidOperationException]::new($Code)
}
try {
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 16777216) { Reject 'audit_input_limit' '' }
  $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $inputText
  if ((@($request.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'paths,version' -or $request.version -ne 1) { Reject 'invalid_audit_request' '' }
  if ($request.paths.Count -eq 0 -or $request.paths.Count -gt 65536) { Reject 'audit_path_limit' '' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  try { $currentSid = $identity.User.Value } finally { $identity.Dispose() }
  $nodes = [System.Collections.Generic.List[object]]::new()
  foreach ($target in $request.paths) {
    if ((@($target.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'directory,path,readAcl') { Reject 'invalid_audit_target' '' }
    $path = [string]$target.path; $script:failurePath = $path
    $attributes = [System.IO.File]::GetAttributes($path)
    if (([int]$attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) { Reject 'reparse_component' $path }
    $directory = ([int]$attributes -band [int][System.IO.FileAttributes]::Directory) -ne 0
    if ($directory -ne $target.directory) { Reject 'path_kind_changed' $path }
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { Reject 'local_ntfs_required' $path }
    $owner = $null; $present = $false; $canonical = $false
    $aces = [System.Collections.Generic.List[object]]::new()
    if ($target.readAcl) {
      try { $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path }
      catch { Reject 'acl_read_failed' $path }
      $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
      $canonical = $acl.AreAccessRulesCanonical
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      $present = (([int]$raw.ControlFlags -band [int][System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0) -and ($null -ne $raw.DiscretionaryAcl)
      if (-not $present) { Reject 'null_dacl' $path }
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($aces.Count -ge 256) { Reject 'acl_entry_limit' $path }
        if (-not ($ace -is [System.Security.AccessControl.CommonAce]) -or $ace.IsCallback) { Reject 'unsupported_acl_entry' $path }
        $qualifier = $ace.AceQualifier.ToString()
        if ($qualifier -ne 'AccessAllowed' -and $qualifier -ne 'AccessDenied') { Reject 'unsupported_acl_entry' $path }
        [void]$aces.Add(@{ sid = $ace.SecurityIdentifier.Value; qualifier = $qualifier;
          mask = ([int64]$ace.AccessMask -band [int64]4294967295); flags = [int]$ace.AceFlags })
      }
    }
    [void]$nodes.Add(@{ path = $path; directory = $directory; attributes = [int64]$attributes;
      volumeRoot = $drive.RootDirectory.FullName; driveType = $drive.DriveType.ToString(); fileSystem = $drive.DriveFormat;
      ownerSid = $owner; daclPresent = $present; canonical = $canonical; aces = $aces.ToArray() })
  }
  [Console]::Out.WriteLine((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{ version = 1; currentSid = $currentSid; nodes = $nodes.ToArray() } -Depth 8 -Compress))
  exit 0
} catch {
  [Console]::Out.WriteLine((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{ version = 1; errorCode = $script:failureCode; path = $script:failurePath } -Compress))
  exit 1
}
`;

export function assertNativeWindows(): void {
  const major = Number(release().split(".")[0]);
  if (process.platform !== "win32" || process.arch !== "x64" || !Number.isInteger(major) || major < 10) {
    fail("native win-x64 on Windows 10 or later is required");
  }
}
export function windowsPathComponents(path: string): string[] {
  const root = win32.parse(path).root, parts = path.slice(root.length).split("\\").filter(Boolean), result = [root];
  for (const part of parts) result.push(win32.join(result.at(-1)!, part));
  return result;
}
export function assertCanonicalWindowsPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
    || !/^[a-zA-Z]:\\/.test(value) || !/^[a-zA-Z]:\\$/.test(win32.parse(value).root) || value !== win32.resolve(value)) {
    fail("an absolute canonical local path is required");
  }
  for (const part of value.slice(3).split("\\").filter(Boolean)) {
    if (/[<>:"|?*]/u.test(part) || /[ .]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part)) {
      fail("unsupported Windows path component");
    }
  }
}
export function physicalWindowsDirectory(value: unknown): string {
  assertCanonicalWindowsPath(value);
  try {
    for (const component of windowsPathComponents(value)) {
      const stat = lstatSync(component);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`directory link or non-directory component: ${component}`);
    }
    if (realpathSync.native(value) !== value) fail(`directory is not its physical path: ${value}`);
    return value;
  } catch (error) { throw markWindowsStorageFailure(error, "filesystem_observation_failed"); }
}
export function windowsPathsOverlap(left: string, right: string): boolean {
  const inside = (parent: string, child: string): boolean => {
    const suffix = win32.relative(parent, child);
    return suffix === "" || suffix !== ".." && !suffix.startsWith("..\\") && !win32.isAbsolute(suffix);
  };
  return inside(left, right) || inside(right, left);
}
function isSid(value: unknown): value is string { return typeof value === "string" && /^S-1-(?:\d+-)+\d+$/.test(value) && value.length <= 184; }

/** Fixed system collector; no scripts, SIDs, booleans or executor callbacks supplied by a remote request. */
export function collectWindowsAclFacts(targets: readonly WindowsAclTarget[], timeoutMs = 60000): WindowsAclReport {
  const begun = performance.now();
  assertNativeWindows();
  // Local callers may spend only their remaining operation budget; serialized targets cannot override it.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail("invalid local audit timeout");
  if (!targets.length || targets.length > MAX_WINDOWS_AUDIT_PATHS) fail("audit path limit");
  const expected = new Map<string, WindowsAclTarget>();
  for (const target of targets) {
    assertCanonicalWindowsPath(target.path);
    if (typeof target.directory !== "boolean" || typeof target.readAcl !== "boolean" || expected.has(windowsPathKey(target.path))) fail("invalid or duplicate audit target");
    expected.set(windowsPathKey(target.path), target);
  }
  const configured = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!configured || !win32.isAbsolute(configured)) fail("the node lacks its local Windows system root");
  let systemRoot: string;
  try { systemRoot = physicalWindowsDirectory(realpathSync.native(configured)); }
  catch (error) { throw markWindowsStorageFailure(error, "filesystem_observation_failed"); }
  const input = JSON.stringify({ version: 1, paths: targets });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) fail("audit input limit");
  const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scope = readWindowsGuardianOperation();
  const result = scope ? (() => {
    const bindingDigest = `sha256:${createHash("sha256").update(JSON.stringify({ version: 1, operation: scope.bindingDigest,
      collector: "windows-local-acl", executable, script: SCRIPT, input })).digest("hex")}`;
    const slot = reserveWindowsGuardianSlotSync(scope.guardian, { operationKind: "observer", operationId: scope.operationId,
      bindingDigest, serverOperation: scope.serverOperation });
    const remaining = Math.floor(timeoutMs - (performance.now() - begun));
    if (remaining < 1) fail("audit deadline elapsed before collector launch", "acl_collector_failed");
    const observed = startWindowsGuardianObserverSync(scope.backend, { executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], cwd: scope.workspaceRoot,
      timeoutMs: remaining, cleanupTimeoutMs: 5000, maxOutputBytes: MAX_OUTPUT_BYTES,
      normalExitPolicy: "require-empty", normalExitGraceMs: 250, guardianSlot: slot, inputBytes: Buffer.from(input, "utf8"),
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32"),
        PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") } });
    return { stdout: observed.stdout.toString("utf8"), status: observed.receipt.rootExitCode, signal: null,
      error: observed.receipt.terminationReason !== null || observed.receipt.failureCode !== null ? new Error("Owned collector failed") : undefined };
  })() : spawnSync(executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      cwd: systemRoot, shell: false, windowsHide: true, input, encoding: "utf8", timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32"),
        PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") },
    });
  let value: unknown;
  try { value = JSON.parse(result.stdout ?? ""); } catch { fail("the fixed local collector did not return valid facts", "acl_facts_rejected"); }
  if (result.error || result.status !== 0 || result.signal !== null) {
    const failed = value as { errorCode?: unknown; path?: unknown } | null;
    const code = typeof failed?.errorCode === "string" && /^[a-z_]{1,64}$/.test(failed.errorCode) ? failed.errorCode : "collector_failed";
    fail(`${code}${typeof failed?.path === "string" ? `: ${failed.path}` : ""}`, "acl_collector_failed");
  }
  if (!value || typeof value !== "object") fail("invalid audit response", "acl_facts_rejected");
  const report = value as WindowsAclReport;
  if (report.version !== 1 || !isSid(report.currentSid) || !Array.isArray(report.nodes) || report.nodes.length !== expected.size) fail("audit identity or inventory mismatch", "acl_facts_rejected");
  const seen = new Set<string>();
  for (const node of report.nodes) {
    if (!node || typeof node !== "object" || typeof node.path !== "string") fail("invalid path fact", "acl_facts_rejected");
    assertCanonicalWindowsPath(node.path);
    const identity = windowsPathKey(node.path), target = expected.get(identity);
    if (!target || target.path !== node.path || seen.has(identity) || node.directory !== target.directory
      || !Number.isSafeInteger(node.attributes) || node.attributes < 0 || (node.attributes & 0x400) !== 0
      || ((node.attributes & 0x10) !== 0) !== node.directory || node.driveType !== "Fixed" || node.fileSystem !== "NTFS"
      || typeof node.volumeRoot !== "string" || windowsPathKey(node.volumeRoot) !== windowsPathKey(win32.parse(node.path).root)) fail("physical NTFS facts are invalid", "acl_facts_rejected");
    seen.add(identity);
    if (!target.readAcl) continue;
    if (!isSid(node.ownerSid) || node.daclPresent !== true || node.canonical !== true || !Array.isArray(node.aces) || node.aces.length > 256) fail(`unsupported owner or DACL: ${node.path}`, "acl_facts_rejected");
    for (const ace of node.aces) {
      if (!ace || !isSid(ace.sid) || !["AccessAllowed", "AccessDenied"].includes(ace.qualifier)
        || !Number.isSafeInteger(ace.mask) || ace.mask < 0 || ace.mask > 0xffffffff
        || !Number.isInteger(ace.flags) || ace.flags < 0 || ace.flags > 31) fail("unsupported DACL entry", "acl_facts_rejected");
    }
  }
  return report;
}
