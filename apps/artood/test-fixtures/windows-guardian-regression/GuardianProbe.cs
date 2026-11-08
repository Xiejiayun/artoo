// Test-only access to the actual live state, constructed through its normal authority checks.
using System.Collections;
using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Text.Json;

internal static class GuardianProbe
{
    private sealed record Outcome(bool Succeeded, string? Error, string? ErrorType);
    private sealed record Pending(Task<Outcome> Work, GuardianRequestTrace Trace, string BeforeRoster);
    private static Pending? pending;

    internal static int Run() {
        var input = GuardianWire.Decode<GuardianBootstrap>(GuardianWire.Input());
        Fixture.Require(input.SessionId.StartsWith("fixture-", StringComparison.Ordinal)
            && Guid.TryParseExact(input.SessionId[8..], "N", out _), "Dedicated fixture session required");
        // Do not dispose live state while its production Serve/ObserveDaemon tasks run.
        // The original Supervisor's shared Job owns the entire fixture process lifetime.
        var state = new GuardianState(input);
        using var self = new GuardianProcess((uint)Environment.ProcessId);
        var first = Fixture.Invoke<NamedPipeServerStream>(typeof(GuardianProgram), "CreatePipe", state.Endpoint.PipeName, self.Sid);
        _ = Fixture.Invoke<Task>(typeof(GuardianProgram), "Serve", state, self.Sid, first);
        Console.WriteLine(GuardianWire.Encode(new { version = 1, kind = "guardian_ready", payload = state.Initial }));
        Control(state, "artoo-regression-guardian-" + input.SessionId[8..]).GetAwaiter().GetResult();
        throw new InvalidOperationException("Guardian test control unexpectedly returned");
    }

    private static async Task Control(GuardianState state, string name) {
        for (;;) {
            using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync();
            using var limit = new CancellationTokenSource(12000);
            using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            string? id = null;
            try {
                var input = GuardianWire.Decode<JsonElement>(await GuardianWire.ReadLine(reader, limit.Token));
                id = input.GetProperty("id").GetString(); Fixture.Require(GuardianWire.Uuid(id), "Invalid fixture correlation");
                var result = await Command(state, input.GetProperty("command"));
                await writer.WriteLineAsync(GuardianWire.Encode(new { id, ok = true, result }).AsMemory(), limit.Token);
            } catch (Exception error) {
                await writer.WriteLineAsync(GuardianWire.Encode(new { id, ok = false, error = error.Message }).AsMemory(), limit.Token);
            }
        }
    }

