// Dedicated test assembly only. No test mode or hook is compiled into the product.
using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal sealed record HarnessConfiguration(int Version, string SessionId, string DaemonPipe, string GuardianPipe,
    string TargetEvent, string Workspace, string Store, string Control, string Executable);

internal static class Fixture
{
    internal static void Require(bool condition, string message) {
        if (!condition) throw new InvalidOperationException(message);
    }
    internal static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, GuardianWire.Json);
    internal static string Hash(string value) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    internal static object Field(object value, string name) => value.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
        ?.GetValue(value) ?? throw new InvalidOperationException("Missing production field: " + name);
    internal static object Property(object value, string name) => value.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.NonPublic)
        ?.GetValue(value) ?? throw new InvalidOperationException("Missing production property: " + name);
    internal static T Invoke<T>(Type type, string method, params object?[] values) {
        var target = type.GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Missing production method: " + method);
        try { return (T)target.Invoke(null, values)!; }
        catch (TargetInvocationException error) { throw error.InnerException ?? error; }
    }
    internal static async Task<JsonElement> Call(string pipe, object command, int milliseconds = 12000) {
        using var limit = new CancellationTokenSource(milliseconds);
        using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(limit.Token);
        using var reader = new StreamReader(client, new UTF8Encoding(false, true), false, 4096, true);
        using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        string id = Guid.NewGuid().ToString("D");
        await writer.WriteLineAsync(GuardianWire.Encode(new { id, command }).AsMemory(), limit.Token);
        var response = GuardianWire.Decode<JsonElement>(await GuardianWire.ReadLine(reader, limit.Token));
        Require(response.GetProperty("id").GetString() == id, "Fixture reply correlation changed");
        Require(response.GetProperty("ok").GetBoolean(), response.TryGetProperty("error", out var error)
            ? "Fixture command rejected: " + error.GetString() : "Fixture command rejected");
        return response.GetProperty("result").Clone();
    }
    internal static SupervisorFilePin Pin(string path) {
        path = Path.GetFullPath(path); byte[] bytes = File.ReadAllBytes(path);
        return new(path, bytes.LongLength, "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }
    internal static Dictionary<string, string> EnvironmentBlock() {
        string root = Environment.GetEnvironmentVariable("SystemRoot") ?? throw new InvalidOperationException("SystemRoot required");
        return new(StringComparer.OrdinalIgnoreCase) { ["SystemRoot"] = root, ["WINDIR"] = root, ["PATH"] = Path.Combine(root, "System32") };
    }
    internal static void AssertClosure(JsonElement summary) {
        var closure = summary.GetProperty("lifetimeClosure");
        foreach (string field in new[] { "jobCreated", "allRootsWaitObserved", "jobEmptyObserved", "allStdoutEof", "allStderrEof", "cleanupConfirmed" })
            Require(closure.GetProperty(field).GetBoolean(), "Original Supervisor closure missing: " + field);
        Require(summary.GetProperty("incarnations").GetArrayLength() == 1, "Unexpected fixture daemon incarnation");
        var daemon = summary.GetProperty("incarnations")[0];
        foreach (string field in new[] { "rootWaitObserved", "stdoutEof", "stderrEof", "atomicJobMember" })
            Require(daemon.GetProperty(field).GetBoolean(), "Original daemon closure missing: " + field);
    }
}

/** An explicit entered/released barrier on the real Supervisor gate. It cannot
 * outlive its owner silently: Dispose releases it and joins the original thread. */
internal sealed class GateBarrier : IDisposable
{
    private readonly ManualResetEventSlim entered = new(false), release = new(false);
    private readonly Thread owner;
    private Exception? failure;
    internal bool IsHeld => entered.IsSet && !release.IsSet;
    internal GateBarrier(object gate) {
        owner = new Thread(() => {
            try { lock (gate) { entered.Set(); Fixture.Require(release.Wait(15000), "Supervisor test barrier expired"); } }
            catch (Exception error) { failure = error; entered.Set(); }
        }) { IsBackground = true, Name = "guardian-regression-supervisor-gate" };
        owner.Start();
        if (!entered.Wait(3000)) { release.Set(); throw new InvalidOperationException("Supervisor gate barrier was not entered"); }
        if (failure is not null) throw failure;
    }
    public void Dispose() {
        release.Set(); Fixture.Require(owner.Join(5000), "Supervisor gate barrier did not release");
        entered.Dispose(); release.Dispose(); if (failure is not null) throw failure;
    }
}

internal static class GuardianRegressionProgram
{
    private const string RawWireSelector = "ARTOO_GUARDIAN_REGRESSION_RAW_WIRE";
    public static int Main(string[] args) {
        try {
            string? wireMode = Environment.GetEnvironmentVariable(RawWireSelector);
            // Ordinary relays must let the production entry consume the original
            // stdin. Resetting InputEncoding inside MainRelay invalidates a replay
            // Console.In; no fixture parsing or Console.SetIn precedes this call.
            if (args is ["--guardian-client-v1"] && wireMode is null) return Program.Main(args);
            Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
            Fixture.Require(OperatingSystem.IsWindowsVersionAtLeast(10) && Environment.Is64BitProcess, "Native x64 Windows is required; no skip");
            if (args is ["--daemon-supervisor-v1"]) return RunSupervisor();
            if (args is ["--guardian-v1"]) return GuardianProbe.Run();
            if (args is ["--guardian-client-v1"]) {
                Fixture.Require(wireMode == "v1", "Unknown test-assembly raw-wire selector");
                return RunWireProbe().GetAwaiter().GetResult();
            }
            if (args is ["--fixture-target", var eventName]) {
                using var release = EventWaitHandle.OpenExisting(eventName);
                Fixture.Require(release.WaitOne(15000), "Target release event was not observed");
                Console.Out.WriteLine("fixture target completed"); Console.Error.WriteLine("fixture target stderr completed"); return 0;
            }
            if (args is ["--run", var node, var output]) return RunParent(node, output).GetAwaiter().GetResult();
            return Program.Main(args); // Production relay, qualifier and stdio execution.
        } catch (Exception error) {
            Console.Error.WriteLine(GuardianWire.Encode(new { kind = "harness_error", type = error.GetType().Name, message = error.Message })); return 2;
        }
    }

    private static async Task<int> RunWireProbe() {
        // Only this test assembly recognizes the explicit worker-only selector.
        // Raw compatibility probes retain the required single native mode argv.
        string phase = "input", scenario = "unknown";
        string? requestNonceDigest = null;
        bool resultEmitted = false;
        SafePipeHandle? originalPipeHandle = null;
        SafeProcessHandle? originalGuardianHandle = null;
        try {
        var input = GuardianWire.Decode<JsonElement>(GuardianWire.Input());
        string selected = input.GetProperty("fixtureWireCase").GetString()!;
        Fixture.Require(selected is "legacy-success" or "legacy-timeout" or "expired" or "unknown-version" or "negative" or "distant-future",
            "Unknown fixed wire case");
        scenario = selected;
        var endpoint = GuardianWire.Decode<GuardianEndpoint>(input.GetProperty("endpoint").GetRawText());
        string nonce = Guid.NewGuid().ToString("D"); long now = Environment.TickCount64;
        requestNonceDigest = GuardianWire.Digest(nonce);
        var request = new GuardianRequest { Version = 1, Kind = scenario == "legacy-success" ? "status" : "reserve", Nonce = nonce,
            EpochId = input.GetProperty("epochId").GetString(), SessionId = input.GetProperty("sessionId").GetString(),
            OperationKind = "observer", OperationId = "wire-" + scenario, BindingDigest = Fixture.Hash("wire-" + scenario),
            Deadline = scenario switch {
                "expired" => new(1, Math.Max(0, now - 1)), "unknown-version" => new(2, checked(now + 2500)),
                "negative" => new(1, -1), "distant-future" => new(1, long.MaxValue), _ => null } };
        // The production constructor still authenticates the exact Guardian and
        // bundle. Only Send's automatic deadline insertion is intentionally bypassed
        // for wire compatibility cases; the real server Client/Decode/Handle remains.
        phase = "connect";
        var connection = new GuardianConnection(endpoint);
        try {
        phase = "inspect_connection";
        // Retain these exact managed owner objects only: do not duplicate, reopen,
        // AddRef or independently dispose their original native handles.
        originalPipeHandle = ((NamedPipeClientStream)Fixture.Field(connection, "pipe")).SafePipeHandle;
        originalGuardianHandle = ((GuardianProcess)Fixture.Field(connection, "guardian")).Handle;
        var reader = (StreamReader)Fixture.Field(connection, "reader");
        var writer = (StreamWriter)Fixture.Field(connection, "writer");
        using var limit = new CancellationTokenSource(8000);
        long begun = Environment.TickCount64; string? replyKind = null, transportError = null;
        bool peerClosed = false, clientTimeout = false, nonceBound = false;
        string encoded = GuardianWire.Encode(request);
        bool deadlineIncluded = GuardianWire.Decode<JsonElement>(encoded).TryGetProperty("deadline", out _);
        Fixture.Require(deadlineIncluded == (scenario is not "legacy-success" and not "legacy-timeout"), "Unexpected legacy deadline field");
        phase = "write_request";
        await writer.WriteLineAsync(encoded.AsMemory(), limit.Token);
        phase = "read_response";
        try {
            var response = GuardianWire.Decode<JsonElement>(await GuardianWire.ReadLine(reader, limit.Token));
            nonceBound = response.GetProperty("version").GetInt32() == 1 && response.GetProperty("nonce").GetString() == nonce;
            Fixture.Require(nonceBound, "Raw wire reply did not bind the original request"); replyKind = response.GetProperty("kind").GetString();
            Fixture.Require(replyKind is "ok" or "error", "Unexpected raw wire response kind");
        } catch (OperationCanceledException) { clientTimeout = true; }
        catch (IOException error) { peerClosed = error.Message == "guardian_peer_eof"; transportError = error.Message; }
        phase = "emit_result";
        Console.WriteLine(GuardianWire.Encode(new { kind = "fixture_wire_result", payload = new { scenario,
            nonceDigest = requestNonceDigest, elapsedMs = Environment.TickCount64 - begun,
            replyKind, nonceBound, peerClosed, clientTimeout, transportError, deadlineIncluded } }));
        resultEmitted = true;
        return 0;
        } finally {
            // Same original Dispose call/order as the former using declaration.
            // Mark this exact call without suppressing any disposal exception.
            string previousPhase = phase; phase = "connection_dispose";
            connection.Dispose(); phase = previousPhase;
        }
        } catch (Exception error) {
            var facts = NativeFailureDiagnostic.Capture("unknown_phase", error);
            // This executes in the original helper after the original Dispose
            // threw and before Main returns its unchanged failure exit code.
            object? originalHandles = phase == "connection_dispose" && originalPipeHandle is not null && originalGuardianHandle is not null
                ? new { pipeClosed = originalPipeHandle.IsClosed, guardianClosed = originalGuardianHandle.IsClosed, observedBeforeExit = true }
                : null;
            try { Console.Error.WriteLine(GuardianWire.Encode(new { version = 1, kind = "fixture_wire_failure", payload = new {
                scenario, nonceDigest = requestNonceDigest, resultEmitted, phase,
                exceptionType = error.GetType().Name, code = facts.Code, nativeError = facts.NativeError, originalHandles } })); }
            catch { /* Supplementary reporting cannot replace the original exception rethrown below. */ }
            throw;
        }
    }

    private static int RunSupervisor() {
        var frames = new SupervisorFrames(); DaemonSupervisorState? state = null;
        using var cancellation = new CancellationTokenSource();
        object[] cases = []; string? failure = null; JsonElement summary = JsonSerializer.SerializeToElement<object?>(null); bool closure = false;
        try {
            var launch = GuardianWire.Decode<SupervisorLaunch>(GuardianWire.Input());
            Fixture.Require(launch.LifetimeOwnership is not null, "The test requires the original shared lifetime Job");
            state = new DaemonSupervisorState(launch, frames);
            var first = SupervisorProtocol.CreatePipe(state.PipeName, state.Sid, true);
            _ = Fixture.Invoke<Task>(typeof(DaemonSupervisorProgram), "Serve", state, first, cancellation.Token);
            state.Ready(); state.Start();
            var configuration = GuardianWire.Decode<HarnessConfiguration>(File.ReadAllText(launch.Configuration.Path));
            Fixture.Require(configuration.Version == 1 && configuration.Executable == Environment.ProcessPath, "Fixture configuration binding changed");
            cases = RunCases(state, configuration).GetAwaiter().GetResult();
        } catch (Exception error) { failure = error.GetType().Name + ": " + error.Message; }
        finally {
            if (state is not null) {
                try {
                    // Use the production lifetime/closure decisions, never a fixture copy.
                    closure = state.CleanupLifetime(); summary = Fixture.Json(state.Summary);
                    Fixture.Require(closure, "Production Supervisor did not confirm shared Job cleanup"); Fixture.AssertClosure(summary);
                } catch (Exception error) { failure ??= error.GetType().Name + ": " + error.Message; }
            }
            cancellation.Cancel();
            frames.Terminal(failure is null ? "supervisor_stopped" : "supervisor_failed", new { reason = "controlled-regression", facts = summary });
            if (!frames.Finish()) failure ??= "Supervisor control frames did not finish";
            state?.Dispose();
        }
        Console.WriteLine(GuardianWire.Encode(new { kind = "harness_result", version = 1, passed = failure is null && closure,
            cases, originalSupervisorClosure = summary, failure }));
        return failure is null && closure ? 0 : 2;
    }

    private static async Task<object[]> RunCases(DaemonSupervisorState state, HarnessConfiguration config) {
        await Fixture.Call(config.DaemonPipe, new { kind = "bootstrap" });
        await Fixture.Call(config.DaemonPipe, new { kind = "activate" });
        await Fixture.Call(config.DaemonPipe, new { kind = "start-host" });
        object supervisorGate = Fixture.Field(state, "gate");
        var cases = new List<object>();

        // The first request really reaches the original Handle/Require path while
        // the Supervisor's original gate is held. The host then closes before release.
        var peer = await Fixture.Call(config.DaemonPipe, new { kind = "held-relay" });
        JsonElement hostClose, expired;
        using (var barrier = new GateBarrier(supervisorGate)) {
            var entered = await Fixture.Call(config.GuardianPipe, new { kind = "begin", peerPid = peer.GetProperty("pid").GetUInt32(),
                operation = "pending-qualification", budgetMs = 2500 });
            Fixture.Require(entered.GetProperty("qualificationPending").GetBoolean(), "Original qualification was not observed pending");
            Fixture.Require(barrier.IsHeld, "Qualification barrier released early");
            using (var target = EventWaitHandle.OpenExisting(config.TargetEvent)) target.Set();
            hostClose = await Fixture.Call(config.DaemonPipe, new { kind = "finish-host" });
            var hostState = await Fixture.Call(config.GuardianPipe, new { kind = "inspect-host" });
            Fixture.Require(barrier.IsHeld, "Host terminal was observed only after qualification resumed");
            Fixture.Require(hostState.GetProperty("qualificationPending").GetBoolean(), "Host closed only after the pending request had already failed");
            foreach (string field in new[] { "terminal", "ackReceived", "hostExited", "rootExited" })
                Fixture.Require(hostState.GetProperty(field).GetBoolean(), "Original host state did not close: " + field);
            expired = await Fixture.Call(config.GuardianPipe, new { kind = "result" });
            Fixture.Require(!expired.GetProperty("succeeded").GetBoolean(), "Blocked qualification unexpectedly admitted a reservation");
            Fixture.Require(expired.GetProperty("errorType").GetString() is "OperationCanceledException" or "TaskCanceledException" or "TimeoutException",
                "Reservation failed for a reason other than its original deadline");
            Fixture.Require(!expired.GetProperty("mutationStarted").GetBoolean(), "Expired qualification started a reservation");
            Fixture.Require(expired.GetProperty("sameRoster").GetBoolean(), "Expired qualification changed the authoritative roster");
        }
        // Releasing the Supervisor cannot revive the already completed request.
        var after = await Fixture.Call(config.GuardianPipe, new { kind = "inspect-roster" });
        Fixture.Require(after.GetProperty("slotCount").GetInt32() == 1, "A reservation committed after its original request completed");
        await Fixture.Call(config.DaemonPipe, new { kind = "close-held-relay" });
        cases.Add(new { name = "host-terminal-during-pending-qualification", qualificationBarrierHeld = true, host = hostClose });
        cases.Add(new { name = "expired-reservation-never-commits-after-unblock", request = expired, after });

        // A fresh request fully qualifies, but the Guardian's original owner object
        // is replaced while it waits. PID/creation equality must not bypass the snapshot.
        peer = await Fixture.Call(config.DaemonPipe, new { kind = "held-relay" });
        JsonElement identityChange;
        using (var barrier = new GateBarrier(supervisorGate)) {
            var entered = await Fixture.Call(config.GuardianPipe, new { kind = "begin", peerPid = peer.GetProperty("pid").GetUInt32(),
                operation = "changed-original-owner", budgetMs = 5000 });
            Fixture.Require(entered.GetProperty("qualificationPending").GetBoolean(), "Identity case did not reach original qualification");
            identityChange = await Fixture.Call(config.GuardianPipe, new { kind = "replace-daemon-owner" });
            Fixture.Require(identityChange.GetProperty("sameProcessIdentity").GetBoolean(), "Fixture replaced the wrong daemon");
            Fixture.Require(identityChange.GetProperty("originalHandleStillWaitable").GetBoolean(), "Snapshot did not retain the original native HANDLE");
        }
        var rejected = await Fixture.Call(config.GuardianPipe, new { kind = "result" });
        Fixture.Require(!rejected.GetProperty("succeeded").GetBoolean() && !rejected.GetProperty("mutationStarted").GetBoolean(), "Changed original owner admitted a reservation");
        Fixture.Require(rejected.GetProperty("error").GetString() == "guardian_relay_parent", "Identity case did not reach the production snapshot rejection");
        Fixture.Require(rejected.GetProperty("stage").GetString() == "commit_gate", "Identity case failed before full qualification returned");
        Fixture.Require(rejected.GetProperty("sameRoster").GetBoolean(), "Identity rejection changed the roster");
        await Fixture.Call(config.DaemonPipe, new { kind = "close-held-relay" });
        cases.Add(new { name = "original-owner-invalidated-after-snapshot", identityChange, request = rejected });
        cases.AddRange(await RunWireCases(supervisorGate, config));
        return cases.ToArray();
    }

    // Validate the actual raw helper's outcome, not the server rejection itself.
    // Server nonce/cause/no-mutation, post-release roster and Supervisor closure
    // remain separate mandatory assertions below; an exit-2 child is still failed.
    private static void AssertWireHelper(JsonElement wire, string scenario) {
        bool negative = scenario is "legacy-timeout" or "expired" or "unknown-version" or "negative" or "distant-future";
        Fixture.Require(negative || scenario == "legacy-success", "Unknown raw wire outcome scenario");
        Fixture.Require(wire.GetProperty("scenario").GetString() == scenario, "Raw helper scenario changed");
        string nonceDigest = wire.GetProperty("nonceDigest").GetString() ?? "";
        Fixture.Require(GuardianWire.Hash(nonceDigest), "Raw helper request nonce digest is missing");
        Fixture.Require(wire.GetProperty("elapsedMs").GetInt64() is >= 0 and <= 60000, "Invalid raw helper elapsed clock");
        Fixture.Require(wire.GetProperty("deadlineIncluded").GetBoolean() == (scenario is not "legacy-success" and not "legacy-timeout"),
            "Raw helper deadline shape changed");
        Fixture.Require(!wire.GetProperty("clientTimeout").GetBoolean(), "Client timeout cannot establish server rejection");
        string? replyKind = wire.GetProperty("replyKind").GetString();
        bool replied = (replyKind is "ok" or "error") && wire.GetProperty("nonceBound").GetBoolean()
            && !wire.GetProperty("peerClosed").GetBoolean() && wire.GetProperty("transportError").ValueKind == JsonValueKind.Null;
        bool peerEof = replyKind is null && !wire.GetProperty("nonceBound").GetBoolean()
            && wire.GetProperty("peerClosed").GetBoolean() && wire.GetProperty("transportError").GetString() == "guardian_peer_eof";
        Fixture.Require(negative ? (replied && replyKind == "error") || peerEof : replied && replyKind == "ok",
            "Raw helper did not report the expected bound reply or exact peer EOF");
        var closed = wire.GetProperty("closed");
        foreach (string field in new[] { "spawnObserved", "exitObserved", "closeObserved", "stdoutEof", "stderrEof" })
            Fixture.Require(closed.GetProperty(field).GetBoolean(), "Actual raw helper closure missing: " + field);
        Fixture.Require(closed.GetProperty("signal").ValueKind == JsonValueKind.Null, "Raw helper ended by signal");
        var failures = wire.GetProperty("failures");
        Fixture.Require(!failures.GetProperty("wireFailureRejected").GetBoolean() && failures.GetProperty("native").GetArrayLength() == 0,
            "Unexpected or invalid raw helper failure diagnostic");
        var rejected = failures.GetProperty("wire"); int exitCode = closed.GetProperty("code").GetInt32();
        if (exitCode == 0) {
            Fixture.Require(rejected.GetArrayLength() == 0 && failures.GetProperty("wireFailureFrames").GetInt32() == 0,
                "A zero-exit raw helper reported a failure");
            return;
        }
        Fixture.Require(negative && exitCode == 2 && peerEof, "Only a fixed negative probe's exact peer-EOF failure is expected");
        Fixture.Require(rejected.GetArrayLength() == 1 && failures.GetProperty("wireFailureFrames").GetInt32() == 1,
            "Exactly one original Dispose failure is required");
        var error = rejected[0];
        Fixture.Require(error.GetProperty("scenario").GetString() == scenario && error.GetProperty("nonceDigest").GetString() == nonceDigest
            && error.GetProperty("resultEmitted").GetBoolean(), "Dispose failure was not bound to the completely emitted raw result");
        Fixture.Require(error.GetProperty("phase").GetString() == "connection_dispose" && error.GetProperty("exceptionType").GetString() == "IOException"
            && error.GetProperty("code").GetString() == "io_error" && error.GetProperty("nativeError").ValueKind == JsonValueKind.Null,
            "Unexpected raw helper failure type or stage");
        var handles = error.GetProperty("originalHandles");
        foreach (string field in new[] { "pipeClosed", "guardianClosed", "observedBeforeExit" })
            Fixture.Require(handles.GetProperty(field).GetBoolean(), "Original managed owner was not closed before helper exit: " + field);
        // The real r3 false/false observation must fail above. IsClosed is only
        // managed ownership evidence, never a replacement for original Job/HANDLE/EOF.
    }

    private static async Task<object[]> RunWireCases(object supervisorGate, HarnessConfiguration config) {
        var results = new List<object>();
        var legacy = await Fixture.Call(config.DaemonPipe, new { kind = "wire-case", scenario = "legacy-success" });
        AssertWireHelper(legacy, "legacy-success");
        Fixture.Require(legacy.GetProperty("replyKind").GetString() == "ok" && legacy.GetProperty("nonceBound").GetBoolean()
            && !legacy.GetProperty("clientTimeout").GetBoolean(), "A valid old request without deadline was rejected");
        results.Add(new { name = "wire-legacy-request-without-deadline", wire = legacy });
        foreach (string scenario in new[] { "legacy-timeout", "expired", "unknown-version", "negative", "distant-future" }) {
            var before = await Fixture.Call(config.GuardianPipe, new { kind = "inspect-roster" });
            JsonElement wire, evidence;
            using (var barrier = new GateBarrier(supervisorGate)) {
                wire = await Fixture.Call(config.DaemonPipe, new { kind = "wire-case", scenario });
                AssertWireHelper(wire, scenario);
                Fixture.Require(barrier.IsHeld, "Wire request completed only after Supervisor qualification resumed");
                Fixture.Require(!wire.GetProperty("clientTimeout").GetBoolean(), "Client timeout cannot establish server rejection");
                Fixture.Require(wire.GetProperty("replyKind").GetString() == "error" || wire.GetProperty("peerClosed").GetBoolean(),
                    "Invalid or expired wire request was not rejected by the server");
                evidence = await Fixture.Call(config.GuardianPipe, new { kind = "wire-evidence", nonceDigest = wire.GetProperty("nonceDigest").GetString() });
                Fixture.Require(evidence.GetProperty("kind").GetString() == "guardian_request_failure_diagnostic"
                    && evidence.GetProperty("request").GetProperty("nonceDigest").GetString() == wire.GetProperty("nonceDigest").GetString()
                    && (evidence.GetProperty("facts").GetProperty("phase").GetString() is "guardian_request_handle" or "guardian_client_read"),
                    "Server rejection diagnostic did not bind the same original raw request");
                Fixture.Require(!evidence.GetProperty("request").GetProperty("mutationStarted").GetBoolean(), "Rejected wire request started a mutation");
                string? code = evidence.GetProperty("facts").GetProperty("code").GetString();
                Fixture.Require(scenario is "unknown-version" or "negative" ? code == "guardian_request" : code is "timeout" or "operation_cancelled",
                    "Wire request failed for a reason other than the tested deadline contract");
                if (scenario is "legacy-timeout" or "distant-future") {
                    long elapsed = evidence.GetProperty("request").GetProperty("elapsedMs").GetInt64();
                    // This is the real server diagnostic clock, not the helper's
                    // eight-second failure guard or a fixture sleep assumption.
                    Fixture.Require(elapsed is >= 2000 and <= 3500 && wire.GetProperty("elapsedMs").GetInt64() <= 4000,
                        "The server did not enforce its own 2.5-second processing maximum");
                    Fixture.Require(evidence.GetProperty("request").GetProperty("stage").GetString() == "supervisor_qualification",
                        "The server did not actually wait in full qualification");
                }
            }
            var after = await Fixture.Call(config.GuardianPipe, new { kind = "inspect-roster" });
            Fixture.Require(before.GetRawText() == after.GetRawText(), "Rejected wire request changed the original native roster");
            results.Add(new { name = "wire-" + scenario, wire, evidence, unchangedRoster = true });
        }
        return results.ToArray();
    }

    private static async Task<int> RunParent(string node, string output) {
        Fixture.Require(Path.IsPathFullyQualified(node) && Path.IsPathFullyQualified(output), "Use absolute node.exe and output paths");
        Fixture.Require(!Directory.Exists(output) && !File.Exists(output), "Preserve existing output; choose a fresh directory");
        Directory.CreateDirectory(output);
        string token = Guid.NewGuid().ToString("N"), self = Environment.ProcessPath!;
        var config = new HarnessConfiguration(1, "fixture-" + token, "artoo-regression-daemon-" + token,
            "artoo-regression-guardian-" + token, "Local\\artoo-regression-target-" + token,
            Path.Combine(output, "workspace"), Path.Combine(output, "store"), Path.Combine(output, "control"), self);
        Directory.CreateDirectory(config.Workspace); Directory.CreateDirectory(config.Store); Directory.CreateDirectory(config.Control);
        string configurationPath = Path.Combine(output, "fixture.json"), worker = Path.Combine(AppContext.BaseDirectory, "daemon.mjs");
        File.WriteAllText(configurationPath, GuardianWire.Encode(config), new UTF8Encoding(false));
        using var target = new EventWaitHandle(false, EventResetMode.ManualReset, config.TargetEvent, out bool created);
        Fixture.Require(created, "Fixture target event already exists");
        var start = new ProcessStartInfo(self) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--daemon-supervisor-v1"); start.Environment.Clear();
        foreach (var pair in Fixture.EnvironmentBlock()) start.Environment[pair.Key] = pair.Value;
        var launch = new SupervisorLaunch(1, "launch", Fixture.Pin(node), Fixture.Pin(worker), Fixture.Pin(configurationPath), output,
            [configurationPath], Fixture.EnvironmentBlock(), 0, 0, 60000, 2 * 1024 * 1024, new(1, 10000, 5000));
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Supervisor did not start");
        try {
        // Process owns the original HANDLE; retain it before any PID can be reused.
        IntPtr originalHandle = child.Handle;
        Fixture.Require(Native.GetProcessTimes(originalHandle, out long creation, out _, out _, out _), "Original Supervisor creation time unavailable");
        var stdout = ReadBounded(child.StandardOutput, 4 * 1024 * 1024);
        var stderr = ReadBounded(child.StandardError, 256 * 1024);
        await child.StandardInput.WriteLineAsync(GuardianWire.Encode(launch));
        await Task.WhenAll(child.WaitForExitAsync(), stdout, stderr).WaitAsync(TimeSpan.FromSeconds(60));
        Fixture.Require(Native.WaitForSingleObject(originalHandle, 0) == 0, "Original Supervisor HANDLE was not signalled");
        var results = stdout.Result.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(GuardianWire.Decode<JsonElement>)
            .Where(item => item.GetProperty("kind").GetString() == "harness_result").ToArray();
        Fixture.Require(results.Length == 1, "Exactly one complete harness result is required");
        var report = new { version = 1, scope = "source-linked-native-concurrency-regression", supervisor = new {
            pid = child.Id, creationTime = creation.ToString(System.Globalization.CultureInfo.InvariantCulture),
            originalHandleWaitObserved = true, stdoutEof = true, stderrEof = true, exitCode = child.ExitCode }, result = results[0] };
        File.WriteAllText(Path.Combine(output, "result.json"), GuardianWire.Encode(report), new UTF8Encoding(false));
        Fixture.Require(child.ExitCode == 0 && results[0].GetProperty("passed").GetBoolean(), "Native regression failed; inspect result.json");
        Fixture.Require(results[0].GetProperty("cases").GetArrayLength() == 9, "Three causal and six wire cases are required");
        Fixture.AssertClosure(results[0].GetProperty("originalSupervisorClosure"));
        Console.WriteLine(GuardianWire.Encode(new { passed = true, result = Path.Combine(output, "result.json") })); return 0;
        } catch (Exception failure) {
            // Failure containment only, including failures before launch input was
            // sent. Never turn this fallback into passed native closure.
            try {
                if (!child.HasExited) child.Kill(entireProcessTree: false);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            } catch (Exception cleanup) { throw new AggregateException("Fixture failure and original Supervisor cleanup failure", failure, cleanup); }
            throw;
        }
    }
    private static async Task<string> ReadBounded(StreamReader reader, int limit) {
        var result = new StringBuilder(); var buffer = new char[4096];
        for (;;) { int count = await reader.ReadAsync(buffer); if (count == 0) return result.ToString();
            Fixture.Require(result.Length + count <= limit, "Fixture process output exceeded its bound"); result.Append(buffer, 0, count); }
    }
}
