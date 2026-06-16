import { describe, expect, it } from "vitest";

import { createChildProcessSpawner } from "./child-process-spawner.js";

describe("createChildProcessSpawner", () => {
  it("spawns a real process and resolves exited with its exit code", async () => {
    const spawner = createChildProcessSpawner([process.execPath, "-e", "process.exit(0)"]);
    const result = await spawner.spawn({}).exited;
    expect(result.code).toBe(0);
  });

  it("kill terminates a long-running process", async () => {
    const spawner = createChildProcessSpawner([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    const child = spawner.spawn({});
    child.kill("SIGTERM");
    const result = await child.exited;
    // Exited (Windows reports a code on SIGTERM; POSIX reports the signal).
    expect(result.code !== null || result.signal !== null).toBe(true);
  });

  it("resolves exited even when the executable cannot be spawned", async () => {
    const spawner = createChildProcessSpawner(["this-binary-does-not-exist-artoo"]);
    const result = await spawner.spawn({}).exited;
    expect(result).toEqual({ code: null, signal: null });
  });

  it("rejects an empty command", () => {
    expect(() => createChildProcessSpawner([])).toThrow(/executable/);
  });
});
