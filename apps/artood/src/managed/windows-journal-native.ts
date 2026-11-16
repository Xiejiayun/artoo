import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory } from "../windows-local-acl.js";

/** Fixed node-local operations only. No script, argv, SID or permission policy is
 * accepted from the controller, task, adapter or journal's serialized contents. */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
try {
  $text = [Console]::In.ReadToEnd()
  if ($text.Length -gt 8192) { throw 'Journal helper input limit' }
  $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $text
  if ($request.version -ne 1 -or $request.operation -notin @('clock', 'create-directory', 'flush-directory')) { throw 'Invalid journal operation' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  try { $sid = $identity.User.Value } finally { $identity.Dispose() }
  # Windows PowerShell CodeDom writes compiler files. Use the genuine known
  # profile and an audited fixed directory, never inherited TEMP/TMP or input.
  $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([string]::IsNullOrWhiteSpace($profile) -or $profile -notmatch '^[A-Za-z]:\\' -or
    [System.IO.Path]::GetFullPath($profile) -cne $profile) { throw 'Journal compiler profile path' }
  $compileBase = [System.IO.Path]::Combine($profile, '.artoo')
  $compileTemp = [System.IO.Path]::Combine($compileBase, 'windows-journal-compiler')
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  function Assert-CompileChain([string]$Leaf) {
    $component = $Leaf
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Leaf))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'Journal compiler local NTFS required' }
    while ($null -ne $component) {
      $attributes = [System.IO.File]::GetAttributes($component)
      if (([int]$attributes -band 1040) -ne 16) { throw 'Journal compiler reparse/kind' }
      $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $component
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -or -not $acl.AreAccessRulesCanonical -or
        $null -eq $raw.DiscretionaryAcl -or (([int]$raw.ControlFlags -band 4) -eq 0)) { throw 'Journal compiler ACL' }
      foreach ($ace in $raw.DiscretionaryAcl) {
        if (-not ($ace -is [System.Security.AccessControl.CommonAce]) -or $ace.IsCallback) { throw 'Journal compiler ACE' }
        if ($ace.AceQualifier.ToString() -notin @('AccessAllowed', 'AccessDenied')) { throw 'Journal compiler ACE kind' }
        if ($ace.AceQualifier.ToString() -ne 'AccessAllowed' -or $trusted -contains $ace.SecurityIdentifier.Value) { continue }
        $effective = ([int]$ace.AceFlags -band 8) -eq 0
        $future = $component -eq $compileTemp -and ([int]$ace.AceFlags -band 3) -ne 0
        $mask = if ($component -eq $compileTemp) { 0x500d0156 } else { 0x500d0152 }
        if (($effective -or $future) -and (([int64]$ace.AccessMask -band $mask) -ne 0)) { throw 'Journal compiler writable boundary' }
      }
      $parent = [System.IO.Directory]::GetParent($component)
      $component = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
  }
  if (-not [System.IO.Directory]::Exists($compileBase)) {
    Assert-CompileChain $profile
    Microsoft.PowerShell.Management\New-Item -Path $profile -Name '.artoo' -ItemType Directory -ErrorAction Stop | Out-Null
  }
  Assert-CompileChain $compileBase
  if (-not [System.IO.Directory]::Exists($compileTemp)) {
    Microsoft.PowerShell.Management\New-Item -Path $compileBase -Name 'windows-journal-compiler' -ItemType Directory -ErrorAction Stop | Out-Null
  }
  Assert-CompileChain $compileTemp
  $env:TEMP = $compileTemp; $env:TMP = $compileTemp
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace ArtooJournalV1 {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
      public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
      public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
      public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
      public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
    }
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr buffer, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryPerformanceCounter(out long value);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryPerformanceFrequency(out long value);
    [DllImport("advapi32.dll", EntryPoint="ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", EntryPoint="CreateDirectoryW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static string[] BootSample() {
      IntPtr memory = Marshal.AllocHGlobal(32);
      try {
        uint returned;
        int status = NtQuerySystemInformation(90, memory, 32, out returned);
        if (status != 0 || returned < 16 || returned > 32) throw new InvalidOperationException("Kernel boot identity unavailable");
        byte[] bytes = new byte[16]; Marshal.Copy(memory, bytes, 0, bytes.Length);
        Guid id = new Guid(bytes);
        if (id == Guid.Empty) throw new InvalidOperationException("Empty kernel boot identity");
        long counter, frequency; Check(QueryPerformanceFrequency(out frequency)); Check(QueryPerformanceCounter(out counter));
        if (counter < 0 || frequency <= 0) throw new InvalidOperationException("Invalid performance counter");
        return new string[] { id.ToString("D"), counter.ToString(CultureInfo.InvariantCulture), frequency.ToString(CultureInfo.InvariantCulture) };
      } finally { Marshal.FreeHGlobal(memory); }
    }
    public static void CreatePrivateDirectory(string path, string sid) {
      IntPtr descriptor; uint size;
      // Protected at creation: never create a public directory and harden it
      // afterward. Existing paths are rejected by CreateDirectoryW itself.
      Check(ConvertDescriptor("O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", 1, out descriptor, out size));
      try {
        SecurityAttributes attributes = new SecurityAttributes();
        attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Descriptor = descriptor; attributes.Inherit = 0;
        Check(CreateDirectory(path, ref attributes));
      } finally { LocalFree(descriptor); }
    }
    static void CheckDirectory(SafeFileHandle handle, string expectedDev, string expectedIno) {
      FileInformation information; Check(GetFileInformationByHandle(handle, out information));
      ulong index = ((ulong)information.IndexHigh << 32) | information.IndexLow;
      if ((information.Attributes & 0x10) == 0 || (information.Attributes & 0x400) != 0 ||
        information.Volume.ToString(CultureInfo.InvariantCulture) != expectedDev || index.ToString(CultureInfo.InvariantCulture) != expectedIno)
        throw new InvalidOperationException("Directory handle identity changed");
    }
    public static void FlushDirectory(string path, string expectedDev, string expectedIno) {
      // No volume handle/elevation fallback. Both the actual handle identity
      // and actual FlushFileBuffers result are mandatory qualification gates.
      using (SafeFileHandle handle = CreateFile(path, 0xc0000000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        CheckDirectory(handle, expectedDev, expectedIno); Check(FlushFileBuffers(handle));
        CheckDirectory(handle, expectedDev, expectedIno);
      }
    }
  }
}
'@
    switch ($request.operation) {
      'clock' {
        $sample = [ArtooJournalV1.Native]::BootSample()
        $result = @{ bootId = $sample[0]; counter = $sample[1]; frequency = $sample[2] }
      }
      'create-directory' {
        [ArtooJournalV1.Native]::CreatePrivateDirectory([string]$request.directory, $sid)
        $result = @{ created = $true }
      }
      'flush-directory' {
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$request.directory)
        [ArtooJournalV1.Native]::FlushDirectory([string]$request.directory, [string]$request.dev, [string]$request.ino)
        $result = @{ flushed = $true; currentSid = $sid; protected = $acl.AreAccessRulesProtected }
      }
    }
  $result['version'] = 1; $result['operation'] = $request.operation
  [Console]::Out.WriteLine((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $result -Depth 4 -Compress))
  exit 0
} catch {
  # Never echo scripts, input, task data or native exception details.
  [Console]::Out.WriteLine('{"version":1,"error":"windows_journal_native_failed"}')
  exit 1
}
`;

type Operation = "clock" | "create-directory" | "flush-directory";
function invoke(
  operation: Operation,
  input: { directory?: string; dev?: string; ino?: string } = {},
): Record<string, unknown> {
  assertNativeWindows();
  if (input.directory !== undefined) assertCanonicalWindowsPath(input.directory);
  const configured = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!configured || !win32.isAbsolute(configured))
    throw new Error("Windows journal requires the local Windows system root");
  const root = physicalWindowsDirectory(realpathSync.native(configured));
  // Select fields explicitly: even an extra property on a local identity object
  // cannot replace the fixed operation, directory or request version.
  const request = {
    version: 1,
    operation,
    ...(operation !== "clock" ? { directory: input.directory } : {}),
    ...(operation === "flush-directory" ? { dev: input.dev, ino: input.ino } : {}),
  };
  const result = spawnSync(
    win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 2500,
      maxBuffer: 8192,
      env: {
        SystemRoot: root,
        WINDIR: root,
        PATH: win32.join(root, "System32"),
        PSModulePath: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      },
    },
  );
  if (result.error || result.signal !== null || result.status !== 0)
    throw new Error(`Windows journal ${operation} failed; continuity is unqualified`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Windows journal native response is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Windows journal native response is invalid");
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || response.operation !== operation)
    throw new Error("Windows journal native operation binding failed");
  return response;
}

export function readWindowsJournalBootSample(): { readonly id: string; readonly counterNs: bigint } {
  const sample = invoke("clock");
  if (
    typeof sample.bootId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(sample.bootId) ||
    sample.bootId === "00000000-0000-0000-0000-000000000000" ||
    typeof sample.counter !== "string" ||
    !/^\d{1,20}$/u.test(sample.counter) ||
    typeof sample.frequency !== "string" ||
    !/^[1-9]\d{0,12}$/u.test(sample.frequency)
  ) {
    throw new Error("Windows journal boot/counter identity is unavailable");
  }
  return {
    id: `windows-boot-v1:${sample.bootId.toLowerCase()}`,
    counterNs: (BigInt(sample.counter) * 1_000_000_000n) / BigInt(sample.frequency),
  };
}

export function createWindowsJournalDirectory(directory: string): void {
  if (invoke("create-directory", { directory }).created !== true)
    throw new Error("Windows journal exclusive private creation was not confirmed");
}

export function assertWindowsJournalProtectedDirectory(
  directory: string,
  expectedSid: string,
  identity: { readonly dev: string; readonly ino: string },
): void {
  const result = flush(directory, identity);
  if (result.protected !== true || result.currentSid !== expectedSid)
    throw new Error("Windows journal directory DACL or node SID continuity failed");
}

function flush(directory: string, identity: { readonly dev: string; readonly ino: string }): Record<string, unknown> {
  if (!/^\d{1,20}$/u.test(identity.dev) || !/^\d{1,20}$/u.test(identity.ino))
    throw new Error("Windows journal directory identity is invalid");
  const result = invoke("flush-directory", { directory, dev: identity.dev, ino: identity.ino });
  if (result.flushed !== true) {
    throw new Error("Windows journal directory durability was not confirmed");
  }
  return result;
}

export function flushWindowsJournalDirectory(
  directory: string,
  identity: { readonly dev: string; readonly ino: string },
): void {
  flush(directory, identity);
}
