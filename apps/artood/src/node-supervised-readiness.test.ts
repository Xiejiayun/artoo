// Controlled registration callbacks and transport only; no native qualification or model execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processBackend from "./owned/windows-owned-process.js";
import * as verifier from "./verification.js";
import * as publisher from "./product-release.js";
import * as sources from "./product-source-node.js";
import * as configuration from "./product-source-config.js";
import * as authority from "./windows-supervisor-authority.js";
import * as clients from "./node-client.js";
import * as sockets from "./ws-transport.js";
import { createArtoodNode } from "./node-runner.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(processBackend, "assertWindowsProcessBackend").mockImplementation(() => {});
  vi.spyOn(verifier, "prepareVerificationProfiles").mockReturnValue([]);
  vi.spyOn(publisher, "prepareReleaseProfiles").mockReturnValue([]);
  vi.spyOn(authority, "prepareWindowsDaemonSupervisorAuthority").mockResolvedValue(Object.freeze({}) as authority.PreparedWindowsDaemonSupervisorAuthority);
  vi.spyOn(configuration, "prepareProductSourceConfiguration").mockReturnValue({ config: { recovery: { version: 1 } } } as ReturnType<typeof configuration.prepareProductSourceConfiguration>);
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
function fixture() {
  const source = { recoveryRequired: true, recoveryConfiguration: Object.freeze({}), features: [], assertCurrent: vi.fn(), assertDiscovery: vi.fn(),
    qualifyRecovery: vi.fn(), activateRecovery: vi.fn(() => Object.freeze({})), close: vi.fn() } as unknown as ReturnType<typeof sources.prepareProductSourceNode>;
  vi.spyOn(sources, "prepareProductSourceNode").mockReturnValue(source);
  let live = true;
  const transport = { get connected() { return live; }, ready: Promise.resolve(), close: vi.fn(async () => { live = false; }), currentSessionIdentity: () => ({}) };
  const connect = vi.spyOn(sockets, "createWebSocketTransport").mockReturnValue(transport as unknown as ReturnType<typeof sockets.createWebSocketTransport>);
  const client = { start: vi.fn(), ready: vi.fn(async () => {}), stop: vi.fn(async () => {}), productSourceFeatures: () => [], replayReleaseHealth: vi.fn(async () => {}) };
  const create = vi.spyOn(clients, "createNodeClient").mockReturnValue(client as unknown as ReturnType<typeof clients.createNodeClient>);
  const node = createArtoodNode({ url: "wss://control.example/api/v1/node?token=fixture", hello: { kind: "node.hello", node_id: "node",
    protocol_version: "2026-06-11", artood_version: "0.1.0", machine: { hostname: "fixture", os: "windows", arch: "x64" } },
    workspace: { allowedRoots: [process.cwd()] }, windowsProcessBackend: Object.freeze({}) as processBackend.PreparedWindowsProcessBackend,
    productSourceConfigFile: "C:\\fixed\\source.json", requireSupervisorLifetime: true, acknowledgeRunEvents: true });
  return { node, source, create, connect, client, disconnect() { live = false; connect.mock.calls.at(-1)![0].onFatalDisconnect?.(); } };
}
describe("source execution readiness", () => {
  it("rejects an internal selector with ordinary configuration before acquiring a source owner", async () => {
    const f = fixture();
    vi.mocked(configuration.prepareProductSourceConfiguration).mockReturnValue({ config: {} } as ReturnType<typeof configuration.prepareProductSourceConfiguration>);
    await expect(f.node.start()).rejects.toThrow(/requires recovery configuration/);
    expect(sources.prepareProductSourceNode).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
    await expect(f.node.executionReady).rejects.toThrow(/requires recovery configuration/); await f.node.stop();
  });
  it("waits beyond hello and activation until all initialized controllers report current-session readiness", async () => {
    const f = fixture(); let ready = false; void f.node.executionReady!.then(() => { ready = true; });
    await f.node.start(); await Promise.resolve(); expect(ready).toBe(false);
    const recovery = f.create.mock.calls.at(-1)![0].productSourceRecovery!;
    recovery.activate(Object.freeze({}) as Parameters<typeof recovery.activate>[0]);
    await Promise.resolve(); expect(ready).toBe(false);
    recovery.onReady!(); await f.node.executionReady; expect(ready).toBe(true);
    expect(authority.prepareWindowsDaemonSupervisorAuthority).toHaveBeenCalledWith(expect.anything(), { requireLifetime: true });
    await f.node.stop();
  });
  it("rejects stop-before-registration and refuses a late registration callback", async () => {
    const f = fixture(); await f.node.start(); const recovery = f.create.mock.calls.at(-1)![0].productSourceRecovery!;
    const rejected = expect(f.node.executionReady).rejects.toThrow(/stopped before/);
    await f.node.stop(); await rejected;
    expect(() => recovery.onReady!()).toThrow(/original session/);
    expect(f.source.close).toHaveBeenCalledTimes(1);
  });
  it("does not connect when stopped during the awaited native qualification", async () => {
    const f = fixture(); let qualified!: (token: authority.PreparedWindowsDaemonSupervisorAuthority) => void;
    vi.mocked(authority.prepareWindowsDaemonSupervisorAuthority).mockReturnValue(new Promise(resolve => { qualified = resolve; }));
    const starting = f.node.start(), failure = expect(starting).rejects.toThrow(/stopped during native qualification/);
    await f.node.stop(); qualified(Object.freeze({}) as authority.PreparedWindowsDaemonSupervisorAuthority); await failure;
    expect(f.connect).not.toHaveBeenCalled(); expect(f.source.qualifyRecovery).not.toHaveBeenCalled();
  });
  it("rejects disconnect-before-registration and never reconnects this source instance", async () => {
    const f = fixture(); await f.node.start(); const recovery = f.create.mock.calls.at(-1)![0].productSourceRecovery!;
    const rejected = expect(f.node.executionReady).rejects.toThrow(/connection ended/);
    f.disconnect(); await rejected; await f.node.stop();
    expect(f.connect.mock.calls.at(-1)![0].reconnect).toBe(false);
    expect(() => recovery.onReady!()).toThrow(/original session/);
    await expect(f.node.start()).rejects.toThrow(/session ended/);
  });
  it("fails readiness when controller or publisher initialization fails", async () => {
    const f = fixture(); await f.node.start(); const error = Error("publisher initialization failed");
    const rejected = expect(f.node.executionReady).rejects.toBe(error);
    f.create.mock.calls.at(-1)![0].productSourceRecovery!.onFailure!(error);
    await rejected; expect(await f.node.failed).toBe(error); await f.node.stop();
  });
  it("does not let an old instance's callback ready its replacement", async () => {
    const first = fixture(); await first.node.start(); const old = first.create.mock.calls.at(-1)![0].productSourceRecovery!;
    await first.node.stop();
    const next = fixture(); let ready = false; void next.node.executionReady!.then(() => { ready = true; }, () => {});
    await next.node.start(); expect(() => old.onReady!()).toThrow(/original session/);
    await Promise.resolve(); expect(ready).toBe(false);
    next.create.mock.calls.at(-1)![0].productSourceRecovery!.onReady!(); await next.node.executionReady; expect(ready).toBe(true);
    await next.node.stop();
  });
});
