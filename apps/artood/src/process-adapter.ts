import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";

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
    let existing = resolve(path);
    const suffix: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      suffix.unshift(basename(existing));
      existing = parent;
    }
    return resolve(realpathSync(existing), ...suffix);
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
        // 128 means the process already exited; no process can still be writing.
        if (code === 0 || code === 128) resolveStop();
        else rejectStop(new Error(`could not stop process tree (${code}): ${output}`));
      });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

// A small independent Node process owns a pipe from the daemon. If the daemon
// crashes (including an Electron worker kill), pipe EOF kills the CLI's process
// tree. A normal CLI exit disarms it first. No task content becomes executable.
const PROCESS_GUARDIAN = `
const {spawn}=require('node:child_process');
const pid=Number(process.argv[1]);
let disarmed=false;
process.stdin.on('data',()=>{disarmed=true;});
process.stdin.on('end',()=>{
  if(disarmed) return;
  if(process.platform==='win32') spawn(require('node:path').resolve(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  else { try { process.kill(-pid,'SIGKILL'); } catch {} }
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

export function createProcessAdapter(options: ProcessAdapterOptions): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "process";
  const contextPackFilename = options.contextPackFilename ?? "context_pack.md";
  const artifactSpecs = options.artifacts ?? [];
  const runs = new Map<string, RunState>();

  function workspacePath(workspaceRoot: string, relativePath: string): string {
    const absolute = resolve(workspaceRoot, relativePath);
    assertWorkspaceScope(absolute, [workspaceRoot]);
    assertRealWorkspaceScope(absolute, [workspaceRoot]);
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

  return {
    runtimeId,

    async start(config: AgentInstanceConfig): Promise<AgentInstanceHandle> {
      // Enforce the workspace allowlist before doing anything else.
      assertWorkspaceScope(config.workspaceRoot, options.allowedRoots);
      assertRealWorkspaceScope(config.workspaceRoot, options.allowedRoots);

      const discussion = config.runStart.context_pack.payload?.policy.execution_mode === "discussion";
      if (discussion && !options.discussionCommand) throw new Error("runtime has no explicitly configured read-only discussion command");

      const contextPackPath = workspacePath(config.workspaceRoot, contextPackFilename);
      artifactPaths(config.workspaceRoot);
      writeFileSync(contextPackPath, renderContextPack(config));

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
      const child = spawn(resolved[0]!, [...resolved.slice(1), ...args], { cwd: config.workspaceRoot, detached: process.platform !== "win32", windowsHide: true });
      // The agent receives its task via the command template + context pack, not
      // stdin. Close stdin so CLIs that read it (e.g. `codex exec` prints
      // "Reading additional input from stdin...") get EOF immediately instead of
      // blocking forever on an open, never-written pipe.
      child.stdin?.end();
      const queue = new AsyncEventQueue<RunEvent>();
      let finalized = false;
      let spawned = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });
      let termination: Promise<void> | undefined;
      let guardian: ChildProcess | undefined;
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
        workspaceRoot: config.workspaceRoot,
        discussion,
        kill: async () => {
          if (finalized) return;
          termination ??= child.pid === undefined ? Promise.resolve() : stopProcessTree(child.pid);
          await termination;
          await closed;
        }
      };

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
      }

      child.on("error", (err: Error) => {
        if (!spawned) {
          return;
        }
        stderr.feed(`${err.message}\n`);
      });
      child.on("close", async (code: number | null, signal: NodeJS.Signals | null) => {
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
          try { descriptors = discussion ? [] : collectDescriptors(config.workspaceRoot); }
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

      if (!finalized && child.pid !== undefined) {
        guardian = spawn(process.execPath, ["-e", PROCESS_GUARDIAN, String(child.pid)], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
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

      runs.set(config.runId, state);
      return { runId: config.runId };
    },

    streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      const state = runs.get(handle.runId);
      if (!state) {
        throw new Error(`no active run for ${handle.runId}`);
      }
      return state.queue.drain();
    },

    async stop(handle: AgentInstanceHandle, reason: StopReason): Promise<void> {
      const state = runs.get(handle.runId);
      if (state) {
        state.stopReason = reason;
        await state.kill();
      }
    },

    async collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]> {
      const state = runs.get(handle.runId);
      return state && !state.discussion ? collectDescriptors(state.workspaceRoot) : [];
    }
  };
}
