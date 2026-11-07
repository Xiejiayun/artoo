// Candidate only: not compiled or native-tested. The wire is private to the node.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private static string? stopReason;
    private static volatile bool finished;
    private static string? token;
    private static FrameWriter? wire;
    private static long outputBytes;
    private static long capturedBytes;
    private const string MemberCapability = "artoo.windows-job-member-observation.v1";
    private static readonly BlockingCollection<MemberObservation> observations = new(16);
    private static void Stop(string reason) => Interlocked.CompareExchange(ref stopReason, reason, null);

    public static int Main(string[] args)
    {
        if (args.Length == 1 && OperatingSystem.IsWindowsVersionAtLeast(10)) {
            if (args[0] == "--guardian-v1") return GuardianProgram.MainGuardian();
            if (args[0] == "--guardian-client-v1") return GuardianProgram.MainRelay();
            if (args[0] == "--daemon-supervisor-v1") return DaemonSupervisorProgram.Run();
            if (args[0] == "--daemon-supervisor-qualify-v1") return DaemonSupervisorProgram.Qualify();
        }
        if (args.Length != 1 || (args[0] != "--stdio-v1" && args[0] != "--stdio-sync-v1") || !OperatingSystem.IsWindowsVersionAtLeast(10)) return 3;
        bool synchronous = args[0] == "--stdio-sync-v1";
        Console.InputEncoding = new UTF8Encoding(false, true);
        wire = new FrameWriter();
        if (!Native.GetProcessTimes(new IntPtr(-1), out long hostCreation, out _, out _, out _)) return 2;
        if (!wire.Send("ready", new { protocol = "artoo.windows-job-process.v1", atomicJobList = true,
            hostIdentity = new { pid = (uint)Environment.ProcessId, creationTime = hostCreation.ToString(CultureInfo.InvariantCulture) },
            capabilities = synchronous ? new[] { GuardianWire.Capability } : new[] { GuardianWire.Capability, MemberCapability } })) return 2;
        Launch? request = null;
        string? failureCode = null;
        int? nativeError = null;
        IntPtr job = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, input = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handlesValue = IntPtr.Zero, jobsValue = IntPtr.Zero, environment = IntPtr.Zero;
        bool attributesInitialized = false, jobWasCreated = false, created = false, started = false, member = false, rootWait = false, jobEmpty = false;
        bool attemptedCreate = false, createReturned = false, terminated = false, normalDescendants = false;
        uint? rootExit = null;
        long? rootCreationTime = null;
        Native.PROCESS_INFORMATION process = default;
        PipePump? stdout = null, stderr = null;
        InputPump? stdin = null;
        Stopwatch elapsed = Stopwatch.StartNew();
        double? cleanupStarted = null, normalExitAt = null;
        int cleanupMs = 5000;
        bool cleanupConfirmed = false;
        GuardianHost? guardian = null;
        bool guardianAcknowledged = false;
        try
        {
            var first = ReadLineBounded(Console.In, synchronous ? 24 * 1024 * 1024 : 1024 * 1024);
            if (first is null) { Stop("parent_eof"); throw new HostFailure("no_launch"); }
            request = JsonSerializer.Deserialize<Launch>(first, Json) ?? throw new HostFailure("invalid_request");
            if (Guid.TryParseExact(request.Token, "D", out _)) token = request.Token;
            Validate(request); cleanupMs = request.CleanupTimeoutMs;
            // Synchronous collectors receive one fixed bounded input. Their original
            // guardian observes daemon death; ordinary stdio retains parent-EOF cancellation.
            if (synchronous != (request.InputBase64 is not null) || (synchronous && request.Guardian is null))
                throw new HostFailure("invalid_sync_request");
            byte[]? inputBytes = synchronous ? Convert.FromBase64String(request.InputBase64!) : null;
            if (inputBytes is not null && (inputBytes.Length > 16 * 1024 * 1024
                || Convert.ToBase64String(inputBytes) != request.InputBase64)) throw new HostFailure("invalid_sync_input");
            // Keep the original clock: reading and validating launch input cannot renew the deadline.
            if (!synchronous) new Thread(ControlLoop) { IsBackground = true, Name = "artoo-control" }.Start();
            if (Volatile.Read(ref stopReason) is not null) throw new HostFailure("cancelled_before_create");
            // The launch slot already exists. Authenticate and attach this exact native host
            // before any Job or suspended root is created; old bundles never receive this field.
            if (request.Guardian is not null) guardian = new GuardianHost(request.Guardian, Stop);

            job = Native.CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "job_create");
            jobWasCreated = true;
            var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // Deliberately omit both BREAKAWAY flags; this anonymous handle is never inherited.
            Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()), "job_limits");
            var security = new Native.SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle = 1 };
            Check(Native.CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0), "stdout_pipe");
            Check(Native.SetHandleInformation(stdoutRead, 1, 0), "stdout_no_inherit");
            Check(Native.CreatePipe(out stderrRead, out stderrWrite, ref security, 0), "stderr_pipe");
            Check(Native.SetHandleInformation(stderrRead, 1, 0), "stderr_no_inherit");
            if (synchronous) {
                Check(Native.CreatePipe(out input, out inputWrite, ref security, 0), "stdin_pipe");
                Check(Native.SetHandleInformation(inputWrite, 1, 0), "stdin_no_inherit");
            } else {
                input = Native.CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
                Check(input != new IntPtr(-1), "null_input");
            }
            UIntPtr size = UIntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Check(size.ToUInt64() > 0 && size.ToUInt64() <= 65536, "attribute_size");
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "attribute_initialize");
            attributesInitialized = true;
            handlesValue = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handlesValue, 0, input);
            Marshal.WriteIntPtr(handlesValue, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handlesValue, IntPtr.Size * 2, stderrWrite);
            jobsValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobsValue, job);
            Check(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002), handlesValue,
                new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "handle_list");
            // JOB_LIST requires Windows 10 / Server 2016+. No Create-then-Assign fallback.
            Check(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x0002000D), jobsValue,
                new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "atomic_job_list");
            var startup = new Native.STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf<Native.STARTUPINFOEX>();
            startup.StartupInfo.dwFlags = 0x100;
            startup.StartupInfo.hStdInput = input; startup.StartupInfo.hStdOutput = stdoutWrite; startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributes;
            environment = Marshal.StringToHGlobalUni(EnvironmentBlock(request.Env));
            var commandLine = new StringBuilder(string.Join(" ", new[] { request.Executable }.Concat(request.Args).Select(Quote)));
            if (commandLine.Length >= 32767) throw new HostFailure("command_line_too_long");
            stdout = new PipePump(stdoutRead, "stdout", request.MaxOutputBytes); stdout.Start();
            stderr = new PipePump(stderrRead, "stderr", request.MaxOutputBytes); stderr.Start();
            if (Volatile.Read(ref stopReason) is not null) throw new HostFailure("cancelled_before_create");
            if (elapsed.ElapsedMilliseconds >= request.TimeoutMs) { Stop("timeout"); throw new HostFailure("deadline_before_create"); }
            attemptedCreate = true;
            created = Native.CreateProcessW(request.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x00000004 | 0x00000400 | 0x00080000 | 0x08000000, environment, request.Cwd, ref startup, out process);
            createReturned = true;
            if (!created) throw new HostFailure("create_process", Marshal.GetLastWin32Error());
            // The target was atomically placed in the Job before CreateProcess returned, still suspended.
            // Close our copies immediately; target/descendant handles alone now determine pipe EOF.
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input);
            bool membershipRead = Native.IsProcessInJob(process.hProcess, job, out bool queriedMember);
            member = membershipRead && queriedMember;
            Check(member, "job_membership");
            Check(Native.GetProcessTimes(process.hProcess, out long creation, out _, out _, out _), "process_identity");
            rootCreationTime = creation;
            guardian?.EnrollRoot(process.dwProcessId, creation);
            wire.Send("created", new { pid = process.dwProcessId, creationTime = creation.ToString(CultureInfo.InvariantCulture), jobMember = true });
            // Exact root HANDLE and pipe readers already exist. Wait state cannot be lost to a quick exit.
            if (Volatile.Read(ref stopReason) is not null) throw new HostFailure("cancelled_before_resume");
            if (elapsed.ElapsedMilliseconds >= request.TimeoutMs) { Stop("timeout"); throw new HostFailure("deadline_before_resume"); }
            uint previousSuspendCount = Native.ResumeThread(process.hThread);
            if (previousSuspendCount != 1) throw new HostFailure(previousSuspendCount == uint.MaxValue ? "resume_failed" : "resume_state",
                previousSuspendCount == uint.MaxValue ? Marshal.GetLastWin32Error() : null);
            started = true;
            wire.Send("started", new { pid = process.dwProcessId, creationTime = creation.ToString(CultureInfo.InvariantCulture) });
            if (synchronous) {
                // Only the enrolled, resumed target may receive input. The writer owns
                // this noninheritable HANDLE until actual write completion or pipe failure.
                stdin = new InputPump(inputWrite, inputBytes!); inputWrite = IntPtr.Zero; stdin.Start();
            }
        }
        catch (HostFailure error) { failureCode = error.Code; nativeError = error.NativeCode; Stop(error.Code); }
        catch (Exception) { failureCode = "request_or_setup_failed"; Stop(failureCode); }
        finally
        {
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input); Close(ref inputWrite);
            if (attributesInitialized) Native.DeleteProcThreadAttributeList(attributes);
            // Attribute values are deliberately retained through DeleteProcThreadAttributeList.
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handlesValue != IntPtr.Zero) Marshal.FreeHGlobal(handlesValue);
            if (jobsValue != IntPtr.Zero) Marshal.FreeHGlobal(jobsValue);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref process.hThread);
        }

        try
        {
            for (;;)
            {
                double now = elapsed.Elapsed.TotalMilliseconds;
                // This thread owns the original Job HANDLE until final closure. Diagnostics
                // never duplicate it and never query the unrelated "any Job" membership.
                if (!synchronous && observations.TryTake(out var observation)) ObserveMembers(job, observation, now);
                string? stop = Volatile.Read(ref stopReason);
                if (request is not null && stop is null && now >= request.TimeoutMs) { Stop("timeout"); stop = Volatile.Read(ref stopReason); }
                if (created && !rootWait)
                {
                    uint wait = Native.WaitForSingleObject(process.hProcess, 0);
                    if (wait == 0)
                    {
                        rootWait = true; normalExitAt = now;
                        if (Native.GetExitCodeProcess(process.hProcess, out uint status))
                        { rootExit = status; wire.Send("root_exit", new { code = status }); }
                        else { failureCode ??= "exit_status"; nativeError ??= Marshal.GetLastWin32Error(); Stop("exit_status"); }
                    }
                    else if (wait != 258) { failureCode ??= "root_wait"; nativeError ??= Marshal.GetLastWin32Error(); Stop("root_wait"); }
                }
                uint? active = null;
                if (job != IntPtr.Zero)
                {
                    if (Native.QueryInformationJobObject(job, 1, out Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting,
                        (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero))
                    { active = accounting.ActiveProcesses; if (active == 0 && (!created || rootWait)) jobEmpty = true; }
                    else { failureCode ??= "job_query"; nativeError ??= Marshal.GetLastWin32Error(); Stop("job_query"); }
                }
                if (rootWait && Volatile.Read(ref stopReason) is null && !jobEmpty)
                {
                    if (request?.NormalExitPolicy == "terminate-descendants") normalDescendants = true;
                    else if (now - normalExitAt!.Value >= (request?.NormalExitGraceMs ?? 250)) Stop("lingering_processes");
                }
                stop = Volatile.Read(ref stopReason);
                if (stop is not null || rootWait || !created) cleanupStarted ??= now;
                if ((stop is not null || normalDescendants) && !terminated)
                {
                    terminated = true;
                    if (job != IntPtr.Zero && !jobEmpty && !Native.TerminateJobObject(job, 0xE0000001))
                    { failureCode ??= "terminate_job"; nativeError ??= Marshal.GetLastWin32Error(); }
                    // A failed membership query is never evidence that this exact suspended root is covered.
                    if (created && !member && !rootWait && !Native.TerminateProcess(process.hProcess, 0xE0000002))
                    { failureCode ??= "terminate_unconfirmed_root"; nativeError ??= Marshal.GetLastWin32Error(); }
                }
                bool noRoot = !created && (!attemptedCreate || createReturned);
                bool pipesClosed = (stdout is null || (guardian is null ? stdout.Eof : stdout.ObservedEof))
                    && (stderr is null || (guardian is null ? stderr.Eof : stderr.ObservedEof));
                bool noJob = job == IntPtr.Zero;
                if ((noRoot || rootWait) && pipesClosed && (noJob || jobEmpty) && (stdin is null || stdin.Closed)) { cleanupConfirmed = true; break; }
                if (cleanupStarted.HasValue && now - cleanupStarted.Value >= cleanupMs) break;
                Thread.Sleep(10);
            }
        }
        catch (Exception) { failureCode ??= "closure_observation_failed"; cleanupConfirmed = false; }
        finally
        {
            ExceptionDispatchInfo? first = null;
            void Failed(Exception error) {
                first ??= ExceptionDispatchInfo.Capture(error);
            }
            // Independent guardian delivery happens while this host still owns every original
            // HANDLE. Broken daemon stdout cannot erase locally observed pipe EOF.
            try {
            if (guardian is not null && cleanupConfirmed) guardianAcknowledged = guardian.Terminal(new GuardianTerminal(
                created, started, created ? process.dwProcessId : null, rootCreationTime?.ToString(CultureInfo.InvariantCulture),
                member, rootWait, rootExit, jobWasCreated, jobEmpty, stdout is not null, stderr is not null,
                stdout?.ObservedEof ?? false, stderr?.ObservedEof ?? false, !created && (!attemptedCreate || createReturned), cleanupConfirmed));
            } catch (Exception error) { Failed(error); }
            try { guardian?.Dispose(); } catch (Exception error) { Failed(error); }
            finished = true;
            // Job close is a safety fallback, not an observed successful receipt.
            void ReleaseHandle(ref IntPtr handle) {
                try { Close(ref handle); } catch (Exception error) { Failed(error); }
            }
            ReleaseHandle(ref job); ReleaseHandle(ref process.hProcess); ReleaseHandle(ref stdoutRead); ReleaseHandle(ref stderrRead);
            // Preserve observed ACK/Job/EOF facts, but never let the existing
            // ACK-based success return turn a terminal/cleanup exception into zero.
            if (first is not null) {
                NativeFailureDiagnostic.Emit("guardian_lifetime", first.SourceException);
                first.Throw();
            }
        }
        bool sent = wire.Send("complete", new
        {
            rootCreated = created, rootStarted = started, rootPid = created ? (uint?)process.dwProcessId : null,
            rootCreationTime = rootCreationTime?.ToString(CultureInfo.InvariantCulture), atomicJobMember = member,
            rootWaitObserved = rootWait, rootExitCode = rootExit,
            stdoutEof = stdout?.Eof ?? false, stderrEof = stderr?.Eof ?? false,
            stdoutCreated = stdout is not null, stderrCreated = stderr is not null,
            jobCreated = jobWasCreated, jobEmptyObserved = jobEmpty,
            noTargetCreated = !created && (!attemptedCreate || createReturned),
            terminationReason = Volatile.Read(ref stopReason) ?? (normalDescendants ? "normal_exit_descendants" : null),
            failureCode, nativeError, outputBytesObserved = Interlocked.Read(ref outputBytes),
            outputBytesCaptured = Interlocked.Read(ref capturedBytes), cleanupConfirmed
        });
        bool delivered = sent && wire.Finish(2000);
        if (request?.Guardian is not null) return guardianAcknowledged && cleanupConfirmed ? 0 : 2;
        return delivered ? (cleanupConfirmed ? 0 : 1) : 2;
    }

    private static void ControlLoop()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            for (;;)
            {
                string? line = ReadLineBounded(Console.In, 16384);
                if (finished) return;
                if (line is null) { Stop("parent_eof"); return; }
                if (Encoding.UTF8.GetByteCount(line) > 16384) throw new HostFailure("control_frame_limit");
                using var frame = JsonDocument.Parse(line);
                if (frame.RootElement.GetProperty("kind").GetString() == "cancel") {
                    var cancel = JsonSerializer.Deserialize<Cancel>(line, Json);
                    if (cancel?.Version != 1 || cancel.Token != token) throw new HostFailure("control_protocol");
                    Stop("cancelled");
                } else {
                    var request = JsonSerializer.Deserialize<MemberObservation>(line, Json);
                    if (request is null || request.Version != 1 || request.Kind != "observe_members" || request.Token != token
                        || !Guid.TryParseExact(request.RequestId, "D", out _) || seen.Count >= 256 || !seen.Add(request.RequestId)
                        || request.Members is null || request.Members.Length is < 1 or > 128
                        || request.Members.Any(member => member.Pid == 0 || !ulong.TryParse(member.CreationTime, NumberStyles.None, CultureInfo.InvariantCulture, out _))
                        || request.Members.Select(member => member.Pid).Distinct().Count() != request.Members.Length
                        || !observations.TryAdd(request)) throw new HostFailure("control_protocol");
                }
            }
        }
        catch (Exception) { if (!finished) Stop("control_protocol"); }
    }
    private static void ObserveMembers(IntPtr originalJob, MemberObservation request, double elapsedMs)
    {
        var result = new List<object>();
        foreach (var member in request.Members) {
            string? reason = null; bool belongs = false;
            try {
                using var process = GuardianNative.OpenProcess(0x00100000 | 0x1000, false, member.Pid);
                if (originalJob == IntPtr.Zero) reason = "job_unavailable";
                else if (process.IsInvalid) reason = "process_unavailable";
                else if (!Native.GetProcessTimes(process.DangerousGetHandle(), out long creation, out _, out _, out _)) reason = "identity_unavailable";
                else if (creation.ToString(CultureInfo.InvariantCulture) != member.CreationTime) reason = "identity_changed";
                else if (Native.WaitForSingleObject(process.DangerousGetHandle(), 0) != 258) reason = "process_not_live";
                else if (!Native.IsProcessInJob(process.DangerousGetHandle(), originalJob, out belongs)) reason = "membership_unavailable";
            } catch { reason = "observation_failed"; }
            result.Add(reason is null
                ? new { member.Pid, member.CreationTime, status = "observed", jobMember = belongs }
                : (object)new { member.Pid, member.CreationTime, status = "unavailable", reason });
        }
        wire!.Send("job_members", new { request.RequestId, members = result, observedElapsedMs = elapsedMs });
    }
    private static string? ReadLineBounded(TextReader reader, int limit)
    {
        var line = new StringBuilder();
        for (;;)
        {
            int value = reader.Read();
            if (value < 0) { if (line.Length == 0) return null; throw new HostFailure("partial_control_frame"); }
            if (value == '\n') return line.ToString();
            if (line.Length >= limit || value == '\0') throw new HostFailure("control_frame_limit");
            line.Append((char)value);
        }
    }
    private static void Validate(Launch request)
    {
        if (request.Version != 1 || request.Kind != "launch" || !Guid.TryParseExact(request.Token, "D", out _)
            || request.Args is null || request.Env is null || request.Args.Length > 4096
            || !Path.IsPathFullyQualified(request.Executable) || !request.Executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(request.Executable) || !Path.IsPathFullyQualified(request.Cwd) || !Directory.Exists(request.Cwd)
            || request.TimeoutMs is < 1 or > 43_200_000 || request.CleanupTimeoutMs is < 1 or > 60_000
            || request.MaxOutputBytes is < 1 or > 67_108_864 || request.NormalExitGraceMs < 0 || request.NormalExitGraceMs > request.CleanupTimeoutMs
            || (request.NormalExitPolicy != "terminate-descendants" && request.NormalExitPolicy != "require-empty")
            || new[] { request.Executable, request.Cwd }.Concat(request.Args).Any(value => value is null || value.Contains('\0')))
            throw new HostFailure("invalid_request");
        _ = EnvironmentBlock(request.Env);
    }
    private static string EnvironmentBlock(Dictionary<string, string> input)
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in input)
        {
            if (string.IsNullOrEmpty(pair.Key) || pair.Key.Contains('=') || pair.Key.Contains('\0') || pair.Value is null
                || pair.Value.Contains('\0') || !values.TryAdd(pair.Key, pair.Value)) throw new HostFailure("invalid_environment");
        }
        if (!values.TryGetValue("SystemRoot", out string? systemRoot) || string.IsNullOrEmpty(systemRoot)) throw new HostFailure("system_root_required");
        return string.Join('\0', values.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
    }
    private static string Quote(string value)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static void Check(bool success, string code) { if (!success) throw new HostFailure(code, Marshal.GetLastWin32Error()); }
    private static void Close(ref IntPtr handle)
    { var old = handle; handle = IntPtr.Zero; if (old != IntPtr.Zero && old != new IntPtr(-1)) Native.CloseHandle(old); }
    private sealed class HostFailure(string code, int? nativeCode = null) : Exception
    { public string Code { get; } = code; public int? NativeCode { get; } = nativeCode; }
    private sealed class Launch
    {
        public int Version { get; init; } public string Kind { get; init; } = ""; public string Token { get; init; } = "";
        public string Executable { get; init; } = ""; public string[] Args { get; init; } = []; public string Cwd { get; init; } = "";
        public Dictionary<string, string> Env { get; init; } = []; public int TimeoutMs { get; init; }
        public int CleanupTimeoutMs { get; init; } public int MaxOutputBytes { get; init; }
        public string NormalExitPolicy { get; init; } = ""; public int NormalExitGraceMs { get; init; }
        public GuardianEnrollment? Guardian { get; init; }
        public string? InputBase64 { get; init; }
    }
    private sealed class Cancel { public int Version { get; init; } public string Kind { get; init; } = ""; public string Token { get; init; } = ""; }
    private sealed record MemberIdentity(uint Pid, string CreationTime);
    private sealed record MemberObservation(int Version, string Kind, string Token, string RequestId, MemberIdentity[] Members);
    private sealed class InputPump(IntPtr handle, byte[] input)
    {
        public volatile bool Closed;
        public void Start() => new Thread(Run) { IsBackground = true, Name = "artoo-fixed-input" }.Start();
        private void Run()
        {
            try {
                int offset = 0;
                while (offset < input.Length) {
                    byte[] chunk = input.AsSpan(offset, Math.Min(16384, input.Length - offset)).ToArray();
                    if (!Native.WriteFile(handle, chunk, (uint)chunk.Length, out uint written, IntPtr.Zero)
                        || written == 0 || written > chunk.Length) { Stop("input_write_failed"); return; }
                    offset += checked((int)written);
                }
            } catch (Exception) { Stop("input_write_failed"); }
            finally {
                if (Native.CloseHandle(handle)) Closed = true;
                else Stop("input_close_failed");
            }
        }
    }
    private sealed class PipePump(IntPtr handle, string stream, int maximum)
    {
        public volatile bool Eof;
        public volatile bool ObservedEof;
        public void Start() => new Thread(Run) { IsBackground = true, Name = "artoo-" + stream }.Start();
        private void Run()
        {
            try
            {
                byte[] buffer = new byte[16384];
                for (;;)
                {
                    if (!Native.ReadFile(handle, buffer, (uint)buffer.Length, out uint count, IntPtr.Zero))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 109) { ObservedEof = true; if (wire!.Send("pipe_eof", new { stream })) Eof = true; }
                        else Stop("pipe_read_failed");
                        return;
                    }
                    if (count == 0) continue;
                    long prior = Interlocked.Add(ref outputBytes, count) - count;
                    int take = (int)Math.Clamp(maximum - prior, 0, count);
                    if (take > 0)
                    {
                        Interlocked.Add(ref capturedBytes, take);
                        wire!.Send("output", new { stream, data = Convert.ToBase64String(buffer, 0, take) });
                    }
                    if (take != count) Stop("output_limit");
                    // Continue draining after limits/cancellation, even if output is no longer forwarded.
                }
            }
            catch (Exception) { Stop("pipe_read_failed"); }
        }
    }
    private sealed class FrameWriter
    {
        private readonly BlockingCollection<string> queue = new(64);
        private readonly object gate = new();
        private readonly Thread thread;
        private long sequence;
        private volatile bool failed;
        public FrameWriter()
        {
            thread = new Thread(() =>
            {
                try
                {
                    using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 4096, false) { AutoFlush = true };
                    foreach (string line in queue.GetConsumingEnumerable()) output.WriteLine(line);
                }
                catch (Exception) { failed = true; Stop("control_output_failed"); }
            }) { IsBackground = true, Name = "artoo-frames" };
            thread.Start();
        }
        public bool Send(string kind, object payload)
        {
            lock (gate)
            {
                if (failed || queue.IsAddingCompleted) { Stop("control_output_failed"); return false; }
                string frame = JsonSerializer.Serialize(new { version = 1, kind, token, sequence = sequence++, payload }, Json);
                if (!queue.TryAdd(frame)) { failed = true; Stop("control_backpressure"); return false; }
                return true;
            }
        }
        public bool Finish(int milliseconds)
        { lock (gate) queue.CompleteAdding(); return thread.Join(milliseconds) && !failed; }
    }
}

internal static class Native
{
    internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFO
    {
        public uint cb; public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION value, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern IntPtr CreateFileW(string path, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ReadFile(IntPtr file, byte[] buffer, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(IntPtr file, byte[] buffer, uint size, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
}
