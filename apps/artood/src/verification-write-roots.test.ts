import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInProcessChannel } from "@artoo/testkit";
import type { NodeHello, NodeToServerMessage, RuntimeAdapter, RunStartCommand } from "@artoo/protocol";
import { loadConfigFromEnv } from "./main.js";
import { createArtoodNode } from "./node-runner.js";
import { createNodeClient } from "./node-client.js";
import { assertVerificationWorkspaceBoundary, loadVerificationProfilesFile, prepareVerificationProfiles,
  type VerificationProfile } from "./verification.js";

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-verifier-roots-"))); fixtures.push(root);
  const workspace = join(root, "product"), control = join(root, "control"), verifier = join(root, "verifier");
  const evidence = join(root, "evidence"), ordinary = join(root, "ordinary");
  for (const directory of [workspace, control, verifier, evidence, ordinary]) mkdirSync(directory);
  const script = join(verifier, "verify.cjs"), config = join(control, "check.json"), profilesFile = join(control, "profiles.json");
  writeFileSync(script, "process.exit(0)\n"); writeFileSync(config, "{}\n");
  const profile: VerificationProfile = { id: "acceptance", project_id: "project_1", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["product"] };
  const withEvidence: VerificationProfile = { ...profile, commands: [{ ...profile.commands[0]!,
    observation: { format: "static-web-acceptance.v1", evidence_root: evidence } }] };
  const writeProfiles = (profiles: readonly VerificationProfile[] = [profile]) => writeFileSync(profilesFile, JSON.stringify(profiles));
  writeProfiles();
  return { root, workspace, control, verifier, evidence, ordinary, script, config, profilesFile, profile, withEvidence, writeProfiles };
}
function command(workspace: string): RunStartCommand {
  return { kind: "command", id: "start", idempotency_key: "run_1:start", type: "run.start", payload: {
    run_id: "run_1", task_id: "task_1", agent_instance_id: "instance_1", runtime: "fixture", workspace: { root: workspace },
    context_pack: { id: "context_1", payload: { task: { id: "task_1", title: "T", description: "", acceptance_criteria: ["works"] },
      project: { id: "project_1", name: "P", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } } },
    policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
  } };
}
function adapter() {
  return { runtimeId: "fixture", start: vi.fn(async (config) => ({ runId: config.runId })),
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } } satisfies RuntimeAdapter;
}
const hello: NodeHello = { kind: "node.hello", node_id: "node_1", protocol_version: "2026-06-11", artood_version: "0.1.0",
  machine: { hostname: "local", os: process.platform, arch: process.arch } };

describe("all node writable roots stay outside verifier authority", () => {
  it("rejects a broad parent root that includes a sibling verifier", () => {
    const f = fixture();
    expect(() => prepareVerificationProfiles([f.profile], [f.root])).toThrow(/protected verification/);
  });

  it.each(["script", "configuration"])("checks a second allowed root containing the protected %s", (asset) => {
    const f = fixture();
    const profile = asset === "configuration" ? { ...f.profile, commands: [{ ...f.profile.commands[0]!,
      argv: [process.execPath, f.script, f.config] }] } : f.profile;
    expect(() => prepareVerificationProfiles([profile], [f.workspace, asset === "script" ? f.verifier : f.control])).toThrow(/protected verification/);
  });

  it.each(["same", "parent", "child"])("rejects writable roots %s to the evidence directory", (relation) => {
    const f = fixture(), child = join(f.evidence, "ordinary"); mkdirSync(child);
    const writable = relation === "same" ? f.evidence : relation === "parent" ? f.root : child;
    expect(() => prepareVerificationProfiles([f.withEvidence], [f.workspace, writable])).toThrow(/protected verification/);
  });

  it("canonicalizes an allowed-root directory alias before admitting a verifier", () => {
    const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.verifier, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareVerificationProfiles([f.profile], [f.workspace, alias])).toThrow(/protected verification/);
  });

  it("keeps valid separated roots and the serialized profile digest unchanged", () => {
    const f = fixture(), previous = prepareVerificationProfiles([f.withEvidence])[0]!;
    const guarded = prepareVerificationProfiles([f.withEvidence], [f.workspace, f.ordinary])[0]!;
    expect(guarded.digest).toBe(previous.digest);
    expect(JSON.stringify(guarded)).toBe(JSON.stringify(previous));
    expect(Object.keys(guarded)).toEqual(Object.keys(previous));
  });

  it("rechecks an already prepared profile against the newly supplied wider roots", () => {
    const f = fixture(), prepared = prepareVerificationProfiles([f.profile], [f.workspace]);
    expect(() => prepareVerificationProfiles(prepared, [f.root])).toThrow(/protected verification/);
  });

  it("protects the profile JSON against a separate ordinary writable root", () => {
    const f = fixture();
    expect(() => loadVerificationProfilesFile(f.profilesFile, [f.workspace, f.control])).toThrow(/profiles file.*writable/);
    expect(loadVerificationProfilesFile(f.profilesFile, [f.workspace, f.ordinary])).toHaveLength(1);
  });

  it("main passes its complete allowedRoots through both verifier and profile-file checks", () => {
    const f = fixture(), env = { ARTOO_NODE_URL: "ws://localhost", ARTOO_NODE_ID: "node_1",
      ARTOO_VERIFICATION_PROFILES_FILE: f.profilesFile, ARTOO_ALLOWED_ROOTS: f.workspace };
    expect(() => loadConfigFromEnv({ ...env, ARTOO_ALLOWED_ROOTS: [f.workspace, f.verifier].join(";") })).toThrow(/protected verification/);
    expect(() => loadConfigFromEnv({ ...env, ARTOO_ALLOWED_ROOTS: [f.workspace, f.control].join(";") })).toThrow(/profiles file.*writable/);
    expect(loadConfigFromEnv(env).verificationProfiles).toHaveLength(1);
  });

  it.each(["runner", "client"])("rechecks explicit writable roots in the programmatic %s entry", (entry) => {
    const f = fixture(), shared = { adapter: adapter(), verificationProfiles: [f.profile], workspace: { allowedRoots: [f.root] } };
    expect(() => entry === "runner" ? createArtoodNode({ ...shared, url: "ws://localhost", hello })
      : createNodeClient({ ...shared, nodeId: "node_1", transport: createInProcessChannel().node })).toThrow(/protected verification/);
  });

  it("keeps unconfigured ordinary APIs compatible without resolving their optional roots", () => {
    const f = fixture(), roots = [join(f.root, "not-created")];
    expect(prepareVerificationProfiles(undefined, roots)).toEqual([]);
    expect(() => createArtoodNode({ url: "ws://localhost", hello, adapter: adapter(), workspace: { allowedRoots: roots } })).not.toThrow();
    const client = createNodeClient({ nodeId: "node_1", adapter: adapter(), transport: createInProcessChannel().node,
      workspace: { allowedRoots: roots } });
    expect(client).toBeDefined();
    expect(loadConfigFromEnv({ ARTOO_NODE_URL: "ws://localhost", ARTOO_NODE_ID: "node_1", ARTOO_ALLOWED_ROOTS: roots.join(";") }).verificationProfiles).toBeUndefined();
  });
});

