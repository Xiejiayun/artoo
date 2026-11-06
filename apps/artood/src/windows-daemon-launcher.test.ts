// Controlled protocol/OS observations only; no native helper or model is executed.
import { describe, expect, it, vi } from "vitest";
import type { WindowsStartupDiagnostic } from "./windows-startup-diagnostics.js";
import { join } from "node:path";
import { SupervisedLifecycle, supervisedEnvironment, supervisedSelection, type SupervisorProcessObservation } from "./windows-daemon-launcher.js";
const nonce = "00000000-0000-4000-8000-000000000001", armNonce = "00000000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`, manifest = { path: "C:\\fixed\\bundle-manifest.json", bytes: 42, sha256: digest };
const daemon = (generation: number) => ({ pid: 100 + generation, creationTime: String(200 + generation), image: "C:\\fixed\\node.exe", sid: "S-1-5-21-1" });
const observed: SupervisorProcessObservation = { spawned: true, exited: true, closed: true, stdoutEof: true, stderrEof: true,
  exitCode: 0, closeCode: 0, signal: null, closeSignal: null };
function fixture(diagnostic?: (generation: number, value: WindowsStartupDiagnostic) => void) {
  const lifecycle = new SupervisedLifecycle(nonce, manifest, diagnostic); let sequence = 0;
  const frame = (kind: string, payload: unknown) => lifecycle.accept({ version: 1, sequence: sequence++, kind, payload });
  frame("supervisor_ready", { capability: "artoo.windows-daemon-supervisor.v1", supervisor: daemon(9), launchIdentityDigest: digest,
    lifetimeOwnership: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", cleanupTimeoutMs: 15000,
      gracefulStopMs: 45000, sharedJob: true, runtimeManifest: manifest } });
  const start = (generation = 0) => frame("daemon_started", { generation, daemon: daemon(generation), launchIdentityDigest: digest, atomicJobMember: true });
  const output = (kind: "ready" | "stopped", generation = 0, exitCode?: number) => frame("daemon_output", { generation, stream: "stdout",
    data: Buffer.from("ARTOO_SUPERVISED_V1 " + JSON.stringify({ version: 1, kind, nonce, pid: daemon(generation).pid,
      ...(exitCode === undefined ? {} : { exitCode }) }) + "\n").toString("base64") });
  const exit = (generation = 0, exitCode = 0) => frame("daemon_exit", { generation, daemon: daemon(generation), rootWaitObserved: true,
    exitCode, exitTime: "999", stdoutEof: false, stderrEof: false });
  const arm = () => { const command = lifecycle.arm(armNonce); frame("command_ack", { nonce: armNonce, kind: command.kind, generation: command.generation }); };
  const terminal = (patch: Record<string, unknown> = {}) => frame("supervisor_stopped", { reason: "stopped", facts: {
    launchIdentityDigest: digest, incarnations: Array.from({ length: lifecycle.generation + 1 }, (_, generation) => ({ generation,
      daemon: daemon(generation), rootWaitObserved: true, exitCode: 0, stdoutEof: true, stderrEof: true, atomicJobMember: true })),
    lifetimeClosure: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", jobCreated: true,
      allRootsWaitObserved: true, jobEmptyObserved: true, allStdoutEof: true, allStderrEof: true, cleanupConfirmed: true,
      gracefulStopArmed: true, gracefulStopTimedOut: false, forcedJobTermination: true, ...patch },
  } });
  return { lifecycle, frame, start, output, exit, arm, terminal };
}
describe("supervised CLI selection", () => {
  it("preserves ordinary and Desktop manual launch and rejects mixed selectors", () => {
    expect(supervisedSelection([], false)).toBeUndefined();
    expect(supervisedSelection(["--prepared-journal"], true)).toBeUndefined();
    expect(supervisedSelection(["--windows-supervised"], false)).toBe("parent");
    expect(supervisedSelection(["--windows-supervised-daemon"], false)).toBe("daemon");
    expect(() => supervisedSelection(["--windows-supervised"], true)).toThrow(/standalone/);
    expect(() => supervisedSelection(["--windows-supervised", "--prepared-journal"], false)).toThrow(/one standalone/);
  });
  it("copies only local explicit settings and removes executable injection and Desktop identity", () => {
    const env = supervisedEnvironment({ ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: join(process.cwd(), "codex.exe"),
      ARTOO_NODE_URL: "wss://local/api/v1/node?token=private", ARTOO_CODEX_PROVIDER_KEY: "local-secret",
      NODE_OPTIONS: "--import attacker", NODE_PATH: "evil", ELECTRON_RUN_AS_NODE: "1", PATH: "evil", UNKNOWN_SECRET: "unused" }, nonce);
    expect(env.ARTOO_CODEX_PROVIDER_KEY).toBe("local-secret");
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "PATH", "UNKNOWN_SECRET", "ARTOO_WORKER_LAUNCH_ID"]) expect(env[key]).toBeUndefined();
    expect(env.WS_NO_BUFFER_UTIL).toBe("1");
    expect(() => supervisedEnvironment({ ARTOO_RUNTIMES: "codex,claude-code", ARTOO_CODEX_BINARY: process.execPath }, nonce)).toThrow(/ARTOO_RUNTIMES/);
    expect(() => supervisedEnvironment({ ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: process.execPath, ARTOO_JOURNAL_VERSION: "1" }, nonce)).toThrow(/ordinary fixed/);
  });
  it.each(["untrusted", JSON.stringify({ version: 1, path: "C:\\untrusted\\git.exe", bytes: 42, sha256: digest })])
  ("never inherits a bootstrap executable projection even when initialization is enabled", injected => {
    const env = supervisedEnvironment({ ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: join(process.cwd(), "codex.exe"),
      ARTOO_INITIALIZE_REPOSITORY: "1", ARTOO_SUPERVISED_BOOTSTRAP_GIT: injected, PATH: "C:\\untrusted" }, nonce);
    expect(env.ARTOO_INITIALIZE_REPOSITORY).toBe("1");
    expect(env.ARTOO_SUPERVISED_BOOTSTRAP_GIT).toBeUndefined();
    expect(env.PATH).toBeUndefined();
  });
});
describe("current-generation readiness and actual closure", () => {
  it("projects only a bounded bound startup record without authorizing readiness or clean stop", () => {
    const sink = vi.fn(), f = fixture(sink); f.start();
    const diagnostic = { version: 1, phase: "git_installation", status: "failed", elapsed_ms: 123, phase_elapsed_ms: 15, error_code: "startup_stage_failed" };
    expect(f.frame("daemon_output", { generation: 0, stream: "stdout", data: Buffer.from("ARTOO_SUPERVISED_V1 " + JSON.stringify({
      version: 1, kind: "startup", nonce, pid: daemon(0).pid, diagnostic }) + "\n").toString("base64") })).toBeUndefined();
    expect(sink).toHaveBeenCalledWith(0, diagnostic); expect(f.lifecycle.ready).toBe(false);
    f.arm(); f.exit(); f.terminal(); expect(() => f.lifecycle.confirm(observed)).toThrow(/closure/);
  });
  it.each(["nonce", "pid", "phase", "secret-field", "oversized"])("rejects changed startup diagnostic binding/schema: %s", variant => {
    const f = fixture(); f.start();
    const event = { version: 1, kind: "startup", nonce, pid: daemon(0).pid,
      diagnostic: { version: 1, phase: "git_installation", status: "entered", elapsed_ms: 0, phase_elapsed_ms: 0 } as Record<string, unknown> };
    if (variant === "nonce") event.nonce = armNonce;
    if (variant === "pid") event.pid++;
    if (variant === "phase") event.diagnostic.phase = "raw-error-text";
    if (variant === "secret-field") event.diagnostic.stderr = "secret";
    if (variant === "oversized") event.diagnostic.elapsed_ms = 86_400_001;
    expect(() => f.frame("daemon_output", { generation: 0, stream: "stdout",
      data: Buffer.from("ARTOO_SUPERVISED_V1 " + JSON.stringify(event) + "\n").toString("base64") })).toThrow();
  });
  it("does not forward arbitrary daemon stderr and preserves failed native closure facts without upgrading them", () => {
    const sink = vi.fn(), f = fixture(sink); f.start();
    f.frame("daemon_output", { generation: 0, stream: "stderr", data: Buffer.from("provider secret and raw stack").toString("base64") });
    expect(sink).not.toHaveBeenCalled();
    f.frame("supervisor_failed", { reason: "graceful_stop_timeout", facts: { secret: "do not echo", lifetimeClosure: {
      version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", jobCreated: true,
      allRootsWaitObserved: true, jobEmptyObserved: false, allStdoutEof: true, allStderrEof: false,
      cleanupConfirmed: false, gracefulStopArmed: true, gracefulStopTimedOut: true, forcedJobTermination: true, secret: "do not echo" } } });
    const projection = f.lifecycle.diagnosticClosure({ ...observed, exitCode: 2, closeCode: 2 });
    expect(projection).toMatchObject({ native_terminal: "supervisor_failed", native_reason: "graceful_stop_timeout",
      native_lifetime: { cleanupConfirmed: false, jobEmptyObserved: false, allStderrEof: false, gracefulStopTimedOut: true },
      supervisor_observed: { exit_code: 2, close_code: 2 } });
    expect(JSON.stringify(projection)).not.toContain("secret");
    expect(() => f.lifecycle.confirm({ ...observed, exitCode: 2, closeCode: 2 })).toThrow(/graceful_stop_timeout/);
  });
  it("keeps missing native closure unknown despite wrapper closure", () => {
    const f = fixture(); f.start();
    expect(f.lifecycle.diagnosticClosure(observed)).toMatchObject({ native_terminal: "missing_or_invalid", native_lifetime: null });
    expect(() => f.lifecycle.confirm(observed)).toThrow();
  });
  it("does not equate native daemon creation with registration readiness", () => {
    const f = fixture(); f.start(); expect(f.lifecycle.ready).toBe(false);
    f.output("ready"); expect(f.lifecycle.ready).toBe(true);
  });
  it("allows an autonomous daemon failure to restart but never reuses prior readiness", () => {
    const f = fixture(); f.start(); f.output("ready"); f.output("stopped", 0, 1); f.exit(0, 1); f.start(1);
    expect(f.lifecycle.ready).toBe(false);
    f.output("ready", 0); expect(f.lifecycle.ready).toBe(false);
    f.output("ready", 1); expect(f.lifecycle.ready).toBe(true);
  });
  it("accepts successful settlement delivered after the original exit frame only after full closure", () => {
    const f = fixture(); f.start(); f.output("ready"); f.arm(); f.exit(); f.output("stopped", 0, 0); f.terminal();
    expect(() => f.lifecycle.confirm(observed)).not.toThrow();
  });
  it("never turns only the graceful-stop ACK into a clean stop", () => {
    const f = fixture(); f.start(); f.arm(); f.exit(); f.terminal();
    expect(() => f.lifecycle.confirm(observed)).toThrow(/closure/);
  });
  it("ignores readiness already buffered when graceful stop was requested", () => {
    const f = fixture(); f.start(); f.arm(); expect(() => f.output("ready")).not.toThrow();
    expect(f.lifecycle.ready).toBe(false); f.output("stopped", 0, 0); f.exit(); f.terminal();
    expect(() => f.lifecycle.confirm(observed)).not.toThrow();
  });
  it("does not report ready when the same output chunk already contains stopped", () => {
    const f = fixture(); f.start();
    const line = (kind: string, exitCode?: number) => "ARTOO_SUPERVISED_V1 " + JSON.stringify({ version: 1, kind, nonce, pid: daemon(0).pid,
      ...(exitCode === undefined ? {} : { exitCode }) }) + "\n";
    expect(f.frame("daemon_output", { generation: 0, stream: "stdout", data: Buffer.from(line("ready") + line("stopped", 1)).toString("base64") })).toBeUndefined();
    expect(f.lifecycle.ready).toBe(false);
  });
  it.each(["jobEmptyObserved", "allRootsWaitObserved", "allStdoutEof", "allStderrEof", "cleanupConfirmed"])("requires native %s", key => {
    const f = fixture(); f.start(); f.arm(); f.output("stopped", 0, 0); f.exit(); f.terminal({ [key]: false });
    expect(() => f.lifecycle.confirm(observed)).toThrow();
  });
  it.each(["spawned", "exited", "closed", "stdoutEof", "stderrEof"])("requires original ChildProcess %s", key => {
    const f = fixture(); f.start(); f.arm(); f.output("stopped", 0, 0); f.exit(); f.terminal();
    expect(() => f.lifecycle.confirm({ ...observed, [key]: false })).toThrow(/closure/);
  });
  it("preserves a graceful timeout and rejects a replacement while stopping", () => {
    const f = fixture(); f.start(); f.arm(); f.output("stopped", 0, 0); f.exit(); f.terminal({ gracefulStopTimedOut: true });
    expect(() => f.lifecycle.confirm(observed)).toThrow();
    const g = fixture(); g.start(); g.arm(); g.exit(); expect(() => g.start(1)).toThrow(/replaced/);
  });
  it("rejects stale readiness after exit and cannot arm an already dead generation", () => {
    const f = fixture(); f.start(); f.exit(); f.output("ready"); expect(f.lifecycle.ready).toBe(false);
    expect(() => f.arm()).toThrow(/live daemon/);
  });
});
