// Real inherited-pipe router and private parent-binding state. The outer host,
// streams and application startup callback are controlled; no process is run.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShutdownHost } from "./main.js";
import { importedCleanValidationRequestFixture } from "./test-fixtures/imported-clean-validation-request.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const nonce = "00000000-0000-4000-8000-000000000001";
let input: EventEmitter, output: string[];
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  input = new EventEmitter(); output = [];
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...args: unknown[]) => {
    output.push(String(chunk)); const callback = args.at(-1);
    if (typeof callback === "function") callback(null); return true;
  });
});
afterEach(() => {
  const pending = vi.getTimerCount(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "stdin", stdin);
  expect(pending).toBe(0);
});
const flush = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
async function fixture() {
  const { runWindowsSupervisedDaemon } = await import("./windows-daemon-launcher.js");
  const { bindCleanDaemonParent } = await import("./windows-clean-daemon-control.js");
  const launch = importedCleanValidationRequestFixture().checkpoint.lifecycle_registration.launch;
  const outer = Object.assign(new EventEmitter(), { exit: vi.fn() });
  let host!: ShutdownHost, stopping = false, requests = 0, finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const work = runWindowsSupervisedDaemon({ ARTOO_SUPERVISED_CONTROL_NONCE: nonce, ARTOO_SOURCE_CLEAN_CONFIG_FILE: "controlled-lineage",
    ARTOO_SOURCE_LIFECYCLE_OBSERVER_ID: launch.observer_id }, outer, async current => {
    host = current; current.on("message", () => { stopping = true; requests++; }); await settled;
  });
  await flush();
  const send = (value: unknown) => input.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  return { launch, outer, work, send, binding: () => bindCleanDaemonParent(launch), stopping: () => stopping, requests: () => requests,
    shutdown: () => send({ version: 1, kind: "shutdown", nonce }),
    acknowledge: () => send({ version: 1, kind: "source-lifecycle-bound", nonce, observer_id: launch.observer_id,
      launch_identity_digest: launch.launch_identity_digest }),
    async close() { host.exit(0); finish(); await work; await flush(); },
  };
}

describe("user stop releases only unfinished clean parent binding", () => {
  it("latches shutdown before rejecting an in-flight bind without waiting for its 30-second deadline", async () => {
    const f = await fixture();
    let rejection: unknown, stoppedBeforeRejection = false;
    const binding = f.binding().catch(error => { rejection = error; stoppedBeforeRejection = f.stopping(); });
    try {
      expect(output.some(line => line.startsWith("ARTOO_SOURCE_LIFECYCLE_V1 "))).toBe(true);
      f.shutdown(); await flush();
      expect(rejection).toMatchObject({ message: "Original clean parent binding cancelled by shutdown" });
      expect(stoppedBeforeRejection).toBe(true); expect(f.requests()).toBe(1); expect(vi.getTimerCount()).toBe(0);
      await binding;
    } finally { await f.close(); }
    expect(f.outer.exit).toHaveBeenCalledWith(0);
    expect(output.some(line => line.includes('"kind":"stopped"') && line.includes('"exitCode":0'))).toBe(true);
  });
  it("cannot begin a late bind after user shutdown was already requested", async () => {
    const f = await fixture();
    try {
      f.shutdown(); await expect(f.binding()).rejects.toThrow("original private parent binding route");
      expect(output.some(line => line.startsWith("ARTOO_SOURCE_LIFECYCLE_V1 "))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.close(); }
    expect(f.outer.exit).toHaveBeenCalledWith(0);
  });
  it("does not reset an accepted binding or classify its exact duplicate acknowledgement as a pipe failure", async () => {
    const f = await fixture();
    try {
      const binding = f.binding(); f.acknowledge(); await binding;
      f.shutdown(); f.acknowledge();
      expect(f.requests()).toBe(1);
      await expect(f.binding()).rejects.toThrow("original private parent binding route");
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.close(); }
    expect(f.outer.exit).toHaveBeenCalledWith(0);
  });
});
