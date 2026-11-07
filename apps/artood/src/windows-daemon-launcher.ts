import { createWindowsStopDiagnostics, createWindowsStopDiagnosticWriter, WindowsStopDiagnosticSchema, type WindowsStopDiagnostic } from "./windows-stop-diagnostics.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { ArtoodConfig, ShutdownHost } from "./main.js";
import { prepareProductSourceConfiguration } from "./product-source-config.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsReleaseStorage } from "./windows-release-storage.js";
import { prepareProductBootstrapGit, describeProductBootstrapGit, readProductBootstrapGit } from "./product-bootstrap-git.js";
import { installCleanDaemonControl } from "./windows-clean-daemon-control.js";
import { WindowsStartupDiagnosticSchema, withWindowsStartupDiagnostics, type WindowsStartupDiagnostic } from "./windows-startup-diagnostics.js";
import { SourceCommandDiagnosticSchema, SOURCE_COMMAND_DIAGNOSTIC_LIMITS, type SourceCommandDiagnostic } from "./source-command-diagnostics.js";

export const SUPERVISED_CLI = "--windows-supervised";
export const SUPERVISED_DAEMON = "--windows-supervised-daemon";
const CAPABILITY = "artoo.windows-daemon-supervisor-lifetime.v1";
const PREFIX = "ARTOO_SUPERVISED_V1 ";
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const pinSchema = z.object({ path: z.string(), bytes: z.number().int().positive().max(4 * 1024 * 1024), sha256: hash }).strict();
const identity = z.object({ pid: z.number().int().positive(), creationTime: z.string().regex(/^\d+$/),
  image: z.string(), sid: z.string().startsWith("S-1-") }).strict();
const lifetime = z.object({ version: z.literal(1), capability: z.literal(CAPABILITY),
  cleanupTimeoutMs: z.number().int().min(100).max(60_000), gracefulStopMs: z.number().int().min(100).max(60_000),
  sharedJob: z.literal(true), runtimeManifest: pinSchema }).strict();
// The fixed native grace includes stop observers and the existing 5s stopped-output flush.
const LIFETIME = Object.freeze({ version: 1 as const, cleanupTimeoutMs: 15_000, gracefulStopMs: 45_000 });
const SUPERVISOR_STARTUP_MS = 120_000;
// Registration includes protected native audits; each actual generation has one fixed budget.
const DAEMON_REGISTRATION_MS = 300_000;
const filePin = (path: string, maximum = 512 * 1024 * 1024, allowEmpty = false) => {
  if (!isAbsolute(path) || realpathSync.native(path) !== path) throw Error("Supervised input must use its physical absolute path");
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < (allowEmpty ? 0n : 1n) || before.size > BigInt(maximum)) {
    throw Error("Supervised input must be a bounded single-link regular file");
  }
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || after.nlink !== 1n || BigInt(bytes.length) !== after.size || realpathSync.native(path) !== path) throw Error("Supervised input changed during inspection");
  return { path, bytes: bytes.length, sha256: sha(bytes) };
};

/** Local selection only. Neither inherited environment nor argv confers native authority. */
export function supervisedSelection(args: readonly string[], ipc: boolean): "parent" | "daemon" | undefined {
  const selected = args.some(arg => arg === SUPERVISED_CLI || arg === SUPERVISED_DAEMON);
  if (!selected) return undefined;
  if (ipc || args.length !== 1) throw Error("Supervised Windows startup requires one standalone CLI selector");
  return args[0] === SUPERVISED_CLI ? "parent" : "daemon";
}

const ENV_KEYS = ["SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "LANG", "TZ", "CODEX_HOME",
  "ARTOO_NODE_URL", "ARTOO_NODE_ID", "ARTOO_RUNTIMES", "ARTOO_ALLOWED_ROOTS", "ARTOO_REPORT_ARTIFACTS", "ARTOO_TRUSTED_EXECUTION",
  "ARTOO_CODEX_BINARY", "ARTOO_CODEX_MODEL", "ARTOO_CODEX_PROVIDER_URL", "ARTOO_CODEX_PROVIDER_KEY", "ARTOO_HEARTBEAT_INTERVAL_MS",
  "ARTOO_WINDOWS_PROCESS_BUNDLE", "ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256", "ARTOO_PRODUCT_SOURCE_CONFIG_FILE",
  "ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256",
  "ARTOO_VERIFICATION_PROFILES_FILE", "ARTOO_RELEASE_PROFILES_FILE", "ARTOO_RESEARCH_ENABLED", "ARTOO_RESEARCH_RECEIPTS_DIR",
  "ARTOO_RESEARCH_BRAVE_KEY", "ARTOO_INITIALIZE_REPOSITORY"] as const;
