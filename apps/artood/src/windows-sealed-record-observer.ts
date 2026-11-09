// Fixed local facts only. A JSON observation is never storage or writer authority.
import { isDeepStrictEqual } from "node:util";

export const MAX_WINDOWS_SEALED_RECORD_BYTES = 65536;
export interface WindowsSealedRecordBindingV1 {
  version: 1; dev: string; ino: string; size: string; mtimeNs: string; sha256: string;
}
interface EaFact { name: string; flags: number; bytes: number; sha256: string; containsExpectedSha256: boolean }
interface Snapshot {
  dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; birthtimeNs: string;
  attributes: number; links: number; sha256: string; securitySha256: string;
  eas: EaFact[]; streams: { name: string; size: string; allocation: string }[];
}
export interface WindowsSealedRecordAuditV1 { version: 1; before: Snapshot; after: Snapshot }
const decimal = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const keys = (value: object, expected: string): boolean => Object.keys(value).sort().join(",") === expected;

export function isWindowsSealedRecordBinding(value: unknown): value is WindowsSealedRecordBindingV1 {
  if (!value || typeof value !== "object" || !keys(value, "dev,ino,mtimeNs,sha256,size,version")) return false;
  const item = value as WindowsSealedRecordBindingV1;
  return item.version === 1 && [item.dev, item.ino, item.mtimeNs, item.size].every(decimal)
    && BigInt(item.size) > 0n && BigInt(item.size) <= BigInt(MAX_WINDOWS_SEALED_RECORD_BYTES) && hash(item.sha256);
}
function isSnapshot(value: unknown, binding: WindowsSealedRecordBindingV1): value is Snapshot {
  if (!value || typeof value !== "object"
    || !keys(value, "attributes,birthtimeNs,ctimeNs,dev,eas,ino,links,mtimeNs,securitySha256,sha256,size,streams")) return false;
  const item = value as Snapshot;
  if (![item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs, item.birthtimeNs].every(decimal)
    || item.dev !== binding.dev || item.ino !== binding.ino || item.size !== binding.size || item.mtimeNs !== binding.mtimeNs
    || item.sha256 !== binding.sha256 || !hash(item.securitySha256) || item.links !== 1
    || !Number.isInteger(item.attributes) || item.attributes < 0 || item.attributes > 0xffffffff || (item.attributes & 0x410) !== 0
    || !Array.isArray(item.eas) || item.eas.length > 128 || !Array.isArray(item.streams) || item.streams.length !== 1) return false;
  const stream = item.streams[0];
  if (!stream || !keys(stream, "allocation,name,size") || stream.name !== "::$DATA" || stream.size !== binding.size || !decimal(stream.allocation)) return false;
  let previous = "";
  for (const ea of item.eas) {
    if (!ea || typeof ea !== "object" || !keys(ea, "bytes,containsExpectedSha256,flags,name,sha256")
      || typeof ea.name !== "string" || !/^[\x21-\x7e]{1,255}$/.test(ea.name) || ea.name !== ea.name.toUpperCase()
      || ea.name <= previous || !Number.isInteger(ea.flags) || ea.flags < 0 || ea.flags > 255
      || !Number.isInteger(ea.bytes) || ea.bytes < 0 || ea.bytes > 65535 || !hash(ea.sha256)
      || typeof ea.containsExpectedSha256 !== "boolean") return false;
    previous = ea.name;
  }
  return true;
}
export function isWindowsSealedRecordAudit(value: unknown, binding: WindowsSealedRecordBindingV1): value is WindowsSealedRecordAuditV1 {
  if (!isWindowsSealedRecordBinding(binding) || !value || typeof value !== "object" || !keys(value, "after,before,version")) return false;
  const item = value as WindowsSealedRecordAuditV1;
  return item.version === 1 && isSnapshot(item.before, binding) && isSnapshot(item.after, binding);
}

/** Only the original writer's immutable internal records use this projection.
 * Independent bytes/identity/mtime, current security, ordinary metadata and the
 * complete default stream remain binding. ctime and EAs are diagnostics, never
 * execution inputs or permissions; OS-private cache names/formats are irrelevant.
 * This is trusted-team semantic integrity, not historical same-user continuity. */
export function isWindowsSealedRecordIntegrity(value: WindowsSealedRecordAuditV1, binding: WindowsSealedRecordBindingV1): boolean {
  if (!isWindowsSealedRecordAudit(value, binding)) return false;
  const { ctimeNs: _beforeCtime, eas: _beforeEas, ...before } = value.before;
  const { ctimeNs: _afterCtime, eas: _afterEas, ...after } = value.after;
  return isDeepStrictEqual(before, after);
}

