// Candidate source only. Qualification describes this fixed native launch; it is
// not a passed verifier, a recovered workspace, or a publication authorization.
using Microsoft.Win32.SafeHandles;
using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal sealed record SupervisorFilePin(string Path, long Bytes, string Sha256);
internal sealed record SupervisorLaunch(int Version, string Kind, SupervisorFilePin Node, SupervisorFilePin Entry,
    SupervisorFilePin Configuration, string Cwd, string[] Args, Dictionary<string, string> Env,
    int MaxRestarts, int RestartBackoffMs, int LifetimeMs, int OutputLimitBytes,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SupervisorLifetimeOwnership? LifetimeOwnership = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SupervisorFilePin? RuntimeManifest = null);
internal sealed record SupervisorLifetimeOwnership(int Version, int CleanupTimeoutMs, int GracefulStopMs);
internal sealed record SupervisorLifetimeQualification(int Version, string Capability, int CleanupTimeoutMs,
    int GracefulStopMs, bool SharedJob, bool AtomicDaemonMembership,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SupervisorFilePin? RuntimeManifest = null);
internal sealed record SupervisorIdentity(uint Pid, string CreationTime, string Image, string Sid);
internal sealed record SupervisorQualification(int Version, string Capability, SupervisorIdentity Daemon,
    SupervisorIdentity Supervisor, string LaunchIdentityDigest,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SupervisorLifetimeQualification? LifetimeOwnership = null);
internal sealed record SupervisorQualifyInput(int Version, string Kind);
internal sealed record SupervisorQuery(int Version, string Kind, string Nonce, uint DaemonPid, string DaemonCreationTime,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] GuardianRequestDeadline? Deadline = null);
internal sealed record SupervisorQueryResult(int Version, string Kind, string Nonce, SupervisorQualification Payload);
internal sealed record SupervisorControl(int Version, string Kind, string Nonce, int? Generation, string? Data);

internal static class SupervisorProtocol
{
    internal const string Capability = "artoo.windows-daemon-supervisor.v1";
    internal const string LifetimeCapability = "artoo.windows-daemon-supervisor-lifetime.v1";
    internal static string Pipe(GuardianProcess supervisor) => "artoo-daemon-supervisor-v1-" + supervisor.Pid.ToString(CultureInfo.InvariantCulture)
        + "-" + supervisor.CreationTime.ToString(CultureInfo.InvariantCulture);
    internal static SupervisorIdentity Identity(GuardianProcess process) => new(process.Pid,
        process.CreationTime.ToString(CultureInfo.InvariantCulture), process.Image, process.Sid);
    internal static bool SameImage(string left, string right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    internal static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static void Close(ref IntPtr handle) {
        IntPtr old = handle; handle = IntPtr.Zero;
        if (old != IntPtr.Zero && old != new IntPtr(-1)) Native.CloseHandle(old);
    }
    internal static NamedPipeServerStream CreatePipe(string name, string sid, bool first) {
        GuardianWire.Require(GuardianNative.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out IntPtr descriptor, out _), "supervisor_pipe_acl");
        try {
            var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), lpSecurityDescriptor = descriptor };
            var handle = GuardianNative.CreateNamedPipeW("\\\\.\\pipe\\" + name,
                3 | 0x40000000 | (first ? 0x00080000u : 0), 8, 16, 65536, 65536, 0, ref security);
            GuardianWire.Require(!handle.IsInvalid, "supervisor_pipe_create");
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        } finally { GuardianNative.LocalFree(descriptor); }
    }
}

/** All values are measured again from held physical handles. Read-only sharing
 * prevents replacement or byte modification while the same launch is supervised. */
internal sealed class SupervisorPinnedFile : IDisposable
{
    private readonly FileStream stream;
    private readonly GuardianNative.BY_HANDLE_FILE_INFORMATION identity;
    internal readonly SupervisorFilePin Pin;
    internal SupervisorPinnedFile(SupervisorFilePin pin, string sid, bool allowEmpty = false) {
        GuardianWire.Require(pin is not null && System.IO.Path.IsPathFullyQualified(pin.Path) && !pin.Path.StartsWith("\\\\", StringComparison.Ordinal)
            && pin.Bytes >= (allowEmpty ? 0 : 1) && pin.Bytes <= 536870912 && GuardianWire.Hash(pin.Sha256), "supervisor_file_pin");
        var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>() };
        var handle = new SafeFileHandle(Native.CreateFileW(pin.Path, 0x80000000 | 0x00020000, 1, ref security, 3, 0x00200000 | 0x08000000, IntPtr.Zero), true);
        try {
            GuardianWire.Require(!handle.IsInvalid && GuardianNative.GetFileInformationByHandle(handle, out identity), "supervisor_file_handle");
            GuardianWire.Require((identity.FileAttributes & (0x10 | 0x400)) == 0 && identity.NumberOfLinks == 1, "supervisor_file_reparse_or_links");
            var final = new StringBuilder(32768);
            uint length = GuardianNative.GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
            GuardianWire.Require(length > 0 && length < final.Capacity && final.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal)
                && SupervisorProtocol.SameImage(final.ToString()[4..], pin.Path), "supervisor_file_alias");
            SupervisorNative.AssertProtectedFile(handle, sid);
            stream = new FileStream(handle, FileAccess.Read); Pin = pin; AssertCurrent();
        } catch { handle.Dispose(); throw; }
    }
    internal void AssertCurrent(GuardianRequestBudget? budget = null) {
        budget?.AssertCurrent();
        GuardianWire.Require(GuardianNative.GetFileInformationByHandle(stream.SafeFileHandle, out var current)
            && current.VolumeSerialNumber == identity.VolumeSerialNumber && current.FileIndexHigh == identity.FileIndexHigh
            && current.FileIndexLow == identity.FileIndexLow && current.NumberOfLinks == 1
            && (current.FileAttributes & (0x10 | 0x400)) == 0 && stream.Length == Pin.Bytes, "supervisor_file_identity_changed");
        stream.Position = 0;
        string digest;
        if (budget is null) digest = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(stream));
        else {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            byte[] buffer = ArrayPool<byte>.Shared.Rent(65536);
            try {
                for (;;) {
                    budget.AssertCurrent();
                    // A synchronous kernel read cannot be preempted by this token.
                    // Qualify never holds the control gate across this work.
                    int count = stream.Read(buffer, 0, 65536);
                    budget.AssertCurrent();
                    if (count == 0) break;
                    hash.AppendData(buffer, 0, count);
                }
                digest = "sha256:" + Convert.ToHexStringLower(hash.GetHashAndReset());
            } finally { ArrayPool<byte>.Shared.Return(buffer, clearArray: true); }
        }
        GuardianWire.Require(digest == Pin.Sha256, "supervisor_file_bytes_changed");
        budget?.AssertCurrent();
    }
    internal byte[] ReadBytes(int maximum) {
        AssertCurrent(); GuardianWire.Require(stream.Length <= maximum, "supervisor_runtime_manifest_bound");
        stream.Position = 0; var bytes = new byte[checked((int)stream.Length)]; stream.ReadExactly(bytes); AssertCurrent(); return bytes;
    }
    public void Dispose() => stream.Dispose();
}