export function supervisedEnvironment(env: NodeJS.ProcessEnv, nonce: string): Record<string, string> {
  uuid.parse(nonce);
  if (env.ARTOO_RUNTIMES !== "codex" || !env.ARTOO_CODEX_BINARY || !isAbsolute(env.ARTOO_CODEX_BINARY)) {
    throw Error("Supervised Windows CLI currently requires ARTOO_RUNTIMES=codex and an absolute ARTOO_CODEX_BINARY");
  }
  if (env.ARTOO_WORKER_LAUNCH_ID || env.ARTOO_WORKTREE_BASE_REPO || env.ARTOO_OWNED_RESULT_PROFILES_FILE
    || Object.keys(env).some(key => /^(ARTOO_MANAGED_|ARTOO_JOURNAL_)/i.test(key) && env[key])) {
    throw Error("Supervised Windows CLI requires ordinary fixed workspaces without Desktop or managed settings");
  }
  const result: Record<string, string> = {};
  for (const key of ENV_KEYS) if (env[key] !== undefined) result[key] = env[key]!;
  // The bundle deliberately externalizes these optional ws accelerators. Disable
  // their fallback resolution so a parent node_modules tree cannot supply code.
  result.WS_NO_BUFFER_UTIL = "1"; result.WS_NO_UTF_8_VALIDATE = "1";
  result.ARTOO_SUPERVISED_CONTROL_NONCE = nonce;
  return result;
}

/** Local parent control is opt-in. It never travels in the daemon environment. */
export function supervisedStdinControlEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw Error("ARTOO_SUPERVISED_STDIN_CONTROL must be 0 or 1");
}

/** The creator of this inherited pipe may request the same graceful stop as Ctrl+C.
 * This protocol grants no command execution, registration or recovery authority. */
export function installSupervisedStdinControl(input: Pick<NodeJS.ReadableStream, "on" | "off" | "pause">,
  stop: () => void, fail: (error: Error) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let pending = "", bytesSeen = 0, requested = false, disposed = false, failed = false;
  const reject = () => {
    if (disposed || failed) return; failed = true;
    fail(Error("Supervised parent stdin control was lost or invalid"));
  };
  const data = (chunk: Buffer | string) => {
    if (disposed || failed) return;
    try {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytesSeen += bytes.length;
      if (bytesSeen > 4096) throw Error("Parent control byte bound exceeded");
      pending += decoder.write(bytes); let commands = 0;
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        z.object({ version: z.literal(1), kind: z.literal("shutdown") }).strict().parse(JSON.parse(line)); commands++;
      }
      if (commands && !requested) { requested = true; stop(); }
    } catch { reject(); }
  };
  const end = () => {
    if (disposed || failed) return;
    pending += decoder.end();
    if (pending.length || !requested) reject();
  };
  input.on("data", data); input.on("end", end); input.on("error", reject);
  return () => {
    if (disposed) return; disposed = true;
    input.off("data", data); input.off("end", end); input.off("error", reject); input.pause();
  };
}

function inspectBundle(entry: string, expectedDigest: string | undefined, roots: readonly string[]) {
  hash.parse(expectedDigest);
  if (basename(entry) !== "artood.mjs") throw Error("Supervised CLI requires the complete bundled artood.mjs installation");
  const directory = dirname(entry);
  prepareWindowsReleaseStorage({ directory, writableWorkspaceRoots: roots });
  const manifestPin = filePin(join(directory, "bundle-manifest.json"), 4 * 1024 * 1024);
  if (manifestPin.sha256 !== expectedDigest) throw Error("Supervised bundle manifest differs from the local pinned version");
  const member = z.string().min(1).refine(value => !isAbsolute(value) && !/[\\:\u0000-\u001f]/.test(value)
    && value.split("/").every(part => !!part && part !== "." && part !== ".."));
  const manifest = z.object({ format: z.literal("artoo.desktop-daemon.v1"), node_target: z.literal("node24"),
    tree: z.object({ directories: z.array(member).max(4096), files: z.array(z.object({ path: member,
      size: z.number().int().nonnegative().max(512 * 1024 * 1024), sha256: hash }).strict()).min(1).max(4096) }).strict(),
  }).passthrough().parse(JSON.parse(readFileSync(manifestPin.path, "utf8")));
  if (manifest.tree.files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024 * 1024) throw Error("Supervised bundle byte limit exceeded");
  const expected = new Map<string, { size: number; sha256: string }>();
  const names = new Set<string>();
  for (const value of [...manifest.tree.directories, ...manifest.tree.files.map(file => file.path)]) {
    if (names.has(value.toLowerCase()) || value.toLowerCase() === "bundle-manifest.json") throw Error("Supervised bundle has duplicate members");
    names.add(value.toLowerCase());
  }
  for (const file of manifest.tree.files) expected.set(file.path, file);
  const actualFiles: string[] = [], actualDirectories: string[] = [];
  const visit = (path: string, depth: number) => {
    if (depth > 64 || actualFiles.length + actualDirectories.length > 8192) throw Error("Supervised bundle inventory limit exceeded");
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name), local = relative(directory, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw Error("Supervised bundle contains a link");
      if (local === "bundle-manifest.json") continue;
      if (stat.isDirectory()) { actualDirectories.push(local); visit(absolute, depth + 1); }
      else {
        const fixed = expected.get(local); if (!fixed) throw Error("Supervised bundle has an unlisted file");
        const actual = filePin(absolute, 512 * 1024 * 1024, true);
        if (actual.bytes !== fixed.size || actual.sha256 !== fixed.sha256) throw Error("Supervised bundle bytes changed");
        actualFiles.push(local);
      }
    }
  };
  visit(directory, 0);
  const same = (left: string[], right: string[]) => JSON.stringify(left.sort()) === JSON.stringify(right.sort());
  if (!same(actualFiles, [...expected.keys()]) || !same(actualDirectories, [...manifest.tree.directories]) || !expected.has("artood.mjs")
    || filePin(manifestPin.path, 4 * 1024 * 1024).sha256 !== manifestPin.sha256) throw Error("Supervised bundle inventory changed");
  return manifestPin;
}

