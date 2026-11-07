// Real node-client controllers with controlled native/storage admissions; no model or helper process.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NodeHello, RuntimeAdapter } from "@artoo/protocol";
import * as native from "./owned/windows-owned-process.js";
import * as sourceNode from "./product-source-node.js";
import * as runtime from "./product-source-runtime.js";
import * as clients from "./node-client.js";
import * as verification from "./verification.js";
import { createArtoodNode } from "./node-runner.js";
const allSourceFeatures = ["product-source-transfer.v1", "product-source-transfer.v2", "product-source-transfer.measurement-v2.v1",
  "product-source-operations.v1", "imported-product-review.v1", "imported-design-continuation.v1"];
const hello: NodeHello = { kind: "node.hello", node_id: "node", protocol_version: "2026-06-11", artood_version: "0.1.0",
  machine: { hostname: "fixture", os: "windows", arch: "x64" }, execution_features: [...allSourceFeatures] };
const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { throw Error("No execution is allowed in a launcher fixture"); },
  async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
const sockets: Socket[] = [];
class Socket {
  static OPEN = 1; readyState = 0; sent: string[] = []; handlers = new Map<string, ((event: unknown) => void)[]>();
  constructor(_url: string) { sockets.push(this); }
  addEventListener(type: string, fn: (event: unknown) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  emit(type: string, event: unknown = {}) { for (const fn of this.handlers.get(type) ?? []) fn(event); }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
}
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(native, "assertWindowsProcessBackend").mockImplementation(() => {});
  vi.spyOn(runtime, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); sockets.length = 0; Object.defineProperty(process, "platform", platform); });
