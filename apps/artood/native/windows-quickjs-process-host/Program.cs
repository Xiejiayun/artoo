using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Artoo.QuickJsProcessHost;

internal static class Program
{
    internal static int Main(string[] args) {
        if (args.Length != 1 || args[0] is not ("--application-quickjs-owner-v1" or "--application-quickjs-compiler-owner-v1")
            || !OperatingSystem.IsWindowsVersionAtLeast(10) || !Environment.Is64BitProcess) return Failed(3);
        try { return new ProcessOwner(args[0] == "--application-quickjs-owner-v1" ? OwnerMode.Runtime : OwnerMode.Compiler).Run(); }
        catch { return Failed(2); }
    }
    internal static int Failed(int code) {
        // Never leak native errors, paths, input contents or environment values.
        try { Console.Error.WriteLine("artoo-quickjs-process-host-failed"); } catch { }
        return code;
    }
}

internal sealed class ProcessOwner(OwnerMode mode)
{
    private readonly object gate = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly BlockingCollection<Control> inputQueue = new(2);
    private readonly TaskCompletionSource<bool> inputDone = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly ManualResetEventSlim admissionFinished = new(false);
    private readonly CapturedOutput stdout = new(), stderr = new();
    private readonly HashSet<string> nonces = new(StringComparer.OrdinalIgnoreCase);
    private string? failure;
    private Launch? launch;
    private FrameWriter? wire;
    private Process? child;
    private IntPtr processHandle;
    private SafeFileHandle? job;
    private PinnedInputs? pins;
    private bool admitted, writing, closeRequested, inputClosed, finishing;
    private bool inputStarted, stdoutStarted, stderrStarted;
    private int writes, writtenBytes, nextSequence;
    private bool started, jobAssigned, jobLimitsReadBack, originalExitObserved, jobEmptyObserved;
    private bool terminationRequested, terminationSucceeded, inputsUnchanged;
    private int? pid;
    private uint? exitCode;
    private Stopwatch? cleanup;

    private sealed class CapturedOutput {
        internal volatile bool NaturalEof;
        internal readonly TaskCompletionSource<bool> Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private string? Failure { get { lock (gate) return failure; } }
    private void Stop(string reason) { lock (gate) { if (!finishing) failure ??= reason; } }
    private int Remaining => Math.Max(0, (launch?.LifetimeMs ?? 30000) - checked((int)Math.Min(int.MaxValue, clock.ElapsedMilliseconds)));
    private int CleanupRemaining => cleanup is null ? Protocol.CleanupMs : Math.Max(0, Protocol.CleanupMs - (int)Math.Min(int.MaxValue, cleanup.ElapsedMilliseconds));
    private void RequireActive() {
        if (Remaining == 0) Stop("request-deadline");
        Native.Require(Failure is null, Failure ?? "request-stopped");
    }
    private void CheckCleanupBudget() {
        if (Remaining == 0) Stop("request-deadline");
        Native.Require(CleanupRemaining > 0, "cleanup-deadline");
    }