const incarnation = z.object({ generation: z.number().int().min(0).max(8), daemon: identity,
  rootWaitObserved: z.literal(true), exitCode: z.number().int().nonnegative(), stdoutEof: z.literal(true), stderrEof: z.literal(true),
  atomicJobMember: z.literal(true) }).strict();
const closure = z.object({ version: z.literal(1), capability: z.literal(CAPABILITY), jobCreated: z.literal(true),
  allRootsWaitObserved: z.literal(true), jobEmptyObserved: z.literal(true), allStdoutEof: z.literal(true), allStderrEof: z.literal(true),
  cleanupConfirmed: z.literal(true), gracefulStopArmed: z.literal(true), gracefulStopTimedOut: z.literal(false), forcedJobTermination: z.boolean() }).strict();
export interface SupervisorProcessObservation { spawned: boolean; exited: boolean; closed: boolean; stdoutEof: boolean; stderrEof: boolean;
  exitCode: number | null; closeCode: number | null; signal: string | null; closeSignal: string | null }
const diagnosticNativeReason = z.enum(["stopped", "output_failed", "output_limit", "daemon_input_failed", "control_eof_or_invalid",
  "lifetime_expired", "graceful_stop_timeout", "daemon_failed_during_stop", "restart_budget_exhausted", "lifetime_cleanup_unconfirmed",
  "supervisor_admission_or_lifecycle_failed"]);
const diagnosticLifetime = z.object({ version: z.literal(1), capability: z.literal(CAPABILITY), jobCreated: z.boolean(),
  allRootsWaitObserved: z.boolean(), jobEmptyObserved: z.boolean(), allStdoutEof: z.boolean(), allStderrEof: z.boolean(),
  cleanupConfirmed: z.boolean(), gracefulStopArmed: z.boolean(), gracefulStopTimedOut: z.boolean(), forcedJobTermination: z.boolean() });

