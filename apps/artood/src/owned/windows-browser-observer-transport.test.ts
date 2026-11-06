import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotOwnedWindowsProcesses, windowsObservationPhase } from "./windows-browser-exit.js";

const control = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  const execFile = () => { throw new Error("This controlled fixture uses execFile's promisified contract"); };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: (...args: unknown[]) => control.execute(...args) });
  return { ...native, execFile };
});

beforeEach(() => { vi.clearAllMocks(); });
function invocation(inputFailure = false) {
  const bytes: Buffer[] = [], stderr = new PassThrough();
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    bytes.push(Buffer.from(chunk));
    callback(inputFailure ? Object.assign(new Error("private pipe failure"), { code: "EPIPE" }) : undefined);
  } });
  let resolve!: (value: { stdout: string; stderr: string }) => void, reject!: (error: unknown) => void;
  const completion = Object.assign(new Promise<{ stdout: string; stderr: string }>((yes, no) => { resolve = yes; reject = no; }), { child: { stdin, stderr } });
  control.execute.mockReturnValue(completion);
  return { stdin, stderr, bytes, complete: () => { stderr.end(); resolve({ stdout: JSON.stringify({ parent_pid: 101,
    processes: [{ pid: 101, created_utc: "2026-11-05T00:00:00Z" }] }), stderr: "" }); },
  fail: (error: unknown) => { stderr.end(); reject(error); } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe("protected Windows observer private input transport", () => {
  it("waits for the controlled actual-completion boundary after asynchronous stdin failure", async () => {
    const child = invocation(true), operation = snapshotOwnedWindowsProcesses(101, "C:\\Chrome\\chrome.exe", "C:\\private-profile");
    let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; });
    await tick(); expect(settled).toBe(false); expect(control.execute).toHaveBeenCalledTimes(1);
    const [, argv, options] = control.execute.mock.calls[0]!;
    expect(options).toMatchObject({ timeout: 5000, windowsHide: true, killSignal: "SIGKILL" });
    expect((argv as string[]).join(" ")).not.toContain("private-profile");
    expect((argv as string[]).join(" ").length).toBeLessThan(2048);
    expect(Buffer.concat(child.bytes).toString("utf8")).toContain("CreateToolhelp32Snapshot");
    child.complete();
    await expect(operation).rejects.toThrow("Protected Windows process observation failed (observer_input_failed)");
    expect(control.execute).toHaveBeenCalledTimes(1);
  });

  it("also waits for completion after a synchronous pipe write failure and emits no private error text", async () => {
    const child = invocation();
    vi.spyOn(child.stdin, "end").mockImplementation(() => { throw new Error("private synchronous transport payload"); });
    const operation = snapshotOwnedWindowsProcesses(101, "C:\\Chrome\\chrome.exe", "C:\\private-profile");
    let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; });
    await tick(); expect(settled).toBe(false);
    child.complete();
    const error: unknown = await operation.catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("observer_input_failed");
    expect((error as Error).message).not.toContain("private synchronous");
    expect(control.execute).toHaveBeenCalledTimes(1);
  });

  it("retains only an allowed last phase on the original timeout without retry or raw diagnostics", async () => {
    const child = invocation(), operation = snapshotOwnedWindowsProcesses(101, "C:\\Chrome\\chrome.exe", "C:\\private-profile");
    child.stderr.write("ARTOO_BROWSER_PHASE|root_query\nARTOO_BROWSER_PHASE|private_command_line\nprivate raw command text\n");
    child.fail({ killed: true, stdout: "private raw output", stderr: "private raw command", code: "private code" });
    const error: unknown = await operation.catch(value => value);
    expect((error as Error).message).toContain("Protected Windows process observation failed (deadline) [last_phase=root_query,");
    expect((error as Error).message).not.toContain("private");
    expect(control.execute).toHaveBeenCalledTimes(1);
  });

  it("returns only after both the input stream and controlled process completion succeed", async () => {
    const child = invocation(), operation = snapshotOwnedWindowsProcesses(101, "C:\\Chrome\\chrome.exe", "C:\\private-profile");
    child.complete(); await expect(operation).resolves.toEqual([101]);
    expect(control.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts only exact fixed phase markers", () => {
    for (const phase of ["script_started", "native_binding", "root_handle", "root_query", "root_identity", "ancestry_snapshot", "ancestry_confirmation", "final_query", "observation_result"]) {
      expect(windowsObservationPhase(`ARTOO_BROWSER_PHASE|${phase}`)).toBe(phase);
    }
    for (const line of ["ARTOO_BROWSER_PHASE|private", "ARTOO_BROWSER_PHASE|root_query|secret", "ARTOO_BROWSER_PHASE|root_query\n", "x".repeat(101)]) {
      expect(windowsObservationPhase(line)).toBeUndefined();
    }
  });
});
