import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { WINDOWS_BROWSER_SESSION_SCRIPT } from "./windows-browser-session-script.js";
import { WindowsBrowserSessionObservationError as ObserverFailure, windowsObservationFailureCode, windowsObservationPhase } from "./windows-browser-exit.js";
import { parseWindowsBrowserAncestryFailure, parseWindowsBrowserBoundFailure, type WindowsBrowserAncestryFailureV1,
  type WindowsBrowserBoundFailureV1 } from "./windows-browser-negative-evidence.js";

const MAX_FRAME_BYTES = 64 * 1024, MAX_OUTPUT_BYTES = 256 * 1024;
// Read the one protected source frame without letting a TextReader prefetch a
// separate reader's input. The same Console reader remains inside the script.
const BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$source = [Text.StringBuilder]::new()
while ($true) {
  $character = [Console]::In.Read()
  if ($character -lt 0) { exit 1 }
  if ($character -eq 10) { break }
  if ($source.Length -ge 131072 -or $character -eq 13) { exit 1 }
  [void]$source.Append([char]$character)
}
& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($source.ToString()))))
`;

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type State = "starting" | "ready" | "binding" | "bound" | "observing" | "observed" | "auditing" | "final_closing" | "closed" | "failed";
type Operation = "bind" | "initial" | "final";
interface Pending {
  operation: Operation; sequence: number; deadline: number; written: boolean;
  result?: Record<string, unknown>; completion: Deferred<readonly number[]>; timer: ReturnType<typeof setTimeout>;
}
export interface WindowsBrowserObserverOptions {
  executable: string;
  profile: string;
  /** One absolute monotonic deadline shared with this browser's launch. */
  launchDeadline: number;
  signal?: AbortSignal;
  /** Internal owner notification; never read from task or remote configuration. */
  onFailure?(): void;
}

const sessionCodes = new Set(["observer_protocol_failed", "observer_parent_eof", "observer_cleanup_failed", "observer_cleanup_unconfirmed",
  "observer_process_failed", "observer_input_failed", "observer_cancelled", "observer_deadline", "observer_output_invalid"]);
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function parseFrame(line: string): unknown {
  // This protocol only returns fixed ASCII labels, UUIDs, numbers and ISO dates.
  // Disallow escaped keys/strings and check duplicate keys before JSON.parse can
  // collapse them. The ordinary JSON parser still validates the full grammar.
  if (line.includes("\\")) throw new Error("Escaped protocol field");
  const parsed: unknown = JSON.parse(line);
  const objects: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  for (const match of line.matchAll(/"[^"\\]*"|[{}\[\],:]/g)) {
    const token = match[0], current = objects.at(-1);
    if (token === "{" || token === "[") objects.push({ object: token === "{", key: true, seen: new Set() });
    else if (token === "}" || token === "]") objects.pop();
    else if (token === "," && current?.object) current.key = true;
    else if (token.startsWith('"') && current?.object && current.key) {
      if (current.seen.has(token)) throw new Error("Duplicate protocol field");
      current.seen.add(token); current.key = false;
    }
  }
  return parsed;
}
function processIds(value: unknown, parentPid?: number): number[] {
  if (!Array.isArray(value) || value.length > 128 || (parentPid !== undefined && value.length === 0)) throw new Error("Invalid process list");
  const ids = value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)
      || !keys(item as Record<string, unknown>, ["pid", "created_utc"])) throw new Error("Invalid process identity");
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || (record.pid as number) > 0xffffffff || typeof record.created_utc !== "string"
      || record.created_utc.length > 40 || !Number.isFinite(Date.parse(record.created_utc))) throw new Error("Invalid process identity");
    return record.pid as number;
  });
  if (new Set(ids).size !== ids.length || (parentPid !== undefined && !ids.includes(parentPid))) throw new Error("Ambiguous process identities");
  return ids;
}
function exitHistoryIds(value: unknown, parentPid: number, currentIds: readonly number[]): number[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !keys(value as Record<string, unknown>, ["version", "pids"])) throw new Error("Invalid exit history");
  const history = value as Record<string, unknown>;
  if (history.version !== 1 || !Array.isArray(history.pids) || history.pids.length > 127
    || history.pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || pid === parentPid)
    || new Set(history.pids).size !== history.pids.length) throw new Error("Invalid exit history PIDs");
  const ids = history.pids as number[];
  if (new Set([parentPid, ...currentIds, ...ids]).size > 128) throw new Error("Exit history exceeds observation bound");
  return ids;
}
function initialExitIds(frame: Record<string, unknown>, parentPid: number): number[] {
  const currentIds = processIds(frame.processes, parentPid);
  if (!Object.hasOwn(frame, "exit_history")) return currentIds;
  // These extra PIDs are exit-only evidence, never fabricated current identities.
  return [...new Set([...currentIds, ...exitHistoryIds(frame.exit_history, parentPid, currentIds)])];
}

/** Internal per-browser owner. Nonces correlate frames; only private pipe ownership grants authority. */
export class WindowsBrowserObserverSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly nonce = randomUUID();
  private state: State = "starting";
  private sequence = 0;
  private parentPid?: number;
  private phase = "process_start";
  private failure?: ObserverFailure;
  private failureCleanupDeadline?: number;
  private pending?: Pending;
  private readonly readiness = deferred<void>();
  private readonly closure = deferred<void>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private outputBytes = 0;
  private startupWritten = false;
  private readyFrame = false;
  private exitObserved = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private closeObserved = false;
  private terminationRequested = false;
  private closeCode: number | null = null;
  private closeSignal: NodeJS.Signals | null = null;
  private stdoutEnded = false;
  private stderrEnded = false;
  private readonly launchTimer: ReturnType<typeof setTimeout>;
  private cleanupPromise?: Promise<void>;
  private readonly onAbort = () => { this.fail("observer_cancelled"); };

  constructor(private readonly options: WindowsBrowserObserverOptions) {
    if (!Number.isFinite(options.launchDeadline) || options.launchDeadline <= performance.now()
      || !options.executable || !options.profile || options.executable.length > 32768 || options.profile.length > 32768) {
      throw new ObserverFailure("observer_protocol_failed", "process_start");
    }
    if (options.signal?.aborted) throw new ObserverFailure("observer_cancelled", "process_start");
    const source = Buffer.from(WINDOWS_BROWSER_SESSION_SCRIPT, "utf8").toString("base64");
    const configure = JSON.stringify({ version: 1, session: this.nonce, seq: 0, operation: "configure", executable: options.executable, profile: options.profile });
    if (source.length > 131072 || Buffer.byteLength(configure) > MAX_FRAME_BYTES) throw new ObserverFailure("observer_protocol_failed", "process_start");
    this.child = spawn(join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(BOOTSTRAP, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "pipe" });
    this.launchTimer = setTimeout(() => this.fail("observer_deadline"), Math.max(0, options.launchDeadline - performance.now()));
    this.child.once("spawn", () => { if (this.failure) this.terminateOwned(); });
    this.child.once("error", () => this.fail("observer_process_failed"));
    this.child.stdin.on("error", () => this.fail("observer_input_failed"));
    this.child.stdout.on("error", () => this.fail("observer_output_invalid"));
    this.child.stderr.on("error", () => this.fail("observer_output_invalid"));
    this.child.stdout.on("data", (data: Buffer) => this.readOutput(data));
    this.child.stderr.on("data", (data: Buffer) => this.readPhases(data));
    this.child.stdout.once("end", () => {
      this.stdoutEnded = true;
      try { this.stdoutBuffer += this.decoder.decode(); if (this.stdoutBuffer.length) this.fail("observer_output_invalid"); }
      catch { this.fail("observer_output_invalid"); }
      if (this.pending?.operation !== "final") this.fail("observer_parent_eof");
      this.finishFinal();
    });
    this.child.stderr.once("end", () => {
      this.stderrEnded = true;
      if (this.pending?.operation !== "final") this.fail("observer_parent_eof");
      this.finishFinal();
    });
    this.child.once("exit", (code, signal) => {
      this.exitObserved = true; this.exitCode = code; this.exitSignal = signal;
      if (code !== 0 || signal !== null || this.pending?.operation !== "final") this.fail("observer_process_failed");
      this.finishFinal();
    });
    this.child.once("close", (code, signal) => {
      this.closeObserved = true; this.closeCode = code; this.closeSignal = signal;
      clearTimeout(this.launchTimer); this.options.signal?.removeEventListener("abort", this.onAbort);
      this.closure.resolve();
      if (this.state !== "final_closing" || code !== 0 || signal !== null) this.fail("observer_process_failed");
      this.finishFinal();
    });
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
    if (!this.failure) this.write(`${source}\n${configure}\n`, () => { this.startupWritten = true; this.finishReady(); });
  }

  private terminateOwned(): void {
    if (this.closeObserved || this.terminationRequested) return;
    if (this.child.pid !== undefined) {
      this.terminationRequested = true;
      try { this.child.kill("SIGKILL"); } catch { /* Actual close, not kill success, is required below. */ }
    }
    this.child.stdin.destroy();
  }
  private fail(code: string, initialExitHistory?: { parentPid: number; pids: readonly number[] },
    ancestryFailure?: WindowsBrowserAncestryFailureV1, boundFailure?: WindowsBrowserBoundFailureV1): void {
    if (!this.failure) {
      this.failure = new ObserverFailure(code, this.phase, initialExitHistory, ancestryFailure, boundFailure); this.state = "failed";
      this.failureCleanupDeadline = performance.now() + 3000;
      clearTimeout(this.launchTimer);
      this.readiness.reject(this.failure);
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.completion.reject(this.failure); }
      try { this.options.onFailure?.(); } catch { /* The latched failure and owned termination remain authoritative. */ }
    }
    this.terminateOwned();
  }
  private write(text: string, done: () => void): void {
    try {
      this.child.stdin.write(text, "utf8", error => {
        if (error) this.fail("observer_input_failed");
        else if (!this.failure) done();
      });
    } catch { this.fail("observer_input_failed"); }
  }
  private countOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputBytes > MAX_OUTPUT_BYTES) { this.fail("observer_output_invalid"); return false; }
    return true;
  }
  private readPhases(data: Buffer): void {
    if (!this.countOutput(data.length)) return;
    this.stderrBuffer += data.toString("utf8");
    if (this.stderrBuffer.length > 4096) { this.stderrBuffer = ""; return; }
    const lines = this.stderrBuffer.split(/\r?\n/); this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) { const phase = windowsObservationPhase(line); if (phase) this.phase = phase; }
  }
  private readOutput(data: Buffer): void {
    if (!this.countOutput(data.length) || this.failure) return;
    try {
      this.stdoutBuffer += this.decoder.decode(data, { stream: true });
      let end: number;
      while ((end = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, end).replace(/\r$/, ""); this.stdoutBuffer = this.stdoutBuffer.slice(end + 1);
        if (!line || Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Invalid frame size");
        this.acceptFrame(parseFrame(line));
        if (this.failure) return;
      }
      if (Buffer.byteLength(this.stdoutBuffer) > MAX_FRAME_BYTES) throw new Error("Incomplete oversized frame");
    } catch { this.fail("observer_protocol_failed"); }
  }
  private acceptFrame(input: unknown): void {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid frame");
    const frame = input as Record<string, unknown>;
    if (frame.version !== 1 || frame.session !== this.nonce) throw new Error("Invalid frame binding");
    const base = ["version", "session", "seq", "operation", "status"];
    if (this.state === "starting" && frame.operation === "ready" && frame.seq === 0 && frame.status === "error"
      && keys(frame, [...base, "error_code"]) && typeof frame.error_code === "string"
      && (sessionCodes.has(frame.error_code) || windowsObservationFailureCode(JSON.stringify({ error_code: frame.error_code })))) {
      this.fail(frame.error_code); return;
    }
    if (this.state === "starting" && frame.operation === "ready" && frame.seq === 0 && frame.status === "ok" && keys(frame, base)) {
      if (this.readyFrame) throw new Error("Duplicate ready");
      this.readyFrame = true; this.finishReady(); return;
    }
    const pending = this.pending;
    if (!pending || pending.result || frame.seq !== pending.sequence || frame.operation !== pending.operation) throw new Error("Unexpected frame");
    if (frame.status === "error") {
      if (typeof frame.error_code !== "string" || (!sessionCodes.has(frame.error_code)
        && !windowsObservationFailureCode(JSON.stringify({ error_code: frame.error_code })))) throw new Error("Unknown failure code");
      const hasAncestryFailure = Object.hasOwn(frame, "ancestry_failure");
      const hasBoundFailure = Object.hasOwn(frame, "bound_failure");
      if (keys(frame, [...base, "error_code", "parent_pid", "exit_history", ...(hasAncestryFailure ? ["ancestry_failure"] : []),
        ...(hasBoundFailure ? ["bound_failure"] : [])])) {
        if (pending.operation !== "initial" || pending.sequence !== 2 || this.parentPid === undefined
          || frame.parent_pid !== this.parentPid) throw new Error("Invalid initial error binding");
        if (performance.now() >= pending.deadline) { this.fail("observer_deadline"); return; }
        const pids = exitHistoryIds(frame.exit_history, this.parentPid, []);
        const history = { parentPid: this.parentPid, pids };
        let ancestryFailure: WindowsBrowserAncestryFailureV1 | undefined;
        if (hasAncestryFailure) {
          try {
            if (frame.error_code !== "descendant_precedes_parent") throw new Error("Unexpected ancestry failure evidence");
            ancestryFailure = parseWindowsBrowserAncestryFailure(frame.ancestry_failure, history);
          } catch {
            // A malformed optional diagnostic cannot erase already validated negative history.
            this.fail("observer_protocol_failed", history); return;
          }
        }
        let boundFailure: WindowsBrowserBoundFailureV1 | undefined;
        if (hasBoundFailure) {
          try {
            if (frame.error_code !== "observation_bound_exceeded") throw new Error("Unexpected bound failure evidence");
            boundFailure = parseWindowsBrowserBoundFailure(frame.bound_failure, history);
          } catch {
            // Invalid diagnostics cannot erase independently validated negative history.
            this.fail("observer_protocol_failed", history); return;
          }
        }
        this.fail(frame.error_code, history, ancestryFailure, boundFailure); return;
      }
      if (!keys(frame, [...base, "error_code"])) throw new Error("Invalid error frame");
      this.fail(frame.error_code); return;
    }
    if (frame.status !== "ok") throw new Error("Unknown frame status");
    if (pending.operation === "bind") {
      if (!keys(frame, [...base, "parent_pid"]) || frame.parent_pid !== this.parentPid) throw new Error("Invalid bind result");
    } else if (pending.operation === "initial") {
      const fields = [...base, "parent_pid", "processes", ...(Object.hasOwn(frame, "exit_history") ? ["exit_history"] : [])];
      if (!keys(frame, fields) || pending.sequence !== 2 || this.parentPid === undefined || frame.parent_pid !== this.parentPid) throw new Error("Invalid initial result");
      initialExitIds(frame, this.parentPid);
    } else {
      if (!keys(frame, [...base, "processes"])) throw new Error("Invalid final result");
      if (processIds(frame.processes).length === 0) this.state = "final_closing";
    }
    pending.result = frame; this.finishRequest();
  }
  private finishReady(): void {
    if (this.failure || !this.startupWritten || !this.readyFrame) return;
    if (performance.now() >= this.options.launchDeadline) { this.fail("observer_deadline"); return; }
    this.state = "ready"; this.readiness.resolve();
  }
  private finishRequest(): void {
    const pending = this.pending;
    if (!pending?.written || !pending.result || this.failure) return;
    if (performance.now() >= pending.deadline) { this.fail("observer_deadline"); return; }
    if (this.state === "final_closing") { this.finishFinal(); return; }
    if (pending.operation === "final" && (this.stdoutEnded || this.stderrEnded || this.exitObserved || this.closeObserved)) {
      this.fail("observer_parent_eof"); return;
    }
    const ids = pending.operation === "bind" ? [] : pending.operation === "initial"
      ? initialExitIds(pending.result, this.parentPid!) : processIds(pending.result.processes);
    this.state = pending.operation === "bind" ? "bound" : pending.operation === "initial" ? "observed" : "auditing";
    if (pending.operation === "bind") clearTimeout(this.launchTimer);
    clearTimeout(pending.timer); this.pending = undefined; pending.completion.resolve(ids);
  }
  private finishFinal(): void {
    const pending = this.pending;
    if (this.failure || this.state !== "final_closing" || !pending?.written || !pending.result || !this.closeObserved
      || !this.exitObserved || !this.stdoutEnded || !this.stderrEnded) return;
    if (this.exitCode !== 0 || this.closeCode !== 0 || this.exitSignal !== null || this.closeSignal !== null || this.stdoutBuffer.length) {
      this.fail("observer_process_failed"); return;
    }
    if (performance.now() >= pending.deadline) { this.fail("observer_deadline"); return; }
    clearTimeout(pending.timer); this.pending = undefined; this.state = "closed"; pending.completion.resolve([]);
  }
  private request(operation: Operation, deadline: number, extra: Record<string, unknown> = {}): Promise<readonly number[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending || (operation === "bind" ? this.state !== "ready" : operation === "initial" ? this.state !== "bound"
      : this.state !== "observed" && this.state !== "auditing")) {
      this.fail("observer_protocol_failed"); return Promise.reject(this.failure);
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) { this.fail("observer_deadline"); return Promise.reject(this.failure); }
    const sequence = ++this.sequence, completion = deferred<readonly number[]>();
    this.state = operation === "bind" ? "binding" : operation === "initial" ? "observing" : "auditing";
    const pending: Pending = { operation, sequence, deadline, written: false, completion,
      timer: setTimeout(() => this.fail("observer_deadline"), remaining) };
    this.pending = pending;
    this.write(JSON.stringify({ version: 1, session: this.nonce, seq: sequence, operation, ...extra }) + "\n", () => {
      pending.written = true; this.finishRequest();
    });
    return completion.promise;
  }
  async bind(parentPid: number): Promise<void> {
    if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0xffffffff) {
      this.fail("observer_protocol_failed"); throw this.failure;
    }
    await this.readiness.promise;
    this.parentPid = parentPid;
    await this.request("bind", this.options.launchDeadline, { parent_pid: parentPid });
  }
  observe(): Promise<readonly number[]> { return this.request("initial", performance.now() + 5000); }
  finalAudit(remainingMs: number): Promise<readonly number[]> {
    if (!Number.isInteger(remainingMs) || remainingMs < 1 || remainingMs > 5000) {
      this.fail("observer_protocol_failed"); return Promise.reject(this.failure);
    }
    return this.request("final", performance.now() + remainingMs);
  }
  /** Failure cleanup never restores session success or authorizes profile removal. */
  abort(): void { this.fail("observer_cancelled"); }
  assertCompleted(): void {
    if (this.failure) throw this.failure;
    if (this.state !== "closed") throw new ObserverFailure("observer_cleanup_unconfirmed", this.phase);
  }
  cleanup(): Promise<void> {
    return this.cleanupPromise ??= (async () => {
      if (this.state === "closed" && !this.failure) return;
      this.abort();
      if (this.closeObserved) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.closure.promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ObserverFailure("observer_cleanup_unconfirmed", this.phase)),
            Math.max(0, (this.failureCleanupDeadline ?? performance.now()) - performance.now()));
        })]);
      } finally { clearTimeout(timer); }
      if (!this.closeObserved) throw new ObserverFailure("observer_cleanup_unconfirmed", this.phase);
    })();
  }
}