/** A lifecycle parser cannot manufacture a receipt; success also joins the original ChildProcess observations. */
export class SupervisedLifecycle {
  private sequence = 0;
  private digest: string | undefined;
  private readonly generations = new Map<number, z.infer<typeof identity>>();
  private readonly exited = new Set<number>();
  private readonly text = new Map<number, { decoder: StringDecoder; pending: string }>();
  private readonly diagnosticCounts = new Map<number, number>();
  private readonly stopDiagnosticCounts = new Map<number, number>();
  private readonly sourceDiagnosticCounts = new Map<number, number>();
  private terminal: unknown;
  private armed: { nonce: string; generation: number } | undefined;
  private armAcknowledged = false;
  private stopAcknowledged = false;
  generation = -1;
  ready = false;
  constructor(private readonly nonce: string, private readonly runtimeManifest: z.infer<typeof pinSchema>,
    private readonly startupDiagnostic?: (generation: number, diagnostic: WindowsStartupDiagnostic) => void,
    private readonly stopDiagnostic?: (generation: number, diagnostic: WindowsStopDiagnostic) => void,
    private readonly sourceCommandDiagnostic?: (generation: number, diagnostic: SourceCommandDiagnostic) => void) { uuid.parse(nonce); pinSchema.parse(runtimeManifest); }
  arm(nonce: string) {
    uuid.parse(nonce);
    if (this.armed || this.generation < 0 || this.exited.has(this.generation)) throw Error("No current live daemon can begin graceful stop");
    this.armed = { nonce, generation: this.generation }; this.ready = false;
    return { version: 1, kind: "arm-graceful-stop", nonce, generation: this.generation };
  }
  accept(value: unknown): "started" | "ready" | "armed" | "terminal" | undefined {
    const frame = z.object({ version: z.literal(1), kind: z.string(), sequence: z.number().int().nonnegative(), payload: z.unknown() }).strict().parse(value);
    if (frame.sequence !== this.sequence++) throw Error("Supervisor frame sequence changed");
    if (this.terminal) throw Error("Supervisor emitted data after terminal closure");
    if (frame.kind === "supervisor_ready") {
      const facts = z.object({ capability: z.literal("artoo.windows-daemon-supervisor.v1"), supervisor: identity,
        launchIdentityDigest: hash, lifetimeOwnership: lifetime }).strict().parse(frame.payload);
      if (this.digest || facts.lifetimeOwnership.cleanupTimeoutMs !== LIFETIME.cleanupTimeoutMs
        || facts.lifetimeOwnership.gracefulStopMs !== LIFETIME.gracefulStopMs
        || JSON.stringify(facts.lifetimeOwnership.runtimeManifest) !== JSON.stringify(this.runtimeManifest)) throw Error("Supervisor changed its fixed lifetime binding");
      this.digest = facts.launchIdentityDigest; return;
    }
    if (!this.digest) throw Error("Supervisor has not admitted the fixed launch");
    if (frame.kind === "daemon_started") {
      const facts = z.object({ generation: z.number().int().min(0).max(8), daemon: identity, launchIdentityDigest: hash,
        atomicJobMember: z.literal(true) }).strict().parse(frame.payload);
      if (this.armed || facts.generation !== this.generation + 1 || facts.launchIdentityDigest !== this.digest
        || this.generation >= 0 && !this.exited.has(this.generation)) throw Error("Supervisor replaced a daemon without its original exit");
      this.generation = facts.generation; this.generations.set(facts.generation, facts.daemon); this.ready = false;
      this.text.set(facts.generation, { decoder: new StringDecoder("utf8"), pending: "" }); return "started";
    }
    if (frame.kind === "daemon_exit") {
      const facts = z.object({ generation: z.number().int(), daemon: identity, rootWaitObserved: z.literal(true), exitCode: z.number().int(),
        exitTime: z.string().regex(/^\d+$/), stdoutEof: z.boolean(), stderrEof: z.boolean() }).strict().parse(frame.payload);
      if (JSON.stringify(this.generations.get(facts.generation)) !== JSON.stringify(facts.daemon) || this.exited.has(facts.generation)) throw Error("Supervisor changed an original daemon exit");
      this.exited.add(facts.generation); if (facts.generation === this.generation) this.ready = false; return;
    }
    if (frame.kind === "command_ack") {
      const facts = z.object({ nonce: uuid, kind: z.string(), generation: z.number().int() }).strict().parse(frame.payload);
      if (facts.kind === "arm-graceful-stop") {
        if (!this.armed || this.armAcknowledged || facts.nonce !== this.armed.nonce || facts.generation !== this.armed.generation) throw Error("Unmatched graceful-stop acknowledgement");
        this.armAcknowledged = true; return "armed";
      }
      return;
    }
    if (frame.kind === "daemon_output") {
      const facts = z.object({ generation: z.number().int(), stream: z.enum(["stdout", "stderr"]), data: z.string() }).strict().parse(frame.payload);
      if (!this.generations.has(facts.generation)) throw Error("Supervisor output has no original daemon");
      const bytes = Buffer.from(facts.data, "base64");
      if (bytes.toString("base64") !== facts.data || bytes.length > 16384) throw Error("Invalid bounded daemon output");
      if (facts.stream !== "stdout") return;
      const output = this.text.get(facts.generation)!; output.pending += output.decoder.write(bytes);
      if (Buffer.byteLength(output.pending) > 65536) throw Error("Daemon lifecycle line exceeds its bound");
      let action: "ready" | undefined;
      for (let end; (end = output.pending.indexOf("\n")) >= 0;) {
        const line = output.pending.slice(0, end); output.pending = output.pending.slice(end + 1);
        if (!line.startsWith(PREFIX)) continue;
        const value: unknown = JSON.parse(line.slice(PREFIX.length));
        if (value && typeof value === "object" && "kind" in value && value.kind === "source_command") {
          const event = z.object({ version: z.literal(1), kind: z.literal("source_command"), nonce: uuid,
            pid: z.number().int().positive(), diagnostic: SourceCommandDiagnosticSchema }).strict().parse(value);
          if (event.nonce !== this.nonce || event.pid !== this.generations.get(facts.generation)!.pid) throw Error("Daemon source diagnostic binding changed");
          const count = (this.sourceDiagnosticCounts.get(facts.generation) ?? 0) + 1;
          if (count > SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents + SOURCE_COMMAND_DIAGNOSTIC_LIMITS.failureEvents)
            throw Error("Daemon source diagnostics exceeded their bound");
          this.sourceDiagnosticCounts.set(facts.generation, count);
          // A diagnostic cannot acknowledge a command, readiness, native closure or publication.
          try { void Promise.resolve(this.sourceCommandDiagnostic?.(facts.generation, event.diagnostic)).catch(() => {}); }
          catch { /* Optional observation cannot fail an otherwise valid lifecycle frame. */ }
          continue;
        }
        if (value && typeof value === "object" && "kind" in value && value.kind === "startup") {
          const event = z.object({ version: z.literal(1), kind: z.literal("startup"), nonce: uuid,
            pid: z.number().int().positive(), diagnostic: WindowsStartupDiagnosticSchema }).strict().parse(value);
          if (event.nonce !== this.nonce || event.pid !== this.generations.get(facts.generation)!.pid) throw Error("Daemon diagnostic binding changed");
          const count = (this.diagnosticCounts.get(facts.generation) ?? 0) + 1;
          if (count > 64) throw Error("Daemon startup diagnostics exceeded their bound");
          this.diagnosticCounts.set(facts.generation, count);
          // Diagnostics never acknowledge readiness, stop, process closure or an execution capability.
          this.startupDiagnostic?.(facts.generation, event.diagnostic); continue;
        }
        if (value && typeof value === "object" && "kind" in value && value.kind === "stop") {
          const event = z.object({ version: z.literal(1), kind: z.literal("stop"), nonce: uuid,
            pid: z.number().int().positive(), diagnostic: WindowsStopDiagnosticSchema }).strict().parse(value);
          if (event.nonce !== this.nonce || event.pid !== this.generations.get(facts.generation)!.pid) throw Error("Daemon stop diagnostic binding changed");
          const count = (this.stopDiagnosticCounts.get(facts.generation) ?? 0) + 1;
          if (count > 64) throw Error("Daemon stop diagnostics exceeded their bound");
          this.stopDiagnosticCounts.set(facts.generation, count);
          // A completed cleanup stage cannot acknowledge successful requested settlement.
          this.stopDiagnostic?.(facts.generation, event.diagnostic); continue;
        }
        const event = z.object({ version: z.literal(1), kind: z.enum(["ready", "stopped"]), nonce: uuid,
          pid: z.number().int().positive(), exitCode: z.number().int().min(0).max(1).optional() }).strict().parse(value);
        if (event.nonce !== this.nonce || event.pid !== this.generations.get(facts.generation)!.pid) throw Error("Daemon lifecycle binding changed");
        if (facts.generation !== this.generation) continue;
        if (event.kind === "ready") {
          // A ready line may already be buffered when the operator requests Stop.
          // It cannot make a stopping/dead generation ready, but is not a failure.
          if (this.armed || this.exited.has(facts.generation)) continue;
          if (event.exitCode !== undefined || this.ready) throw Error("Daemon readiness arrived outside its live registration");
          this.ready = true; action = "ready";
        } else {
          if (event.exitCode === undefined) throw Error("Daemon stop has no actual requested exit status");
          if (this.armed && (event.exitCode !== 0 || !this.armAcknowledged)) throw Error("Daemon stop lacks successful requested settlement");
          if (this.armAcknowledged) this.stopAcknowledged = true;
          this.ready = false;
        }
      }
      return this.ready ? action : undefined;
    }
    if (frame.kind === "supervisor_stopped" || frame.kind === "supervisor_failed") {
      this.terminal = frame; this.ready = false; return "terminal";
    }
    if (frame.kind === "daemon_input_failed") throw Error("Supervisor could not deliver daemon shutdown");
    if (!["daemon_pipe_eof", "daemon_input_written"].includes(frame.kind)) throw Error("Unknown supervisor lifecycle frame");
  }
  /** Bounded observed facts only, including false/unknown failure closure. Never a success receipt. */
  diagnosticClosure(observed: SupervisorProcessObservation) {
    const terminal = z.object({ kind: z.enum(["supervisor_stopped", "supervisor_failed"]), payload: z.object({
      reason: z.unknown(), facts: z.object({ lifetimeClosure: z.unknown() }).nullable().optional() }) }).safeParse(this.terminal);
    const reason = diagnosticNativeReason.safeParse(terminal.success ? terminal.data.payload.reason : undefined);
    const lifetime = diagnosticLifetime.safeParse(terminal.success ? terminal.data.payload.facts?.lifetimeClosure : undefined);
    return { kind: "artoo.supervised.closure", generation: this.generation,
      native_terminal: terminal.success ? terminal.data.kind : "missing_or_invalid",
      native_reason: reason.success ? reason.data : "unrecognized_or_missing",
      native_lifetime: lifetime.success ? lifetime.data : null,
      supervisor_observed: { spawned: observed.spawned, exited: observed.exited, closed: observed.closed,
        stdout_eof: observed.stdoutEof, stderr_eof: observed.stderrEof, exit_code: observed.exitCode, close_code: observed.closeCode,
        signalled: observed.signal !== null, close_signalled: observed.closeSignal !== null } };
  }
  confirm(observed: SupervisorProcessObservation): void {
    const failed = z.object({ kind: z.literal("supervisor_failed"), payload: z.object({ reason: z.string().regex(/^[a-z_]{1,80}$/) }).passthrough() })
      .passthrough().safeParse(this.terminal);
    if (failed.success) throw Error(`Native supervisor ended without a clean stop: ${failed.data.payload.reason}`);
    const terminal = z.object({ kind: z.literal("supervisor_stopped"), payload: z.object({ reason: z.literal("stopped"),
      facts: z.object({ launchIdentityDigest: hash, incarnations: z.array(incarnation).min(1).max(9), lifetimeClosure: closure }).strict() }).strict(),
    }).passthrough().parse(this.terminal);
    const facts = terminal.payload.facts;
    if (!this.armAcknowledged || !this.stopAcknowledged || !this.armed || facts.launchIdentityDigest !== this.digest
      || facts.incarnations.length !== this.generations.size || facts.incarnations.at(-1)?.exitCode !== 0
      || facts.incarnations.some((item, index) => item.generation !== index || !this.exited.has(index)
        || JSON.stringify(item.daemon) !== JSON.stringify(this.generations.get(index)))
      || !observed.spawned || !observed.exited || !observed.closed || !observed.stdoutEof || !observed.stderrEof
      || observed.exitCode !== 0 || observed.closeCode !== 0 || observed.signal !== null || observed.closeSignal !== null) {
      throw Error("Supervised shutdown lacks actual successful original process and Job closure");
    }
  }
}

