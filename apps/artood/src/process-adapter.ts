import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";

import type { ArtifactPayload, ArtifactType } from "@artoo/domain";
import type {
  AgentInstanceConfig,
  AgentInstanceHandle,
  ArtifactDescriptor,
  RunEvent,
  RuntimeAdapter,
  StopReason
} from "@artoo/protocol";
import { assertWorkspaceScope } from "@artoo/protocol";
import { resolveCliCommand } from "./cli-resolver.js";
import { createStructuredOutput, type ProcessOutputFormat } from "./structured-output.js";
import { assertOwnedContextForLaunch, assertOwnedContextLocalBoundary, writeOwnedContextFile } from "./owned/owned-context.js";
import { assertOwnedMaterializedWorktree, assertOwnedWorktreeLocalBoundary, WorktreeReservationError, type MaterializedWorktree } from "./owned/worktree-reservation.js";
import { OwnedGitError } from "./owned/owned-git.js";
import type { OwnedAdmissionIdentity, OwnedPhysicalFacts, OwnedRunAdmission, OwnedRunRuntimeAdapter, OwnedRunStatusReceipt, OwnedStartupReceipt, OwnedStopReceipt } from "./process-adapter-owned-receipts.js";
export type { OwnedAdmissionIdentity, OwnedPhysicalFacts, OwnedRunAdmission, OwnedRunRuntimeAdapter, OwnedRunStatusReceipt, OwnedStartupReceipt, OwnedStopReceipt } from "./process-adapter-owned-receipts.js";

interface AdmissionState { identity: Readonly<OwnedAdmissionIdentity>; claimed: boolean }
interface ReceiptScope { admission: WeakRef<OwnedRunAdmission>; worktree: WeakRef<MaterializedWorktree>; handle?: WeakRef<AgentInstanceHandle> }
interface StartupAuthentication extends ReceiptScope { receipt: OwnedStartupReceipt }
interface PhysicalAuthentication extends ReceiptScope { receipt: OwnedStopReceipt | OwnedRunStatusReceipt }
interface OwnedControl {
  facts(): OwnedPhysicalFacts;
  confirmClosed(): Promise<OwnedPhysicalFacts>;
  stop(reason: StopReason): Promise<OwnedPhysicalFacts>;
  inspect(): Promise<"running" | "confirmed_closed" | "uncertain">;
}
interface OwnedInvocation extends ReceiptScope {
  owner: object;
  genuine: boolean;
  spawnAttempted: boolean;
  helperUncertain: boolean;
  control?: OwnedControl;
  closedFacts?: OwnedPhysicalFacts;
  queue?: AsyncEventQueue<RunEvent>;
  workspaceRoot: string;
  discussion: boolean;
}
const ownedAdmissions = new WeakMap<OwnedRunAdmission, AdmissionState>();
const ownedAdapters = new WeakMap<RuntimeAdapter, Readonly<Record<string, unknown>>>();
const ownedStartupErrors = new WeakMap<object, StartupAuthentication>();
const ownedStopReceipts = new WeakMap<object, PhysicalAuthentication>();
const ownedStatusReceipts = new WeakMap<object, PhysicalAuthentication>();
const ownedExecutions = new WeakMap<AgentInstanceHandle, OwnedInvocation>();
const weakKey = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

export function createOwnedRunAdmission(identity: OwnedAdmissionIdentity): OwnedRunAdmission {
  const value = Object.freeze({ launchKey: identity.launchKey, runId: identity.runId, taskId: identity.taskId,
    agentInstanceId: identity.agentInstanceId, runtime: identity.runtime, workspaceRoot: identity.workspaceRoot,
    workspaceBranch: identity.workspaceBranch });
  if (Object.values(value).some((item) => typeof item !== "string" || !item || item.includes("\0"))) throw new Error("A complete local owned admission identity is required");
  const admission = Object.freeze({}) as OwnedRunAdmission;
  ownedAdmissions.set(admission, { identity: value, claimed: false });
  return admission;
}

export function isOwnedRunAdapter(adapter: RuntimeAdapter): adapter is OwnedRunRuntimeAdapter {
  const methods = ownedAdapters.get(adapter);
  if (!methods) return false;
  // Do not invoke arbitrary getters while checking a capability boundary.
  return Object.entries(methods).every(([name, method]) => Object.getOwnPropertyDescriptor(adapter, name)?.value === method);
}

function matchesScope(scope: ReceiptScope, admission: OwnedRunAdmission, handle?: AgentInstanceHandle): boolean {
  return scope.admission.deref() === admission && ownedAdmissions.has(admission)
    && (handle === undefined || scope.handle?.deref() === handle);
}
export function getOwnedStartupReceipt(error: unknown, admission: OwnedRunAdmission, worktree: MaterializedWorktree): OwnedStartupReceipt | undefined {
  const value = weakKey(error) ? ownedStartupErrors.get(error) : undefined;
  return value && matchesScope(value, admission) && value.worktree.deref() === worktree ? value.receipt : undefined;
}
export function getOwnedStopReceipt(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle): OwnedStopReceipt | undefined {
  const found = weakKey(value) ? ownedStopReceipts.get(value) : undefined;
  return found && matchesScope(found, admission, handle) ? found.receipt as OwnedStopReceipt : undefined;
}
export function getOwnedRunStatusReceipt(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle): OwnedRunStatusReceipt | undefined {
  const found = weakKey(value) ? ownedStatusReceipts.get(value) : undefined;
  return found && matchesScope(found, admission, handle) ? found.receipt as OwnedRunStatusReceipt : undefined;
}

