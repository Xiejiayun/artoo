import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  NodeToServerMessage,
  RuntimeAdapter,
  RunEventMessage,
  RunStartCommand
} from "@artoo/protocol";
import { nodeHeartbeatSchema } from "@artoo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { createAdapterRegistry } from "./adapter-registry.js";
import { createArtoodNode } from "./node-runner.js";
import { createProcessAdapter } from "./process-adapter.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";
import { VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE, VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE, MEASUREMENT_PLAN_V2_FEATURE, verificationSupported } from "./verification.js";
import * as verification from "./verification.js";
import * as windowsProcess from "./owned/windows-owned-process.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import * as nodeClient from "./node-client.js";
import { PRODUCT_RELEASE_FEATURE, PRODUCT_RELEASE_HEALTH_FEATURE, PRODUCT_RELEASE_ACCEPTANCE_FEATURE } from "./product-release.js";
import { PRODUCT_RELEASE_RETRY_FEATURE_V1 } from "@artoo/domain";

const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));

const hello: NodeHello = {
  kind: "node.hello",
  node_id: "computer_1",
  protocol_version: "2026-06-11",
  artood_version: "0.1.0",
  machine: { hostname: "h", os: "windows", arch: "x64" }
};

function makeRunStart(workspace: string): RunStartCommand {
  return {
    kind: "command",
    id: "cmd_1",
    idempotency_key: "run_1:start",
    type: "run.start",
    payload: {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "codex",
      workspace: { root: workspace },
      context_pack: { id: "ctx_1", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: ["*.patch"] }
    }
  };
}

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}
function isAck(m: NodeToServerMessage): m is CommandAck {
  return m.kind === "command.ack";
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let activeServer: WebSocketServer | undefined;
afterEach(() => {
  activeServer?.close();
  activeServer = undefined;
  fakeClientSockets.length = 0;
});

const idleAdapter: RuntimeAdapter = {
  runtimeId: "idle",
  async start(config) {
    return { runId: config.runId };
  },
  async *streamEvents() {},
  async stop() {},
  async collectArtifacts() {
    return [];
  }
};

const fakeClientSockets: FakeClientWebSocket[] = [];

class FakeClientWebSocket {
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    fakeClientSockets.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeClientWebSocket.OPEN;
    this.emit("open", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("Windows node activation (controlled backend admission; no native helper or provider run)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
  let backends: WeakSet<object>, invalidated: boolean;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    backends = new WeakSet(); invalidated = false;
    vi.spyOn(windowsProcess, "assertWindowsProcessBackend").mockImplementation(value => {
      if (!backends.has(value) || invalidated) throw new Error("Unprepared or changed Windows backend");
    });
    vi.spyOn(windowsProcess, "assertWindowsProcessBackendImage").mockImplementation(value => {
      if (!backends.has(value) || invalidated) throw new Error("Unprepared or changed Windows backend image");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function backend() {
    const value = Object.freeze({}) as PreparedWindowsProcessBackend; backends.add(value); return value;
  }
  function profilesFixture(capabilities = false) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-windows-node-activation-"))); roots.push(root);
    const workspace = join(root, "workspace"), script = join(root, "verify.mjs"); mkdirSync(workspace);
    writeFileSync(script, "process.exit(0)\n");
    const profile: verification.VerificationProfile = { id: "local", project_id: "project", workspace_root: workspace,
      commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["product", ".artoo/product"] };
    if (capabilities) {
      const evidence = join(root, "evidence"), config = join(root, "browser.json"); mkdirSync(evidence);
      writeFileSync(config, JSON.stringify({ evidence_root: evidence, viewports: [768, 320], design_capture_cases: true }));
      profile.commands = [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config], timeout_ms: 1000,
        observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }];
      profile.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    }
    return { root, workspace, script, profile };
  }
  const injectedHello = (): NodeHello => ({ ...hello, execution_features: [VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE,
    VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE, MEASUREMENT_PLAN_V2_FEATURE, PRODUCT_RELEASE_FEATURE,
    PRODUCT_RELEASE_HEALTH_FEATURE, PRODUCT_RELEASE_ACCEPTANCE_FEATURE, PRODUCT_RELEASE_RETRY_FEATURE_V1, "product-source-transfer.v1", "product-source-transfer.v2", "other-feature"],
    verification_profiles: [{ profile_id: "forged", project_id: "forged", workspace_root: "/forged" }],
    release_profiles: [{ profile_id: "forged", project_id: "forged", workspace_root: "/forged", verification_profile_id: "forged", target_kind: "static_site" }] });

  it("attaches every prepared profile and advertises only their exact supported Windows verification scope", async () => {
    const f = profilesFixture(true), other = join(f.root, "other"); mkdirSync(other);
    const localBackend = backend(), create = vi.spyOn(nodeClient, "createNodeClient");
    const profiles = [f.profile, { ...f.profile, id: "second", workspace_root: other }];
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello: injectedHello(), adapter: idleAdapter,
      verificationProfiles: profiles, windowsProcessBackend: localBackend, WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      profiles.length = 0;
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(verificationSupported()).toBe(false);
      expect(sent.execution_features).toEqual(["other-feature", VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE,
        VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE]);
      expect(sent.verification_profiles.map((item: { profile_id: string; workspace_root: string }) => [item.profile_id, item.workspace_root]))
        .toEqual([["local", f.workspace], ["second", other]]);
      expect(sent.verification_profiles[0].capabilities.measurement_plan_policy).toEqual({ version: 1, coverage: "every-must-criterion" });
      const prepared = create.mock.calls[0]![0].verificationProfiles as readonly verification.PreparedVerificationProfile[];
      expect(prepared).toHaveLength(2);
      for (const profile of prepared) expect(verification.readWindowsVerificationBackend(profile)).toBe(localBackend);
      expect(sent).not.toHaveProperty("release_profiles");
      for (const value of ["windowsProcessBackend", "trustedFiles", "argv", "manifestSha256"]) expect(JSON.stringify(sent)).not.toContain(value);
    } finally { await node.stop(); }
  });

  it.each(["no profiles", "no local backend"] as const)("does not authorize injected hello capabilities with %s", async missing => {
    const f = profilesFixture(), localBackend = backend();
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello: injectedHello(), adapter: idleAdapter,
      verificationProfiles: missing === "no profiles" ? [] : [f.profile],
      ...(missing === "no profiles" ? { windowsProcessBackend: localBackend } : {}), WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.execution_features).toEqual(["other-feature"]);
      expect(sent).not.toHaveProperty("verification_profiles"); expect(sent).not.toHaveProperty("release_profiles");
    } finally { await node.stop(); }
  });

  it("rejects forged or serialized backends before creating any transport even without profiles", () => {
    const localBackend = backend();
    for (const value of [{}, structuredClone(localBackend)]) {
      expect(() => createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
        windowsProcessBackend: value as PreparedWindowsProcessBackend, WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket })).toThrow(/Unprepared/);
    }
    expect(fakeClientSockets).toHaveLength(0);
  });

  it("rejects a Windows backend on other platforms and with a managed session", () => {
    const localBackend = backend();
    expect(() => createArtoodNode({ url: "ws://example.invalid/api/v1/node", adapter: idleAdapter, windowsProcessBackend: localBackend,
      hello: { ...hello, managed_receipts: { version: 1, nonce: "00000000-0000-4000-8000-000000000001", required_contract: "qualified" } } })).toThrow(/cannot be combined with managed/);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(() => createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
      windowsProcessBackend: localBackend })).toThrow(/only on Windows/);
    expect(fakeClientSockets).toHaveLength(0);
  });

  it("rejects an installation invalidated after construction before publishing any hello", async () => {
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
      windowsProcessBackend: backend(), WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      invalidated = true;
      await expect(node.start()).rejects.toThrow(/changed Windows backend/);
      expect(fakeClientSockets).toHaveLength(0);
    } finally { await node.stop(); }
  });

  it("rejects a protected verifier changed after construction before publishing its advertisement", async () => {
    const f = profilesFixture(), node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
      verificationProfiles: [f.profile], windowsProcessBackend: backend(), WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      writeFileSync(f.script, "process.exit(1)\n");
      await expect(node.start()).rejects.toThrow(/administrator verifier changed/);
      expect(fakeClientSockets).toHaveLength(0);
    } finally { await node.stop(); }
  });
});