/** The production parent owns only this exact native child; no PID discovery or lock repair. */
export async function launchWindowsSupervisedCli(env: NodeJS.ProcessEnv, config: ArtoodConfig, entry: string): Promise<void> {
  if (process.platform !== "win32" || process.connected !== undefined || !config.windowsProcessBackend || !config.productSourceConfigFile
    || config.managedJournal || config.worktreeBaseRepo) throw Error("Supervised CLI requires ordinary standalone native Windows configuration");
  if (env.ARTOO_SOURCE_CLEAN_CONFIG_FILE !== undefined) {
    const { launchCleanWindowsSupervisedCli } = await import("./windows-clean-launcher.js");
    return launchCleanWindowsSupervisedCli(env, config, entry);
  }
  if (env.ARTOO_SOURCE_CLEAN_RESTART_STOP_ID !== undefined) throw Error("Clean restart selection requires protected lineage configuration");
  const stdinControl = supervisedStdinControlEnabled(env.ARTOO_SUPERVISED_STDIN_CONTROL);
  const nonce = randomUUID(), childEnv = supervisedEnvironment(env, nonce);
  const local = prepareProductSourceConfiguration({ file: config.productSourceConfigFile, allowedRoots: config.allowedRoots });
  if (!local.config.recovery) throw Error("Supervised CLI requires explicit protected recovery configuration");
  const bootstrapGit = config.initializeRepository ? prepareProductBootstrapGit({ file: local.config.gitExecutable,
    allowedRoots: config.allowedRoots, assertConfigurationUnchanged: () => {
      if (local.read().identity !== local.original.identity) throw Error("Product bootstrap source configuration changed");
    } }) : undefined;
  // This projection is selected from protected local configuration by this
  // original parent. The environment allowlist never copies an inherited value.
  if (bootstrapGit) childEnv.ARTOO_SUPERVISED_BOOTSTRAP_GIT = JSON.stringify(describeProductBootstrapGit(bootstrapGit));
  const runtimeManifest = inspectBundle(entry, env.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256, config.allowedRoots);
  const installation = describeWindowsProcessInstallation(config.windowsProcessBackend);
  const manifest = JSON.parse(readFileSync(join(installation.directory, "manifest.json"), "utf8")) as { executable: string; capabilities?: string[] };
  if (!manifest.capabilities?.includes(CAPABILITY)) throw Error("Native installation lacks shared supervisor lifetime ownership");
  const executable = join(installation.directory, manifest.executable), node = filePin(realpathSync.native(process.execPath));
  if (basename(node.path).toLowerCase() !== "node.exe") throw Error("Supervised CLI requires native node.exe");
  const launch = { version: 1, kind: "launch", node, entry: filePin(entry), configuration: filePin(local.file, 1024 * 1024), runtimeManifest,
    cwd: dirname(entry), args: [SUPERVISED_DAEMON], env: childEnv, maxRestarts: 8, restartBackoffMs: 1000,
    lifetimeMs: 86_400_000, outputLimitBytes: 16_777_216, lifetimeOwnership: LIFETIME };
  if (launch.configuration.sha256 !== sha(local.original.bytes)) throw Error("Source configuration changed before supervised launch");
  const line = JSON.stringify(launch) + "\n";
  if (Buffer.byteLength(line) >= 65536) throw Error("Supervised launch configuration exceeds the native input bound");
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw Error("Supervised CLI requires the local Windows system directory");
  // A separate Windows process group prevents Ctrl+C from bypassing the graceful
  // control protocol. Pipes and the original child remain owned; no unref/breakaway.
  const child = spawn(executable, ["--daemon-supervisor-v1"], { cwd: installation.directory, windowsHide: true, shell: false, detached: true,
    stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") } });
  const observed: SupervisorProcessObservation = { spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false,
    exitCode: null, closeCode: null, signal: null, closeSignal: null };
  const lifecycle = new SupervisedLifecycle(nonce, runtimeManifest, (generation, diagnostic) => {
    process.stderr.write(JSON.stringify({ kind: "artoo.supervised.startup", generation, diagnostic }) + "\n");
  }, (generation, diagnostic) => {
    process.stderr.write(JSON.stringify({ kind: "artoo.supervised.stop", generation, diagnostic }) + "\n");
  }, (generation, diagnostic) => {
    process.stderr.write(JSON.stringify({ kind: "artoo.supervised.source-command", generation, diagnostic }) + "\n");
  }), decoder = new StringDecoder("utf8");
  let pending = "", diagnosticBytes = 0, failure: Error | undefined, stopping = false;
  let startup: ReturnType<typeof setTimeout> | undefined, cleanup: ReturnType<typeof setTimeout> | undefined, emergency: ReturnType<typeof setTimeout> | undefined;
  const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n", error => { if (error) fail(error); });
  const fail = (cause: unknown) => {
    failure ??= cause instanceof Error ? cause : Error("Supervised lifecycle failed");
    clearTimeout(startup);
    if (!stopping) { stopping = true; write({ version: 1, kind: "stop", nonce: randomUUID() }); }
    emergency ??= setTimeout(() => { failure ??= Error("Native supervised closure deadline elapsed"); child.kill(); }, 40_000);
  };
  const stop = () => {
    if (stopping) return; stopping = true; clearTimeout(startup);
    try { write(lifecycle.arm(randomUUID())); }
    catch (error) { stopping = false; fail(error); return; }
    cleanup = setTimeout(() => { fail(Error("Graceful supervised shutdown deadline elapsed")); child.kill(); },
      LIFETIME.gracefulStopMs + LIFETIME.cleanupTimeoutMs + 5000);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const removeStdinControl = stdinControl ? installSupervisedStdinControl(process.stdin, stop, fail) : () => {};
  const closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
    observed.closed = true; observed.closeCode = code; observed.closeSignal = signal; resolve();
  }));
  child.once("spawn", () => { observed.spawned = true; });
  child.once("exit", (code, signal) => { observed.exited = true; observed.exitCode = code; observed.signal = signal; });
  child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      pending += decoder.write(bytes); if (Buffer.byteLength(pending) > 1024 * 1024) throw Error("Supervisor output line exceeds its bound");
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 1);
        const action = lifecycle.accept(JSON.parse(frame));
        if (action === "started") { clearTimeout(startup); startup = setTimeout(() => fail(Error("Daemon registration readiness timed out")), DAEMON_REGISTRATION_MS); }
        if (action === "ready" && lifecycle.ready && !stopping) { clearTimeout(startup); process.stdout.write(JSON.stringify({ kind: "artoo.supervised.ready", generation: lifecycle.generation, node_id: config.nodeId }) + "\n"); }
        if (action === "armed") write({ version: 1, kind: "daemon-input", nonce: randomUUID(), generation: lifecycle.generation,
          data: Buffer.from(JSON.stringify({ version: 1, kind: "shutdown", nonce }) + "\n").toString("base64") });
      }
    } catch (error) { fail(error); }
  });
  child.stdout.once("end", () => { pending += decoder.end(); observed.stdoutEof = true; if (pending.length) fail(Error("Supervisor closed with an incomplete frame")); });
  // Native diagnostics never authorize success and never echo launch environment or credentials.
  child.stderr.on("data", (bytes: Buffer) => { diagnosticBytes += bytes.length; if (diagnosticBytes > 65536) fail(Error("Supervisor diagnostics exceeded their bound")); });
  child.stderr.once("end", () => { observed.stderrEof = true; });
  startup = setTimeout(() => fail(Error("Supervisor did not start a registered daemon")), SUPERVISOR_STARTUP_MS);
  child.stdin.write(line, error => { if (error) fail(error); });
  try { await closed; process.stderr.write(JSON.stringify(lifecycle.diagnosticClosure(observed)) + "\n");
    if (failure) throw failure; if (bootstrapGit) readProductBootstrapGit(bootstrapGit); lifecycle.confirm(observed); }
  finally { clearTimeout(startup); clearTimeout(cleanup); clearTimeout(emergency); process.off("SIGINT", stop); process.off("SIGTERM", stop); removeStdinControl(); }
  process.stdout.write(JSON.stringify({ kind: "artoo.supervised.stopped", cleanupConfirmed: true }) + "\n");
}