function confirmedHelperFailure(error: unknown, signal: AbortSignal): boolean {
  const seen = new Set<unknown>();
  for (let item = error; item && !seen.has(item);) {
    seen.add(item);
    if (item instanceof OwnedGitError) return item.receipt.cleanupConfirmed === true;
    if (signal.aborted && item === signal.reason) return true;
    if (!(item instanceof WorktreeReservationError)) return false;
    item = Object.getOwnPropertyDescriptor(item, "cause")?.value;
  }
  return false;
}

async function ownedPreparation<T>(invocation: OwnedInvocation | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (invocation) invocation.helperUncertain = true;
  try {
    const result = await operation();
    if (invocation) invocation.helperUncertain = false;
    return result;
  } catch (error) {
    if (invocation && signal) invocation.helperUncertain = !confirmedHelperFailure(error, signal);
    throw error;
  }
}

async function boundedOwnedWait(promise: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned physical closure remains uncertain")), Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Process-based {@link RuntimeAdapter} (design §5.2 minimal model). Runs a CLI
 * coding agent (e.g. Codex) as a child process and maps its lifecycle to the
 * RunEvent contract:
 *
 *   spawn         -> run.lifecycle(started)
 *   stdout/stderr -> run.output (line-buffered)
 *   exit 0        -> collect artifacts -> artifact.created* -> run.lifecycle(completed)
 *   exit non-zero -> run.lifecycle(failed, reason)
 *
 * The workspace allowlist is enforced before spawn (design §4.7); an out-of-scope
 * workspace throws WorkspaceScopeError and the run never starts. Task #7 only
 * supplies this real adapter; the node-side loop and contract come from #6's
 * createNodeClient, unchanged.
 */
export interface ArtifactSpec {
  type: ArtifactType;
  /** Path relative to the workspace root. */
  path: string;
}

export interface ProcessAdapterOptions {
  runtimeId?: string;
  /** argv template; supports {{workspace_root}} and {{context_pack_path}}. */
  command: string[];
  /** Explicit operator-configured read-only command for discussion sessions. */
  discussionCommand?: string[];
  /** Workspace allowlist enforced before spawn. */
  allowedRoots: string[];
  /** Artifacts collected from the workspace after the run completes. */
  artifacts?: ArtifactSpec[];
  contextPackFilename?: string;
  /** Recognized CLI JSONL output; overrides/fixtures default to plain logs. */
  outputFormat?: ProcessOutputFormat;
}

interface RunState {
  queue: AsyncEventQueue<RunEvent>;
  kill: () => Promise<void>;
  workspaceRoot: string;
  discussion: boolean;
  stopReason?: StopReason;
}

/** Resolve existing ancestors so symlinks/junctions cannot bypass root policy. */
export function assertRealWorkspaceScope(target: string, allowedRoots: readonly string[]): void {
  const canonical = (path: string): string => {
    // Keep the original spelling until the OS resolves existing symlinks and
    // '..'. Lexically normalizing first can authorize a different directory.
    let existing = path;
    const suffix: string[] = [];
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(existing), component = basename(existing);
        // A missing ancestor followed by '..' has no current OS resolution.
        if (parent === existing || component === "..") throw error;
        suffix.unshift(component);
        existing = parent;
      }
    }
    // lstat recognizes dangling links. Resolve outside the ENOENT fallback so
    // they fail closed instead of being mistaken for ordinary missing names.
    return resolve(realpathSync.native(existing), ...suffix);
  };
  assertWorkspaceScope(canonical(target), allowedRoots.map(canonical));
}

async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveStop, rejectStop) => {
      const killer = spawn(resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      let output = "";
      killer.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
      killer.once("error", rejectStop);
      killer.once("close", (code) => {
        // 128 means the requested root PID already exited. Windows descendant
        // containment remains taskkill-based; POSIX uses an owned group below.
        if (code === 0 || code === 128) resolveStop();
        else rejectStop(new Error(`could not stop process tree (${code}): ${output}`));
      });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // macOS can briefly report EPERM while killed members are being
        // reaped. Retry the observation, never count EPERM as a stopped group.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      await new Promise((resolveStop) => setTimeout(resolveStop, 20));
    }
    throw new Error("CLI process group did not exit after termination");
  }
}