// Loaded only for a batch containing records sealed by the original local writer.
// Add-Type is fixed code, runs inside the existing collector Job when one exists,
// and must finish together with every compiler child before that Job can close.
// Unsupported/constrained PowerShell, compile errors and API failures reject;
// there is no fallback to path-only facts or a caller-provided observer.
export const WINDOWS_SEALED_RECORD_OBSERVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# CodeDom needs a writable temporary directory. The general user Temp may grant
# other principals mutation rights. This fixed node directory is derived from
# the current Windows known profile, never a request, TEMP/TMP or environment path.
# It persists for reuse. Concurrent first creation must fail rather than Force or
# retry; CodeDom chooses its own unique temporary filenames within the directory.
$compileProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($compileProfile) -or $compileProfile -notmatch '^[A-Za-z]:\\' -or
  [System.IO.Path]::GetFullPath($compileProfile) -cne $compileProfile) { throw 'sealed_compile_profile_path' }
$compileBase = [System.IO.Path]::Combine($compileProfile, '.artoo')
$compileTemp = [System.IO.Path]::Combine($compileBase, 'windows-sealed-compiler')
$compileIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try { $compileSid = $compileIdentity.User.Value } finally { $compileIdentity.Dispose() }
$compileTrusted = @($compileSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Assert-SealedCompileDirectoryChain([string]$Leaf) {
 $compilePath = $Leaf
 while ($null -ne $compilePath) {
  $attributes = [System.IO.File]::GetAttributes($compilePath)
  if (([int]$attributes -band 1040) -ne 16) { throw 'sealed_compile_directory_kind' }
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $compilePath
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($compileTrusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -or -not $acl.AreAccessRulesCanonical -or
    $null -eq $raw.DiscretionaryAcl -or (([int]$raw.ControlFlags -band 4) -eq 0)) { throw 'sealed_compile_directory_acl' }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if (-not ($ace -is [System.Security.AccessControl.CommonAce]) -or $ace.IsCallback) { throw 'sealed_compile_directory_ace' }
    if ($ace.AceQualifier.ToString() -ne 'AccessAllowed' -or $compileTrusted -contains $ace.SecurityIdentifier.Value) { continue }
    $effective = ([int]$ace.AceFlags -band 8) -eq 0
    $future = $compilePath -eq $compileTemp -and ([int]$ace.AceFlags -band 3) -ne 0
    $mask = if ($compilePath -eq $compileTemp) { 0x500d0156 } else { 0x500d0152 }
    if (($effective -or $future) -and (([int64]$ace.AccessMask -band $mask) -ne 0)) { throw 'sealed_compile_directory_writable' }
  }
  $parent = [System.IO.Directory]::GetParent($compilePath)
  $compilePath = if ($null -eq $parent) { $null } else { $parent.FullName }
 }
}
if (-not [System.IO.Directory]::Exists($compileBase)) {
  Assert-SealedCompileDirectoryChain $compileProfile
  Microsoft.PowerShell.Management\New-Item -Path $compileProfile -Name '.artoo' -ItemType Directory -ErrorAction Stop | Out-Null
  Assert-SealedCompileDirectoryChain $compileBase
}
if ([System.IO.Directory]::Exists($compileTemp)) {
  Assert-SealedCompileDirectoryChain $compileTemp
} else {
  # Verify the existing parent and all ancestors before creating anything. An
  # existing file/reparse target or a competing creator is not adopted on error.
  Assert-SealedCompileDirectoryChain $compileBase
  Microsoft.PowerShell.Management\New-Item -Path $compileBase -Name 'windows-sealed-compiler' -ItemType Directory -ErrorAction Stop | Out-Null
  Assert-SealedCompileDirectoryChain $compileTemp
}
$env:TEMP = $compileTemp
$env:TMP = $compileTemp
Microsoft.PowerShell.Utility\Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace ArtooSealedRecordV1 {
  static class Native {
    [StructLayout(LayoutKind.Sequential)] internal struct Basic { internal long Creation, Access, Write, Change; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
      internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
      internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IoStatus { internal IntPtr Status; internal UIntPtr Information; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info value);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out Basic value, uint size);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInfo(SafeFileHandle file, int kind, byte[] value, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder value, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool ReadFile(SafeFileHandle file, byte[] buffer, uint size, out uint read, IntPtr overlapped);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityInfo(SafeFileHandle file, uint type, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr value);
    [DllImport("ntdll.dll")] internal static extern int NtQueryEaFile(SafeFileHandle file, out IoStatus status, byte[] buffer, uint length, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr list, uint listLength, IntPtr index, [MarshalAs(UnmanagedType.U1)] bool restart);
    internal static void Check(bool success, string phase) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), phase); }
    internal static string Hash(byte[] bytes) { using (var hash=SHA256.Create()) return "sha256:"+BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    internal static string Ns(long ticks) { return checked((ticks-116444736000000000L)*100L).ToString(System.Globalization.CultureInfo.InvariantCulture); }
    internal static void Path(SafeFileHandle file, string expected) {
      var buffer=new StringBuilder(4100); uint length=GetFinalPathNameByHandleW(file,buffer,(uint)buffer.Capacity,0);
      Check(length>0,"sealed-final-path");
      if(length>=buffer.Capacity || !String.Equals(buffer.ToString(),@"\\?\"+expected,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("sealed-path-changed");
    }
  }
  public sealed class Ea { public string name, sha256; public int flags, bytes; public bool containsExpectedSha256; }
  public sealed class StreamFact { public string name, size, allocation; }
  public sealed class Snapshot {
    public string dev, ino, size, mtimeNs, ctimeNs, birthtimeNs, sha256, securitySha256;
    public uint attributes, links; public Ea[] eas; public StreamFact[] streams;
  }
  public sealed class Audit { public int version=1; public Snapshot before, after; }
  public sealed class Observer : IDisposable {
    readonly string path; readonly byte[] expectedHash; readonly List<SafeFileHandle> parents=new List<SafeFileHandle>();
    SafeFileHandle handle; Snapshot first; byte[] initialSecurity; bool completed;
    public Observer(string path, string digest) {
      this.path=path; expectedHash=new byte[32];
      if(digest==null || digest.Length!=71 || !digest.StartsWith("sha256:",StringComparison.Ordinal)) throw new InvalidDataException("sealed-digest");
      for(int i=0;i<32;i++) expectedHash[i]=Convert.ToByte(digest.Substring(7+i*2,2),16);
      try {
        string parent=System.IO.Path.GetDirectoryName(path);
        while(parent!=null) {
          var owned=Native.CreateFileW(parent,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero); parents.Add(owned);
          Native.Check(!owned.IsInvalid,"sealed-parent-open"); Native.Info info;
          Native.Check(Native.GetFileInformationByHandle(owned,out info),"sealed-parent-info"); Native.Path(owned,parent);
          if((info.Attributes&0x410)!=0x10) throw new InvalidDataException("sealed-parent-kind");
          var next=System.IO.Directory.GetParent(parent); parent=next==null?null:next.FullName;
        }
        handle=Native.CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x08200000,IntPtr.Zero);
        Native.Check(!handle.IsInvalid,"sealed-file-open"); first=Observe(out initialSecurity);
        if(first.sha256!=digest) throw new InvalidDataException("sealed-content-binding");
      } catch { Dispose(); throw; }
    }
    Snapshot Metadata() {
      Native.Basic basic; Native.Info info; Native.Path(handle,path);
      Native.Check(Native.GetFileInformationByHandleEx(handle,0,out basic,(uint)Marshal.SizeOf(typeof(Native.Basic))),"sealed-basic-info");
      Native.Check(Native.GetFileInformationByHandle(handle,out info),"sealed-file-info");
      ulong size=((ulong)info.SizeHigh<<32)|info.SizeLow;
      if((basic.Attributes&0x410)!=0 || info.Links!=1 || size==0 || size>65536) throw new InvalidDataException("sealed-regular-file-bound");
      return new Snapshot { dev=info.Volume.ToString(),ino=(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(),size=size.ToString(),
        mtimeNs=Native.Ns(basic.Write),ctimeNs=Native.Ns(basic.Change),birthtimeNs=Native.Ns(basic.Creation),attributes=basic.Attributes,links=info.Links };
    }
    byte[] Security() {
      IntPtr owner,group,dacl,sacl,descriptor; uint error=Native.GetSecurityInfo(handle,1,7,out owner,out group,out dacl,out sacl,out descriptor);
      if(error!=0) throw new Win32Exception((int)error,"sealed-security");
      try { uint length=Native.GetSecurityDescriptorLength(descriptor); if(length<20||length>65536) throw new InvalidDataException("sealed-security-bound");
        var bytes=new byte[length]; Marshal.Copy(descriptor,bytes,0,(int)length); return bytes;
      } finally { Native.LocalFree(descriptor); }
    }
    string Contents() {
      long position; Native.Check(Native.SetFilePointerEx(handle,0,out position,0),"sealed-seek");
      using(var bytes=new MemoryStream()) {
        var buffer=new byte[8192]; uint read;
        for(;;) { Native.Check(Native.ReadFile(handle,buffer,(uint)buffer.Length,out read,IntPtr.Zero),"sealed-read");
          if(read==0) break; if(bytes.Length+read>65536) throw new InvalidDataException("sealed-content-bound"); bytes.Write(buffer,0,(int)read); }
        return Native.Hash(bytes.ToArray());
      }
    }
    bool ContainsDigest(byte[] bytes) {
      int count=0;
      for(int i=0;i+expectedHash.Length<=bytes.Length;i++) { bool same=true;
        for(int j=0;j<expectedHash.Length;j++) if(bytes[i+j]!=expectedHash[j]) { same=false; break; }
        if(same) count++;
      }
      return count==1;
    }
    Ea[] Eas() {
      var buffer=new byte[65536]; Native.IoStatus status; int result=Native.NtQueryEaFile(handle,out status,buffer,(uint)buffer.Length,false,IntPtr.Zero,0,IntPtr.Zero,true);
      if(unchecked((uint)result)==0xc0000052 || unchecked((uint)result)==0x80000012) return new Ea[0];
      if(result!=0) throw new InvalidDataException("sealed-ea-query");
      int used=checked((int)status.Information.ToUInt64()); if(used<0||used>buffer.Length) throw new InvalidDataException("sealed-ea-bound");
      var entries=new List<Ea>(); int offset=0;
      while(offset<used) {
        if(entries.Count>=128||offset+8>used) throw new InvalidDataException("sealed-ea-entry-bound");
        int next=checked((int)BitConverter.ToUInt32(buffer,offset)), names=buffer[offset+5], size=BitConverter.ToUInt16(buffer,offset+6);
        if(names==0||offset+9+names+size>used||buffer[offset+8+names]!=0) throw new InvalidDataException("sealed-ea-value-bound");
        for(int i=0;i<names;i++) if(buffer[offset+8+i]<33||buffer[offset+8+i]>126) throw new InvalidDataException("sealed-ea-name");
        string name=Encoding.ASCII.GetString(buffer,offset+8,names).ToUpperInvariant();
        var bytes=new byte[size]; Array.Copy(buffer,offset+9+names,bytes,0,size);
        entries.Add(new Ea { name=name,flags=buffer[offset+4],bytes=size,sha256=Native.Hash(bytes),containsExpectedSha256=ContainsDigest(bytes) });
        if(next==0) break; if((next&3)!=0||next<9+names+size||offset+next>=used) throw new InvalidDataException("sealed-ea-next-bound"); offset+=next;
      }
      entries.Sort(delegate(Ea left,Ea right) { return StringComparer.Ordinal.Compare(left.name,right.name); });
      for(int i=1;i<entries.Count;i++) if(entries[i-1].name==entries[i].name) throw new InvalidDataException("sealed-ea-duplicate");
      return entries.ToArray();
    }
    StreamFact[] Streams() {
      var buffer=new byte[65536]; Native.Check(Native.QueryInfo(handle,7,buffer,(uint)buffer.Length),"sealed-stream-query");
      int next=checked((int)BitConverter.ToUInt32(buffer,0)), names=checked((int)BitConverter.ToUInt32(buffer,4));
      if(next!=0||names<0||(names&1)!=0||24+names>buffer.Length) throw new InvalidDataException("sealed-stream-bound");
      string name=Encoding.Unicode.GetString(buffer,24,names); long size=BitConverter.ToInt64(buffer,8),allocation=BitConverter.ToInt64(buffer,16);
      if(name!="::$DATA"||size<0||allocation<0) throw new InvalidDataException("sealed-stream-kind");
      return new [] {new StreamFact { name=name,size=size.ToString(),allocation=allocation.ToString() }};
    }
    Snapshot Observe(out byte[] security) {
      var before=Metadata(); security=Security(); var eas=Eas(); var streams=Streams(); var content=Contents(); var after=Metadata();
      // ctime/EA are diagnostic metadata of this sealed internal record. Every
      // semantic fact remains strict across the original same-handle read.
      if(before.dev!=after.dev||before.ino!=after.ino||before.size!=after.size||before.mtimeNs!=after.mtimeNs
        ||before.birthtimeNs!=after.birthtimeNs||before.attributes!=after.attributes||before.links!=after.links||streams[0].size!=after.size)
        throw new InvalidDataException("sealed-snapshot-changed");
      after.sha256=content; after.securitySha256=Native.Hash(security); after.eas=eas; after.streams=streams; return after;
    }
    public byte[] InitialSecurity() { if(completed) throw new InvalidOperationException("sealed-completed"); return (byte[])initialSecurity.Clone(); }
    public Audit Complete() { if(completed) throw new InvalidOperationException("sealed-reused"); completed=true; byte[] security;
      return new Audit { before=first,after=Observe(out security) };
    }
    public void Dispose() { if(handle!=null) handle.Dispose(); foreach(var parent in parents) parent.Dispose(); }
  }
}
'@ -ErrorAction Stop | Out-Null
`;