/** Private inherited-stdio control. The selector/nonce only route messages; native qualification is still mandatory. */
export async function runWindowsSupervisedDaemon(env: NodeJS.ProcessEnv, outer: ShutdownHost,
  start: (host: ShutdownHost, ready: () => Promise<void>) => Promise<unknown>): Promise<void> {
  if (process.platform !== "win32" || outer.connected !== undefined || env.ARTOO_WORKER_LAUNCH_ID) throw Error("Controlled daemon requires native standalone supervision");
  const nonce = uuid.parse(env.ARTOO_SUPERVISED_CONTROL_NONCE), events = new EventEmitter();
  if ((env.ARTOO_SOURCE_CLEAN_CONFIG_FILE === undefined) !== (env.ARTOO_SOURCE_LIFECYCLE_OBSERVER_ID === undefined))
    throw Error("Clean daemon lineage and original observer selection must be paired");
  const cleanControl = env.ARTOO_SOURCE_CLEAN_CONFIG_FILE === undefined ? undefined
    : installCleanDaemonControl(nonce, env.ARTOO_SOURCE_LIFECYCLE_OBSERVER_ID!);
  const writeStopDiagnostic = createWindowsStopDiagnosticWriter(process.stdout, error => failed("daemon_notification", error));
  const stopDiagnostics = createWindowsStopDiagnostics(diagnostic => {
    writeStopDiagnostic(PREFIX + JSON.stringify({ version: 1, kind: "stop", nonce, pid: process.pid, diagnostic }) + "\n");
  });
  let broken = false, exiting = false, pending = "", cleanBindingSettled = false;
  const decoder = new StringDecoder("utf8");
  const notify = (kind: "ready" | "stopped", exitCode?: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Daemon lifecycle output did not close")), 5000);
    process.stdout.write(PREFIX + JSON.stringify({ version: 1, kind, nonce, pid: process.pid, ...(exitCode === undefined ? {} : { exitCode }) }) + "\n",
      error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
  const request = () => {
    // Latch the ordinary shutdown first, then release only an unfinished
    // parent bind. Otherwise node.stop waits for its 30-second bind deadline.
    events.emit("message", { type: "shutdown" });
    if (!cleanBindingSettled) cleanControl?.invalidate(Error("Original clean parent binding cancelled by shutdown"));
  };
  const failed = (phase: "daemon_input" | "daemon_signal" | "daemon_notification", cause?: unknown) => {
    stopDiagnostics.record(phase, "failed", cause);
    broken = true; cleanControl?.invalidate(Error("Original controlled daemon pipe failed")); request();
  };
  const host: ShutdownHost = { stopDiagnostics,
    sourceCommandDiagnostic(diagnostic) {
      writeStopDiagnostic(PREFIX + JSON.stringify({ version: 1, kind: "source_command", nonce, pid: process.pid, diagnostic }) + "\n");
    },
    argv: outer.argv, on: (event, listener) => events.on(event, listener), off: (event, listener) => events.off(event, listener),
    exit(code) { if (exiting) return; exiting = true; cleanControl?.invalidate(Error("Original controlled daemon stopped")); const status = broken || code !== 0 ? 1 : 0;
      void notify("stopped", status).then(() => outer.exit(status), error => {
        stopDiagnostics.record("daemon_notification", "failed", error); outer.exit(1);
      }); } };
  const input = (bytes: Buffer) => {
    try {
      pending += decoder.write(bytes); if (Buffer.byteLength(pending) > 4096) throw Error("Invalid controlled daemon input");
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const parsed: unknown = JSON.parse(line);
        if (cleanControl && typeof parsed === "object" && parsed !== null && "kind" in parsed && parsed.kind === "source-lifecycle-bound") {
          cleanControl.accept(parsed); cleanBindingSettled = true; continue;
        }
        const command = z.object({ version: z.literal(1), kind: z.literal("shutdown"), nonce: uuid }).strict().parse(parsed);
        if (command.nonce !== nonce) throw Error("Controlled daemon input changed its launch binding"); request();
      }
    } catch (error) { failed("daemon_input", error); }
  };
  process.stdin.on("data", input); process.stdin.once("end", () => failed("daemon_input")); process.stdin.on("error", error => failed("daemon_input", error));
  outer.on("SIGINT", () => failed("daemon_signal")); outer.on("SIGTERM", () => failed("daemon_signal"));
  try { await withWindowsStartupDiagnostics(diagnostic => {
    process.stdout.write(PREFIX + JSON.stringify({ version: 1, kind: "startup", nonce, pid: process.pid, diagnostic }) + "\n");
  }, () => start(host, () => { if (broken || exiting) throw Error("Controlled daemon stopped before readiness"); return notify("ready"); })); }
  catch (error) { broken = true; host.exit(1); throw error; }
}