// A small independent Node process owns a pipe from the daemon. If the daemon
// crashes (including an Electron worker kill), pipe EOF kills the CLI's process
// tree. POSIX cleanup disarms it only after the owned group is gone. No task
// content becomes executable, and detached/setsid escape is not containment.
const PROCESS_GUARDIAN = `
const {spawn}=require('node:child_process');
const pid=Number(process.argv[1]);
let disarmed=false;
process.stdin.on('data',()=>{disarmed=true;});
process.stdin.on('end',async()=>{
  if(disarmed) return;
  if(process.platform==='win32') spawn(require('node:path').resolve(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  else {
    try {
      process.kill(-pid,'SIGKILL');
      const deadline=Date.now()+5000;
      while(Date.now()<deadline) {
        try { process.kill(-pid,0); } catch(error) { if(error.code!=='EPERM') throw error; }
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      process.exitCode=1;
    } catch(error) { if(error.code!=='ESRCH') process.exitCode=1; }
  }
});
process.stdin.resume();
`;

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined as never, done: true });
      waiter = this.waiters.shift();
    }
  }

  async *drain(): AsyncIterable<T> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

function makeLineEmitter(onLine: (text: string) => void): {
  feed(chunk: Buffer | string): void;
  flush(): void;
} {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    feed(chunk): void {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    }
  };
}