describe("createArtoodNode (WS + ProcessAdapter end-to-end)", () => {
  it("advertises verifier support only when a configured profile has platform process-group support", async () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-verification-hello-"));
    const workspace = join(root, "product"); mkdirSync(workspace);
    const script = join(root, "verify.mjs"); writeFileSync(script, "process.exit(0)");
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node?token=dev",
      hello: { ...hello, execution_features: [VERIFICATION_FEATURE, VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE],
        verification_profiles: [{ profile_id: "forged", project_id: "forged", workspace_root: "/forged" }] }, adapter: idleAdapter,
      verificationProfiles: [{ id: "default", project_id: "p", workspace_root: workspace, commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["src"] }],
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.execution_features.includes(VERIFICATION_FEATURE)).toBe(verificationSupported());
      expect(sent.execution_features.includes(PRODUCT_STAGE_VERIFICATION_FEATURE)).toBe(verificationSupported());
      expect(sent.execution_features.includes(VERIFICATION_CAPABILITIES_FEATURE)).toBe(false);
      expect(sent.execution_features.includes(MEASUREMENT_PLAN_FEATURE)).toBe(false);
      expect(sent.verification_profiles).toEqual(verificationSupported()
        ? [{ profile_id: "default", project_id: "p", workspace_root: realpathSync.native(workspace) }] : undefined);
    } finally { await node.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("derives and snapshots discovery from local profiles rather than mutable caller advertisements", async () => {
    const supported = vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
    const root = mkdtempSync(join(tmpdir(), "artoo-verification-discovery-"));
    const workspace = join(root, "product"); mkdirSync(workspace);
    const script = join(root, "verify.mjs"); writeFileSync(script, "process.exit(0)");
    const profiles = [{ id: "local", project_id: "project_local", workspace_root: workspace,
      commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["src"] }];
    const callerHello: NodeHello = { ...hello, machine: { ...hello.machine }, execution_features: [VERIFICATION_FEATURE],
      verification_profiles: [{ profile_id: "forged", project_id: "forged", workspace_root: "/forged" }] };
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node?token=dev", hello: callerHello,
      adapter: idleAdapter, verificationProfiles: profiles, WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      profiles[0]!.id = "changed"; profiles[0]!.project_id = "changed"; profiles[0]!.workspace_root = "/missing";
      profiles[0]!.commands[0]!.argv[1] = "/missing-script"; profiles.length = 0;
      callerHello.node_id = "changed_node"; callerHello.machine.hostname = "changed_host";
      callerHello.execution_features!.push("forged-feature"); callerHello.verification_profiles![0]!.project_id = "changed-again";
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.node_id).toBe(hello.node_id); expect(sent.machine.hostname).toBe(hello.machine.hostname);
      expect(sent.execution_features).toEqual([VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE]);
      expect(sent.verification_profiles).toEqual([{ profile_id: "local", project_id: "project_local", workspace_root: realpathSync.native(workspace) }]);
      expect(JSON.stringify(sent)).not.toContain("argv"); expect(JSON.stringify(sent)).not.toContain(script);
    } finally { await node.stop(); supported.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("drops injected profile discovery and verification capability when no local profiles exist", async () => {
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node?token=dev", adapter: idleAdapter,
      hello: { ...hello, execution_features: [VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE, VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE, PRODUCT_RELEASE_FEATURE, PRODUCT_RELEASE_HEALTH_FEATURE, PRODUCT_RELEASE_RETRY_FEATURE_V1, "other-feature"],
        release_profiles: [{ profile_id: "forged", project_id: "p", workspace_root: "/forged", verification_profile_id: "forged", target_kind: "static_site" }],
        verification_profiles: [{ profile_id: "forged", project_id: "p", workspace_root: "/forged" }] },
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.execution_features).toEqual(["other-feature"]); expect(sent).not.toHaveProperty("verification_profiles");
      expect(sent).not.toHaveProperty("release_profiles");
    } finally { await node.stop(); }
  });
  it.each([false, true])("advertises the frozen opt-in contract and only locally enforced measurement policy (enabled=%s)", async (enabled) => {
    const supported = vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-capability-discovery-")));
    const workspace = join(root, "workspace"), evidence = join(root, "evidence"), path = join(root, "browser.json"); mkdirSync(workspace); mkdirSync(evidence);
    writeFileSync(path, JSON.stringify({ evidence_root: evidence, viewports: [768, 320], design_capture_cases: true }));
    readFileSync(path); // Settle NTFS's initial access metadata before immutable preparation.
    const profile: verification.VerificationProfile = { id: "local", project_id: "project", workspace_root: workspace,
      commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), path], timeout_ms: 1000,
        observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }], required_files: [], subject_paths: ["product", ".artoo/product"],
      ...(enabled ? { measurement_plan_policy: { version: 1, coverage: "every-must-criterion" } as const } : {}) };
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
      verificationProfiles: [profile], WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      // Startup passes prepared objects into createNodeClient; their private snapshot must survive.
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.execution_features).toContain(VERIFICATION_CAPABILITIES_FEATURE);
      expect(sent.execution_features.includes(MEASUREMENT_PLAN_FEATURE)).toBe(enabled);
      expect(sent.verification_profiles[0].capabilities.measurement_plan_policy).toEqual(enabled ? { version: 1, coverage: "every-must-criterion" } : undefined);
      expect(sent.verification_profiles[0]).toMatchObject({ profile_id: "local", capabilities: { version: 1,
        checks: [{ command_id: "browser", contract: { claim: "configured", viewports: [{ width: 768, height: 900 }, { width: 320, height: 900 }],
          stage_policy: { design: "declared-cases" } } }] } });
      for (const privateValue of [path, evidence, "argv", "options", "trustedFiles"]) expect(JSON.stringify(sent)).not.toContain(privateValue);
    } finally { await node.stop(); supported.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps measurement v2 publication discovery without advertising unsupported research transfer semantics", async () => {
    const supported = vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-release-acceptance-discovery-")));
    const workspace = join(root, "workspace"), storage = join(root, "storage"), evidence = join(root, "evidence"), path = join(root, "browser.json");
    mkdirSync(workspace); mkdirSync(storage); mkdirSync(evidence);
    writeFileSync(path, JSON.stringify({ evidence_root: evidence, design_capture_cases: true,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 900 }] } })); readFileSync(path);
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello: { ...hello,
      execution_features: [MEASUREMENT_PLAN_FEATURE, MEASUREMENT_PLAN_V2_FEATURE, PRODUCT_RELEASE_ACCEPTANCE_FEATURE,
        "product-source-transfer.v1", "product-source-transfer.v2"] }, adapter: idleAdapter,
      verificationProfiles: [{ id: "verify", project_id: "project", workspace_root: workspace, subject_paths: ["product", ".artoo/product"], required_files: [],
        measurement_plan_policy: { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] },
        commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), path], timeout_ms: 1000,
          observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }] }],
      releaseProfiles: [{ id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage, output_path: "product",
        public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port, health_checks: [{ path: "/" }], health_timeout_ms: 1000,
        criterion_acceptance: { version: 1 } }], WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.execution_features).toContain(MEASUREMENT_PLAN_V2_FEATURE); expect(sent.execution_features).toContain(PRODUCT_RELEASE_ACCEPTANCE_FEATURE);
      expect(sent.execution_features).not.toContain(MEASUREMENT_PLAN_FEATURE);
      expect(sent.execution_features).not.toContain("product-source-transfer.v1");
      expect(sent.execution_features).not.toContain("product-source-transfer.v2");
      expect(sent.verification_profiles[0].capabilities.measurement_plan_policy).toEqual({ version: 2,
        coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] });
      expect(sent.release_profiles[0]).toMatchObject({ profile_id: "site", capabilities: { version: 1,
        binding: { release_profile_id: "site", project_id: "project", workspace_root: workspace, verification_profile_id: "verify",
          verification_profile_digest: sent.verification_profiles[0].capabilities.profile_digest },
        contract: { kind: "configured-static-release", measurement_scope: "node-http-point-in-time" } } });
      for (const privateValue of [storage, path, evidence, "argv", "trustedFiles"]) expect(JSON.stringify(sent)).not.toContain(privateValue);
    } finally { await node.stop(); supported.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("advertises only local capabilities and target metadata (monitoring=%s)", async (monitoring) => {
    const supported = vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
    const root = mkdtempSync(join(tmpdir(), "artoo-release-discovery-"));
    const workspace = join(root, "workspace"), storage = join(root, "storage"); mkdirSync(workspace); mkdirSync(storage);
    const script = join(root, "verify.mjs"); writeFileSync(script, "process.exit(0)");
    const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port; await new Promise<void>((resolve) => listener.close(() => resolve()));
    const releases = [{ id: "local-release", project_id: "project", verification_profile_id: "local-verify", storage_root: storage,
      output_path: "web", public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
      health_checks: [{ path: "/" }], health_timeout_ms: 1000,
      ...(monitoring ? { monitoring: { interval_ms: 60000, failure_threshold: 2 } } : {}) }];
    const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello, adapter: idleAdapter,
      verificationProfiles: [{ id: "local-verify", project_id: "project", workspace_root: workspace,
        commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["web"] }],
      releaseProfiles: releases, WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket });
    try {
      releases[0]!.storage_root = "/changed"; releases[0]!.id = "changed"; releases.length = 0;
      const started = node.start(); fakeClientSockets.at(-1)!.open(); await started;
      const sent = JSON.parse(fakeClientSockets.at(-1)!.sent[0]!);
      expect(sent.release_profiles).toEqual([{ profile_id: "local-release", project_id: "project",
        verification_profile_id: "local-verify", workspace_root: realpathSync.native(workspace), target_kind: "static_site" }]);
      expect(sent.execution_features).toContain(PRODUCT_RELEASE_FEATURE);
      expect(sent.execution_features).toContain(PRODUCT_RELEASE_RETRY_FEATURE_V1);
      expect(sent.execution_features.includes(PRODUCT_RELEASE_HEALTH_FEATURE)).toBe(monitoring);
      expect(JSON.stringify(sent)).not.toContain(storage); expect(JSON.stringify(sent)).not.toContain("health_checks");
    } finally { await node.stop(); supported.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("does not open the WebSocket until start is called", async () => {
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      adapter: idleAdapter,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });

    expect(fakeClientSockets).toHaveLength(0);
    const started = node.start();
    expect(fakeClientSockets).toHaveLength(1);
    fakeClientSockets[0]?.open();
    await started;
    expect(fakeClientSockets[0]?.sent[0]).toBe(JSON.stringify(hello));

    await node.stop();
  });

  it("runs the full node loop: hello -> run.start -> process adapter -> run.event -> completed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "artoo-node-"));
    try {
      const wss = new WebSocketServer({ port: 0 });
      activeServer = wss;
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      const port = (wss.address() as AddressInfo).port;

      const received: NodeToServerMessage[] = [];
      wss.once("connection", (socket) => {
        socket.on("message", (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as NodeToServerMessage;
          received.push(message);
          // Server dispatches run.start only after node.hello (registration rule).
          if (message.kind === "node.hello") {
            socket.send(JSON.stringify(makeRunStart(workspace)));
          }
        });
      });

      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"],
        allowedRoots: [workspace],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const node = createArtoodNode({ url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`, hello, adapter });
      await node.start();

      await waitUntil(() =>
        received.some(
          (m) => isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed"
        )
      );

      const acks = received.filter(isAck);
      const runEvents = received.filter(isRunEvent);

      expect(acks[0]).toMatchObject({ status: "accepted", command_id: "cmd_1" });
      // sequence is per-run monotonic from 0
      expect(runEvents.map((e) => e.sequence)).toEqual(runEvents.map((_, i) => i));
      expect(runEvents.every((e) => e.run_id === "run_1" && e.node_id === "computer_1")).toBe(true);
      expect(runEvents.some((e) => e.event.type === "artifact.created")).toBe(true);
      expect(runEvents.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });

      await node.stop();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("createArtoodNode registry heartbeat wiring", () => {
  function heartbeatFrames(socket: FakeClientWebSocket): NodeToServerMessage[] {
    return socket.sent
      .map((s) => JSON.parse(s) as NodeToServerMessage)
      .filter((m) => m.kind === "node.heartbeat");
  }

  it("auto-wires a heartbeat advertising registry capability tags in registry mode", async () => {
    const registry = createAdapterRegistry([
      codexRuntime({ allowedRoots: ["/ws"] }),
      claudeCodeRuntime({ allowedRoots: ["/ws"] })
    ]);
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      registry,
      heartbeatIntervalMs: 5,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });
    const started = node.start();
    fakeClientSockets[0]?.open();
    await started;

    const socket = fakeClientSockets[0]!;
    await waitUntil(() => heartbeatFrames(socket).length > 0);
    const parsed = nodeHeartbeatSchema.parse(heartbeatFrames(socket)[0]);
    expect(parsed.node_id).toBe("computer_1");
    expect(parsed.runtimes).toEqual([
      { runtime: "codex", status: "available", capabilities: ["code.read", "code.modify", "code.review", "test.run"] },
      {
        runtime: "claude-code",
        status: "available",
        capabilities: ["code.read", "code.modify", "code.review", "test.run"]
      }
    ]);

    await node.stop();
  });

  it("lets an explicit heartbeat option override the registry default", async () => {
    const registry = createAdapterRegistry([codexRuntime({ allowedRoots: ["/ws"] })]);
    const explicit = (): NodeHeartbeat => ({
      kind: "node.heartbeat",
      node_id: "computer_1",
      sequence: 0,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 0 },
      runtimes: [],
      running_instances: []
    });
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      registry,
      heartbeat: explicit,
      heartbeatIntervalMs: 5,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });
    const started = node.start();
    fakeClientSockets[0]?.open();
    await started;

    const socket = fakeClientSockets[0]!;
    await waitUntil(() => heartbeatFrames(socket).length > 0);
    // Empty runtimes proves the explicit producer was used, not the registry default.
    expect(nodeHeartbeatSchema.parse(heartbeatFrames(socket)[0]).runtimes).toEqual([]);

    await node.stop();
  });
});
