import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  /** Workspace allowlist enforced before spawn. */
  allowedRoots: string[];
  /** Artifacts collected from the workspace after the run completes. */
  artifacts?: ArtifactSpec[];
  contextPackFilename?: string;
}

interface RunState {
  queue: AsyncEventQueue<RunEvent>;
  kill: () => void;
  workspaceRoot: string;
  stopReason?: StopReason;
}

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
  return {
    feed(chunk): void {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
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

      const contextPackPath = workspacePath(config.workspaceRoot, contextPackFilename);
      artifactPaths(config.workspaceRoot);
      writeFileSync(contextPackPath, renderContextPack(config));

      const argv = options.command.map((part) =>
        part
          .replaceAll("{{workspace_root}}", config.workspaceRoot)
          .replaceAll("{{context_pack_path}}", contextPackPath)
      );
      const [cmd, ...args] = argv;
      if (cmd === undefined) {
        throw new Error("process adapter command template is empty");
      }

      const child = spawn(cmd, args, { cwd: config.workspaceRoot });
      // The agent receives its task via the command template + context pack, not
      // stdin. Close stdin so CLIs that read it (e.g. `codex exec` prints
      // "Reading additional input from stdin...") get EOF immediately instead of
      // blocking forever on an open, never-written pipe.
      child.stdin?.end();
      const queue = new AsyncEventQueue<RunEvent>();
      let finalized = false;
      let spawned = false;

      const stdout = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stdout", text } })
      );
      const stderr = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stderr", text } })
      );
      child.stdout?.on("data", (chunk: Buffer) => stdout.feed(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.feed(chunk));

      const state: RunState = {
        queue,
        workspaceRoot: config.workspaceRoot,
        kill: () => {
          child.kill();
        }
      };

      function finishWith(event: RunEvent): void {
        if (finalized) {
          return;
        }
        finalized = true;
        stdout.flush();
        stderr.flush();
        queue.push(event);
        queue.end();
      }

      child.on("error", (err: Error) => {
        if (!spawned) {
          return;
        }
        finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: err.message } });
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (state.stopReason) {
          finishWith({
            type: "run.lifecycle",
            payload: { phase: "cancelled", reason: state.stopReason }
          });
          return;
        }

        if (code === 0) {
          stdout.flush();
          stderr.flush();
          finalized = true;
          for (const descriptor of collectDescriptors(config.workspaceRoot)) {
            queue.push({ type: "artifact.created", payload: descriptor.payload });
          }
          queue.push({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
          queue.end();
          return;
        }

        finishWith({
          type: "run.lifecycle",
          payload: { phase: "failed", reason: signal ? `signal ${signal}` : `exit ${code ?? "unknown"}` }
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
        state.kill();
      }
    },

    async collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]> {
      const state = runs.get(handle.runId);
      return state ? collectDescriptors(state.workspaceRoot) : [];
    }
  };
}