    internal int Run() {
        wire = new FrameWriter(Stop, mode.HelperBytes);
        try {
            var reader = new LineReader(Console.OpenStandardInput());
            var first = new TaskCompletionSource<byte[]?>(TaskCreationOptions.RunContinuationsAsynchronously);
            new Thread(() => {
                try { first.TrySetResult(reader.Read()); }
                catch { first.TrySetException(new OwnerFailure("launch-input")); }
            }) { IsBackground = true, Name = "artoo-quickjs-launch" }.Start();
            Native.Require(first.Task.Wait(30000), "launch-deadline");
            launch = Protocol.ReadLaunch(first.Task.GetAwaiter().GetResult() ?? throw new OwnerFailure("launch-eof"), mode);
            new Thread(() => ReadControls(reader)) { IsBackground = true, Name = "artoo-quickjs-control" }.Start();
            RequireActive();
            pins = new PinnedInputs(launch, RequireActive);
            RequireActive();
            StartTarget();
        } catch (OwnerFailure error) { Stop(error.Code); }
        catch { Stop("owner-setup"); }

        try { CollectClosure(); }
        catch (OwnerFailure error) { Stop(error.Code); }
        catch { Stop("owner-closure"); }

        // Freeze after the original target/Job/pipes and pin recheck. Late parent
        // bytes cannot add target authority once this owner has no work remaining.
        object terminal;
        bool success;
        lock (gate) {
            if (Remaining == 0) failure ??= "request-deadline";
            success = failure is null && started && originalExitObserved && exitCode == 0 && jobAssigned && jobLimitsReadBack
                && jobEmptyObserved && inputDone.Task.IsCompletedSuccessfully && inputClosed && stdout.NaturalEof && stderr.NaturalEof
                && stdout.Completion.Task.IsCompletedSuccessfully && stderr.Completion.Task.IsCompletedSuccessfully
                && inputsUnchanged && !terminationRequested;
            if (!success) failure ??= "closure-unconfirmed";
            // Cancellation may arrive during the post-exit pin recheck. Even an
            // already-empty Job receives the failure path's termination request.
            if (!success) TerminateOriginal();
            finishing = true;
            terminal = new { pid, originalExitObserved, exitCode, jobAssigned, jobLimitsReadBack, jobEmptyObserved,
                inputSettled = inputDone.Task.IsCompletedSuccessfully, inputClosed,
                stdoutEof = stdout.NaturalEof, stderrEof = stderr.NaturalEof,
                outputTasksSettled = stdout.Completion.Task.IsCompletedSuccessfully && stderr.Completion.Task.IsCompletedSuccessfully,
                terminationRequested, terminationSucceeded, inputsUnchanged, failure };
        }
        bool terminalQueued = wire.Send("terminal", terminal);
        wire.Complete();
        int outputBudget = success ? Math.Min(Remaining, CleanupRemaining) : CleanupRemaining;
        bool outputComplete = wire.Wait(outputBudget);
        // Job closure is still the backstop on an uncertain path. Original held
        // pins are released last; no caller-supplied PID is reopened at any stage.
        job?.Dispose();
        if (inputDone.Task.IsCompleted && stdout.Completion.Task.IsCompleted && stderr.Completion.Task.IsCompleted) child?.Dispose();
        pins?.Dispose();
        return success && terminalQueued && outputComplete && Remaining > 0 ? 0 : Program.Failed(2);
    }

    private void StartTarget() {
        job = Native.CreateJobObjectW(IntPtr.Zero, null);
        Native.Require(!job.IsInvalid, "job-create");
        var limits = new Native.ExtendedLimits(); limits.Basic.Flags = Native.JobFlags;
        limits.Basic.ActiveProcesses = 1; limits.ProcessMemory = new UIntPtr(Native.ProcessCommitBytes);
        uint size = (uint)Marshal.SizeOf<Native.ExtendedLimits>();
        Native.Require(Native.SetInformationJobObject(job, 9, ref limits, size), "job-limits");
        Native.Require(Native.QueryInformationJobObject(job, 9, out var readback, size, IntPtr.Zero)
            && readback.Basic.Flags == Native.JobFlags && readback.Basic.ActiveProcesses == 1
            && readback.ProcessMemory.ToUInt64() == Native.ProcessCommitBytes, "job-limits-readback");
        jobLimitsReadBack = true;
        var start = new ProcessStartInfo { FileName = launch!.Node.Path, WorkingDirectory = launch.Cwd,
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string value in new[] { "--max-old-space-size=256", launch.Entry.Path, mode.Selector, launch.Configuration.Path, launch.Configuration.Sha256 }) start.ArgumentList.Add(value);
        start.Environment.Clear();
        foreach (string name in new[] { "SystemRoot", "WINDIR" }) {
            string? value = Environment.GetEnvironmentVariable(name);
            Native.Require(!string.IsNullOrEmpty(value), "system-environment");
            start.Environment.Add(name, value);
        }
        RequireActive(); child = new Process { StartInfo = start };
        Native.Require(child.Start(), "target-start");
        started = true; pid = child.Id; processHandle = child.Handle;
        StartOutput(child.StandardOutput.BaseStream, stdout, "stdout", mode.StdoutBytes); stdoutStarted = true;
        StartOutput(child.StandardError.BaseStream, stderr, "stderr", Protocol.StderrBytes); stderrStarted = true;
        // The fixed trusted bootstrap does not load vendor/Wasm before admission.
        // Assignment and original-HANDLE verification precede that first write.
        Native.Require(Native.AssignProcessToJobObject(job, processHandle), "job-assign");
        jobAssigned = true;
        Native.Require(Native.IsProcessInJob(processHandle, job, out bool member) && member, "job-membership");
        Native.Require(Native.GetProcessTimes(processHandle, out long creation, out _, out _, out _), "target-identity");
        var image = new StringBuilder(32768); uint length = (uint)image.Capacity;
        Native.Require(Native.QueryFullProcessImageNameW(processHandle, 0, image, ref length)
            && string.Equals(image.ToString(), launch.Node.Path, StringComparison.OrdinalIgnoreCase), "target-image");
        Native.Require(wire!.Send("started", new { pid, creationTime = creation.ToString(CultureInfo.InvariantCulture), image = image.ToString(),
            jobAssigned = true, jobLimitsReadBack = true, processCommitLimitBytes = Native.ProcessCommitBytes, activeProcessLimit = 1 }), "helper-output-started");
        new Thread(WriteInput) { IsBackground = true, Name = "artoo-quickjs-input" }.Start();
        inputStarted = true;
    }

