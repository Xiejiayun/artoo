// H9 candidate. A surviving guardian is live authority; its files are audit/discovery only.
// No Job HANDLE is duplicated here: KILL_ON_JOB_CLOSE keeps its existing meaning.
using Microsoft.Win32.SafeHandles;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class GuardianWire
{
    internal const string Capability = "artoo.windows-runtime-guardian.v1";
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    internal static string Encode(object value) => JsonSerializer.Serialize(value, Json);
    internal static string Digest(object value) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Encode(value))));
    internal static T Decode<T>(string text) => JsonSerializer.Deserialize<T>(text, Json) ?? throw new IOException("empty_guardian_frame");
    internal static void Require(bool value, string reason) { if (!value) throw new IOException(reason); }
    internal static bool Id(string? value) => value is { Length: > 0 and <= 128 } && !value.Contains('\0');
    internal static bool Uuid(string? value) => Guid.TryParseExact(value, "D", out _);
    internal static bool Hash(string? value) => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.AsSpan(7).ToArray().All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    internal static async Task<string> ReadLine(TextReader reader, CancellationToken cancellation)
    {
        var output = new StringBuilder(); var one = new char[1];
        for (;;) {
            int count = await reader.ReadAsync(one.AsMemory(), cancellation);
            if (count == 0) throw new IOException("guardian_peer_eof");
            if (one[0] == '\n') return output.ToString();
            Require(one[0] != '\0' && output.Length < 65536, "guardian_frame_limit"); output.Append(one[0]);
        }
    }
    internal static string Input() { using var timeout = new CancellationTokenSource(5000); return ReadLine(Console.In, timeout.Token).GetAwaiter().GetResult(); }
}

internal sealed record GuardianEndpoint(int Version, string Capability, string PipeName, string GuardianInstanceId,
    uint GuardianPid, string GuardianCreationTime, string ExecutableDigest);
internal sealed record GuardianBootstrap(int Version, string Kind, string NodeId, string DeviceId, string SessionId,
    string ConfigurationDigest, string StoreDirectory, string WorkspaceRoot, string Topology, string ControlDirectory, string SupervisorLaunchIdentityDigest);
internal sealed record GuardianEnrollment(int Version, GuardianEndpoint Endpoint, string EpochId, string SlotId, string Ticket);
internal sealed record GuardianRelay(int Version, GuardianEndpoint Endpoint, JsonElement Request);
internal sealed record GuardianRequestDeadline(int Version, long TickCount64);

internal sealed class GuardianRequest
{
    public int Version { get; init; }
    public string Kind { get; init; } = "";
    public string Nonce { get; init; } = "";
    // Same-machine monotonic budget only. This optional extension never grants
    // authority; old senders receive the server's own bounded processing budget.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public GuardianRequestDeadline? Deadline { get; set; }
    public string? EpochId { get; init; }
    public string? SessionId { get; init; }
    public string? RegistrationId { get; init; }
    public string? RegistrationDigest { get; init; }
    public string? SlotId { get; init; }
    public string? Ticket { get; init; }
    public string? OperationKind { get; init; }
    public string? OperationId { get; init; }
    public string? BindingDigest { get; init; }
    public uint? RootPid { get; init; }
    public string? RootCreationTime { get; init; }
    public GuardianTerminal? Terminal { get; init; }
    public string? TerminalAck { get; init; }
    public string? ChallengeId { get; init; }
    public string? RequestDigest { get; init; }
    public string? ExpectedRosterDigest { get; init; }
    public int? ExpectedRosterRevision { get; init; }
    public string? ExpectedNewDaemonIdentityDigest { get; init; }
    public GuardianServerOperation? ServerOperation { get; init; }
}
internal sealed record GuardianServerOperation(string Kind, string OperationId, string RequestDigest, string? RunId);
internal sealed record GuardianTerminal(bool RootCreated, bool RootStarted, uint? RootPid, string? RootCreationTime,
    bool AtomicJobMember, bool RootWaitObserved, uint? RootExitCode, bool JobCreated, bool JobEmptyObserved,
    bool StdoutCreated, bool StderrCreated, bool StdoutEof, bool StderrEof, bool NoTargetCreated, bool CleanupConfirmed);

/** A request cannot renew its budget while waiting for either control gate or
 * supervisor qualification. TickCount64 is shared by local peers on this boot. */
internal sealed class GuardianRequestBudget : IDisposable
{
    private readonly CancellationTokenSource cancellation;
    internal readonly long DeadlineTickCount64;
    internal CancellationToken Token => cancellation.Token;
    internal GuardianRequestBudget(int maximumMs, CancellationToken outer = default, GuardianRequestDeadline? requestedDeadline = null) {
        long now = Environment.TickCount64;
        GuardianWire.Require(maximumMs is > 0 and <= 5000 && (requestedDeadline is null || requestedDeadline.Version == 1 && requestedDeadline.TickCount64 >= 0), "guardian_request");
        DeadlineTickCount64 = Math.Min(checked(now + maximumMs), requestedDeadline?.TickCount64 ?? long.MaxValue);
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(outer);
        cancellation.CancelAfter((int)Math.Clamp(DeadlineTickCount64 - now, 0, maximumMs));
    }
    internal void AssertCurrent() {
        Token.ThrowIfCancellationRequested();
        if (Environment.TickCount64 >= DeadlineTickCount64) throw new TimeoutException("Guardian request deadline expired");
    }
    internal IDisposable Enter(object gate) {
        for (;;) {
            AssertCurrent();
            if (Monitor.TryEnter(gate)) {
                try { AssertCurrent(); return new HeldGate(gate); }
                catch { Monitor.Exit(gate); throw; }
            }
            // Monitor's blocking overload cannot observe an earlier outer
            // cancellation. Wait outside the gate on the cancellation handle;
            // a free gate is retried at most 20 ms later without renewing time.
            int remaining = (int)Math.Clamp(DeadlineTickCount64 - Environment.TickCount64, 0, 5000);
            if (remaining == 0) throw new TimeoutException("Guardian control gate deadline expired");
            if (Token.WaitHandle.WaitOne(Math.Min(remaining, 20))) Token.ThrowIfCancellationRequested();
        }
    }
    private sealed class HeldGate(object gate) : IDisposable {
        public void Dispose() => Monitor.Exit(gate);
    }
    public void Dispose() => cancellation.Dispose();
}

/** Safe correlation only: no tickets, process paths, argv, request body or output. */
internal sealed class GuardianRequestTrace(GuardianRequest request)
{
    private readonly long begun = Environment.TickCount64;
    internal readonly string Kind = request.Kind is "attach" or "root" or "pulse" or "terminal" or "terminal_ack_received"
        or "status" or "activate" or "reserve" or "transfer" ? request.Kind : "unknown";
    private readonly string? nonceDigest = GuardianWire.Uuid(request.Nonce) ? GuardianWire.Digest(request.Nonce) : null;
    internal string Stage = "dispatch";
    internal bool MutationStarted, MutationRecorded;
    internal object Snapshot() => new { version = 1, kind = Kind, nonceDigest, stage = Stage,
        elapsedMs = Math.Clamp(Environment.TickCount64 - begun, 0, 60000), MutationStarted, MutationRecorded };
}

