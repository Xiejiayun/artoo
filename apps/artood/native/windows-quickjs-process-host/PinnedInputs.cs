using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Artoo.QuickJsProcessHost;

// These locks establish byte/namespace continuity, not installation provenance.
// The trusted caller separately admits the protected installation and rechecks it.
internal sealed class PinnedInputs : IDisposable
{
    private sealed record HeldDirectory(string Path, SafeFileHandle Handle, Native.FileInformation Identity);
    private sealed record HeldFile(FilePin Pin, FileStream Stream, Native.FileInformation Identity);
    private readonly Dictionary<string, HeldDirectory> directories = new(StringComparer.Ordinal);
    private readonly List<HeldFile> files = [];

    internal PinnedInputs(Launch launch, Action checkBudget) {
        try {
            foreach (FilePin pin in Protocol.AllPins(launch).DistinctBy(pin => pin.Path, StringComparer.Ordinal)) {
                checkBudget(); HoldParents(Path.GetDirectoryName(pin.Path)!, checkBudget);
                // FILE_SHARE_READ denies existing/new write and delete handles. Opening
                // the reparse point itself lets us reject it rather than follow it.
                SafeFileHandle handle = Native.CreateFileW(pin.Path, 0x80000000, 1, IntPtr.Zero, 3, 0x08200000, IntPtr.Zero);
                try {
                    Native.Require(!handle.IsInvalid && Native.GetFileInformationByHandle(handle, out _), "pin-open");
                    Native.Require(Native.GetFileInformationByHandle(handle, out var identity)
                        && (identity.Attributes & (0x10 | 0x400)) == 0 && identity.Links == 1, "pin-file-kind");
                    Native.Require(string.Equals(Native.FinalPath(handle), pin.Path, StringComparison.OrdinalIgnoreCase), "pin-file-alias");
                    var stream = new FileStream(handle, FileAccess.Read);
                    var held = new HeldFile(pin, stream, identity); files.Add(held);
                    CheckFile(held, checkBudget);
                } catch { handle.Dispose(); throw; }
            }
        } catch { Dispose(); throw; }
    }
    private void HoldParents(string parent, Action checkBudget) {
        var chain = new Stack<string>();
        for (string? path = parent; path is not null && !directories.ContainsKey(path); path = Path.GetDirectoryName(path)) chain.Push(path);
        while (chain.TryPop(out string? path)) {
            checkBudget();
            // Directory writes remain possible, but denying delete sharing prevents an
            // ancestor rename/replacement from redirecting the fixed loader namespace.
            var handle = Native.CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            try {
                Native.Require(!handle.IsInvalid && Native.GetFileInformationByHandle(handle, out _), "pin-parent-open");
                Native.Require(Native.GetFileInformationByHandle(handle, out var identity)
                    && (identity.Attributes & 0x10) != 0 && (identity.Attributes & 0x400) == 0, "pin-parent-kind");
                Native.Require(string.Equals(Native.FinalPath(handle), path, StringComparison.OrdinalIgnoreCase), "pin-parent-alias");
                directories.Add(path, new HeldDirectory(path, handle, identity));
            } catch { handle.Dispose(); throw; }
        }
    }
    internal void AssertUnchanged(Action checkBudget) {
        foreach (HeldDirectory directory in directories.Values) {
            checkBudget();
            Native.Require(Native.GetFileInformationByHandle(directory.Handle, out var identity)
                && Native.SameFile(identity, directory.Identity) && (identity.Attributes & 0x400) == 0
                && string.Equals(Native.FinalPath(directory.Handle), directory.Path, StringComparison.OrdinalIgnoreCase), "pin-parent-changed");
        }
        foreach (HeldFile file in files) CheckFile(file, checkBudget);
    }
    private static void CheckFile(HeldFile file, Action checkBudget) {
        checkBudget();
        Native.Require(Native.GetFileInformationByHandle(file.Stream.SafeFileHandle, out var identity)
            && Native.SameFile(identity, file.Identity) && identity.Links == 1 && (identity.Attributes & (0x10 | 0x400)) == 0
            && file.Stream.Length == file.Pin.Bytes
            && string.Equals(Native.FinalPath(file.Stream.SafeFileHandle), file.Pin.Path, StringComparison.OrdinalIgnoreCase), "pin-identity-changed");
        file.Stream.Position = 0;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[65536];
        for (;;) {
            checkBudget();
            int count = file.Stream.Read(buffer, 0, buffer.Length);
            checkBudget();
            if (count == 0) break;
            hash.AppendData(buffer, 0, count);
        }
        Native.Require("sha256:" + Convert.ToHexStringLower(hash.GetHashAndReset()) == file.Pin.Sha256, "pin-bytes-changed");
    }
    public void Dispose() {
        foreach (HeldFile file in files) file.Stream.Dispose();
        files.Clear();
        foreach (HeldDirectory directory in directories.Values.Reverse()) directory.Handle.Dispose();
        directories.Clear();
    }
}
