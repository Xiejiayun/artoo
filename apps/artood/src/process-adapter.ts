import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
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
  const lines = [
    `# Context Pack ${pack.id}`,
    `task: ${config.taskId}`,
    `run: ${config.runId}`,
    pack.uri ? `uri: ${pack.uri}` : undefined,
    pack.payload ? `payload: ${JSON.stringify(pack.payload)}` : undefined
  ].filter((line): line is string => line !== undefined);
  return `${lines.join("\n")}\n`;
}

export function createProcessAdapter(options: ProcessAdapterOptions): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "process";
  const contextPackFilename = options.contextPackFilename ?? "context_pack.md";
  const artifactSpecs = options.artifacts ?? [];
  const runs = new Map<string, RunState>();

  function collectDescriptors(workspaceRoot: string): ArtifactDescriptor[] {
    const descriptors: ArtifactDescriptor[] = [];
    for (const spec of artifactSpecs) {
      const absolute = join(workspaceRoot, spec.path);
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

      const contextPackPath = join(config.workspaceRoot, contextPackFilename);
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
      const queue = new AsyncEventQueue<RunEvent>();
      queue.push({ type: "run.lifecycle", payload: { phase: "started" } });

      const stdout = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stdout", text } })
      );
      const stderr = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stderr", text } })
      );
      child.stdout?.on("data", (chunk: Buffer) => stdout.feed(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.feed(chunk));

      child.on("error", (err: Error) => {
        queue.push({ type: "run.lifecycle", payload: { phase: "failed", reason: err.message } });
        queue.end();
      });
      child.on("close", (code: number | null) => {
        stdout.flush();
        stderr.flush();
        for (const descriptor of collectDescriptors(config.workspaceRoot)) {
          queue.push({ type: "artifact.created", payload: descriptor.payload });
        }
        const ok = code === 0;
        queue.push({
          type: "run.lifecycle",
          payload: { phase: ok ? "completed" : "failed", reason: ok ? null : `exit ${code ?? "signal"}` }
        });
        queue.end();
      });

      runs.set(config.runId, {
        queue,
        workspaceRoot: config.workspaceRoot,
        kill: () => {
          child.kill();
        }
      });
      return { runId: config.runId };
    },

    streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      const state = runs.get(handle.runId);
      if (!state) {
        throw new Error(`no active run for ${handle.runId}`);
      }
      return state.queue.drain();
    },

    async stop(handle: AgentInstanceHandle, _reason: StopReason): Promise<void> {
      runs.get(handle.runId)?.kill();
    },

    async collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]> {
      const state = runs.get(handle.runId);
      return state ? collectDescriptors(state.workspaceRoot) : [];
    }
  };
}