    private static string Roster(GuardianState state) => GuardianWire.Encode(Fixture.Property(state, "Epoch"));
    private static IDictionary Slots(GuardianState state) => (IDictionary)Fixture.Field(state, "slots");
    private static object SlotField(object slot, string name) => slot.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
        ?.GetValue(slot) ?? throw new InvalidOperationException("Required real slot field absent: " + name);
    private static async Task<object> Command(GuardianState state, JsonElement command) {
        string? kind = command.GetProperty("kind").GetString(); object gate = Fixture.Field(state, "gate");
        if (kind == "wire-evidence") {
            string digest = command.GetProperty("nonceDigest").GetString()!;
            Fixture.Require(GuardianWire.Hash(digest), "Exact wire nonce digest required");
            var configuration = (GuardianBootstrap)Fixture.Field(state, "configuration");
            string path = Path.Combine(configuration.ControlDirectory, "guardian-diagnostic-v1.ndjson");
            // Watch concrete diagnostic publication; a delay or an absent log is
            // never accepted as a rejection/closure result. No state gate is held.
            using var changed = new SemaphoreSlim(0);
            using var watcher = new FileSystemWatcher(configuration.ControlDirectory, "guardian-diagnostic-v1.ndjson")
                { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size };
            FileSystemEventHandler notify = (_, _) => { try { changed.Release(); } catch (ObjectDisposedException) { /* A final queued event raced disposal. */ } };
            watcher.Created += notify; watcher.Changed += notify; watcher.EnableRaisingEvents = true;
            using var deadline = new CancellationTokenSource(3000);
            for (;;) {
                if (File.Exists(path)) {
                    using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    Fixture.Require(file.Length <= 65536, "Production diagnostic file exceeded its bound");
                    using var reader = new StreamReader(file, new UTF8Encoding(false, true));
                    string text = await reader.ReadToEndAsync(deadline.Token); int end = text.LastIndexOf('\n');
                    if (end >= 0) foreach (string line in text[..end].Split('\n', StringSplitOptions.RemoveEmptyEntries)) {
                        var row = GuardianWire.Decode<JsonElement>(line);
                        if (row.GetProperty("kind").GetString() != "guardian_request_failure_diagnostic"
                            || row.GetProperty("request").GetProperty("nonceDigest").GetString() != digest) continue;
                        // Prefer the actual Handle or parser rejection. A subsequent
                        // reply-write cancellation alone cannot explain the cause.
                        string? phase = row.GetProperty("facts").GetProperty("phase").GetString();
                        if (phase is "guardian_request_handle" or "guardian_client_read") return row.Clone();
                    }
                }
                await changed.WaitAsync(deadline.Token);
            }
        }
        if (kind == "begin") {
            Fixture.Require(pending is null, "The previous original request must settle first");
            uint pid = command.GetProperty("peerPid").GetUInt32();
            var peer = new GuardianProcess(pid);
            GuardianRequestBudget? budget = null;
            try {
                // This is a real daemon child with the real relay mode, not a forged identity.
                Fixture.Require(peer.HasNativeMode("--guardian-client-v1") && !peer.Exited, "Expected the original held relay process");
                int milliseconds = command.GetProperty("budgetMs").GetInt32();
                Fixture.Require(milliseconds is >= 250 and <= 5000, "Bounded test budget required");
                string operation = command.GetProperty("operation").GetString()!;
                Fixture.Require(operation is "pending-qualification" or "changed-original-owner", "Unknown test operation");
                GuardianRequest request; string before;
                using (var read = new GuardianRequestBudget(5000)) using (read.Enter(gate)) {
                    before = Roster(state);
                    request = new() { Version = 1, Kind = "reserve", Nonce = Guid.NewGuid().ToString("D"),
                        EpochId = (string)Fixture.Field(state, "epochId"), SessionId = (string)Fixture.Field(state, "sessionId"),
                        OperationKind = "observer", OperationId = operation, BindingDigest = Fixture.Hash(operation) };
                }
                budget = new GuardianRequestBudget(milliseconds); var originalBudget = budget;
                var trace = new GuardianRequestTrace(request);
                var work = Task.Run(() => {
                    try { state.Handle(peer, request, originalBudget, trace); return new Outcome(true, null, null); }
                    catch (Exception error) { return new Outcome(false, error.Message, error.GetType().Name); }
                    finally { originalBudget.Dispose(); peer.Dispose(); }
                });
                // Ownership has moved to the tracked task. Never abandon/retry it.
                budget = null; pending = new(work, trace, before);
                Fixture.Require(SpinWait.SpinUntil(() => Volatile.Read(ref trace.Stage) == "supervisor_qualification" || work.IsCompleted, 1500),
                    "Production qualification stage was not observed");
                Fixture.Require(!work.IsCompleted && Volatile.Read(ref trace.Stage) == "supervisor_qualification", "Production qualification was not pending");
                return new { qualificationPending = true, stage = trace.Stage, originalPeer = peer.Identity };
            } catch {
                if (pending is null) { budget?.Dispose(); peer.Dispose(); }
                throw;
            }
        }
        if (kind == "result") {
            var current = pending ?? throw new InvalidOperationException("No original pending request");
            Outcome result = await current.Work.WaitAsync(TimeSpan.FromSeconds(8));
            using var read = new GuardianRequestBudget(5000); using var held = read.Enter(gate);
            var response = new { succeeded = result.Succeeded, error = result.Error, errorType = result.ErrorType, mutationStarted = current.Trace.MutationStarted,
                mutationRecorded = current.Trace.MutationRecorded, stage = current.Trace.Stage,
                sameRoster = current.BeforeRoster == Roster(state), slotCount = Slots(state).Count };
            pending = null; return response;
        }
        using var budgetForInspection = new GuardianRequestBudget(5000);
        using (budgetForInspection.Enter(gate)) {
            if (kind == "inspect-roster") return new { slotCount = Slots(state).Count, epoch = Fixture.Property(state, "Epoch") };
            if (kind == "inspect-host") {
                var rows = Slots(state).Values.Cast<object>().Where(slot => (string)SlotField(slot, "Operation") == "fixture-host").ToArray();
                Fixture.Require(rows.Length == 1, "Expected one original registered host"); var slot = rows[0];
                var host = (GuardianProcess)SlotField(slot, "Host"); var root = (GuardianProcess)SlotField(slot, "Root");
                return new { terminal = SlotField(slot, "Terminal") is GuardianTerminal, ackReceived = (bool)SlotField(slot, "AckReceived"),
                    hostExited = host.Exited, rootExited = root.Exited,
                    qualificationPending = pending is not null && !pending.Work.IsCompleted
                        && Volatile.Read(ref pending.Trace.Stage) == "supervisor_qualification" };
            }
            if (kind == "replace-daemon-owner") {
                Fixture.Require(pending is not null && !pending.Work.IsCompleted
                    && Volatile.Read(ref pending.Trace.Stage) == "supervisor_qualification", "Identity change requires an actual pending qualification");
                var original = (GuardianProcess)Fixture.Field(state, "daemon"); var replacement = new GuardianProcess(original.Pid);
                Fixture.Require(replacement.Same(original) && !replacement.Exited, "Replacement fixture owner must describe the same live process");
                IntPtr handle = original.Handle.DangerousGetHandle(); long creation = original.CreationTime;
                var field = typeof(GuardianState).GetField("daemon", BindingFlags.Instance | BindingFlags.NonPublic)!;
                field.SetValue(state, replacement); original.Dispose();
                // The in-flight production RelaySnapshot must still retain the old HANDLE.
                bool waited = Native.WaitForSingleObject(handle, 0) == 258
                    && Native.GetProcessTimes(handle, out long stillCreation, out _, out _, out _) && stillCreation == creation;
                return new { sameProcessIdentity = replacement.Same(original), originalOwnerDisposed = original.Handle.IsClosed,
                    originalHandleStillWaitable = waited };
            }
            throw new InvalidOperationException("Unknown fixed Guardian fixture operation");
        }
    }
}