/** Used by the short qualifier and by the surviving guardian. The queried daemon
 * comes from an opened kernel parent, never directly from a remote message. */
internal static class DaemonSupervisorAuthority
{
    internal static SupervisorQualification Require(GuardianProcess daemon, string? expectedLaunchIdentityDigest = null,
        CancellationToken cancellation = default, GuardianRequestDeadline? requestedDeadline = null) {
        using var budget = new GuardianRequestBudget(5000, cancellation, requestedDeadline);
        budget.AssertCurrent();
        using var self = new GuardianProcess((uint)Environment.ProcessId);
        using var supervisor = new GuardianProcess(daemon.ParentPid);
        GuardianWire.Require(!daemon.Exited && !supervisor.Exited && daemon.CreationTime > supervisor.CreationTime
            && daemon.Sid == self.Sid && supervisor.Sid == self.Sid
            && SupervisorProtocol.SameImage(supervisor.Image, self.Image)
            && supervisor.HasNativeMode("--daemon-supervisor-v1"), "supervisor_exact_kernel_parent");
        budget.AssertCurrent();
        using var pipe = new NamedPipeClientStream(".", SupervisorProtocol.Pipe(supervisor), PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.ConnectAsync(budget.Token).GetAwaiter().GetResult();
        GuardianWire.Require(GuardianNative.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint serverPid)
            && serverPid == supervisor.Pid, "supervisor_pipe_server_pid");
        using var actualServer = new GuardianProcess(serverPid);
        GuardianWire.Require(actualServer.Same(supervisor) && !actualServer.Exited, "supervisor_pipe_server_identity");
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
        string nonce = Guid.NewGuid().ToString("D");
        budget.AssertCurrent();
        writer.WriteLineAsync(GuardianWire.Encode(new SupervisorQuery(1, "qualify", nonce, daemon.Pid,
            daemon.CreationTime.ToString(CultureInfo.InvariantCulture), new(1, budget.DeadlineTickCount64))).AsMemory(), budget.Token).GetAwaiter().GetResult();
        var response = GuardianWire.Decode<SupervisorQueryResult>(GuardianWire.ReadLine(reader, budget.Token).GetAwaiter().GetResult());
        var result = response.Payload;
        budget.AssertCurrent();
        GuardianWire.Require(response.Version == 1 && response.Kind == "qualified" && response.Nonce == nonce
            && result is not null && result.Version == 1 && result.Capability == SupervisorProtocol.Capability
            && result.Daemon == SupervisorProtocol.Identity(daemon) && result.Supervisor == SupervisorProtocol.Identity(supervisor)
            && GuardianWire.Hash(result.LaunchIdentityDigest)
            && (expectedLaunchIdentityDigest is null || result.LaunchIdentityDigest == expectedLaunchIdentityDigest)
            && !daemon.Exited && !supervisor.Exited, "supervisor_original_launch_binding");
        return result;
    }
}

internal sealed class SupervisorFrames
{
    private readonly BlockingCollection<string> queue = new(128);
    // Diagnostics never occupy the authoritative stdout queue or set its Failed
    // flag. A blocked/lost stderr consumer may lose diagnostics, not the daemon.
    private readonly BlockingCollection<string> diagnostics = new(16);
    private readonly Thread writer;
    private readonly object gate = new();
    private long sequence;
    internal volatile bool Failed;
    internal SupervisorFrames() {
        writer = new Thread(() => {
            try {
                using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 4096, false) { AutoFlush = true };
                foreach (string line in queue.GetConsumingEnumerable()) output.WriteLine(line);
            } catch { Failed = true; }
        }) { IsBackground = true, Name = "artoo-supervisor-frames" }; writer.Start();
        new Thread(() => {
            try {
                using var output = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false), 4096, false) { AutoFlush = true };
                foreach (string line in diagnostics.GetConsumingEnumerable()) output.WriteLine(line);
            } catch { /* Best-effort diagnostics cannot fail ordinary control output. */ }
        }) { IsBackground = true, Name = "artoo-supervisor-diagnostics" }.Start();
    }
    internal void Diagnostic(NativeFailureDiagnostic diagnostic) {
        try { diagnostics.TryAdd(GuardianWire.Encode(new { version = 1, kind = "native_failure_diagnostic", payload = diagnostic })); }
        catch { /* Queue-full/write failures neither terminate nor qualify a daemon. */ }
    }
    internal void Send(string kind, object payload) {
        lock (gate) {
            if (queue.IsAddingCompleted) return;
            if (Failed || !queue.TryAdd(GuardianWire.Encode(new { version = 1, kind, sequence = sequence++, payload }))) Failed = true;
        }
    }
    internal void Terminal(string kind, object payload) {
        lock (gate) {
            if (queue.IsAddingCompleted) return;
            if (Failed || !queue.TryAdd(GuardianWire.Encode(new { version = 1, kind, sequence = sequence++, payload }))) Failed = true;
            // Successful lifetime cleanup first observes every producer settled.
            // A failed/unknown cleanup may still have blocked producers; seal the
            // failure frame without allowing their late events after terminal.
            queue.CompleteAdding();
        }
    }
    internal bool Finish() { lock (gate) queue.CompleteAdding(); return writer.Join(2000) && !Failed; }
}

