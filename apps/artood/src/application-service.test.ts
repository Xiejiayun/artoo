import { beforeEach, describe, expect, it, vi } from "vitest";
const starts = vi.hoisted(() => ({ runtime: vi.fn(), broker: vi.fn() }));
vi.mock("./application-runtime-process.js", () => ({ startApplicationRuntimeProcess: starts.runtime }));
vi.mock("./application-broker-process.js", () => ({ startApplicationBrokerProcess: starts.broker }));
import { createApplicationService } from "./application-service.js";
import { ApplicationWireEncoder } from "./application-wire-v1.js";
import type { ApplicationBrokerProcess, ApplicationBrokerProcessReceipt, PreparedApplicationBrokerProcess } from "./application-broker-process.js";
import type { ApplicationRuntimeProcess, ApplicationRuntimeProcessReceipt, PreparedApplicationRuntimeProcess } from "./application-runtime-process.js";
import type { ApplicationBrokerReply } from "./application-broker-control.js";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw Error("controlled owner condition did not occur");
}
const action = { kind: "begin" as const, invocation: "host-invocation", requestJson: '{"request_id":"r","method":"GET","path":"/","query":{},"body":null}',
  purpose: "application" as const, access: "read" as const, lifetimeMs: 1000 };
function fixture(startupPending = false) {
  // Deliberate controlled original-owner stand-ins. No native launch, database,
  // product or HTTP publication is performed by these coordinator regressions.
  const runtimeReady = deferred<void>(), brokerReady = deferred<void>();
  if (!startupPending) { runtimeReady.resolve(); brokerReady.resolve(); }
  const runtimeClosed = deferred<ApplicationRuntimeProcessReceipt>(), brokerClosed = deferred<ApplicationBrokerProcessReceipt>();
  const runtimeReceipt = { normalShutdown: true, closureConfirmed: true } as ApplicationRuntimeProcessReceipt;
  const brokerReceipt = { normalShutdown: true } as ApplicationBrokerProcessReceipt;
  const invoke = new ApplicationWireEncoder("host-to-application").encode(JSON.stringify({ kind: "invoke", call_id: "broker-internal-1", request: JSON.parse(action.requestJson) }));
  const output = new ApplicationWireEncoder("application-to-host").encode(JSON.stringify({ kind: "response", call_id: "broker-internal-1", response: { status: 200, body: { ok: true } } }));
  const runtime = { ready: runtimeReady.promise, closed: runtimeClosed.promise,
    receive: vi.fn(async (_bytes: Uint8Array) => {}), readOutput: vi.fn(async () => output),
    close: vi.fn(() => runtimeClosed.promise), cancel: vi.fn(() => runtimeClosed.promise) } satisfies ApplicationRuntimeProcess;
  const reply = (sequence: number, frames: string[], responses: ApplicationBrokerReply["responses"]): ApplicationBrokerReply =>
    ({ version: 1, sequence, kind: "result", frames, responses, terminated: [], stopped: false });
  const broker = { ready: brokerReady.promise, closed: brokerClosed.promise,
    command: vi.fn<ApplicationBrokerProcess["command"]>(async command => {
      if (command.kind === "begin") return reply(0, [invoke.toString("base64")], []);
      if (command.kind !== "receive") throw Error("unexpected controlled command");
      expect(Buffer.from(command.data, "base64")).toEqual(output);
      return reply(1, [], [{ invocation: action.invocation, response: { status: 200, body: { ok: true } } }]);
    }), stop: vi.fn(() => brokerClosed.promise), cancel: vi.fn(() => brokerClosed.promise) } satisfies ApplicationBrokerProcess;
  starts.runtime.mockReturnValue(runtime); starts.broker.mockReturnValue(broker);
  const prepareRuntime = vi.fn(() => Object.freeze({}) as PreparedApplicationRuntimeProcess);
  const prepareBroker = vi.fn(() => Object.freeze({}) as PreparedApplicationBrokerProcess);
  const service = createApplicationService({ maximumAccess: "read", prepareRuntime, prepareBroker });
  return { runtime, broker, invoke, runtimeClosed, brokerClosed, runtimeReceipt, brokerReceipt, runtimeReady, brokerReady,
    prepareRuntime, prepareBroker, service, reply };
}
describe("single-request application coordinator", () => {
  beforeEach(() => vi.clearAllMocks());
  it("returns the original handle before startup and withholds response/settlement until both original closures", async () => {
    const f = fixture(), handle = f.service.begin(action, new AbortController().signal);
    expect(starts.runtime).not.toHaveBeenCalled(); expect(starts.broker).not.toHaveBeenCalled();
    let responseDone = false, settledDone = false;
    void handle.response.then(() => { responseDone = true; }); void handle.settled.then(() => { settledDone = true; });
    await until(() => f.runtime.close.mock.calls.length === 1 && f.broker.stop.mock.calls.length === 1);
    expect(f.runtime.receive).toHaveBeenCalledWith(f.invoke); expect(f.broker.command).toHaveBeenCalledTimes(2);
    f.runtimeClosed.resolve(f.runtimeReceipt); await Promise.resolve();
    expect(responseDone).toBe(false); expect(settledDone).toBe(false);
    f.brokerClosed.resolve(f.brokerReceipt); await expect(handle.settled).resolves.toBeUndefined();
    await expect(handle.response).resolves.toBe(JSON.stringify({ invocation: action.invocation, response: { status: 200, body: { ok: true } } }));
    expect(f.broker.command.mock.calls.some(([value]) => value.kind === "cancel")).toBe(false);
  });
  it("cancels the actual owners during startup and never settles from only one closure", async () => {
    const f = fixture(true), handle = f.service.begin(action, new AbortController().signal);
    await until(() => starts.broker.mock.calls.length === 1); handle.cancel();
    await expect(handle.response).rejects.toThrow("cancelled"); expect(f.runtime.cancel).toHaveBeenCalled(); expect(f.broker.cancel).toHaveBeenCalled();
    let settled = false; void handle.settled.then(() => { settled = true; }, () => { settled = true; });
    f.runtimeClosed.resolve({ ...f.runtimeReceipt, normalShutdown: false }); await Promise.resolve(); expect(settled).toBe(false);
    f.brokerClosed.resolve({ ...f.brokerReceipt, normalShutdown: false });
    await expect(handle.settled).rejects.toThrow("uncertain"); expect(f.broker.command).not.toHaveBeenCalled();
  });
  it("does not address a removed broker invocation when cancelled after the response", async () => {
    const f = fixture(), handle = f.service.begin(action, new AbortController().signal);
    await until(() => f.broker.stop.mock.calls.length === 1); handle.cancel();
    await expect(handle.response).rejects.toThrow("cancelled");
    f.runtimeClosed.resolve({ ...f.runtimeReceipt, normalShutdown: false }); f.brokerClosed.resolve(f.brokerReceipt);
    await expect(handle.settled).resolves.toBeUndefined();
    expect(f.broker.command.mock.calls.map(([value]) => value.kind)).toEqual(["begin", "receive"]);
  });
  it("serializes the initial broker command before sending its unchanged frame to the guest", async () => {
    const f = fixture(), begin = deferred<ApplicationBrokerReply>(); f.broker.command.mockImplementationOnce(() => begin.promise);
    const handle = f.service.begin(action, new AbortController().signal);
    await until(() => f.broker.command.mock.calls.length === 1);
    expect(f.runtime.receive).not.toHaveBeenCalled(); expect(f.runtime.readOutput).not.toHaveBeenCalled();
    begin.resolve(f.reply(0, [f.invoke.toString("base64")], []));
    await until(() => f.broker.stop.mock.calls.length === 1);
    f.runtimeClosed.resolve(f.runtimeReceipt); f.brokerClosed.resolve(f.brokerReceipt);
    await expect(handle.response).resolves.toContain("host-invocation"); await handle.settled;
  });
  it("deducts preparation and startup from the one original deadline", async () => {
    const f = fixture(); let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    f.prepareRuntime.mockImplementation(() => { now += 200; return {} as PreparedApplicationRuntimeProcess; });
    f.prepareBroker.mockImplementation(() => { now += 100; return {} as PreparedApplicationBrokerProcess; });
    f.runtime.close.mockImplementation(() => { f.runtimeClosed.resolve(f.runtimeReceipt); return f.runtimeClosed.promise; });
    f.broker.stop.mockImplementation(() => { f.brokerClosed.resolve(f.brokerReceipt); return f.brokerClosed.promise; });
    try {
      const handle = f.service.begin(action, new AbortController().signal); await handle.response; await handle.settled;
      expect(starts.runtime.mock.calls[0]![1]).toBe(1100);
      expect(starts.broker.mock.calls[0]![1]).toBe(1100);
      expect(f.broker.command.mock.calls[0]![0]).toMatchObject({ kind: "begin", lifetimeMs: 700 });
    } finally { clock.mockRestore(); }
  });
  it("awaits the original runtime closure when broker startup rejects the expired deadline", async () => {
    const f = fixture(true);
    starts.broker.mockImplementation(() => { throw Error("Broker original deadline elapsed before launch"); });
    const handle = f.service.begin(action, new AbortController().signal);
    await expect(handle.response).rejects.toThrow("Broker original deadline elapsed");
    expect(f.runtime.cancel).toHaveBeenCalled(); expect(f.broker.cancel).not.toHaveBeenCalled();
    let settled = false; void handle.settled.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    f.runtimeClosed.resolve({ ...f.runtimeReceipt, normalShutdown: false });
    await expect(handle.settled).resolves.toBeUndefined();
  });
  it("creates no work for an already aborted request and safely settles that empty ownership scope", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const handle = f.service.begin(action, controller.signal);
    await expect(handle.response).rejects.toThrow("cancelled"); await expect(handle.settled).resolves.toBeUndefined();
    expect(starts.runtime).not.toHaveBeenCalled(); expect(starts.broker).not.toHaveBeenCalled();
  });
});
