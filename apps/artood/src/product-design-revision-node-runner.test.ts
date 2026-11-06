// Real runner/client/transport and local profile preparation. Socket delivery and
// native backend qualification are controlled; no provider or native process runs.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_DESIGN_REVISION_FEATURE_V1 } from "@artoo/domain";
import type { NodeHello, RuntimeAdapter } from "@artoo/protocol";
import { createArtoodNode } from "./node-runner.js";
import * as nodeClient from "./node-client.js";
import * as native from "./owned/windows-owned-process.js";
import * as browserAuthority from "./windows-browser-process-authority.js";
import { readWindowsVerificationBackend, productDesignRevisionVerificationSupported, type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";

const sockets: ControlledSocket[] = [], roots: string[] = [];
class ControlledSocket {
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) { sockets.push(this); }
  addEventListener(type: string, callback: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; for (const callback of this.listeners.get("open") ?? []) callback({}); }
  close() { this.readyState = 3; for (const callback of this.listeners.get("close") ?? []) callback({}); }
}
const adapter: RuntimeAdapter = { runtimeId: "controlled", async start(config) { return { runId: config.runId }; },
  async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let backend: native.PreparedWindowsProcessBackend;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  backend = Object.freeze({}) as native.PreparedWindowsProcessBackend;
  vi.spyOn(native, "assertWindowsProcessBackend").mockImplementation(value => { if (value !== backend) throw Error("Controlled original backend required"); });
  vi.spyOn(browserAuthority, "assertWindowsBrowserProcessInstallation").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); sockets.length = 0;
  for (const root of roots.splice(0)) {
    const tail = relative(realpathSync.native(tmpdir()), root);
    if (isAbsolute(tail) || tail.startsWith("..") || !tail.startsWith("artoo-revision-discovery-")) throw Error("Unsafe controlled discovery cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});
function profiles(options: { capture?: boolean; job?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-revision-discovery-"))); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "browser.json");
  mkdirSync(workspace); mkdirSync(evidence);
  const configuration = { evidence_root: evidence, design_capture_cases: options.capture ?? true,
    ...(options.job === false ? {} : { windows_browser_process: { version: 1 } }),
    browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } };
  writeFileSync(config, JSON.stringify(configuration)); readFileSync(config);
  const profile: VerificationProfile = { id: "local", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config], timeout_ms: 30000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"],
    measurement_plan_policy: { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] } };
  return { root, workspace, configuration, config, profile };
}
function injectedHello(): NodeHello {
  return { kind: "node.hello", node_id: "computer", protocol_version: "2026-06-11", artood_version: "0.1.0",
    machine: { hostname: "controlled", os: "windows", arch: "x64" },
    execution_features: [PRODUCT_DESIGN_REVISION_FEATURE_V1, "ordinary-extension", PRODUCT_DESIGN_REVISION_FEATURE_V1],
    verification_profiles: [{ profile_id: "forged", project_id: "forged", workspace_root: "C:\\forged" }] };
}
async function observe(profile?: VerificationProfile, withBackend = true) {
  const node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello: injectedHello(), adapter,
    verificationProfiles: profile ? [profile] : [], ...(profile ? { workspace: { allowedRoots: [profile.workspace_root] } } : {}),
    ...(withBackend ? { windowsProcessBackend: backend } : {}), WebSocketImpl: ControlledSocket as unknown as typeof WebSocket });
  try {
    const started = node.start(); sockets.at(-1)!.open(); await started;
    return JSON.parse(sockets.at(-1)!.sent[0]!) as NodeHello;
  } finally { await node.stop(); }
}

describe("design-revision discovery from original local profiles", () => {
  it("strips caller-supplied revision support and forged profile discovery when no local profile exists", async () => {
    const sent = await observe();
    expect(sent.execution_features).toEqual(["ordinary-extension"]); expect(sent.verification_profiles).toBeUndefined();
  });
  it("advertises exactly once for the original native Job/policy-v2/v3/all-case profile used by its client", async () => {
    const f = profiles(), create = vi.spyOn(nodeClient, "createNodeClient"), sent = await observe(f.profile);
    expect(sent.execution_features?.filter(value => value === PRODUCT_DESIGN_REVISION_FEATURE_V1)).toHaveLength(1);
    expect(sent.execution_features).toContain("ordinary-extension");
    expect(sent.verification_profiles).toHaveLength(1);
    expect(sent.verification_profiles![0]).toMatchObject({ profile_id: "local", project_id: "project", workspace_root: f.workspace,
      capabilities: { measurement_plan_policy: { version: 2 }, checks: [{ contract: { version: 3, stage_policy: { design: "declared-cases" } } }] } });
    const prepared = (create.mock.calls[0]![0].verificationProfiles as readonly PreparedVerificationProfile[])[0]!;
    expect(readWindowsVerificationBackend(prepared)).toBe(backend); expect(productDesignRevisionVerificationSupported(prepared)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("trustedFiles"); expect(JSON.stringify(sent)).not.toContain("argv");
  });
  it.each(["prototype-only", "non-job", "missing-backend"])("does not advertise a superficially similar but unsupported profile: %s", mode => {
    const f = profiles({ capture: mode !== "prototype-only", job: mode !== "non-job" });
    return observe(f.profile, mode !== "missing-backend").then(sent => {
      expect(sent.execution_features).not.toContain(PRODUCT_DESIGN_REVISION_FEATURE_V1);
      expect(sent.execution_features).toContain("ordinary-extension");
    });
  });
  it("rejects changed protected configuration before opening a socket or publishing stale revision support", async () => {
    const f = profiles(), node = createArtoodNode({ url: "ws://example.invalid/api/v1/node", hello: injectedHello(), adapter,
      verificationProfiles: [f.profile], windowsProcessBackend: backend, workspace: { allowedRoots: [f.workspace] },
      WebSocketImpl: ControlledSocket as unknown as typeof WebSocket });
    try {
      writeFileSync(f.config, JSON.stringify({ ...f.configuration, design_capture_cases: false }));
      await expect(node.start()).rejects.toThrow("administrator verifier changed"); expect(sockets).toHaveLength(0);
    } finally { await node.stop(); }
  });
});