function fixture(importedReview = true, importedDesign = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-source-launcher-"))), workspace = join(root, "workspace"); mkdirSync(workspace);
  const program = join(root, "check.mjs"); writeFileSync(program, "throw Error('never execute launcher fixtures');\n");
  const backend = Object.freeze({}) as native.PreparedWindowsProcessBackend;
  const profile: verification.VerificationProfile = { id: "local", project_id: "project", workspace_root: workspace,
    commands: [{ id: "test", argv: [process.execPath, program], timeout_ms: 1000 }], required_files: [], subject_paths: ["src"] };
  const source = { runtime: Object.freeze({}) as runtime.PreparedProductSourceRuntime,
    semanticClient: { upload: vi.fn(), download: vi.fn() }, importedReview, importedDesign, assertCurrent: vi.fn(), assertDiscovery: vi.fn(), close: vi.fn() };
  const prepare = vi.spyOn(sourceNode, "prepareProductSourceNode").mockReturnValue(source);
  vi.spyOn(runtime, "readProductSourceRuntimeCapabilities").mockReturnValue({ semantic: true, measurementV2: true, importedReview: true, importedDesign: true });
  const create = vi.spyOn(clients, "createNodeClient");
  const options = { hello, url: "wss://control.example/api/v1/node?token=sk_device_fixture_secret", adapter,
    workspace: { allowedRoots: [workspace] }, windowsProcessBackend: backend, verificationProfiles: [profile],
    productSourceConfigFile: join(root, "source.json"), acknowledgeRunEvents: true, reconnectDelayMs: 1,
    WebSocketImpl: Socket as unknown as typeof WebSocket };
  return { source, prepare, create, options, backend };
}
async function start(node: ReturnType<typeof createArtoodNode>) { const pending = node.start(); sockets.at(-1)!.open(); await pending; return sockets.at(-1)!; }
describe("standard native source launcher", () => {
  it("strips all caller source capabilities when no protected source configuration is selected", async () => {
    const f = fixture(), node = createArtoodNode({ ...f.options, productSourceConfigFile: undefined });
    try {
      const socket = await start(node), advertised = JSON.parse(socket.sent[0]!);
      expect(advertised.execution_features.filter((feature: string) => allSourceFeatures.includes(feature))).toEqual([]);
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.create.mock.calls[0]![0].productSourceRuntime).toBeUndefined();
    } finally { await node.stop(); }
  });
  it("wires original prepared profiles and advertises H1/H2/H3 from constructed controllers", async () => {
    const f = fixture(), node = createArtoodNode(f.options);
    try {
      const socket = await start(node), configured = f.prepare.mock.calls[0]![0], client = f.create.mock.calls[0]![0];
      expect(configured.profiles).toEqual(client.verificationProfiles); expect(configured.profiles[0]).toBe(client.verificationProfiles![0]);
      expect(verification.readWindowsVerificationBackend(configured.profiles[0]!)).toBe(f.backend);
      expect(client.productSourceRuntime).toBe(f.source.runtime); expect(client.productSourceOperations!.isCurrent()).toBe(true);
      expect(JSON.parse(socket.sent[0]!).execution_features.filter((feature: string) => allSourceFeatures.includes(feature))).toEqual(allSourceFeatures);
      expect(JSON.stringify(JSON.parse(socket.sent[0]!))).not.toContain("source.json");
    } finally { await node.stop(); }
    expect(f.source.close).toHaveBeenCalledTimes(1);
  });
  it("does not advertise review or design controllers when only H1 is selected", async () => {
    const f = fixture(false, false), node = createArtoodNode(f.options);
    try {
      const socket = await start(node);
      expect(JSON.parse(socket.sent[0]!).execution_features.filter((feature: string) => allSourceFeatures.includes(feature))).toEqual(allSourceFeatures.slice(0, 4));
    } finally { await node.stop(); }
  });
  it("ends source session authority immediately on disconnect, settles once and never reconnects or restarts it", async () => {
    const f = fixture(), node = createArtoodNode(f.options), socket = await start(node), operations = f.create.mock.calls[0]![0].productSourceOperations!;
    socket.close(); expect(operations.isCurrent()).toBe(false); expect(await node.failed).toBeInstanceOf(Error);
    await Promise.all([node.stop(), node.stop()]);
    expect(sockets).toHaveLength(1); expect(f.source.close).toHaveBeenCalledTimes(1);
    await expect(node.start()).rejects.toThrow(/session ended/);
  });
  it("retains the runtime owner when controller shutdown cannot establish closure", async () => {
    const f = fixture(), node = createArtoodNode(f.options); await start(node);
    vi.spyOn(f.create.mock.results[0]!.value, "stop").mockRejectedValue(new Error("controlled uncertain closure"));
    await expect(node.stop()).rejects.toThrow(/uncertain closure/); expect(f.source.close).not.toHaveBeenCalled();
  });
  it.each(["explicit stop", "disconnect"])("does not report source readiness while %s is still awaiting controller closure", async mode => {
    const f = fixture(), node = createArtoodNode(f.options), socket = await start(node);
    let closed!: () => void;
    const closure = new Promise<void>(resolve => { closed = resolve; });
    vi.spyOn(f.create.mock.results[0]!.value, "stop").mockReturnValue(closure);
    if (mode === "disconnect") socket.close();
    const stopping = node.stop();
    await expect(node.start()).rejects.toThrow(/session ended/);
    expect(f.source.close).not.toHaveBeenCalled();
    closed(); await stopping; expect(f.source.close).toHaveBeenCalledTimes(1);
  });
  it("rejects H3 without committed receipts before any hello and closes the unused prepared runtime", async () => {
    const f = fixture(), node = createArtoodNode({ ...f.options, acknowledgeRunEvents: false });
    await expect(node.start()).rejects.toThrow(/committed/); expect(sockets.flatMap(socket => socket.sent)).toEqual([]);
    expect(f.source.close).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed discovery ACL audit before advertising source capabilities", async () => {
    const f = fixture(), node = createArtoodNode(f.options);
    f.source.assertDiscovery.mockImplementation(() => { throw new Error("controlled configuration ACL changed"); });
    await expect(node.start()).rejects.toThrow(/configuration ACL changed/);
    expect(sockets.flatMap(socket => socket.sent)).toEqual([]); expect(f.source.close).toHaveBeenCalledTimes(1);
  });
  it("rejects source configuration on managed or unqualified nodes without preparing runtime storage", () => {
    const f = fixture();
    expect(() => createArtoodNode({ ...f.options, windowsProcessBackend: undefined })).toThrow(/ordinary native/);
    expect(() => createArtoodNode({ ...f.options, hello: { ...hello, managed_receipts: { version: 1,
      nonce: "00000000-0000-4000-8000-000000000001", required_contract: "qualified" } } })).toThrow(/ordinary native/);
    expect(f.prepare).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
  });
});