internal sealed class GuardianProcess : IDisposable
{
    internal readonly SafeProcessHandle Handle;
    internal readonly uint Pid;
    internal readonly long CreationTime;
    internal readonly uint ParentPid;
    internal readonly string Image;
    internal readonly string Sid;
    internal GuardianProcess(uint pid) {
        Handle = GuardianNative.OpenProcess(0x00100000 | 0x1000 | 0x0400, false, pid);
        try {
            GuardianWire.Require(!Handle.IsInvalid, "guardian_process_open"); Pid = pid;
            GuardianWire.Require(Native.GetProcessTimes(Handle.DangerousGetHandle(), out CreationTime, out _, out _, out _), "guardian_process_times");
            GuardianWire.Require(GuardianNative.NtQueryInformationProcess(Handle, 0, out var basic,
                (uint)Marshal.SizeOf<GuardianNative.PROCESS_BASIC_INFORMATION>(), out _) == 0, "guardian_parent_query");
            ParentPid = checked((uint)basic.InheritedFromUniqueProcessId.ToInt64());
            var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
            GuardianWire.Require(GuardianNative.QueryFullProcessImageNameW(Handle, 0, image, ref size), "guardian_image_query"); Image = image.ToString();
            GuardianWire.Require(GuardianNative.OpenProcessToken(Handle, 8, out IntPtr token), "guardian_process_token");
            try { using var identity = new WindowsIdentity(token); Sid = identity.User?.Value ?? throw new IOException("guardian_process_sid"); }
            finally { Native.CloseHandle(token); }
        } catch { Handle.Dispose(); throw; }
    }
    internal bool Exited => Native.WaitForSingleObject(Handle.DangerousGetHandle(), 0) switch {
        0 => true, 258 => false, _ => throw new IOException("guardian_exact_process_wait") };
    internal bool Same(GuardianProcess other) => Pid == other.Pid && CreationTime == other.CreationTime;
    internal bool HasNativeMode(string mode) {
        // All modes share one signed/hashed bundle. Pin the actual kernel-reported argv
        // too, so a general guardian relay cannot submit host-owned terminal facts.
        GuardianNative.NtQueryInformationProcessBuffer(Handle, 60, IntPtr.Zero, 0, out uint needed);
        GuardianWire.Require(needed is > 0 and <= 65536, "guardian_command_line_bound");
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
        try {
            GuardianWire.Require(GuardianNative.NtQueryInformationProcessBuffer(Handle, 60, buffer, needed, out _) == 0, "guardian_command_line_query");
            var text = Marshal.PtrToStructure<GuardianNative.UNICODE_STRING>(buffer);
            long offset = text.Buffer.ToInt64() - buffer.ToInt64();
            GuardianWire.Require(text.Length % 2 == 0 && offset >= 0 && offset + text.Length <= needed, "guardian_command_line_buffer");
            string commandLine = Marshal.PtrToStringUni(text.Buffer, text.Length / 2) ?? throw new IOException("guardian_command_line_missing");
            IntPtr argv = GuardianNative.CommandLineToArgvW(commandLine, out int argc);
            GuardianWire.Require(argv != IntPtr.Zero, "guardian_command_line_parse");
            try { return argc == 2 && string.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv)), Image, StringComparison.OrdinalIgnoreCase)
                && Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, IntPtr.Size)) == mode; }
            finally { GuardianNative.LocalFree(argv); }
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal object Identity => new { pid = Pid, creationTime = CreationTime.ToString(CultureInfo.InvariantCulture), image = Image, sid = Sid };
    public void Dispose() => Handle.Dispose();
}

internal sealed class GuardianDirectory : IDisposable
{
    internal readonly SafeFileHandle Handle;
    internal readonly string Path;
    internal readonly string IdentityDigest;
    internal GuardianDirectory(string path) {
        GuardianWire.Require(System.IO.Path.IsPathFullyQualified(path) && !path.StartsWith("\\\\", StringComparison.Ordinal), "guardian_local_directory_required");
        // No share-delete: the same physical root is retained throughout the transfer.
        var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>() };
        Handle = new SafeFileHandle(Native.CreateFileW(path, 0x80, 3, ref security, 3, 0x02000000 | 0x00200000, IntPtr.Zero), true);
        try {
            GuardianWire.Require(!Handle.IsInvalid, "guardian_directory_handle");
            GuardianWire.Require(GuardianNative.GetFileInformationByHandle(Handle, out var facts), "guardian_directory_handle");
            GuardianWire.Require((facts.FileAttributes & 0x10) != 0 && (facts.FileAttributes & 0x400) == 0, "guardian_directory_reparse");
            var final = new StringBuilder(32768);
            uint length = GuardianNative.GetFinalPathNameByHandleW(Handle, final, (uint)final.Capacity, 0);
            GuardianWire.Require(length > 0 && length < final.Capacity, "guardian_directory_final_path");
            Path = final.ToString();
            GuardianWire.Require(Path.StartsWith("\\\\?\\", StringComparison.Ordinal)
                && string.Equals(Path[4..].TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase), "guardian_directory_alias");
            IdentityDigest = GuardianWire.Digest(new { path = Path.ToUpperInvariant(), volume = facts.VolumeSerialNumber,
                indexHigh = facts.FileIndexHigh, indexLow = facts.FileIndexLow });
        } catch { Handle.Dispose(); throw; }
    }
    public void Dispose() => Handle.Dispose();
}