    private void ReadControls(LineReader reader) {
        try {
            for (;;) {
                byte[]? line = reader.Read();
                lock (gate) { if (finishing) return; }
                if (line is null) { Stop("control-eof"); return; }
                Control control = Protocol.ReadControl(line, nextSequence++, mode);
                lock (gate) {
                    if (finishing) return;
                    Native.Require(nonces.Add(control.Nonce), "control-nonce-reused");
                    if (control.Kind == "cancel") { failure ??= "control-cancel"; return; }
                    Native.Require(admitted && failure is null && !closeRequested, "control-state");
                    if (control.Kind == "write") {
                        Native.Require(!writing && ++writes <= mode.Writes
                            && writtenBytes + control.Data!.Length <= mode.InputBytes, "control-write-budget");
                        writing = true; writtenBytes += control.Data!.Length;
                    } else closeRequested = true;
                    Native.Require(inputQueue.TryAdd(control), "control-queue");
                }
            }
        } catch (OwnerFailure error) { Stop(error.Code); }
        catch { Stop("control-invalid"); }
    }

    private void WriteInput() {
        try {
            RequireActive();
            int remaining = Remaining;
            Native.Require(remaining > 0, "admission-deadline");
            byte[] json = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, kind = "admit", protocol = mode.AdmissionProtocol, remainingMs = remaining });
            byte[] line = new byte[json.Length + 1]; json.CopyTo(line, 0); line[^1] = 10;
            child!.StandardInput.BaseStream.Write(line, 0, line.Length);
            // Process.StandardInput wraps a buffered FileStream on Windows.
            // Its StreamWriter.AutoFlush does not apply to BaseStream writes.
            child.StandardInput.BaseStream.Flush();
            RequireActive();
            lock (gate) { writtenBytes = line.Length; admitted = true; }
            Native.Require(wire!.Send("admitted", new { bytes = line.Length, remainingMs = remaining }), "helper-output-admitted");
            admissionFinished.Set();
            for (;;) {
                RequireActive();
                if (!inputQueue.TryTake(out Control? control, 20)) continue;
                RequireActive();
                if (control.Kind == "close-input") {
                    child.StandardInput.BaseStream.Dispose();
                    lock (gate) inputClosed = true;
                    Native.Require(wire.Send("input-closed", new { nonce = control.Nonce }), "helper-output-input-closed");
                    return;
                }
                byte[] bytes = control.Data!;
                child.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                child.StandardInput.BaseStream.Flush();
                RequireActive();
                // ACK follows the original stream's completed write and flush,
                // never buffered acceptance. Cancellation uses a separate thread.
                lock (gate) writing = false;
                Native.Require(wire.Send("input-written", new { nonce = control.Nonce, bytes = bytes.Length }), "helper-output-input-written");
            }
        } catch (OwnerFailure error) { Stop(error.Code); }
        catch { Stop("target-input-io"); }
        finally {
            admissionFinished.Set();
            try { child!.StandardInput.BaseStream.Dispose(); lock (gate) inputClosed = true; }
            catch { Stop("target-input-close"); }
            inputDone.TrySetResult(true);
        }
    }

    private void StartOutput(Stream stream, CapturedOutput result, string name, int maximum) {
        new Thread(() => {
            try {
                admissionFinished.Wait();
                byte[] buffer = new byte[8192]; long total = 0;
                for (;;) {
                    int count = stream.Read(buffer, 0, buffer.Length);
                    if (count == 0) { result.NaturalEof = true; break; }
                    total += count;
                    if (total > maximum) Stop("target-" + name + "-limit");
                    else if (Failure is null) wire!.Send("output", new { stream = name, data = Convert.ToBase64String(buffer, 0, count) });
                }
            } catch { Stop("target-" + name + "-io"); }
            finally { result.Completion.TrySetResult(true); }
        }) { IsBackground = true, Name = "artoo-quickjs-" + name }.Start();
    }

    private void TerminateOriginal() {
        if (!started || terminationRequested) return;
        terminationRequested = true;
        if (jobAssigned) terminationSucceeded = Native.TerminateJobObject(job!, 17);
        else if (processHandle != IntPtr.Zero) terminationSucceeded = Native.TerminateProcess(processHandle, 17);
        else {
            // Process.Start succeeded but obtaining its HANDLE failed. This is
            // still the exact original object, never Process.GetProcessById.
            try { child!.Kill(); terminationSucceeded = true; }
            catch { terminationSucceeded = false; }
        }
        if (!terminationSucceeded) Stop("target-termination");
        admissionFinished.Set();
    }

    private void CollectClosure() {
        // Setup can fail after Process.Start but before the pumps were created.
        // Release their gate and create missing pumps so genuine EOF is observed.
        if (started && child is not null) {
            if (processHandle == IntPtr.Zero) processHandle = child.Handle;
            if (!stdoutStarted) { StartOutput(child.StandardOutput.BaseStream, stdout, "stdout", mode.StdoutBytes); stdoutStarted = true; }
            if (!stderrStarted) { StartOutput(child.StandardError.BaseStream, stderr, "stderr", Protocol.StderrBytes); stderrStarted = true; }
            if (!inputStarted) {
                try { child.StandardInput.BaseStream.Dispose(); lock (gate) inputClosed = true; }
                catch { Stop("target-input-close"); }
                inputDone.TrySetResult(true);
                admissionFinished.Set();
            }
        }
        while (started) {
            if (Remaining == 0) Stop("request-deadline");
            uint wait = Native.WaitForSingleObject(processHandle, 0);
            if (wait == 0 && !originalExitObserved) {
                originalExitObserved = true;
                if (Native.GetExitCodeProcess(processHandle, out uint code)) exitCode = code;
                else Stop("target-exit-code");
                if (exitCode != 0) Stop("target-exit-nonzero");
                lock (gate) { if (!closeRequested) failure ??= "target-exit-input-open"; }
            } else if (wait != 0 && wait != 258) Stop("target-wait");
            if (Failure is not null || originalExitObserved) cleanup ??= Stopwatch.StartNew();
            if (Failure is not null) TerminateOriginal();
            if (job is not null && !job.IsInvalid) {
                if (Native.QueryJobAccounting(job, 1, out var accounting, (uint)Marshal.SizeOf<Native.BasicAccounting>(), IntPtr.Zero))
                    jobEmptyObserved = accounting.ActiveProcesses == 0 && originalExitObserved;
                else Stop("job-accounting");
            }
            bool ioSettled = inputDone.Task.IsCompleted && stdout.Completion.Task.IsCompleted && stderr.Completion.Task.IsCompleted;
            if (originalExitObserved && jobEmptyObserved && ioSettled) break;
            if (cleanup is not null && CleanupRemaining == 0) { Stop("closure-deadline"); break; }
            Thread.Sleep(10);
        }
        cleanup ??= Stopwatch.StartNew();
        if (started && (!originalExitObserved || !jobEmptyObserved || !inputDone.Task.IsCompleted
            || !stdout.Completion.Task.IsCompleted || !stderr.Completion.Task.IsCompleted)) Stop("closure-unconfirmed");
        if (pins is not null) {
            pins.AssertUnchanged(CheckCleanupBudget);
            inputsUnchanged = true;
        }
    }
}