internal sealed class SupervisorIncarnation : IDisposable
{
    internal readonly int Generation;
    internal readonly GuardianProcess Identity;
    internal readonly SafeProcessHandle OriginalHandle;
    internal readonly bool AtomicJobMember;
    private readonly SafeFileHandle input;
    private readonly BlockingCollection<byte[]> writes = new(16);
    private IntPtr output, error;
    internal volatile bool StdoutEof, StderrEof, InputSettled, InputFailed;
    internal bool ExitObserved;
    internal bool ExitReported;
    internal uint? ExitCode;
    internal long? ExitTime;
    internal SupervisorIncarnation(int generation, Native.PROCESS_INFORMATION process, IntPtr stdin, IntPtr stdout, IntPtr stderr,
        SupervisorFrames frames, Func<int, bool> reserveOutput, GuardianProcess supervisor, string nodeImage, bool atomicJobMember = false) {
        Generation = generation; OriginalHandle = new SafeProcessHandle(process.hProcess, true); input = new SafeFileHandle(stdin, true); output = stdout; error = stderr;
        AtomicJobMember = atomicJobMember;
        try {
            Identity = new GuardianProcess(process.dwProcessId);
            GuardianWire.Require(Native.GetProcessTimes(OriginalHandle.DangerousGetHandle(), out long creation, out _, out _, out _)
                && creation == Identity.CreationTime && Identity.ParentPid == supervisor.Pid && creation > supervisor.CreationTime
                && Identity.Sid == supervisor.Sid && SupervisorProtocol.SameImage(Identity.Image, nodeImage), "supervisor_created_handle_identity");
            Pump(stdout, "stdout", frames, reserveOutput); Pump(stderr, "stderr", frames, reserveOutput);
            new Thread(() => {
                try { foreach (byte[] bytes in writes.GetConsumingEnumerable()) {
                    bool held = false;
                    try {
                        input.DangerousAddRef(ref held);
                        GuardianWire.Require(Native.WriteFile(input.DangerousGetHandle(), bytes, (uint)bytes.Length, out uint written, IntPtr.Zero)
                            && written == bytes.Length, "supervisor_input_write");
                        frames.Send("daemon_input_written", new { generation = Generation, bytes = bytes.Length });
                    } finally { if (held) input.DangerousRelease(); }
                } } catch { InputFailed = true; frames.Send("daemon_input_failed", new { generation = Generation }); }
                finally { InputSettled = true; }
            }) { IsBackground = true, Name = "artoo-daemon-input" }.Start();
        } catch {
            Native.TerminateProcess(OriginalHandle.DangerousGetHandle(), 0xE0000003); Native.WaitForSingleObject(OriginalHandle.DangerousGetHandle(), 5000);
            Identity?.Dispose(); OriginalHandle.Dispose(); input.Dispose(); throw;
        }
    }
    private void Pump(IntPtr handle, string stream, SupervisorFrames frames, Func<int, bool> reserveOutput) {
        new Thread(() => {
            try {
                byte[] bytes = new byte[16384];
                for (;;) {
                    if (!Native.ReadFile(handle, bytes, (uint)bytes.Length, out uint read, IntPtr.Zero)) {
                        if (Marshal.GetLastWin32Error() == 109) {
                            frames.Send("daemon_pipe_eof", new { generation = Generation, stream });
                            // Cleanup cannot publish its terminal until this EOF
                            // event is already admitted to the ordered frame queue.
                            if (stream == "stdout") StdoutEof = true; else StderrEof = true;
                        }
                        return;
                    }
                    if (read == 0) continue;
                    if (reserveOutput(checked((int)read))) frames.Send("daemon_output", new {
                        generation = Generation, stream, data = Convert.ToBase64String(bytes, 0, checked((int)read)) });
                }
            } catch { /* A failed reader never reports pipe EOF. */ }
        }) { IsBackground = true, Name = "artoo-daemon-" + stream }.Start();
    }
    internal bool ObserveExit() {
        if (ExitObserved) return true;
        uint wait = Native.WaitForSingleObject(OriginalHandle.DangerousGetHandle(), 0);
        if (wait == 258) return false;
        uint status = 0; long creation = 0, exit = 0;
        GuardianWire.Require(wait == 0 && Native.GetExitCodeProcess(OriginalHandle.DangerousGetHandle(), out status)
            && Native.GetProcessTimes(OriginalHandle.DangerousGetHandle(), out creation, out exit, out _, out _)
            && creation == Identity.CreationTime && exit > 0, "supervisor_original_daemon_wait");
        ExitObserved = true; ExitCode = status; ExitTime = exit; writes.CompleteAdding(); input.Dispose(); return true;
    }
    internal void Terminate() {
        if (!ObserveExit()) GuardianWire.Require(Native.TerminateProcess(OriginalHandle.DangerousGetHandle(), 0xE0000003), "supervisor_terminate_current");
    }
    internal bool ParentOf(GuardianProcess child) => child.ParentPid == Identity.Pid && child.CreationTime > Identity.CreationTime
        && (!ExitObserved || child.CreationTime <= ExitTime!.Value);
    internal void Enqueue(byte[] bytes) => GuardianWire.Require(!ExitObserved && !writes.IsAddingCompleted && writes.TryAdd(bytes), "supervisor_input_queue");
    public void Dispose() {
        writes.CompleteAdding(); input.Dispose(); SupervisorProtocol.Close(ref output); SupervisorProtocol.Close(ref error);
        Identity.Dispose(); OriginalHandle.Dispose();
    }
}

