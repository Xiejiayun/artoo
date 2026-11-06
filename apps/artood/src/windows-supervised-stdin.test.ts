// Inherited pipe protocol only; no native helper, model or application startup.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { installSupervisedStdinControl, supervisedEnvironment, supervisedStdinControlEnabled } from "./windows-daemon-launcher.js";

const shutdown = JSON.stringify({ version: 1, kind: "shutdown" }) + "\n";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const input = new PassThrough(), stop = vi.fn(), fail = vi.fn();
  const remove = installSupervisedStdinControl(input, stop, fail);
  return { input, stop, fail, remove };
}

describe("optional supervised parent stdin control", () => {
  it("keeps default startup disabled and accepts only explicit local values", () => {
    expect(supervisedStdinControlEnabled(undefined)).toBe(false); expect(supervisedStdinControlEnabled("0")).toBe(false);
    expect(supervisedStdinControlEnabled("1")).toBe(true);
    for (const value of ["", "true", "yes", " 1", "2"]) expect(() => supervisedStdinControlEnabled(value)).toThrow(/0 or 1/);
  });
  it("never forwards the outer control selector to the daemon", () => {
    const env = supervisedEnvironment({ ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: process.execPath,
      ARTOO_SUPERVISED_STDIN_CONTROL: "1" }, "00000000-0000-4000-8000-000000000001");
    expect(env.ARTOO_SUPERVISED_STDIN_CONTROL).toBeUndefined();
  });
  it("waits for a complete line and deduplicates valid requests", async () => {
    const value = fixture();
    try {
      value.input.write(shutdown.slice(0, -1)); expect(value.stop).not.toHaveBeenCalled();
      value.input.write("\n"); value.input.write(shutdown);
      await tick(); expect(value.stop).toHaveBeenCalledTimes(1); expect(value.fail).not.toHaveBeenCalled();
      value.input.end(); await tick(); expect(value.fail).not.toHaveBeenCalled();
    } finally { value.remove(); value.input.destroy(); }
  });
  it.each([JSON.stringify({ version: 2, kind: "shutdown" }) + "\n", JSON.stringify({ version: 1, kind: "run" }) + "\n",
    JSON.stringify({ version: 1, kind: "shutdown", command: "extra" }) + "\n", "not-json\n", "\n"])(
    "rejects malformed control before requesting graceful stop: %s", async frame => {
      const value = fixture();
      try { value.input.write(frame); await tick(); expect(value.stop).not.toHaveBeenCalled(); expect(value.fail).toHaveBeenCalledTimes(1); }
      finally { value.remove(); value.input.destroy(); }
    });
  it("fails a lost control pipe or incomplete command instead of fabricating a stop request", async () => {
    for (const partial of ["", shutdown.slice(0, -1)]) {
      const value = fixture();
      try { value.input.end(partial); await tick(); expect(value.stop).not.toHaveBeenCalled(); expect(value.fail).toHaveBeenCalledTimes(1); }
      finally { value.remove(); value.input.destroy(); }
    }
  });
  it("retains stream failures after a valid stop request", async () => {
    const value = fixture();
    try { value.input.write(shutdown); value.input.emit("error", Error("lost pipe")); await tick();
      expect(value.stop).toHaveBeenCalledTimes(1); expect(value.fail).toHaveBeenCalledTimes(1); }
    finally { value.remove(); value.input.destroy(); }
  });
  it("enforces the complete input bound across fragments", async () => {
    const value = fixture();
    try { value.input.write(Buffer.alloc(2048, 0x20)); value.input.write(Buffer.alloc(2049, 0x20)); await tick();
      expect(value.stop).not.toHaveBeenCalled(); expect(value.fail).toHaveBeenCalledTimes(1); }
    finally { value.remove(); value.input.destroy(); }
  });
  it("removes every installed listener and pauses the pipe after actual lifecycle completion", async () => {
    const value = fixture(), pause = vi.spyOn(value.input, "pause");
    value.remove(); value.remove();
    expect(pause).toHaveBeenCalledTimes(1);
    for (const event of ["data", "end", "error"]) expect(value.input.listenerCount(event)).toBe(0);
    value.input.write(shutdown); await tick(); expect(value.stop).not.toHaveBeenCalled(); expect(value.fail).not.toHaveBeenCalled(); value.input.destroy();
  });
});