internal sealed class GuardianConnection : IDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly StreamReader reader;
    private readonly StreamWriter writer;
    private readonly GuardianProcess? guardian;
    private readonly object gate = new();
    private bool disposed;
    internal GuardianConnection(GuardianEndpoint endpoint) {
        GuardianWire.Require(endpoint.Version == 1 && endpoint.Capability == GuardianWire.Capability && GuardianWire.Uuid(endpoint.GuardianInstanceId)
            && endpoint.PipeName == "artoo-guardian-" + endpoint.GuardianInstanceId && GuardianWire.Hash(endpoint.ExecutableDigest), "guardian_endpoint");
        pipe = new NamedPipeClientStream(".", endpoint.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        string phase = "guardian_connect";
        try {
            pipe.Connect(3000);
            phase = "guardian_server_identity";
            GuardianWire.Require(GuardianNative.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint pid), "guardian_server_pid");
            guardian = new GuardianProcess(pid);
            GuardianWire.Require(!guardian.Exited && guardian.Pid == endpoint.GuardianPid
                && guardian.CreationTime.ToString(CultureInfo.InvariantCulture) == endpoint.GuardianCreationTime
                && string.Equals(guardian.Image, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase)
                && guardian.HasNativeMode("--guardian-v1")
                && "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(guardian.Image))) == endpoint.ExecutableDigest,
                "guardian_exact_server_identity");
            reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
            // Record ownership before AutoFlush can touch the connected pipe.
            writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
            writer.AutoFlush = true;
        } catch (Exception error) {
            Exception? cleanupFailure = null;
            try { Dispose(); } catch (Exception cleanup) { cleanupFailure = cleanup; }
            NativeFailureDiagnostic.Emit(phase, error);
            if (cleanupFailure is not null) NativeFailureDiagnostic.Emit("guardian_lifetime", cleanupFailure);
            throw; // Retain the constructor failure after every owned resource was attempted.
        }
    }
    internal JsonElement Send(object request) {
        using var budget = new GuardianRequestBudget(3000);
        string phase = "guardian_request_write";
        try { using (budget.Enter(gate)) {
            GuardianWire.Require(!disposed && guardian is not null && !guardian.Exited, "guardian_lost");
            string original = GuardianWire.Encode(request); GuardianWire.Require(original.Length < 65536, "guardian_frame_limit");
            var sent = GuardianWire.Decode<GuardianRequest>(original);
            // A relay cannot replace this sender's budget with a remote field.
            GuardianWire.Require(sent.Deadline is null || sent.Deadline.Version == 1 && sent.Deadline.TickCount64 >= 0, "guardian_request");
            sent.Deadline = new(1, Math.Min(sent.Deadline?.TickCount64 ?? budget.DeadlineTickCount64, budget.DeadlineTickCount64));
            string encoded = GuardianWire.Encode(sent); GuardianWire.Require(encoded.Length < 65536, "guardian_frame_limit");
            budget.AssertCurrent();
            writer.WriteLineAsync(encoded.AsMemory(), budget.Token).GetAwaiter().GetResult();
            phase = "guardian_response_read";
            var result = GuardianWire.Decode<JsonElement>(GuardianWire.ReadLine(reader, budget.Token).GetAwaiter().GetResult());
            phase = "guardian_response_binding";
            budget.AssertCurrent();
            GuardianWire.Require(result.GetProperty("version").GetInt32() == 1 && result.GetProperty("nonce").GetString() == sent.Nonce
                && result.GetProperty("kind").GetString() == "ok", "guardian_request_rejected");
            return result.GetProperty("payload").Clone();
        } } catch (Exception error) { NativeFailureDiagnostic.Emit(phase, error); throw; }
    }
    public void Dispose() { lock (gate) {
        if (disposed) return; disposed = true;
        ExceptionDispatchInfo? first = null;
        void Release(IDisposable? resource) {
            try { resource?.Dispose(); }
            catch (Exception error) {
                first ??= ExceptionDispatchInfo.Capture(error);
            }
        }
        // Reader/writer leave the original pipe open. A failed flush must not
        // skip its close or the original Guardian HANDLE; partial construction
        // may leave either managed stream unassigned. Keep diagnostic I/O out
        // of this sequence; the first failure reaches the owning caller.
        Release(reader); Release(writer); Release(pipe); Release(guardian);
        first?.Throw();
    } }
}

internal sealed class GuardianHost : IDisposable
{
    private readonly GuardianEnrollment enrollment;
    private readonly GuardianConnection connection;
    private volatile bool finished;
    internal GuardianHost(GuardianEnrollment input, Action<string> stop) {
        GuardianWire.Require(input.Version == 1 && GuardianWire.Uuid(input.EpochId) && GuardianWire.Uuid(input.SlotId)
            && GuardianWire.Uuid(input.Ticket), "guardian_enrollment");
        enrollment = input; connection = new GuardianConnection(input.Endpoint);
        try {
        Send("attach");
        new Thread(() => {
            while (!finished) {
                try { bool shouldStop = Send("pulse").GetProperty("stop").GetBoolean(); if (!finished && shouldStop) stop("guardian_epoch_frozen"); }
                catch { if (!finished) stop("guardian_lost"); return; }
                Thread.Sleep(100);
            }
        }) { IsBackground = true, Name = "artoo-guardian-watch" }.Start();
        } catch {
            // Ownership is not handed to the caller until construction returns,
            // including successful startup of the existing watch thread.
            finished = true;
            try { connection.Dispose(); } catch (Exception cleanup) { NativeFailureDiagnostic.Emit("guardian_lifetime", cleanup); }
            throw;
        }
    }
    private JsonElement Send(string kind, uint? pid = null, string? creation = null, GuardianTerminal? terminal = null, string? ack = null) => connection.Send(new GuardianRequest {
        Version = 1, Kind = kind, Nonce = Guid.NewGuid().ToString("D"), EpochId = enrollment.EpochId,
        SlotId = enrollment.SlotId, Ticket = enrollment.Ticket, RootPid = pid, RootCreationTime = creation, Terminal = terminal, TerminalAck = ack });
    internal void EnrollRoot(uint pid, long creation) => Send("root", pid, creation.ToString(CultureInfo.InvariantCulture));
    internal bool Terminal(GuardianTerminal facts) {
        // Closure is already observed. A pulse queued behind this final exchange must not
        // turn a successful operation into cancellation after its ACK was accepted.
        finished = true;
        try {
            var response = Send("terminal", terminal: facts);
            string ack = response.GetProperty("terminalAck").GetString() ?? throw new IOException("guardian_terminal_ack");
            GuardianWire.Require(GuardianWire.Uuid(ack), "guardian_terminal_ack");
            // This round trip establishes that the host actually received the terminal ACK.
            Send("terminal_ack_received", ack: ack); finished = true; return true;
        } catch { finished = true; return false; }
    }
    public void Dispose() { finished = true; connection.Dispose(); }
}