internal sealed class DaemonSupervisorState : IDisposable
{
    private readonly object gate = new();
    // Held streams share their positions. Serialize complete inspection separately
    // from original-process/control state; always acquire this before gate.
    private readonly object qualificationGate = new();
    private readonly SupervisorLaunch launch;
    private readonly GuardianProcess self = new((uint)Environment.ProcessId);
    private readonly SupervisorPinnedFile node, entry, configuration;
    private readonly List<GuardianDirectory> directories = [];
    private readonly List<SupervisorIncarnation> history = [];
    private readonly SortedDictionary<string, string> environment;
    private readonly SupervisorFrames frames;
    private long outputBytes;
    private bool outputExceeded;
    private bool disposed;
    // One Job spans every generation. Its HANDLE is never inherited and is never
    // closed or terminated merely because one daemon exits.
    private IntPtr lifetimeJob;
    private bool lifetimeJobCreated, restartDisabled, gracefulStopArmed, gracefulStopTimedOut;
    private bool forcedJobTermination, jobEmptyObserved, cleanupConfirmed, cleanupFault, startFailed;
    private Stopwatch? cleanupClock;
    private SupervisorPinnedFile? runtimeManifest;
    private readonly List<SupervisorPinnedFile> runtimeFiles = [];
    private readonly Dictionary<string, HashSet<string>> runtimeDirectoryEntries = new(StringComparer.OrdinalIgnoreCase);
    internal readonly string LaunchIdentityDigest;
    internal string PipeName => SupervisorProtocol.Pipe(self);
    internal string Sid => self.Sid;
    internal int Generation => history.Count - 1;
    internal bool HasDaemon => history.Count > 0;
    internal bool OwnsLifetime => launch.LifetimeOwnership is not null;
    internal bool GracefulStopArmed => gracefulStopArmed;
    internal bool InputFailed { get { lock (gate) return history.Any(item => item.InputFailed); } }
    internal uint? CurrentExitCode => history.Count > 0 ? history[^1].ExitCode : null;
    internal DaemonSupervisorState(SupervisorLaunch input, SupervisorFrames output) {
        frames = output; launch = input;
        GuardianWire.Require(input.Version == 1 && input.Kind == "launch" && input.Node is not null && input.Entry is not null && input.Configuration is not null
            && input.Args is not null && input.Args.Length <= 128 && input.Env is not null && input.Env.Count <= 128
            && input.Args.All(arg => arg is not null && arg.Length <= 4096 && !arg.Contains('\0'))
            && input.MaxRestarts is >= 0 and <= 8 && input.RestartBackoffMs is >= 0 and <= 5000
            && input.LifetimeMs is >= 1000 and <= 86400000 && input.OutputLimitBytes is >= 1 and <= 16777216
            && input.Node.Path.EndsWith("node.exe", StringComparison.OrdinalIgnoreCase)
            && self.HasNativeMode("--daemon-supervisor-v1"), "supervisor_fixed_launch");
        GuardianWire.Require(input.LifetimeOwnership is null || input.LifetimeOwnership is { Version: 1,
            CleanupTimeoutMs: >= 100 and <= 60000, GracefulStopMs: >= 100 and <= 60000 }, "supervisor_lifetime_configuration");
        GuardianWire.Require(input.RuntimeManifest is null || input.LifetimeOwnership is not null, "supervisor_runtime_manifest_requires_lifetime");
        try {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string path in new[] { input.Cwd, System.IO.Path.GetDirectoryName(input.Node.Path)!, System.IO.Path.GetDirectoryName(input.Entry.Path)!, System.IO.Path.GetDirectoryName(input.Configuration.Path)! }) {
                string? current = path;
                while (current is not null) { if (paths.Add(current)) directories.Add(new GuardianDirectory(current)); current = System.IO.Path.GetDirectoryName(current); }
            }
            node = new SupervisorPinnedFile(input.Node, self.Sid); entry = new SupervisorPinnedFile(input.Entry, self.Sid);
            configuration = new SupervisorPinnedFile(input.Configuration, self.Sid);
            environment = CleanEnvironment(input.Env);
            if (input.RuntimeManifest is not null) PrepareRuntimeManifest(input.RuntimeManifest);
            // Only this fixed launch descriptor is measured here. The daemon separately
            // binds its complete runtime configuration to this stable launch digest.
            var descriptor = new { version = 1, capability = SupervisorProtocol.Capability,
                image = self.Image, imageDigest = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(self.Image))),
                mode = "--daemon-supervisor-v1", node = node.Pin, entry = entry.Pin, configuration = configuration.Pin,
                cwd = input.Cwd, args = input.Args, env = environment, input.MaxRestarts, input.RestartBackoffMs, input.LifetimeMs, input.OutputLimitBytes };
            // The absent option preserves the complete historical digest shape.
            LaunchIdentityDigest = input.LifetimeOwnership is null ? GuardianWire.Digest(descriptor)
                : input.RuntimeManifest is null ? GuardianWire.Digest(new { launch = descriptor, lifetimeOwnership = input.LifetimeOwnership })
                : GuardianWire.Digest(new { launch = descriptor, lifetimeOwnership = input.LifetimeOwnership, runtimeManifest = input.RuntimeManifest });
            if (OwnsLifetime) {
                lifetimeJob = Native.CreateJobObjectW(IntPtr.Zero, null);
                GuardianWire.Require(lifetimeJob != IntPtr.Zero, "supervisor_lifetime_job_create"); lifetimeJobCreated = true;
                var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                GuardianWire.Require(Native.SetInformationJobObject(lifetimeJob, 9, ref limits,
                    (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()), "supervisor_lifetime_job_limits");
                GuardianWire.Require(Native.SetHandleInformation(lifetimeJob, 1, 0), "supervisor_lifetime_job_noninherit");
            }
        } catch { Dispose(); throw; }
    }
    private static string RuntimeMember(string value) {
        GuardianWire.Require(value is { Length: > 0 and <= 32760 } && !System.IO.Path.IsPathRooted(value)
            && !value.Any(character => character is '\\' or ':' || char.IsControl(character))
            && value.Split('/').All(part => part.Length > 0 && part is not "." and not ".."
                && !part.EndsWith('.') && !part.EndsWith(' ')), "supervisor_runtime_member_path");
        return value;
    }
    private void PrepareRuntimeManifest(SupervisorFilePin pin) {
        GuardianWire.Require(System.IO.Path.GetFileName(pin.Path) == "bundle-manifest.json", "supervisor_runtime_manifest_name");
        runtimeManifest = new SupervisorPinnedFile(pin, self.Sid);
        using var document = JsonDocument.Parse(runtimeManifest.ReadBytes(4 * 1024 * 1024));
        var root = document.RootElement;
        GuardianWire.Require(root.GetProperty("format").GetString() == "artoo.desktop-daemon.v1", "supervisor_runtime_manifest_format");
        var tree = root.GetProperty("tree");
        var files = tree.GetProperty("files");
        var directoryValues = tree.GetProperty("directories");
        GuardianWire.Require(files.ValueKind == JsonValueKind.Array && files.GetArrayLength() is > 0 and <= 4096
            && directoryValues.ValueKind == JsonValueKind.Array && directoryValues.GetArrayLength() <= 4096, "supervisor_runtime_manifest_count");
        string directory = System.IO.Path.GetDirectoryName(pin.Path)!;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "bundle-manifest.json" };
        runtimeDirectoryEntries.Add(directory, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "bundle-manifest.json" });
        directories.Add(new GuardianDirectory(directory));
        var relativeDirectories = directoryValues.EnumerateArray().Select(item => RuntimeMember(item.GetString()!)).ToArray();
        foreach (string relative in relativeDirectories) {
            GuardianWire.Require(names.Add(relative), "supervisor_runtime_duplicate_member");
            string path = System.IO.Path.Combine(directory, relative.Replace('/', '\\'));
            runtimeDirectoryEntries.Add(path, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            directories.Add(new GuardianDirectory(path));
        }
        foreach (string relative in relativeDirectories) {
            string path = System.IO.Path.Combine(directory, relative.Replace('/', '\\'));
            GuardianWire.Require(runtimeDirectoryEntries.TryGetValue(System.IO.Path.GetDirectoryName(path)!, out var parent), "supervisor_runtime_parent_missing");
            parent!.Add(System.IO.Path.GetFileName(path));
        }
        long total = 0; bool entryFound = false;
        foreach (var file in files.EnumerateArray()) {
            string relative = RuntimeMember(file.GetProperty("path").GetString()!);
            GuardianWire.Require(names.Add(relative), "supervisor_runtime_duplicate_member");
            long bytes = file.GetProperty("size").GetInt64(); string sha256 = file.GetProperty("sha256").GetString()!;
            GuardianWire.Require(bytes is >= 0 and <= 536870912 && GuardianWire.Hash(sha256), "supervisor_runtime_member_pin");
            total = checked(total + bytes); GuardianWire.Require(total <= 2147483648L, "supervisor_runtime_total_bound");
            string path = System.IO.Path.Combine(directory, relative.Replace('/', '\\'));
            GuardianWire.Require(runtimeDirectoryEntries.TryGetValue(System.IO.Path.GetDirectoryName(path)!, out var parent), "supervisor_runtime_parent_missing");
            parent!.Add(System.IO.Path.GetFileName(path));
            if (SupervisorProtocol.SameImage(path, entry.Pin.Path)) {
                GuardianWire.Require(bytes == entry.Pin.Bytes && sha256 == entry.Pin.Sha256, "supervisor_runtime_entry_pin"); entryFound = true;
            } else {
                GuardianWire.Require(!SupervisorProtocol.SameImage(path, node.Pin.Path) && !SupervisorProtocol.SameImage(path, configuration.Pin.Path), "supervisor_runtime_pin_overlap");
                runtimeFiles.Add(new SupervisorPinnedFile(new(path, bytes, sha256), self.Sid, allowEmpty: true));
            }
        }
        GuardianWire.Require(entryFound, "supervisor_runtime_entry_missing"); AssertRuntimeManifest();
    }
    private void AssertRuntimeManifest(GuardianRequestBudget? budget = null) {
        budget?.AssertCurrent();
        if (runtimeManifest is null) return;
        runtimeManifest.AssertCurrent(budget); foreach (var file in runtimeFiles) file.AssertCurrent(budget);
        foreach (var directory in runtimeDirectoryEntries) {
            budget?.AssertCurrent(); int count = 0;
            foreach (string path in System.IO.Directory.EnumerateFileSystemEntries(directory.Key)) {
                budget?.AssertCurrent(); count++;
                GuardianWire.Require(directory.Value.Contains(System.IO.Path.GetFileName(path)), "supervisor_runtime_inventory_changed");
            }
            GuardianWire.Require(count == directory.Value.Count, "supervisor_runtime_inventory_changed");
            budget?.AssertCurrent();
        }
    }
    private static SortedDictionary<string, string> CleanEnvironment(Dictionary<string, string> input) {
        var result = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in input) {
            GuardianWire.Require(!string.IsNullOrEmpty(pair.Key) && !pair.Key.Contains('=') && !pair.Key.Contains('\0')
                && pair.Value is not null && !pair.Value.Contains('\0') && pair.Value.Length <= 32768, "supervisor_environment");
            string upper = pair.Key.ToUpperInvariant();
            if (upper.StartsWith("NODE_", StringComparison.Ordinal) || upper.StartsWith("DOTNET_", StringComparison.Ordinal)
                || upper.StartsWith("COMPLUS_", StringComparison.Ordinal) || upper.StartsWith("CORECLR_", StringComparison.Ordinal)
                || upper.StartsWith("COR_", StringComparison.Ordinal) || upper.StartsWith("ELECTRON_", StringComparison.Ordinal)
                || upper is "OPENSSL_CONF" or "OPENSSL_MODULES" or "SSLKEYLOGFILE") continue;
            GuardianWire.Require(result.TryAdd(pair.Key, pair.Value), "supervisor_environment_duplicate");
        }
        string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        GuardianWire.Require(System.IO.Path.IsPathFullyQualified(system), "supervisor_system_root");
        result["SystemRoot"] = system; result["WINDIR"] = system;
        result["PATH"] = System.IO.Path.Combine(system, "System32");
        return result;
    }
    private bool ReserveOutput(int count) { if (Interlocked.Add(ref outputBytes, count) <= launch.OutputLimitBytes) return true; outputExceeded = true; return false; }
    internal bool OutputExceeded => Volatile.Read(ref outputExceeded);
    internal void Ready() {
        if (OwnsLifetime) {
            var lifetime = new Dictionary<string, object> { ["version"] = 1, ["capability"] = SupervisorProtocol.LifetimeCapability,
                ["cleanupTimeoutMs"] = launch.LifetimeOwnership!.CleanupTimeoutMs, ["gracefulStopMs"] = launch.LifetimeOwnership.GracefulStopMs,
                ["sharedJob"] = true };
            if (launch.RuntimeManifest is not null) lifetime["runtimeManifest"] = launch.RuntimeManifest;
            frames.Send("supervisor_ready", new { capability = SupervisorProtocol.Capability,
                supervisor = SupervisorProtocol.Identity(self), launchIdentityDigest = LaunchIdentityDigest, lifetimeOwnership = lifetime });
        }
        else frames.Send("supervisor_ready", new { capability = SupervisorProtocol.Capability,
            supervisor = SupervisorProtocol.Identity(self), launchIdentityDigest = LaunchIdentityDigest });
    }
    internal void Start() {
        lock (qualificationGate) lock (gate) {
            GuardianWire.Require(!restartDisabled && history.Count <= launch.MaxRestarts && (history.Count == 0 || history[^1].ExitObserved), "supervisor_restart_before_original_exit");
            node.AssertCurrent(); entry.AssertCurrent(); configuration.AssertCurrent(); AssertRuntimeManifest();
            IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero,
                stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, env = IntPtr.Zero;
            Native.PROCESS_INFORMATION process = default; bool initialized = false, created = false, adopted = false;
            try {
                var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle = 1 };
                GuardianWire.Require(Native.CreatePipe(out stdinRead, out stdinWrite, ref security, 0)
                    && Native.CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0)
                    && Native.CreatePipe(out stderrRead, out stderrWrite, ref security, 0)
                    && Native.SetHandleInformation(stdinWrite, 1, 0) && Native.SetHandleInformation(stdoutRead, 1, 0)
                    && Native.SetHandleInformation(stderrRead, 1, 0), "supervisor_stdio_create");
                int attributeCount = OwnsLifetime ? 2 : 1;
                UIntPtr size = UIntPtr.Zero; Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
                GuardianWire.Require(size.ToUInt64() is > 0 and <= 65536, "supervisor_attribute_size");
                attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
                GuardianWire.Require(Native.InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size), "supervisor_attributes"); initialized = true;
                handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(handles, stdinRead);
                Marshal.WriteIntPtr(handles, IntPtr.Size, stdoutWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, stderrWrite);
                GuardianWire.Require(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002), handles,
                    new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "supervisor_handle_list");
                if (OwnsLifetime) {
                    jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, lifetimeJob);
                    GuardianWire.Require(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x0002000D), jobs,
                        new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "supervisor_lifetime_atomic_job_list");
                }
                var startup = new Native.STARTUPINFOEX(); startup.StartupInfo.cb = (uint)Marshal.SizeOf<Native.STARTUPINFOEX>();
                startup.StartupInfo.dwFlags = 0x100; startup.StartupInfo.hStdInput = stdinRead;
                startup.StartupInfo.hStdOutput = stdoutWrite; startup.StartupInfo.hStdError = stderrWrite; startup.lpAttributeList = attributes;
                var command = new StringBuilder(string.Join(" ", new[] { node.Pin.Path, entry.Pin.Path }.Concat(launch.Args).Select(SupervisorProtocol.Quote)));
                GuardianWire.Require(command.Length < 32767, "supervisor_command_bound");
                env = Marshal.StringToHGlobalUni(string.Join('\0', environment.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0");
                // There is no per-daemon Job or BREAKAWAY. The opt-in lifetime Job
                // is shared by all generations and survives each individual daemon.
                created = Native.CreateProcessW(node.Pin.Path, command, IntPtr.Zero, IntPtr.Zero, true,
                    0x00000004 | 0x00000400 | 0x00080000 | 0x08000000, env, launch.Cwd, ref startup, out process);
                GuardianWire.Require(created, "supervisor_daemon_create");
                bool atomicMember = false;
                if (OwnsLifetime) GuardianWire.Require(Native.IsProcessInJob(process.hProcess, lifetimeJob, out atomicMember)
                    && atomicMember, "supervisor_lifetime_atomic_membership");
                SupervisorProtocol.Close(ref stdinRead); SupervisorProtocol.Close(ref stdoutWrite); SupervisorProtocol.Close(ref stderrWrite);
                var ownedProcess = process; process.hProcess = IntPtr.Zero;
                // The incarnation now owns the original process HANDLE, including its
                // failed-admission termination path. Never close/reuse it through two owners.
                IntPtr ownedInput = stdinWrite; stdinWrite = IntPtr.Zero;
                var incarnation = new SupervisorIncarnation(history.Count, ownedProcess, ownedInput, stdoutRead, stderrRead, frames, ReserveOutput, self, node.Pin.Path, atomicMember);
                history.Add(incarnation); adopted = true; process.hProcess = IntPtr.Zero;
                stdinWrite = stdoutRead = stderrRead = IntPtr.Zero;
                GuardianWire.Require(Native.ResumeThread(process.hThread) == 1, "supervisor_daemon_resume");
                if (OwnsLifetime) frames.Send("daemon_started", new { generation = incarnation.Generation,
                    daemon = SupervisorProtocol.Identity(incarnation.Identity), launchIdentityDigest = LaunchIdentityDigest, atomicJobMember = incarnation.AtomicJobMember });
                else frames.Send("daemon_started", new { generation = incarnation.Generation, daemon = SupervisorProtocol.Identity(incarnation.Identity), launchIdentityDigest = LaunchIdentityDigest });
            } catch { startFailed = true; throw;
            } finally {
                if (created && !adopted && process.hProcess != IntPtr.Zero) {
                    Native.TerminateProcess(process.hProcess, 0xE0000003); Native.WaitForSingleObject(process.hProcess, 5000);
                }
                SupervisorProtocol.Close(ref process.hThread); SupervisorProtocol.Close(ref process.hProcess);
                SupervisorProtocol.Close(ref stdinRead); SupervisorProtocol.Close(ref stdinWrite); SupervisorProtocol.Close(ref stdoutRead);
                SupervisorProtocol.Close(ref stdoutWrite); SupervisorProtocol.Close(ref stderrRead); SupervisorProtocol.Close(ref stderrWrite);
                if (initialized) Native.DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs); if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            }
        }
    }
    internal bool ObserveExit() {
        lock (gate) {
            var current = history[^1];
            if (!current.ObserveExit()) return false;
            if (!current.ExitReported) frames.Send("daemon_exit", new { generation = current.Generation, daemon = SupervisorProtocol.Identity(current.Identity),
                rootWaitObserved = true, exitCode = current.ExitCode, exitTime = current.ExitTime!.Value.ToString(CultureInfo.InvariantCulture),
                stdoutEof = current.StdoutEof, stderrEof = current.StderrEof });
            current.ExitReported = true;
            return true;
        }
    }
    internal void Interrupt(int generation) { lock (gate) {
        GuardianWire.Require(!restartDisabled && history.Count > 0 && generation == Generation && !history[^1].ExitObserved, "supervisor_interrupt_generation"); history[^1].Terminate();
    } }
    internal void ArmGracefulStop(int generation) { lock (gate) {
        // This runs before command_ack. A daemon which has already died is never
        // replaced merely to make a pending graceful Stop appear successful.
        GuardianWire.Require(OwnsLifetime && !restartDisabled && history.Count > 0 && generation == Generation
            && !history[^1].ObserveExit(), "supervisor_graceful_stop_generation");
        restartDisabled = true; gracefulStopArmed = true;
    } }
    internal void GracefulStopExpired() { lock (gate) { gracefulStopTimedOut = true; } }
    internal void Input(int generation, string data) { lock (gate) {
        GuardianWire.Require(history.Count > 0 && generation == Generation && !history[^1].ObserveExit()
            && data.Length <= 87384, "supervisor_input_generation");
        byte[] bytes = Convert.FromBase64String(data); GuardianWire.Require(bytes.Length <= 65536 && Convert.ToBase64String(bytes) == data, "supervisor_input_bound");
        // Enqueue only: a dedicated writer retains the exact pipe HANDLE during I/O.
        // An unread stdin cannot block the supervisor's original process wait/restart.
        history[^1].Enqueue(bytes);
    } }
    // Called only under gate. Repeat all live lineage/original-HANDLE checks after
    // inspection; no cached qualification can authorize another incarnation.
    private SupervisorIncarnation QualifyCurrent(GuardianProcess peer, SupervisorQuery query, GuardianRequestBudget budget) {
        budget.AssertCurrent();
        GuardianWire.Require(!disposed && query.Version == 1 && query.Kind == "qualify" && GuardianWire.Uuid(query.Nonce)
            && history.Count > 0 && !self.Exited && !peer.Exited && peer.Sid == self.Sid
            && SupervisorProtocol.SameImage(peer.Image, self.Image), "supervisor_qualify_peer");
        bool qualifier = peer.HasNativeMode("--daemon-supervisor-qualify-v1"), guardian = peer.HasNativeMode("--guardian-v1");
        GuardianWire.Require((qualifier || guardian) && history.Any(incarnation => incarnation.ParentOf(peer)), "supervisor_original_child_peer");
        var current = history[^1];
        GuardianWire.Require(!current.ObserveExit() && current.Identity.Pid == query.DaemonPid
            && current.Identity.CreationTime.ToString(CultureInfo.InvariantCulture) == query.DaemonCreationTime
            && (!qualifier || current.ParentOf(peer)), "supervisor_original_current_daemon_handle");
        budget.AssertCurrent(); return current;
    }
    internal SupervisorQualification Qualify(GuardianProcess peer, SupervisorQuery query, GuardianRequestBudget budget) {
        // Expired queued calls leave without reading files. Start and Dispose use
        // the same ordering, keeping every original pinned stream alive here.
        using (budget.Enter(qualificationGate)) {
            SupervisorIncarnation original;
            using (budget.Enter(gate)) original = QualifyCurrent(peer, query, budget);
            node.AssertCurrent(budget); entry.AssertCurrent(budget); configuration.AssertCurrent(budget); AssertRuntimeManifest(budget);
            using (budget.Enter(gate)) {
                var current = QualifyCurrent(peer, query, budget);
                GuardianWire.Require(ReferenceEquals(current, original), "supervisor_original_current_daemon_handle");
                SupervisorLifetimeQualification? lifetime = null;
                if (OwnsLifetime) {
                    GuardianWire.Require(lifetimeJob != IntPtr.Zero && current.AtomicJobMember
                        && Native.IsProcessInJob(current.OriginalHandle.DangerousGetHandle(), lifetimeJob, out bool member) && member,
                        "supervisor_lifetime_current_membership");
                    lifetime = new(1, SupervisorProtocol.LifetimeCapability, launch.LifetimeOwnership!.CleanupTimeoutMs,
                        launch.LifetimeOwnership.GracefulStopMs, true, true, launch.RuntimeManifest);
                }
                budget.AssertCurrent();
                return new SupervisorQualification(1, SupervisorProtocol.Capability, SupervisorProtocol.Identity(current.Identity),
                    SupervisorProtocol.Identity(self), LaunchIdentityDigest, lifetime);
            }
        }
    }
    internal void Stop() { lock (gate) { if (history.Count > 0) history[^1].Terminate(); } }
    /** Only final Supervisor shutdown closes the shared tree. The same original Job
     * HANDLE is queried until zero; closing it is a fallback, never closure evidence. */
    internal bool CleanupLifetime() {
        lock (gate) {
            GuardianWire.Require(OwnsLifetime, "supervisor_lifetime_required");
            restartDisabled = true; cleanupClock ??= Stopwatch.StartNew();
            if (cleanupConfirmed) return true;
        }
        bool terminationAttempted = false;
        do {
            lock (gate) {
                try {
                    // Terminate before observations so a blocked reader or invalid
                    // root cannot prevent containment of the remaining descendants.
                    if (!terminationAttempted && lifetimeJob != IntPtr.Zero) {
                        terminationAttempted = true;
                        GuardianWire.Require(Native.QueryInformationJobObject(lifetimeJob, 1, out Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION before,
                            (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero), "supervisor_lifetime_job_query");
                        if (before.ActiveProcesses > 0) {
                            forcedJobTermination = true;
                            GuardianWire.Require(Native.TerminateJobObject(lifetimeJob, 0xE0000004), "supervisor_lifetime_job_terminate");
                        }
                    }
                    foreach (var item in history) {
                        if (!item.ObserveExit()) continue;
                        if (!item.ExitReported) frames.Send("daemon_exit", new { generation = item.Generation,
                            daemon = SupervisorProtocol.Identity(item.Identity), rootWaitObserved = true, exitCode = item.ExitCode,
                            exitTime = item.ExitTime!.Value.ToString(CultureInfo.InvariantCulture), stdoutEof = item.StdoutEof, stderrEof = item.StderrEof });
                        item.ExitReported = true;
                    }
                    Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = default;
                    GuardianWire.Require(lifetimeJob != IntPtr.Zero && Native.QueryInformationJobObject(lifetimeJob, 1,
                        out accounting,
                        (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero), "supervisor_lifetime_job_query");
                    jobEmptyObserved = accounting.ActiveProcesses == 0;
                    cleanupConfirmed = !cleanupFault && !startFailed && lifetimeJobCreated && jobEmptyObserved
                        && history.All(item => item.ExitObserved && item.StdoutEof && item.StderrEof && item.InputSettled && item.AtomicJobMember);
                    if (cleanupConfirmed) return true;
                } catch (Exception error) {
                    cleanupFault = true; ReportDiagnostic("supervisor_run", error);
                    // A failed query must not bypass termination. Retain the failure
                    // even if this fallback later makes the Job empty.
                    if (lifetimeJob != IntPtr.Zero) {
                        forcedJobTermination = true;
                        if (!Native.TerminateJobObject(lifetimeJob, 0xE0000004))
                            ReportDiagnostic("supervisor_run", new IOException("supervisor_lifetime_job_terminate"));
                    }
                }
            }
            if (cleanupClock!.ElapsedMilliseconds >= launch.LifetimeOwnership!.CleanupTimeoutMs) break;
            Thread.Sleep(10);
        } while (true);
        return false;
    }
    private readonly Dictionary<string, int> diagnosticCounts = new(StringComparer.Ordinal);
    internal void ReportDiagnostic(string phase, Exception error) { lock (gate) {
        var diagnostic = NativeFailureDiagnostic.Capture(phase, error);
        int count = diagnosticCounts.GetValueOrDefault(diagnostic.Phase);
        if (count >= 4) return;
        diagnosticCounts[diagnostic.Phase] = count + 1;
        frames.Diagnostic(diagnostic);
    } }
    internal object Summary {
        get { lock (gate) {
            if (!OwnsLifetime) return new { launchIdentityDigest = LaunchIdentityDigest, incarnations = history.Select(item => new {
                generation = item.Generation, daemon = SupervisorProtocol.Identity(item.Identity), rootWaitObserved = item.ExitObserved,
                exitCode = item.ExitCode, stdoutEof = item.StdoutEof, stderrEof = item.StderrEof }).ToArray() };
            return new { launchIdentityDigest = LaunchIdentityDigest, incarnations = history.Select(item => new {
                generation = item.Generation, daemon = SupervisorProtocol.Identity(item.Identity), rootWaitObserved = item.ExitObserved,
                exitCode = item.ExitCode, stdoutEof = item.StdoutEof, stderrEof = item.StderrEof, atomicJobMember = item.AtomicJobMember }).ToArray(),
                lifetimeClosure = new { version = 1, capability = SupervisorProtocol.LifetimeCapability, jobCreated = lifetimeJobCreated,
                    allRootsWaitObserved = !startFailed && history.All(item => item.ExitObserved), jobEmptyObserved,
                    allStdoutEof = !startFailed && history.All(item => item.StdoutEof), allStderrEof = !startFailed && history.All(item => item.StderrEof),
                    cleanupConfirmed, gracefulStopArmed, gracefulStopTimedOut, forcedJobTermination } };
        } }
    }
    public void Dispose() { lock (qualificationGate) lock (gate) {
        // Run cancels the service before disposal. Keep original file owners until
        // any synchronous inspection has actually returned; cancellation is not closure.
        if (disposed) return; disposed = true;
        // Failure may leave closure unknown. KILL_ON_JOB_CLOSE still contains the
        // tree, but no fact is upgraded after the authoritative summary was sent.
        SupervisorProtocol.Close(ref lifetimeJob);
        foreach (var item in history) item.Dispose(); node?.Dispose(); entry?.Dispose(); configuration?.Dispose();
        runtimeManifest?.Dispose(); foreach (var file in runtimeFiles) file.Dispose();
        foreach (var directory in directories) directory.Dispose(); self.Dispose();
    } }
}

internal static class DaemonSupervisorProgram
{
    internal static int Qualify() {
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false, true);
            var input = GuardianWire.Decode<SupervisorQualifyInput>(GuardianWire.Input());
            GuardianWire.Require(input.Version == 1 && input.Kind == "qualify", "supervisor_qualify_input");
            using var self = new GuardianProcess((uint)Environment.ProcessId);
            GuardianWire.Require(self.HasNativeMode("--daemon-supervisor-qualify-v1"), "supervisor_qualifier_mode");
            using var daemon = new GuardianProcess(self.ParentPid);
            GuardianWire.Require(!daemon.Exited && daemon.CreationTime < self.CreationTime && daemon.Sid == self.Sid, "supervisor_qualifier_parent");
            var result = DaemonSupervisorAuthority.Require(daemon);
            Console.WriteLine(GuardianWire.Encode(new { version = 1, kind = "supervisor_qualified", payload = result })); return 0;
        } catch (Exception error) { NativeFailureDiagnostic.Emit("supervisor_qualify", error); return 2; }
    }
    internal static int Run() {
        var frames = new SupervisorFrames(); DaemonSupervisorState? state = null; string reason = "stopped";
        using var cancellation = new CancellationTokenSource();
        var controls = new BlockingCollection<SupervisorControl>(16);
        bool controlLost = false, stop = false, failed = false; var elapsed = Stopwatch.StartNew();
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            var launch = GuardianWire.Decode<SupervisorLaunch>(GuardianWire.Input());
            state = new DaemonSupervisorState(launch, frames);
            var first = SupervisorProtocol.CreatePipe(state.PipeName, state.Sid, true);
            _ = Serve(state, first, cancellation.Token);
            state.Ready(); state.Start();
            _ = Task.Run(async () => {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                try { for (;;) {
                    var command = GuardianWire.Decode<SupervisorControl>(await GuardianWire.ReadLine(Console.In, cancellation.Token));
                    GuardianWire.Require(command.Version == 1 && GuardianWire.Uuid(command.Nonce) && seen.Count < 4096 && seen.Add(command.Nonce)
                        && command.Kind is "stop" or "interrupt-current" or "daemon-input" or "arm-graceful-stop"
                        && (command.Kind != "arm-graceful-stop" || state.OwnsLifetime)
                        && (command.Kind == "stop" ? command.Generation is null && command.Data is null : command.Generation is >= 0 and <= 8)
                        && (command.Kind == "daemon-input" ? command.Data is not null : command.Data is null)
                        && controls.TryAdd(command), "supervisor_control");
                } } catch { controlLost = true; }
            });
            double? restartAt = null, gracefulStopAt = null;
            for (;;) {
                if (controls.TryTake(out var control)) {
                    if (control.Kind == "stop") stop = true;
                    else if (control.Kind == "interrupt-current") state.Interrupt(control.Generation!.Value);
                    else if (control.Kind == "arm-graceful-stop") {
                        state.ArmGracefulStop(control.Generation!.Value);
                        restartAt = null; gracefulStopAt = elapsed.Elapsed.TotalMilliseconds;
                    }
                    else state.Input(control.Generation!.Value, control.Data!);
                    frames.Send("command_ack", new { control.Nonce, control.Kind, generation = state.Generation });
                }
                bool inputFailed = state.OwnsLifetime && state.InputFailed;
                if (Volatile.Read(ref controlLost) || frames.Failed || state.OutputExceeded || inputFailed || elapsed.ElapsedMilliseconds >= launch.LifetimeMs) {
                    stop = true; reason = frames.Failed ? "output_failed" : state.OutputExceeded ? "output_limit" : inputFailed ? "daemon_input_failed" : controlLost ? "control_eof_or_invalid" : "lifetime_expired";
                    failed = state.OwnsLifetime;
                }
                if (stop) {
                    if (state.OwnsLifetime) break;
                    state.Stop(); var close = Stopwatch.StartNew();
                    while (!state.ObserveExit() && close.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                    GuardianWire.Require(state.ObserveExit(), "supervisor_stop_wait_unconfirmed"); break;
                }
                if (gracefulStopAt is not null && elapsed.Elapsed.TotalMilliseconds - gracefulStopAt.Value >= launch.LifetimeOwnership!.GracefulStopMs) {
                    state.GracefulStopExpired(); reason = "graceful_stop_timeout"; failed = true; break;
                }
                if (state.ObserveExit()) {
                    if (state.GracefulStopArmed) {
                        if (state.CurrentExitCode != 0) { failed = true; reason = "daemon_failed_during_stop"; }
                        break;
                    }
                    if (state.Generation >= launch.MaxRestarts) { reason = "restart_budget_exhausted"; failed = state.OwnsLifetime; break; }
                    restartAt ??= elapsed.Elapsed.TotalMilliseconds + launch.RestartBackoffMs;
                    if (elapsed.Elapsed.TotalMilliseconds >= restartAt) { state.Start(); restartAt = null; }
                }
                Thread.Sleep(10);
            }
            if (state.OwnsLifetime && !state.CleanupLifetime()) {
                if (!failed) reason = "lifetime_cleanup_unconfirmed";
                failed = true;
            }
            if (state.OwnsLifetime && !failed && (Volatile.Read(ref controlLost) || frames.Failed || state.OutputExceeded || state.InputFailed)) {
                failed = true; reason = frames.Failed ? "output_failed" : state.OutputExceeded ? "output_limit" : state.InputFailed ? "daemon_input_failed" : "control_eof_or_invalid";
            }
            frames.Terminal(failed ? "supervisor_failed" : "supervisor_stopped", new { reason, facts = state.Summary });
            return frames.Finish() && !failed ? 0 : 2;
        } catch (Exception error) {
            frames.Diagnostic(NativeFailureDiagnostic.Capture("supervisor_run", error));
            try {
                if (state?.OwnsLifetime == true) state.CleanupLifetime();
                else {
                    state?.Stop(); var close = Stopwatch.StartNew();
                    while (state?.HasDaemon == true && !state.ObserveExit() && close.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                }
            } catch (Exception cleanup) { frames.Diagnostic(NativeFailureDiagnostic.Capture("supervisor_run", cleanup)); }
            frames.Terminal("supervisor_failed", new { reason = "supervisor_admission_or_lifecycle_failed", facts = state?.Summary }); frames.Finish(); return 2;
        } finally { cancellation.Cancel(); state?.Dispose(); }
    }
    private static async Task Serve(DaemonSupervisorState state, NamedPipeServerStream first, CancellationToken cancellation) {
        var capacity = new SemaphoreSlim(15); var pending = first;
        try { for (;;) {
            await pending.WaitForConnectionAsync(cancellation); var connected = pending;
            await capacity.WaitAsync(cancellation); pending = SupervisorProtocol.CreatePipe(state.PipeName, state.Sid, false);
            _ = Task.Run(async () => { string phase = "supervisor_peer_open"; try {
                using (connected) {
                    GuardianWire.Require(GuardianNative.GetNamedPipeClientProcessId(connected.SafePipeHandle, out uint pid), "supervisor_client_pid");
                    using var peer = new GuardianProcess(pid); using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(5000);
                    using var reader = new StreamReader(connected, new UTF8Encoding(false, true), false, 4096, true);
                    using var writer = new StreamWriter(connected, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
                    phase = "supervisor_query_read";
                    var query = GuardianWire.Decode<SupervisorQuery>(await GuardianWire.ReadLine(reader, timeout.Token));
                    using var budget = new GuardianRequestBudget(5000, timeout.Token, query.Deadline);
                    phase = "supervisor_query_qualify";
                    var result = state.Qualify(peer, query, budget);
                    phase = "supervisor_query_reply"; budget.AssertCurrent();
                    await writer.WriteLineAsync(GuardianWire.Encode(new SupervisorQueryResult(1, "qualified", query.Nonce, result)).AsMemory(), budget.Token);
                }
            } catch (Exception error) { state.ReportDiagnostic(phase, error); /* Rejected peers receive no qualification. */ } finally { capacity.Release(); } });
        } } catch { pending.Dispose(); }
    }
}

internal static class SupervisorNative
{
    internal static void AssertProtectedFile(SafeFileHandle handle, string currentSid) {
        GuardianWire.Require(GetSecurityInfo(handle, 1, 1 | 4, out _, out _, out _, out _, out IntPtr descriptor) == 0, "supervisor_file_acl");
        try {
            uint length = GetSecurityDescriptorLength(descriptor); GuardianWire.Require(length is > 0 and <= 65536, "supervisor_file_acl_bound");
            byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            var security = new RawSecurityDescriptor(bytes, 0); var allowed = new HashSet<string>(StringComparer.Ordinal) { currentSid, "S-1-5-18", "S-1-5-32-544" };
            GuardianWire.Require(security.Owner is not null && allowed.Contains(security.Owner.Value) && security.DiscretionaryAcl is not null, "supervisor_file_owner");
            foreach (GenericAce ace in security.DiscretionaryAcl) {
                GuardianWire.Require(ace is CommonAce, "supervisor_file_acl_type"); var common = (CommonAce)ace;
                if ((common.AceFlags & AceFlags.InheritOnly) != 0) continue;
                if (common.AceQualifier == AceQualifier.AccessAllowed && (common.AccessMask & 0x500D0156) != 0)
                    GuardianWire.Require(allowed.Contains(common.SecurityIdentifier.Value), "supervisor_file_external_writer");
            }
        } finally { GuardianNative.LocalFree(descriptor); }
    }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
}