describe("legacy programmatic clients reserve protected verification assets", () => {
  it.each(["verifier", "evidence", "evidence-child"])("rejects ordinary task workspace at %s without requiring a configured allowlist", (asset) => {
    const f = fixture(), child = join(f.evidence, "ordinary"); mkdirSync(child);
    const target = asset === "verifier" ? f.verifier : asset === "evidence" ? f.evidence : child;
    expect(() => assertVerificationWorkspaceBoundary(command(target).payload, prepareVerificationProfiles([f.withEvidence]), false))
      .toThrow(/protected verification/);
  });

  it("reserves profile JSON through subsequent preparations without serializing its path", () => {
    const f = fixture(), loaded = loadVerificationProfilesFile(f.profilesFile);
    const prepared = prepareVerificationProfiles(prepareVerificationProfiles(loaded));
    expect(JSON.stringify(prepared)).not.toContain(f.profilesFile.replaceAll("\\", "\\\\"));
    expect(() => assertVerificationWorkspaceBoundary(command(f.control).payload, prepared, false)).toThrow(/protected verification/);
  });

  it("resolves task workspace aliases and nonexisting evidence descendants before admission", () => {
    const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.verifier, alias, process.platform === "win32" ? "junction" : "dir");
    const prepared = prepareVerificationProfiles([f.withEvidence]);
    for (const target of [alias, join(f.evidence, "future", "workspace")]) {
      expect(() => assertVerificationWorkspaceBoundary(command(target).payload, prepared, false)).toThrow(/protected verification/);
    }
  });

  it("keeps a separate ordinary workspace and an exactly bound verified workspace admissible", () => {
    const f = fixture(), prepared = prepareVerificationProfiles([f.withEvidence]), verified = command(f.workspace);
    verified.payload.verification = { version: 1, profile_id: f.profile.id, request_id: "request_1" };
    expect(() => assertVerificationWorkspaceBoundary(command(f.ordinary).payload, prepared, false)).not.toThrow();
    expect(() => assertVerificationWorkspaceBoundary(verified.payload, prepared, false)).not.toThrow();
    expect(() => assertVerificationWorkspaceBoundary(command(f.verifier).payload, [], false)).not.toThrow();
  });

  it.each(["verifier", "evidence", "profiles"])("node-client rejects an actual ordinary run.start for %s before invoking its adapter", async (asset) => {
    const f = fixture(); f.writeProfiles([f.withEvidence]);
    const target = asset === "verifier" ? f.verifier : asset === "evidence" ? f.evidence : f.control;
    const channel = createInProcessChannel(), messages: NodeToServerMessage[] = [], runtime = adapter();
    channel.serverTransport.subscribe(message => messages.push(message));
    const client = createNodeClient({ nodeId: "node_1", adapter: runtime, transport: channel.node,
      verificationProfiles: loadVerificationProfilesFile(f.profilesFile) }); client.start();
    try {
      await channel.serverTransport.send(command(target));
      await vi.waitFor(() => expect(messages.some(message => message.kind === "command.ack")).toBe(true));
      expect(messages.find(message => message.kind === "command.ack")).toMatchObject({ status: "rejected",
        message: expect.stringContaining("protected verification") });
      expect(runtime.start).not.toHaveBeenCalled();
    } finally { await client.stop(true); }
  });
});