function renderContextPack(config: AgentInstanceConfig): string {
  const pack = config.runStart.context_pack;
  const lines: string[] = [
    `# Context Pack ${pack.id}`,
    `task: ${config.taskId}`,
    `run: ${config.runId}`,
  ];
  if (pack.uri) {
    lines.push(`uri: ${pack.uri}`);
  }
  if (pack.payload) {
    lines.push(
      "",
      "## Task",
      `id: ${pack.payload.task.id}`,
      `title: ${pack.payload.task.title}`,
      `description: ${pack.payload.task.description}`,
      "acceptance_criteria:",
      ...pack.payload.task.acceptance_criteria.map((criterion) => `- ${criterion}`),
      "",
      "## Project",
      `id: ${pack.payload.project.id}`,
      `name: ${pack.payload.project.name}`,
      `default_workspace: ${pack.payload.project.default_workspace ?? ""}`,
      "",
      "## Workspace",
      `root: ${pack.payload.workspace.root}`,
      "file_scope:",
      ...pack.payload.workspace.file_scope.map((scope) => `- ${scope}`),
      "",
      "## Policy",
      "filesystem_write_scope:",
      ...pack.payload.policy.filesystem_write_scope.map((scope) => `- ${scope}`),
      "requires_approval:",
      ...pack.payload.policy.requires_approval.map((approval) => `- ${approval}`),
      "",
      "## Memory",
      `task_summary: ${pack.payload.memory.task_summary ?? ""}`,
      "project_notes:",
      ...pack.payload.memory.project_notes.map((note) => `- ${note}`),
      "",
      "## Expected Artifacts",
      ...pack.payload.artifacts.expected.map((artifact) => `- ${artifact}`),
      "",
      "## Raw Payload",
      JSON.stringify(pack.payload, null, 2)
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Local execution seam; the materialized handle is never a wire field. */
export interface OwnedWorktreeRuntimeAdapter extends RuntimeAdapter {
  /** Startup signal only. Use the same controller in helper preparation for prompt Git cancellation. */
  startOwnedWorktree(config: AgentInstanceConfig, worktree: MaterializedWorktree, startupSignal?: AbortSignal): Promise<AgentInstanceHandle>;
}

export function createProcessAdapter(options: ProcessAdapterOptions): OwnedWorktreeRuntimeAdapter & OwnedRunRuntimeAdapter {
  const runtimeId = options.runtimeId ?? "process";
  const contextPackFilename = options.contextPackFilename ?? "context_pack.md";
  const artifactSpecs = options.artifacts ?? [];
  const runs = new Map<string, RunState>();
  const ownedOwner = Object.freeze({});

  function workspacePath(workspaceRoot: string, relativePath: string): string {
    // Resolve the existing root before joining: its raw symlink/.. spelling
    // must designate the same directory for context files and the child cwd.
    const physicalRoot = realpathSync.native(workspaceRoot);
    const absolute = resolve(physicalRoot, relativePath);
    assertWorkspaceScope(absolute, [physicalRoot]);
    assertRealWorkspaceScope(absolute, [physicalRoot]);
    return absolute;
  }

  function artifactPaths(workspaceRoot: string): Array<ArtifactSpec & { absolute: string }> {
    return artifactSpecs.map((spec) => ({ ...spec, absolute: workspacePath(workspaceRoot, spec.path) }));
  }

  function collectDescriptors(workspaceRoot: string): ArtifactDescriptor[] {
    const descriptors: ArtifactDescriptor[] = [];
    for (const spec of artifactPaths(workspaceRoot)) {
      const absolute = spec.absolute;
      if (!existsSync(absolute)) {
        continue;
      }
      const content = readFileSync(absolute);
      const payload: ArtifactPayload = {
        type: spec.type,
        uri: pathToFileURL(absolute).href,
        metadata: { path: spec.path },
        checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`
      };
      descriptors.push({ payload, localPath: absolute });
    }
    return descriptors;
  }

  async function startProcess(config: AgentInstanceConfig, worktree?: MaterializedWorktree, startupSignal?: AbortSignal, invocation?: OwnedInvocation): Promise<AgentInstanceHandle> {
      const workspaceRoot = config.workspaceRoot, runId = config.runId;
      if (worktree) {
        if (config.workspaceRoot !== worktree.root || config.runStart.workspace.root !== worktree.root
          || config.runStart.workspace.branch !== worktree.branch || config.runId !== config.runStart.run_id
          || config.taskId !== config.runStart.task_id || config.agentInstanceId !== config.runStart.agent_instance_id
          || config.runtime !== config.runStart.runtime) throw new Error("Owned worktree start identity differs");
      }
      // Enforce the workspace allowlist before context writes or process launch.
      assertWorkspaceScope(config.workspaceRoot, options.allowedRoots);
      assertRealWorkspaceScope(config.workspaceRoot, options.allowedRoots);

      const discussion = config.runStart.context_pack.payload?.policy.execution_mode === "discussion";
      if (discussion && !options.discussionCommand) throw new Error("runtime has no explicitly configured read-only discussion command");

      const legacyContextPath = worktree ? undefined : workspacePath(config.workspaceRoot, contextPackFilename);
      artifactPaths(config.workspaceRoot);
      startupSignal?.throwIfAborted();
      const ownedContext = worktree ? await ownedPreparation(invocation, startupSignal,
        () => writeOwnedContextFile(worktree, contextPackFilename, renderContextPack(config))) : undefined;
      startupSignal?.throwIfAborted();
      const contextPackPath = ownedContext?.path ?? legacyContextPath!;
      if (!ownedContext) writeFileSync(contextPackPath, renderContextPack(config));

      const argv = (discussion ? options.discussionCommand! : options.command).map((part) =>
        part
          .replaceAll("{{workspace_root}}", config.workspaceRoot)
          .replaceAll("{{context_pack_path}}", contextPackPath)
      );
      const [cmd, ...args] = argv;
      if (cmd === undefined) {
        throw new Error("process adapter command template is empty");
      }

      const resolved = resolveCliCommand(cmd);
      if (!resolved) throw new Error(`runtime executable is unavailable or has an unsupported shell wrapper: ${cmd}`);
      if (ownedContext) {
        await ownedPreparation(invocation, startupSignal, () => assertOwnedContextForLaunch(ownedContext));
        // Fresh async Git observations end here. Keep the local boundary and
        // cancellation check adjacent to spawn, without an intervening await.
        if (invocation) invocation.helperUncertain = true;
        assertOwnedContextLocalBoundary(ownedContext);
        if (invocation) invocation.helperUncertain = false;
      }
      startupSignal?.throwIfAborted();
      if (invocation) invocation.spawnAttempted = true;
      const child = spawn(resolved[0]!, [...resolved.slice(1), ...args], { cwd: config.workspaceRoot, detached: process.platform !== "win32", windowsHide: true });
      // The agent receives its task via the command template + context pack, not
      // stdin. Close stdin so CLIs that read it (e.g. `codex exec` prints
      // "Reading additional input from stdin...") get EOF immediately instead of
      // blocking forever on an open, never-written pipe.
      child.stdin?.end();
      const queue = new AsyncEventQueue<RunEvent>();
      let finalized = false;
      let spawned = false;
      let childExitObserved = false, childStdioClosed = false, childSpawnFailed = false, groupAbsent = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });
      let termination: Promise<void> | undefined;
      let guardian: ChildProcess | undefined;
      let guardianClosed: Promise<void> | undefined;
      let guardianCloseObserved = false, guardianSpawned = false, guardianSpawnFailed = false;
      let guardianAttempted = false, guardianExitObserved = false, guardianGroupAbsent = false;
      let guardianStatus: number | null = null, guardianSignal: NodeJS.Signals | null = null;
      const structured = createStructuredOutput(options.outputFormat ?? "plain");
      // CLI diagnostics may echo authentication headers. Parse original JSON
      // first: a short key such as "type" must not alter protocol field names.
      // Redact log text separately and redact parsed values before publishing.
      const secret = process.env.ARTOO_CODEX_PROVIDER_KEY;
      const secretForms = secret ? [secret] : [];
      let allFormsKnown = !secret;
      const redact = (text: string): string => {
        // A provider can embed a JSON response inside another JSON diagnostic.
        // Cover every possible repeated JSON escaping level that fits in this
        // text, rather than assuming a single log serialization boundary.
        while (!allFormsKnown && secretForms.at(-1)!.length <= text.length) {
          const last = secretForms.at(-1)!;
          const escaped = JSON.stringify(last).slice(1, -1);
          if (escaped === last) allFormsKnown = true;
          else secretForms.push(escaped);
        }
        return [...secretForms].reverse().reduce((value, part) => value.replaceAll(part, "[redacted]"), text);
      };
      const redactLine = (raw: string): string => {
        if (!secret) return raw;
        // JSON may spell a secret with Unicode escapes. Normalize only records
        // requiring redaction; this output is never used as protocol input.
        try {
          const normalized = JSON.stringify(JSON.parse(raw));
          const safe = redact(normalized);
          return safe === normalized ? redact(raw) : safe;
        } catch { return redact(raw); }
      };
      const emit = (event: RunEvent): void => {
        if (event.type === "run.answer") event = { ...event, payload: { ...event.payload, text: redact(event.payload.text) } };
        else if (event.type === "run.lifecycle" && typeof event.payload.reason === "string") event = { ...event, payload: { ...event.payload, reason: redact(event.payload.reason) } };
        else if (event.type === "run.usage" && event.payload.provider_session_id) event = { ...event, payload: { ...event.payload, provider_session_id: redact(event.payload.provider_session_id) } };
        queue.push(event);
      };

      const stdout = makeLineEmitter((raw) => {
        const text = redactLine(raw);
        queue.push({ type: "run.output", payload: { stream: "stdout", text } });
        structured.consume(raw);
      });
      const stderr = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stderr", text: redactLine(text) } })
      );
      child.stdout?.on("data", (chunk: Buffer) => stdout.feed(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.feed(chunk));

      const state: RunState = {
        queue,
        workspaceRoot,
        discussion,
        kill: async () => {
          if (finalized) return;
          await beginTermination();
          await closed;
        }
      };

      function beginTermination(): Promise<void> {
        if (!termination) {
          termination = child.pid === undefined ? Promise.resolve() : stopProcessTree(child.pid);
          void termination.then(() => { groupAbsent = true; }, () => {});
        }
        return termination;
      }
      function zeroProbe(pid: number): "present" | "absent" | "unknown" {
        // POSIX signal zero is an existence query; it sends no signal.
        try { process.kill(pid, 0); return "present"; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
      }
      function physicalFacts(): OwnedPhysicalFacts {
        const childNeverSpawned = childSpawnFailed && !spawned && child.pid === undefined && childStdioClosed;
        const guardianNeverSpawned = !guardianAttempted || guardianSpawnFailed && !guardianSpawned && guardian?.pid === undefined && guardianCloseObserved;
        return Object.freeze({ childPid: child.pid ?? null, childSpawned: spawned, childExitObserved,
          childStdioClosed, groupAbsent: groupAbsent || childNeverSpawned,
          guardianPid: guardian?.pid ?? null, guardianAttempted, guardianSpawned, guardianExitObserved,
          guardianStdioClosed: guardianCloseObserved || !guardianAttempted,
          guardianGroupAbsent: guardianGroupAbsent || guardianNeverSpawned });
      }
      function observeFullClosure(): OwnedPhysicalFacts | undefined {
        const childNeverSpawned = childSpawnFailed && !spawned && child.pid === undefined && childStdioClosed;
        if (!(childNeverSpawned || childExitObserved && childStdioClosed && groupAbsent)) return;
        if (guardianAttempted) {
          const neverSpawned = guardianSpawnFailed && !guardianSpawned && guardian?.pid === undefined && guardianCloseObserved;
          if (!neverSpawned) {
            if (!guardianExitObserved || !guardianCloseObserved || guardianStatus !== 0 || guardianSignal !== null || guardian?.pid === undefined) return;
            if (!guardianGroupAbsent) guardianGroupAbsent = zeroProbe(-guardian.pid) === "absent";
            if (!guardianGroupAbsent) return;
          }
        }
        const facts = physicalFacts();
        if (invocation) {
          invocation.closedFacts = facts;
          invocation.control = undefined; // Closed tokens must not retain the child/guardian graph.
        }
        return facts;
      }
      async function confirmOwnedClosure(): Promise<OwnedPhysicalFacts> {
        const existing = invocation?.closedFacts ?? observeFullClosure();
        if (existing) return existing;
        const deadline = performance.now() + 5000;
        await boundedOwnedWait(closed, deadline);
        if (guardianAttempted && guardianClosed) await boundedOwnedWait(guardianClosed, deadline);
        for (;;) {
          const facts = observeFullClosure();
          if (facts) return facts;
          if (performance.now() >= deadline) throw new Error("Owned child, stdio, group or guardian closure remains uncertain");
          await new Promise((resolveCheck) => setTimeout(resolveCheck, 10));
        }
      }
      function childObservedRunning(): boolean {
        return spawned && !childExitObserved && !childStdioClosed && child.exitCode === null && child.signalCode === null
          && child.pid !== undefined && zeroProbe(child.pid) === "present" && zeroProbe(-child.pid) === "present";
      }
      if (invocation) {
        invocation.queue = queue;
        invocation.workspaceRoot = workspaceRoot;
        invocation.discussion = discussion;
        invocation.control = {
          facts: physicalFacts,
          confirmClosed: confirmOwnedClosure,
          stop: async (reason) => {
            const existing = invocation.closedFacts ?? observeFullClosure();
            if (existing) return existing;
            // Natural exit already has a real terminal outcome. Confirm its
            // closure without turning a buffered completion into cancellation.
            if (!childExitObserved && !childStdioClosed && child.exitCode === null && child.signalCode === null) {
              if (!childObservedRunning()) throw new Error("Owned child liveness is uncertain");
              state.stopReason = reason;
              await boundedOwnedWait(state.kill(), performance.now() + 5000);
            }
            return confirmOwnedClosure();
          },
          inspect: async () => {
            if (invocation.closedFacts ?? observeFullClosure()) return "confirmed_closed";
            if (childExitObserved || childStdioClosed || child.exitCode !== null || child.signalCode !== null) {
              try { await confirmOwnedClosure(); return "confirmed_closed"; } catch { return "uncertain"; }
            }
            return childObservedRunning() && guardianSpawned && !guardianExitObserved && !guardianCloseObserved
              && guardian?.pid !== undefined && guardian.exitCode === null && guardian.signalCode === null
              && zeroProbe(guardian.pid) === "present" && zeroProbe(-guardian.pid) === "present" ? "running" : "uncertain";
          }
        };
      }
      function compactOwnedAfterClose(): void {
        if (invocation) void confirmOwnedClosure().catch(() => {});
      }

      function finishWith(event: RunEvent): void {
        if (finalized) {
          return;
        }
        finalized = true;
        stdout.flush();
        stderr.flush();
        for (const measured of structured.finish(false)) emit(measured);
        emit(event);
        queue.end();
        resolveClosed();
        compactOwnedAfterClose();
      }

      child.on("error", (err: Error) => {
        if (!spawned) {
          childSpawnFailed = child.pid === undefined;
          return;
        }
        stderr.feed(`${err.message}\n`);
      });
      child.on("exit", () => {
        childExitObserved = true;
        if (process.platform === "win32" || child.pid === undefined) return;
        // The CLI leader can exit while a writer either ignores or inherits
        // stdio. Start group cleanup on exit, before waiting for pipe closure.
        const closing = beginTermination();
        void closing.catch((error: unknown) => stderr.feed(`CLI cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`));
      });
      child.on("close", async (code: number | null, signal: NodeJS.Signals | null) => {
        childStdioClosed = true;
        if (process.platform !== "win32" && child.pid !== undefined) {
          beginTermination();
          try { await termination; } catch { return; }
        }
        // Only disarm after the POSIX group has actually disappeared. A leader
        // exiting successfully is not evidence that all workspace writers did.
        guardian?.stdin?.end("disarm");
        if (state.stopReason) {
          // A parent exit alone does not prove its descendants stopped.
          try { await termination; } catch { resolveClosed(); return; }
          finishWith({
            type: "run.lifecycle",
            payload: { phase: "cancelled", reason: state.stopReason }
          });
          return;
        }

        if (code === 0) {
          stdout.flush();
          stderr.flush();
          if (structured.failureReason() !== undefined) {
            finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: structured.failureReason() } });
            return;
          }
          let descriptors: ArtifactDescriptor[];
          try { descriptors = discussion ? [] : collectDescriptors(workspaceRoot); }
          catch (error) {
            finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: error instanceof Error ? error.message : "artifact collection failed" } });
            return;
          }
          stdout.flush();
          stderr.flush();
          finalized = true;
          for (const descriptor of descriptors) {
            queue.push({ type: "artifact.created", payload: descriptor.payload });
          }
          for (const measured of structured.finish(true)) emit(measured);
          queue.push({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
          queue.end();
          resolveClosed();
          compactOwnedAfterClose();
          return;
        }

        // Parse any final unterminated JSON record before choosing the error.
        // CLIs normally exit nonzero for model/auth/provider failures; preserve
        // their actionable reason instead of reducing every failure to exit 1.
        stdout.flush();
        stderr.flush();
        finishWith({
          type: "run.lifecycle",
          payload: { phase: "failed", reason: signal ? `signal ${signal}` : structured.failureReason() ?? `exit ${code ?? "unknown"}` }
        });
      });

      let startupStop: Promise<void> | undefined;
      let startupAbortHandled = false;
      const onStartupAbort = (): void => {
        state.stopReason = "user_cancelled";
        startupStop ??= state.kill();
        // The startup continuation awaits and reports cleanup failure below.
        void startupStop.catch(() => {});
      };
      async function rejectAfterStartupAbort(): Promise<never> {
        startupAbortHandled = true;
        onStartupAbort();
        try {
          await startupStop;
          if (guardian) {
            if (!guardianClosed) throw new Error("Startup guardian closure was not observed");
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([guardianClosed, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Startup guardian did not close after disarm")), 5000);
              })]);
            } finally { clearTimeout(timer); }
            const neverSpawned = guardianSpawnFailed && !guardianSpawned && guardian.pid === undefined;
            if (!neverSpawned && (!guardianCloseObserved || guardianStatus !== 0 || guardianSignal !== null)) {
              throw new Error("Startup guardian closure was not successful");
            }
          }
        } catch (error) {
          throw new Error("Owned startup cleanup is uncertain; worktree and context retained", { cause: error });
        }
        throw startupSignal!.reason;
      }
      startupSignal?.addEventListener("abort", onStartupAbort, { once: true });
      if (startupSignal?.aborted) onStartupAbort();
      try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", () => {
          spawned = true;
          queue.push({ type: "run.lifecycle", payload: { phase: "started" } });
          resolveSpawn();
        });
        child.once("error", (err: Error) => {
          if (!spawned) {
            rejectSpawn(err);
          }
        });
      });
      if (startupSignal?.aborted) await rejectAfterStartupAbort();

      if (!finalized && child.pid !== undefined) {
        guardianAttempted = true;
        guardian = spawn(process.execPath, ["-e", PROCESS_GUARDIAN, String(child.pid)], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: process.platform !== "win32",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        if (startupSignal) {
          // Observe the actual guardian at creation, before its spawn/close
          // callbacks can run. Only startup cancellation waits on this proof.
          const observedGuardian = guardian;
          guardianClosed = new Promise<void>((resolveGuardianClose) => {
            observedGuardian.once("spawn", () => { guardianSpawned = true; });
            observedGuardian.once("exit", () => { guardianExitObserved = true; });
            observedGuardian.once("close", (code, signal) => {
              guardianCloseObserved = true; guardianStatus = code; guardianSignal = signal;
              resolveGuardianClose();
            });
            observedGuardian.once("error", () => {
              if (!guardianSpawned && observedGuardian.pid === undefined) {
                guardianSpawnFailed = true; resolveGuardianClose();
              }
            });
          });
        }
        guardian.stdin?.on("error", () => {});
        try {
          await new Promise<void>((resolveGuard, rejectGuard) => {
            guardian!.once("spawn", resolveGuard);
            guardian!.once("error", rejectGuard);
          });
        } catch (error) {
          state.stopReason = "user_cancelled";
          await state.kill();
          throw error;
        }
        if (finalized) guardian.stdin?.end("disarm");
      }

      if (startupSignal?.aborted) await rejectAfterStartupAbort();
      if (invocation) {
        const handle = Object.freeze({ runId });
        invocation.handle = new WeakRef(handle);
        ownedExecutions.set(handle, invocation);
        return handle;
      }
      runs.set(runId, state);
      return { runId };
      } catch (error) {
        if (startupSignal?.aborted && !startupAbortHandled) await rejectAfterStartupAbort();
        throw error;
      } finally {
        startupSignal?.removeEventListener("abort", onStartupAbort);
      }
  }

  function ownedExecution(handle: AgentInstanceHandle, admission: OwnedRunAdmission): OwnedInvocation | undefined {
    const execution = ownedExecutions.get(handle);
    return execution?.owner === ownedOwner && matchesScope(execution, admission, handle) ? execution : undefined;
  }
  function stopReceipt(execution: OwnedInvocation, kind: OwnedStopReceipt["kind"]): OwnedStopReceipt {
    const facts = execution.closedFacts ?? execution.control?.facts();
    const receipt = Object.freeze({ kind, observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
    ownedStopReceipts.set(receipt, { admission: execution.admission, worktree: execution.worktree,
      handle: execution.handle, receipt });
    return receipt;
  }
  function statusReceipt(execution: OwnedInvocation, kind: OwnedRunStatusReceipt["kind"]): OwnedRunStatusReceipt {
    const facts = execution.closedFacts ?? execution.control?.facts();
    const receipt = Object.freeze({ kind, observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
    ownedStatusReceipts.set(receipt, { admission: execution.admission, worktree: execution.worktree,
      handle: execution.handle, receipt });
    return receipt;
  }
  const adapter: OwnedWorktreeRuntimeAdapter & OwnedRunRuntimeAdapter = {
    runtimeId,

    async start(config: AgentInstanceConfig): Promise<AgentInstanceHandle> {
      if (config.runStart.workspace_allocation !== undefined) throw new Error("Explicit allocation requires an owned worktree start");
      return startProcess(config);
    },

    async startOwnedWorktree(config: AgentInstanceConfig, worktree: MaterializedWorktree, startupSignal?: AbortSignal): Promise<AgentInstanceHandle> {
      // Detach caller-owned payload before the first async ownership observation.
      const snapshot = structuredClone(config);
      startupSignal?.throwIfAborted();
      await assertOwnedMaterializedWorktree(worktree);
      startupSignal?.throwIfAborted();
      return startProcess(snapshot, worktree, startupSignal);
    },

    async startOwnedRun(config: AgentInstanceConfig, worktree: MaterializedWorktree, admission: OwnedRunAdmission, signal: AbortSignal): Promise<AgentInstanceHandle> {
      const admitted = ownedAdmissions.get(admission);
      if (!admitted || admitted.claimed) throw new Error("A fresh authenticated owned admission is required");
      admitted.claimed = true;
      const invocation: OwnedInvocation = { admission: new WeakRef(admission), worktree: new WeakRef(worktree),
        owner: ownedOwner, genuine: false, spawnAttempted: false, helperUncertain: false,
        workspaceRoot: admitted.identity.workspaceRoot, discussion: false };
      try {
        // Snapshot before any asynchronous ownership observation.
        const snapshot = structuredClone(config), identity = admitted.identity;
        if (!(signal instanceof AbortSignal)) throw new Error("An actual startup AbortSignal is required");
        assertOwnedWorktreeLocalBoundary(worktree);
        invocation.genuine = true;
        if (identity.runId !== snapshot.runId || identity.taskId !== snapshot.taskId
          || identity.agentInstanceId !== snapshot.agentInstanceId || identity.runtime !== snapshot.runtime
          || identity.runtime !== runtimeId || identity.workspaceRoot !== snapshot.workspaceRoot
          || identity.workspaceRoot !== worktree.root || identity.workspaceBranch !== worktree.branch
          || snapshot.runStart.run_id !== identity.runId || snapshot.runStart.task_id !== identity.taskId
          || snapshot.runStart.agent_instance_id !== identity.agentInstanceId || snapshot.runStart.runtime !== identity.runtime
          || snapshot.runStart.workspace.root !== identity.workspaceRoot || snapshot.runStart.workspace.branch !== identity.workspaceBranch) {
          throw new Error("Owned admission does not match this exact frozen launch identity");
        }
        signal.throwIfAborted();
        await ownedPreparation(invocation, signal, () => assertOwnedMaterializedWorktree(worktree));
        signal.throwIfAborted();
        return await startProcess(snapshot, worktree, signal, invocation);
      } catch (cause) {
        let kind: OwnedStartupReceipt["kind"] = "uncertain";
        if (invocation.genuine && !invocation.spawnAttempted && !invocation.helperUncertain) kind = "not_spawned";
        if (invocation.spawnAttempted && invocation.control) {
          try { await invocation.control.stop("user_cancelled"); } catch { /* Retain authenticated uncertainty. */ }
        }
        if (invocation.closedFacts) kind = invocation.closedFacts.childSpawned ? "confirmed_closed" : "not_spawned";
        const error = new Error("Owned runtime startup failed; workspace and context retained", { cause });
        if (invocation.genuine) {
          const facts = invocation.closedFacts ?? invocation.control?.facts();
          const receipt: OwnedStartupReceipt = Object.freeze({ kind, cancellationRequested: signal instanceof AbortSignal && signal.aborted,
            observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
          ownedStartupErrors.set(error, { admission: invocation.admission, worktree: invocation.worktree, receipt });
        }
        throw error;
      }
    },

    async stopOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission, reason: StopReason): Promise<OwnedStopReceipt> {
      const execution = ownedExecution(handle, admission);
      if (!execution) throw new Error("An exact authenticated owned execution handle is required");
      if (execution.closedFacts) return stopReceipt(execution, "confirmed_closed");
      try {
        if (!execution.control) return stopReceipt(execution, "uncertain");
        await execution.control.stop(reason);
        return stopReceipt(execution, execution.closedFacts ? "confirmed_closed" : "uncertain");
      } catch { return stopReceipt(execution, "uncertain"); }
    },

    async inspectOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission): Promise<OwnedRunStatusReceipt> {
      const execution = ownedExecution(handle, admission);
      if (!execution) throw new Error("An exact authenticated owned execution handle is required");
      if (execution.closedFacts) return statusReceipt(execution, "confirmed_closed");
      try {
        const kind = execution.control ? await execution.control.inspect() : "uncertain";
        return statusReceipt(execution, kind);
      } catch { return statusReceipt(execution, "uncertain"); }
    },

    streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) {
        const queue = execution.queue;
        return (async function* () {
          if (!queue) return;
          let drained = false;
          try { yield* queue.drain(); drained = true; }
          finally { if (drained && execution.queue === queue) execution.queue = undefined; }
        })();
      }
      const state = runs.get(handle.runId);
      if (!state) {
        throw new Error(`no active run for ${handle.runId}`);
      }
      return state.queue.drain();
    },

    async stop(handle: AgentInstanceHandle, reason: StopReason): Promise<void> {
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) {
        if (execution.closedFacts) return;
        if (!execution.control) throw new Error("Owned execution closure is uncertain");
        await execution.control.stop(reason);
        return;
      }
      const state = runs.get(handle.runId);
      if (state) {
        state.stopReason = reason;
        await state.kill();
      }
    },

    async collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]> {
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) return execution.discussion ? [] : collectDescriptors(execution.workspaceRoot);
      const state = runs.get(handle.runId);
      return state && !state.discussion ? collectDescriptors(state.workspaceRoot) : [];
    }
  };
  ownedAdapters.set(adapter, Object.freeze({ runtimeId: adapter.runtimeId, startOwnedRun: adapter.startOwnedRun,
    stopOwnedRun: adapter.stopOwnedRun, inspectOwnedRun: adapter.inspectOwnedRun,
    streamEvents: adapter.streamEvents, collectArtifacts: adapter.collectArtifacts }));
  return adapter;
}