internal sealed class GuardianState : IDisposable
{
    private sealed class RelaySnapshot : IDisposable {
        internal readonly GuardianProcess Daemon, Supervisor;
        internal readonly string EpochId, SessionId;
        internal readonly string? RegistrationId, RegistrationDigest;
        internal readonly int Generation;
        private bool daemonHeld, supervisorHeld;
        internal RelaySnapshot(GuardianState state) {
            Daemon = state.daemon; Supervisor = state.supervisor; EpochId = state.epochId; SessionId = state.sessionId;
            RegistrationId = state.registrationId; RegistrationDigest = state.registrationDigest; Generation = state.generation;
            try {
                // Retain these original kernel HANDLEs while the state gate is released.
                // A concurrent epoch transfer may dispose its old managed owner.
                Daemon.Handle.DangerousAddRef(ref daemonHeld); Supervisor.Handle.DangerousAddRef(ref supervisorHeld);
            } catch { Dispose(); throw; }
        }
        public void Dispose() {
            if (supervisorHeld) { supervisorHeld = false; Supervisor.Handle.DangerousRelease(); }
            if (daemonHeld) { daemonHeld = false; Daemon.Handle.DangerousRelease(); }
        }
    }
    private sealed record DiagnosticStamp(string EpochId, int Generation, int Revision);
    private sealed class Slot(string id, string ticket, string kind, string operation, string binding, GuardianServerOperation? serverOperation) {
        internal readonly string Id = id, Ticket = ticket, Kind = kind, Operation = operation, Binding = binding;
        internal readonly GuardianServerOperation? ServerOperation = serverOperation;
        internal GuardianProcess? Host, Root;
        internal GuardianTerminal? Terminal;
        internal string? TerminalDigest, Ack;
        internal bool AckReceived;
        internal object Head => new { slotId = Id, operationKind = Kind, operationId = Operation, bindingDigest = Binding, serverOperation = ServerOperation };
    }
    private readonly object gate = new();
    private GuardianProcess daemon;
    private readonly GuardianProcess supervisor;
    private readonly GuardianDirectory store, workspace, controlDirectory;
    private readonly FileStream owner, sourceOwner, audit;
    private readonly GuardianDirectory sourceOperations;
    private readonly GuardianBootstrap configuration;
    private readonly Dictionary<string, Slot> slots = new(StringComparer.Ordinal);
    private readonly HashSet<string> challenges = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Binding, string EpochId, object Result)> transfers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> diagnosticCounts = new(StringComparer.Ordinal);
    private readonly object diagnosticGate = new();
    private readonly BlockingCollection<string> diagnostics = new(32);
    private DiagnosticStamp diagnosticStamp = new("", 0, 0);
    private volatile bool diagnosticUnavailable;
    private long diagnosticDropped;
    private bool frozen, poisoned, activated;
    private int revision, generation;
    private string epochId = Guid.NewGuid().ToString("D"), sessionId;
    private string? registrationId, registrationDigest;
    internal readonly GuardianEndpoint Endpoint;
    internal GuardianState(GuardianBootstrap input) {
        GuardianWire.Require(input.Version == 1 && input.Kind == "bootstrap" && GuardianWire.Id(input.NodeId) && GuardianWire.Id(input.DeviceId)
            && GuardianWire.Id(input.SessionId) && GuardianWire.Hash(input.ConfigurationDigest)
            && input.Topology == "supervisor-plain-daemon.v1" && GuardianWire.Hash(input.SupervisorLaunchIdentityDigest), "guardian_bootstrap");
        configuration = input; sessionId = input.SessionId;
        using var self = new GuardianProcess((uint)Environment.ProcessId);
        GuardianWire.Require(Native.IsProcessInJob(self.Handle.DangerousGetHandle(), IntPtr.Zero, out bool inJob), "guardian_job_query");
        daemon = new GuardianProcess(self.ParentPid);
        GuardianWire.Require(!daemon.Exited && daemon.CreationTime < self.CreationTime && daemon.Sid == self.Sid, "guardian_bootstrap_parent");
        // The trusted local supervisor is captured from the kernel parent relationship, not a
        // requested PID. Its original HANDLE survives every permitted daemon incarnation.
        supervisor = new GuardianProcess(daemon.ParentPid);
        GuardianWire.Require(!supervisor.Exited && supervisor.CreationTime < daemon.CreationTime && supervisor.Sid == daemon.Sid
            && string.Equals(supervisor.Image, self.Image, StringComparison.OrdinalIgnoreCase)
            && supervisor.HasNativeMode("--daemon-supervisor-v1"),
            "guardian_bootstrap_supervisor");
        DaemonSupervisorAuthority.Require(daemon, input.SupervisorLaunchIdentityDigest);
        store = new GuardianDirectory(input.StoreDirectory); workspace = new GuardianDirectory(input.WorkspaceRoot);
        controlDirectory = new GuardianDirectory(input.ControlDirectory);
        GuardianWire.Require(!string.Equals(controlDirectory.Path, store.Path, StringComparison.OrdinalIgnoreCase)
            && !controlDirectory.Path.StartsWith(store.Path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)
            && !store.Path.StartsWith(controlDirectory.Path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(controlDirectory.Path, workspace.Path, StringComparison.OrdinalIgnoreCase)
            && !controlDirectory.Path.StartsWith(workspace.Path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)
            && !workspace.Path.StartsWith(controlDirectory.Path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase), "guardian_control_store_overlap");
        string instance = Guid.NewGuid().ToString("D");
        Endpoint = new GuardianEndpoint(1, GuardianWire.Capability, "artoo-guardian-" + instance, instance, self.Pid,
            self.CreationTime.ToString(CultureInfo.InvariantCulture), "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(self.Image))));
        // CreateNew deliberately rejects every old fence, including old H8 owner.lock files.
        owner = new FileStream(System.IO.Path.Combine(input.StoreDirectory, "owner.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        try {
            string operationsPath = System.IO.Path.Combine(input.StoreDirectory, "operations");
            Directory.CreateDirectory(operationsPath); sourceOperations = new GuardianDirectory(operationsPath);
            // This is the actual historical source-runtime fence, not the root discovery
            // marker. CreateNew rejects an old H8 owner even when no guardian marker exists.
            sourceOwner = new FileStream(System.IO.Path.Combine(operationsPath, "owner.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
            byte[] bytes = Encoding.UTF8.GetBytes(GuardianWire.Encode(new { version = 1, capability = GuardianWire.Capability, endpoint = Endpoint, binding = Binding }));
            owner.Write(bytes); owner.Flush(true);
            sourceOwner.Write(bytes); sourceOwner.Flush(true);
            // ACL collectors themselves create roster facts. Their audit must not mutate
            // the source store whose before/after inventory they are currently inspecting.
            audit = new FileStream(System.IO.Path.Combine(input.ControlDirectory, "guardian-audit-v1.ndjson"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            // An outer supervisor/fixture Job is allowed. The admitted local topology uses
            // plain daemon spawn; a per-daemon Job requires supervisor-owned guardian launch.
            Record("bootstrap", new { epochId, sessionId, supervisor = supervisor.Identity, topology = input.Topology, guardianInJob = inJob });
            new Thread(WriteDiagnostics) { IsBackground = true, Name = "artoo-guardian-diagnostics" }.Start();
        } catch { owner.Dispose(); throw; }
    }
    private object Binding => new { version = 1, node_id = configuration.NodeId, device_id = configuration.DeviceId,
        guardian_instance_id = Endpoint.GuardianInstanceId, store_identity_digest = store.IdentityDigest,
        configuration_digest = configuration.ConfigurationDigest, workspace_root = configuration.WorkspaceRoot,
        workspace_identity_digest = workspace.IdentityDigest };
    private object[] Roster => slots.Values.OrderBy(slot => slot.Id, StringComparer.Ordinal).Select(slot => slot.Head).ToArray();
    private string RosterDigest => GuardianWire.Digest(Roster);
    private object[] Operations => slots.Values.Select(slot => slot.ServerOperation).Where(operation => operation is not null).Cast<GuardianServerOperation>().Distinct()
        .OrderBy(operation => operation.Kind + ":" + operation.OperationId, StringComparer.Ordinal)
        .Select(operation => (object)(operation.RunId is null
            ? new Dictionary<string, object> { ["kind"] = operation.Kind, ["operation_id"] = operation.OperationId, ["request_digest"] = operation.RequestDigest }
            : new Dictionary<string, object> { ["kind"] = operation.Kind, ["operation_id"] = operation.OperationId, ["request_digest"] = operation.RequestDigest, ["run_id"] = operation.RunId })).ToArray();
    private object Epoch => new { version = 1, epoch_id = epochId, generation, session_id = sessionId, roster_revision = revision, roster_digest = RosterDigest };
    internal object Initial => new { endpoint = Endpoint, binding = Binding, epoch = Epoch };
    private void Record(string kind, object facts) {
        try {
            byte[] line = Encoding.UTF8.GetBytes(GuardianWire.Encode(new { version = 1, kind, epochId, generation, revision, facts }) + "\n");
            GuardianWire.Require(audit.Length + line.Length <= 8 * 1024 * 1024, "guardian_audit_bound");
            audit.Write(line); audit.Flush(true);
            Volatile.Write(ref diagnosticStamp, new(epochId, generation, revision));
        } catch { poisoned = true; throw; }
    }
    internal void RecordDiagnostic(string phase, Exception error, GuardianRequestTrace? request = null) {
        // Never take the authoritative gate or wait for disk/queue capacity here.
        // A slow diagnostic sink can lose diagnostics, never reserve or settle a slot.
        try {
            if (diagnosticUnavailable) return;
            var facts = NativeFailureDiagnostic.Capture(phase, error);
            var stamp = Volatile.Read(ref diagnosticStamp);
            string key = facts.Phase + ":" + (request?.Kind ?? "none");
            lock (diagnosticGate) {
                int count = diagnosticCounts.GetValueOrDefault(key);
                if (count >= 4) { Interlocked.Increment(ref diagnosticDropped); return; }
                diagnosticCounts[key] = count + 1;
            }
            string line = GuardianWire.Encode(new { version = 1,
                kind = request is null ? "native_failure_diagnostic" : "guardian_request_failure_diagnostic",
                epochId = stamp.EpochId, generation = stamp.Generation, revision = stamp.Revision, facts,
                request = request?.Snapshot(), dropped = Interlocked.Read(ref diagnosticDropped) }) + "\n";
            if (!diagnostics.TryAdd(line)) Interlocked.Increment(ref diagnosticDropped);
        } catch { Interlocked.Increment(ref diagnosticDropped); }
    }
    private void WriteDiagnostics() {
        FileStream? diagnosticAudit = null;
        try {
            foreach (string line in diagnostics.GetConsumingEnumerable()) {
                byte[] bytes = Encoding.UTF8.GetBytes(line);
                diagnosticAudit ??= new FileStream(System.IO.Path.Combine(configuration.ControlDirectory, "guardian-diagnostic-v1.ndjson"),
                    FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                if (diagnosticAudit.Length + bytes.Length > 65536) break;
                diagnosticAudit.Write(bytes); diagnosticAudit.Flush(true);
            }
        } catch { /* Diagnostic failure never alters authoritative state. */ }
        finally {
            diagnosticUnavailable = true;
            try { diagnosticAudit?.Dispose(); } catch { /* Preserve the original failure. */ }
        }
    }
    private void FreezeIfDead() { if (!frozen && daemon.Exited) { frozen = true; Record("epoch_frozen", new { daemon = daemon.Identity }); } }
    private GuardianProcess RelayDaemon(GuardianProcess peer, RelaySnapshot snapshot, GuardianRequestBudget budget, GuardianRequestTrace trace) {
        trace.Stage = "relay_identity";
        budget.AssertCurrent();
        GuardianWire.Require(string.Equals(peer.Image, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase) && peer.Sid == snapshot.Daemon.Sid
            && peer.HasNativeMode("--guardian-client-v1"),
            "guardian_relay_image");
        var parent = new GuardianProcess(peer.ParentPid);
        try {
            GuardianWire.Require(!peer.Exited && !parent.Exited && parent.CreationTime < peer.CreationTime && parent.Sid == snapshot.Daemon.Sid
                && string.Equals(parent.Image, snapshot.Daemon.Image, StringComparison.OrdinalIgnoreCase), "guardian_relay_parent");
            GuardianWire.Require(!snapshot.Supervisor.Exited && parent.ParentPid == snapshot.Supervisor.Pid && parent.CreationTime > snapshot.Supervisor.CreationTime,
                "guardian_exact_supervisor_required");
            trace.Stage = "supervisor_qualification";
            // Full original qualification remains mandatory, but cannot hold up an
            // unrelated host's pulse, terminal or ACK on the Guardian state gate.
            var qualified = DaemonSupervisorAuthority.Require(parent, configuration.SupervisorLaunchIdentityDigest, budget.Token,
                new GuardianRequestDeadline(1, budget.DeadlineTickCount64));
            budget.AssertCurrent();
            GuardianWire.Require(qualified.Supervisor == SupervisorProtocol.Identity(snapshot.Supervisor), "guardian_exact_supervisor_required");
            return parent;
        } catch { parent.Dispose(); throw; }
    }
    private void AssertRelaySnapshot(RelaySnapshot snapshot, GuardianProcess caller, GuardianProcess peer, GuardianRequestBudget budget) {
        budget.AssertCurrent();
        GuardianWire.Require(ReferenceEquals(daemon, snapshot.Daemon) && daemon.Same(snapshot.Daemon)
            && ReferenceEquals(supervisor, snapshot.Supervisor) && supervisor.Same(snapshot.Supervisor)
            && epochId == snapshot.EpochId && generation == snapshot.Generation && sessionId == snapshot.SessionId
            && registrationId == snapshot.RegistrationId && registrationDigest == snapshot.RegistrationDigest
            && !supervisor.Exited && !peer.Exited && !caller.Exited && caller.Pid == peer.ParentPid
            && caller.ParentPid == supervisor.Pid && caller.CreationTime > supervisor.CreationTime
            && caller.CreationTime < peer.CreationTime && caller.Sid == daemon.Sid
            && string.Equals(caller.Image, daemon.Image, StringComparison.OrdinalIgnoreCase), "guardian_relay_parent");
        // FreezeIfDead and each original branch below reevaluate current liveness,
        // registration, roster and transfer requirements under this same gate.
    }
    private Slot HostSlot(GuardianProcess peer, GuardianRequest request) {
        GuardianWire.Require(request.EpochId == epochId && request.SlotId is not null && slots.ContainsKey(request.SlotId), "guardian_slot_epoch");
        Slot slot = slots[request.SlotId!];
        GuardianWire.Require(request.Ticket == slot.Ticket && slot.Host is not null && slot.Host.Same(peer), "guardian_exact_host"); return slot;
    }
    private bool Closed() => frozen && !poisoned && !supervisor.Exited && slots.Values.All(slot => slot.Terminal is not null && slot.AckReceived
        && slot.Host is not null && slot.Host.Exited && (slot.Root is null || slot.Root.Exited));
    private static string TransferBinding(GuardianRequest request) => GuardianWire.Digest(new { request.EpochId, request.SessionId,
        request.ChallengeId, request.RequestDigest, request.ExpectedRosterDigest, request.ExpectedRosterRevision,
        request.ExpectedNewDaemonIdentityDigest });
    private static void BeginMutation(GuardianRequestBudget budget, GuardianRequestTrace trace) {
        budget.AssertCurrent(); trace.Stage = "mutation"; trace.MutationStarted = true;
        // The existing authoritative write/fsync is not cancellable. Once begun,
        // uncertainty must retain ownership; expiration never erases a live slot.
    }
    internal object Handle(GuardianProcess peer, GuardianRequest request, GuardianRequestBudget budget, GuardianRequestTrace trace) {
        RelaySnapshot? captured = null;
        if (request.Kind is "status" or "activate" or "reserve" or "transfer") {
            trace.Stage = "snapshot_gate";
            using (budget.Enter(gate)) {
                GuardianWire.Require(request.Version == 1 && GuardianWire.Uuid(request.Nonce) && !poisoned, "guardian_request");
                FreezeIfDead(); budget.AssertCurrent(); captured = new RelaySnapshot(this);
            }
        }
        using var snapshot = captured;
        using var caller = snapshot is null ? null : RelayDaemon(peer, snapshot, budget, trace);
        trace.Stage = "commit_gate";
        using (budget.Enter(gate)) {
            GuardianWire.Require(request.Version == 1 && GuardianWire.Uuid(request.Nonce) && !poisoned, "guardian_request");
            FreezeIfDead();
            if (snapshot is not null) AssertRelaySnapshot(snapshot, caller!, peer, budget);
            budget.AssertCurrent(); trace.Stage = "dispatch_locked";
            if (request.Kind == "attach") {
                GuardianWire.Require(!frozen && activated && request.EpochId == epochId && request.SlotId is not null && slots.ContainsKey(request.SlotId), "guardian_attach_epoch");
                Slot slot = slots[request.SlotId!];
                GuardianWire.Require(slot.Host is null && request.Ticket == slot.Ticket && peer.ParentPid == daemon.Pid
                    && peer.CreationTime > daemon.CreationTime && !daemon.Exited && !peer.Exited
                    && peer.Sid == daemon.Sid && string.Equals(peer.Image, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase)
                    && (peer.HasNativeMode("--stdio-v1") || peer.HasNativeMode("--stdio-sync-v1")), "guardian_attach_identity");
                BeginMutation(budget, trace);
                slot.Host = new GuardianProcess(peer.Pid); GuardianWire.Require(slot.Host.Same(peer), "guardian_attach_identity_changed");
                Record("host_attached", new { slotId = slot.Id, host = slot.Host.Identity }); trace.MutationRecorded = true; return new { attached = true };
            }
            if (request.Kind is "root" or "pulse" or "terminal" or "terminal_ack_received") {
                Slot slot = HostSlot(peer, request);
                if (request.Kind == "pulse") return new { stop = frozen };
                if (request.Kind == "root") {
                    GuardianWire.Require(!frozen && !daemon.Exited && slot.Root is null && slot.Terminal is null && request.RootPid.HasValue, "guardian_root_epoch");
                    var root = new GuardianProcess(request.RootPid!.Value);
                    try {
                        GuardianWire.Require(root.ParentPid == peer.Pid && root.CreationTime > peer.CreationTime && !root.Exited
                            && root.CreationTime.ToString(CultureInfo.InvariantCulture) == request.RootCreationTime, "guardian_root_identity");
                        BeginMutation(budget, trace);
                        slot.Root = root; Record("root_enrolled", new { slotId = slot.Id, root = root.Identity }); trace.MutationRecorded = true;
                    } catch { if (slot.Root is null) root.Dispose(); throw; }
                    return new { enrolled = true };
                }
                if (request.Kind == "terminal") {
                    var facts = request.Terminal ?? throw new IOException("guardian_terminal_missing");
                    GuardianWire.Require(facts.CleanupConfirmed && facts.RootCreated != facts.NoTargetCreated
                        && (!facts.StdoutCreated || facts.StdoutEof) && (!facts.StderrCreated || facts.StderrEof)
                        && (!facts.JobCreated || facts.JobEmptyObserved)
                        && (!facts.RootStarted || facts.RootCreated && facts.AtomicJobMember), "guardian_terminal_incomplete");
                    if (slot.Root is not null) GuardianWire.Require(facts.RootCreated && facts.JobCreated && facts.StdoutCreated && facts.StderrCreated
                        && facts.RootWaitObserved && facts.RootExitCode.HasValue && facts.RootPid == slot.Root.Pid
                        && facts.RootCreationTime == slot.Root.CreationTime.ToString(CultureInfo.InvariantCulture) && slot.Root.Exited
                        && Native.GetExitCodeProcess(slot.Root.Handle.DangerousGetHandle(), out uint exitCode) && exitCode == facts.RootExitCode,
                        "guardian_terminal_root");
                    else GuardianWire.Require(facts.NoTargetCreated && !facts.RootCreated && !facts.RootStarted && !facts.RootWaitObserved
                        && facts.RootPid is null && facts.RootCreationTime is null && facts.RootExitCode is null && !facts.AtomicJobMember,
                        "guardian_terminal_unenrolled_root");
                    string digest = GuardianWire.Digest(facts);
                    GuardianWire.Require(slot.TerminalDigest is null || slot.TerminalDigest == digest, "guardian_terminal_changed");
                    if (slot.Terminal is null) { BeginMutation(budget, trace); slot.Terminal = facts; slot.TerminalDigest = digest; slot.Ack = Guid.NewGuid().ToString("D");
                        Record("terminal_observed", new { slotId = slot.Id, terminalDigest = digest }); trace.MutationRecorded = true; }
                    return new { terminalAck = slot.Ack, terminalDigest = slot.TerminalDigest };
                }
                GuardianWire.Require(slot.Terminal is not null && slot.Ack is not null && request.TerminalAck == slot.Ack, "guardian_terminal_ack_binding");
                if (!slot.AckReceived) { BeginMutation(budget, trace); Record("terminal_ack_received", new { slotId = slot.Id, terminalDigest = slot.TerminalDigest });
                    slot.AckReceived = true; trace.MutationRecorded = true; }
                return new { acknowledged = true };
            }
            if (snapshot is null || caller is null) throw new IOException("guardian_request");
            if (request.Kind == "status") return new { binding = Binding, epoch = Epoch, registrationId, registrationDigest, operations = Operations, frozen, closed = Closed(),
                newDaemonIdentityDigest = GuardianWire.Digest(caller.Identity), callerIsCurrentDaemon = caller.Same(daemon) };
            if (request.Kind == "activate") {
                GuardianWire.Require(!frozen && caller.Same(daemon) && request.EpochId == epochId && request.SessionId == sessionId
                    && GuardianWire.Uuid(request.RegistrationId) && GuardianWire.Hash(request.RegistrationDigest)
                    && (!activated || registrationId == request.RegistrationId && registrationDigest == request.RegistrationDigest), "guardian_activation_binding");
                if (!activated) { BeginMutation(budget, trace); registrationId = request.RegistrationId; registrationDigest = request.RegistrationDigest;
                    Record("registration_accepted", new { registrationId, registrationDigest }); activated = true; trace.MutationRecorded = true; }
                return new { activated = true };
            }
            if (request.Kind == "reserve") {
                GuardianWire.Require(!frozen && activated && caller.Same(daemon) && request.EpochId == epochId && request.SessionId == sessionId
                    && slots.Count < 4096 && request.OperationKind is "author" or "verifier" or "browser" or "observer" or "git" or "tool"
                    && GuardianWire.Id(request.OperationId) && GuardianWire.Hash(request.BindingDigest), "guardian_reservation_binding");
                // Pre-H6 slots remain in the complete native roster but cannot settle any
                // Server operation. H7/H9/release controllers bind their real namespace.
                var serverOperation = request.ServerOperation;
                GuardianWire.Require(serverOperation is null || serverOperation.Kind is "validation" or "validation_review" or "release" && GuardianWire.Id(serverOperation.OperationId)
                    && GuardianWire.Hash(serverOperation.RequestDigest) && (serverOperation.Kind == "validation" ? GuardianWire.Id(serverOperation.RunId) : serverOperation.RunId is null)
                    && slots.Values.Select(slot => slot.ServerOperation).Append(serverOperation).Where(operation => operation is not null).Distinct().Count() <= 128
                    && slots.Values.All(slot => slot.ServerOperation is null || slot.ServerOperation.Kind != serverOperation.Kind || slot.ServerOperation.OperationId != serverOperation.OperationId
                        || slot.ServerOperation == serverOperation), "guardian_server_operation_binding");
                string id = Guid.NewGuid().ToString("D"), ticket = Guid.NewGuid().ToString("D");
                var slot = new Slot(id, ticket, request.OperationKind!, request.OperationId!, request.BindingDigest!, serverOperation);
                // This is the reserve linearization point. Recheck after all slow
                // work and gate waiting; never begin admission after the deadline.
                BeginMutation(budget, trace); slots.Add(id, slot); revision++;
                Record("launch_reserved", new { slot = slot.Head, serverOperation }); trace.MutationRecorded = true;
                return new GuardianEnrollment(1, Endpoint, epochId, id, ticket);
            }
            if (request.Kind == "transfer" && request.ChallengeId is not null && transfers.TryGetValue(request.ChallengeId, out var replay)) {
                GuardianWire.Require(!frozen && caller.Same(daemon) && replay.EpochId == epochId && replay.Binding == TransferBinding(request), "guardian_transfer_replay");
                return replay.Result;
            }
            GuardianWire.Require(request.Kind == "transfer" && Closed() && !caller.Same(daemon) && request.EpochId == epochId
                && GuardianWire.Id(request.SessionId) && request.SessionId != sessionId && GuardianWire.Uuid(request.ChallengeId)
                && GuardianWire.Hash(request.RequestDigest) && request.ExpectedRosterRevision == revision && request.ExpectedRosterDigest == RosterDigest
                && request.ExpectedNewDaemonIdentityDigest == GuardianWire.Digest(caller.Identity)
                && challenges.Count < 256 && !challenges.Contains(request.ChallengeId!), "guardian_transfer_binding");
            var closedSlots = slots.Values.OrderBy(slot => slot.Id, StringComparer.Ordinal).Select(slot => new { slot_id = slot.Id,
                operation_kind = slot.Kind, operation_id = slot.Operation, binding_digest = slot.Binding, terminal_digest = slot.TerminalDigest! }).ToArray();
            string previousEpoch = epochId, nextEpoch = Guid.NewGuid().ToString("D"), previousRoster = RosterDigest;
            int previousRevision = revision; string closure = GuardianWire.Digest(closedSlots); var operations = Operations;
            // Keep the complete roster; never truncate it to satisfy the transport bound.
            // Reserve headroom for the bounded epoch/challenge/session fields and envelope.
            GuardianWire.Require(Encoding.UTF8.GetByteCount(GuardianWire.Encode(new { binding = Binding, slots = closedSlots, operations })) < 48000,
                "guardian_complete_transfer_frame_bound");
            var newDaemon = new GuardianProcess(caller.Pid);
            try {
                GuardianWire.Require(newDaemon.Same(caller) && !newDaemon.Exited, "guardian_transfer_daemon_changed");
                BeginMutation(budget, trace);
                Record("epoch_transfer", new { oldEpochId = epochId, newEpochId = nextEpoch, challengeId = request.ChallengeId,
                    requestDigest = request.RequestDigest, closureSetDigest = closure, newDaemon = caller.Identity });
            } catch { newDaemon.Dispose(); throw; }
            trace.MutationRecorded = true;
            challenges.Add(request.ChallengeId!); daemon.Dispose(); daemon = newDaemon;
            foreach (var slot in slots.Values) { slot.Host?.Dispose(); slot.Root?.Dispose(); } slots.Clear();
            epochId = nextEpoch; generation++; sessionId = request.SessionId!; revision = 0; frozen = false; activated = false; registrationId = null; registrationDigest = null;
            var result = new { binding = Binding, oldEpochId = previousEpoch, newEpochId = epochId, generation, currentSessionId = sessionId,
                newDaemonIdentityDigest = GuardianWire.Digest(daemon.Identity), challengeId = request.ChallengeId, requestDigest = request.RequestDigest,
                rosterRevision = previousRevision, rosterDigest = previousRoster, closureSetDigest = closure, slots = closedSlots, operations, epoch = Epoch };
            // Retain the sealed old roster/facts in this guardian's memory. A lost reply may be
            // replayed only to the same exact new daemon, never reconstructed from audit JSON.
            transfers.Add(request.ChallengeId!, (TransferBinding(request), epochId, result)); return result;
        }
    }
    internal void ObserveDaemon() { lock (gate) { if (!poisoned) FreezeIfDead(); } }
    public void Dispose() {
        // The background sink alone owns its file. Do not join a blocked fsync or
        // dispose that file concurrently while closing authoritative resources.
        try { diagnostics.CompleteAdding(); } catch { /* Diagnostics cannot delay ownership cleanup. */ }
        foreach (var slot in slots.Values) { slot.Host?.Dispose(); slot.Root?.Dispose(); }
        audit.Dispose(); sourceOwner.Dispose(); sourceOperations.Dispose(); owner.Dispose(); workspace.Dispose(); store.Dispose(); controlDirectory.Dispose(); daemon.Dispose(); supervisor.Dispose(); }
}

internal static class GuardianProgram
{
    internal static int MainGuardian() {
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            using var state = new GuardianState(GuardianWire.Decode<GuardianBootstrap>(GuardianWire.Input()));
            try {
            using var self = new GuardianProcess((uint)Environment.ProcessId);
            // Creating the ACL-protected, remote-rejecting pipe precedes every target admission.
            var first = CreatePipe(state.Endpoint.PipeName, self.Sid);
            Console.Out.WriteLine(GuardianWire.Encode(new { version = 1, kind = "guardian_ready", payload = state.Initial })); Console.Out.Flush();
            // stdio is only bootstrap delivery; daemon EOF must not kill the surviving guardian.
            Serve(state, self.Sid, first).GetAwaiter().GetResult(); return 0;
            } catch (Exception error) { state.RecordDiagnostic("guardian_lifetime", error); throw; }
        } catch (Exception error) { NativeFailureDiagnostic.Emit("guardian_bootstrap", error); return 2; }
    }
    internal static int MainRelay() {
        string phase = "guardian_relay_input";
        GuardianConnection? connection = null;
        Exception? operationFailure = null, cleanupFailure = null;
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            var input = GuardianWire.Decode<GuardianRelay>(GuardianWire.Input()); GuardianWire.Require(input.Version == 1, "guardian_relay_version");
            phase = "guardian_relay_send";
            connection = new GuardianConnection(input.Endpoint);
            var output = connection.Send(input.Request);
            phase = "guardian_relay_output";
            Console.Out.WriteLine(GuardianWire.Encode(new { version = 1, kind = "guardian_result", payload = output })); Console.Out.Flush();
        } catch (Exception error) { operationFailure = error; }
        finally {
            // Preserve the original operation independently of cleanup. Report
            // only after owned resources were attempted, so diagnostic I/O
            // cannot interrupt that cleanup sequence.
            try { connection?.Dispose(); }
            catch (Exception cleanup) { cleanupFailure = cleanup; }
        }
        if (operationFailure is not null) NativeFailureDiagnostic.Emit(phase, operationFailure);
        if (cleanupFailure is not null) NativeFailureDiagnostic.Emit("guardian_lifetime", cleanupFailure);
        return operationFailure is not null || cleanupFailure is not null ? 2 : 0;
    }
    private static NamedPipeServerStream CreatePipe(string name, string sid) {
        GuardianWire.Require(GuardianNative.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out IntPtr descriptor, out _), "guardian_pipe_acl");
        try {
            var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), lpSecurityDescriptor = descriptor };
            // FILE_FLAG_OVERLAPPED + duplex; byte mode + PIPE_REJECT_REMOTE_CLIENTS.
            SafePipeHandle handle = GuardianNative.CreateNamedPipeW("\\\\.\\pipe\\" + name, 3 | 0x40000000, 8, 32, 65536, 65536, 0, ref security);
            GuardianWire.Require(!handle.IsInvalid, "guardian_pipe_create");
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        } finally { GuardianNative.LocalFree(descriptor); }
    }
    private static async Task Serve(GuardianState state, string sid, NamedPipeServerStream first) {
        using var capacity = new SemaphoreSlim(31);
        _ = Task.Run(async () => { for (;;) { try { state.ObserveDaemon(); } catch (Exception error) { state.RecordDiagnostic("guardian_observe", error); } await Task.Delay(50); } });
        var pending = first;
        for (;;) {
            await pending.WaitForConnectionAsync(); var connected = pending;
            await capacity.WaitAsync(); pending = CreatePipe(state.Endpoint.PipeName, sid);
            _ = Task.Run(async () => { try { await Client(state, connected); } finally { connected.Dispose(); capacity.Release(); } });
        }
    }
    private static async Task Client(GuardianState state, NamedPipeServerStream pipe) {
        string phase = "guardian_peer_open";
        GuardianRequestTrace? trace = null;
        try {
            GuardianWire.Require(GuardianNative.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint pid), "guardian_client_pid");
            using var peer = new GuardianProcess(pid);
            using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            for (;;) {
                trace = null;
                using var timeout = new CancellationTokenSource(5000);
                phase = "guardian_client_read";
                string line = await GuardianWire.ReadLine(reader, timeout.Token);
                var request = GuardianWire.Decode<GuardianRequest>(line);
                trace = new GuardianRequestTrace(request);
                // Legacy requests without the optional monotonic field still get
                // a local bounded budget. An arbitrary future field cannot extend it.
                using var budget = new GuardianRequestBudget(2500, timeout.Token, request.Deadline);
                object response;
                try { response = new { version = 1, kind = "ok", nonce = request.Nonce, payload = state.Handle(peer, request, budget, trace) }; }
                catch (Exception error) { state.RecordDiagnostic("guardian_request_handle", error, trace); response = new { version = 1, kind = "error", nonce = request.Nonce, payload = new { reason = "guardian_request_rejected" } }; }
                phase = "guardian_client_reply";
                trace.Stage = "reply"; budget.AssertCurrent();
                await writer.WriteLineAsync(GuardianWire.Encode(response).AsMemory(), budget.Token);
            }
        } catch (Exception error) { state.RecordDiagnostic(phase, error, trace); /* Peer loss never settles a slot or releases ownership. */ }
    }
}

internal static class GuardianNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_BASIC_INFORMATION {
        internal IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct UNICODE_STRING { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_TIME { internal uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] internal struct BY_HANDLE_FILE_INFORMATION {
        internal uint FileAttributes; internal FILE_TIME CreationTime, LastAccessTime, LastWriteTime;
        internal uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("ntdll.dll")] internal static extern int NtQueryInformationProcess(SafeProcessHandle process, int informationClass, out PROCESS_BASIC_INFORMATION info, uint length, out uint returned);
    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")] internal static extern int NtQueryInformationProcessBuffer(SafeProcessHandle process, int informationClass, IntPtr buffer, uint length, out uint returned);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CommandLineToArgvW(string command, out int argc);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder image, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref Native.SECURITY_ATTRIBUTES security);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
}
