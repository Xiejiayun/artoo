import { spawn } from "node:child_process";

import type { ChildHandle, Spawner } from "./supervisor.js";

/**
 * Real {@link Spawner} backed by `child_process.spawn` (#29 v2-D slice 4). Spawns
 * the #23 artood bootstrap (`command`, typically `[node, <artood main>]`) with the
 * supervisor-provided env merged over the current process env, and adapts it to
 * the injected {@link ChildHandle} the supervisor drives. stdio is ignored — the
 * node reports state over its heartbeat, not stdout — so a secret-bearing
 * `ARTOO_NODE_URL` is never echoed to a console.
 */
export function createChildProcessSpawner(command: readonly string[], options: { cwd?: string } = {}): Spawner {
  const [cmd, ...args] = command;
  if (cmd === undefined) {
    throw new Error("createChildProcessSpawner: command must include at least the executable");
  }
  return {
    spawn(env: Record<string, string>): ChildHandle {
      const child = spawn(cmd, args, {
        env: { ...process.env, ...env },
        cwd: options.cwd,
        stdio: ["ignore", "ignore", "ignore"]
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        // A spawn error (e.g. missing binary) also ends the lifecycle.
        child.once("error", () => resolve({ code: null, signal: null }));
      });
      return {
        kill(signal) {
          child.kill(signal);
        },
        exited
      };
    }
  };
}
