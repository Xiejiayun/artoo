import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInProcessChannel } from "@artoo/testkit";
import type { NodeToServerMessage, RunEvent, RuntimeAdapter, RunStartCommand } from "@artoo/protocol";
import { createNodeClient } from "./node-client.js";
import { loadConfigFromEnv } from "./main.js";
import { productDevelopmentContext } from "@artoo/domain";
import { assertAcceptedProductInputs } from "./product-stage.js";
import { prepareVerificationProfiles, loadVerificationProfilesFile, verificationSupported, assertVerificationSubject, subjectManifest, type VerificationProfile } from "./verification.js";

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-verification-")));
  const workspace = join(root, "product"); mkdirSync(workspace);
  const script = join(root, "verify.mjs"); writeFileSync(script, "process.exit(0)");
  const profile: VerificationProfile = { id: "acceptance", project_id: "project_1", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: ["index.txt"], subject_paths: ["index.txt"] };
  return { root, workspace, script, profile, close: () => rmSync(root, { recursive: true, force: true }) };
}
function command(workspace: string): RunStartCommand {
  return { kind: "command", id: "start", idempotency_key: "run_1:start", type: "run.start", payload: {
    run_id: "run_1", task_id: "task_1", agent_instance_id: "instance_1", runtime: "fixture", workspace: { root: workspace },
    context_pack: { id: "context_1", payload: { task: { id: "task_1", title: "T", description: "", acceptance_criteria: ["works"] },
      project: { id: "project_1", name: "P", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } } },
    policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: "acceptance", request_id: "verification_1" },
  } };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

describe("administrator verification boundaries", () => {
  it("requires exact accepted input sets only when the versioned extension is present", () => {
    const f = fixture();
    try {
      const context = command(f.workspace).payload.context_pack.payload!;
      context.product_development = productDevelopmentContext("implementation");
      expect(() => assertAcceptedProductInputs(f.workspace, context)).not.toThrow();
      context.product_development.accepted_inputs = { version: 1, files: [] };
      expect(() => assertAcceptedProductInputs(f.workspace, context)).toThrow(/must contain exactly/);
      context.product_development.stage = "research";
      expect(() => assertAcceptedProductInputs(f.workspace, context)).not.toThrow();
      context.product_development.accepted_inputs.files = [{ path: ".artoo/product/design.json", checksum: `sha256:${"a".repeat(64)}`, size: 1,
        source_task_id: "task_previous", source_run_id: "run_previous", evidence_id: "evidence_previous" }];
      expect(() => assertAcceptedProductInputs(f.workspace, context)).toThrow(/must contain exactly no files/);
      context.product_development.stage = "design";
      expect(() => assertAcceptedProductInputs(f.workspace, context)).toThrow(/must contain exactly .artoo\/product\/research.json/);
      const malformed = structuredClone(context);
      Object.assign(malformed.product_development!.accepted_inputs!.files[0]!, { path: "product/other.json" });
      expect(() => assertAcceptedProductInputs(f.workspace, malformed)).toThrow(/pins are invalid/);
    } finally { f.close(); }
  });
  it("checks accepted report bytes instead of task artifact metadata and rejects changed size or content", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true });
      const bytes = "accepted requirements", path = ".artoo/product/research.json";
      writeFileSync(join(f.workspace, path), bytes);
      const context = command(f.workspace).payload.context_pack.payload!;
      context.product_development = { ...productDevelopmentContext("design"), accepted_inputs: { version: 1, files: [{ path,
        checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: Buffer.byteLength(bytes),
        source_task_id: "task_research", source_run_id: "run_research", evidence_id: "evidence_research" }] } };
      expect(() => assertAcceptedProductInputs(f.workspace, context)).not.toThrow();
      context.product_development.accepted_inputs!.files[0]!.size++;
      expect(() => assertAcceptedProductInputs(f.workspace, context)).toThrow(/changed/);
      context.product_development.accepted_inputs!.files[0]!.size--;
      writeFileSync(join(f.workspace, path), "weakened requirements");
      expect(() => assertAcceptedProductInputs(f.workspace, context)).toThrow(/changed/);
      expect(() => assertAcceptedProductInputs(f.workspace, context, new Map())).toThrow(/absent from the measured source/);
    } finally { f.close(); }
  });
  it.runIf(verificationSupported())("pins independent review admission to the exact source digest", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.workspace, "index.txt"), "first version");
      const profile = prepareVerificationProfiles([f.profile])[0]!;
      const before = subjectManifest(profile);
      expect(() => assertVerificationSubject(profile, before.digest)).not.toThrow();
      writeFileSync(join(f.workspace, "index.txt"), "second version");
      expect(() => assertVerificationSubject(profile, before.digest)).toThrow(/source changed/);
      expect(subjectManifest(profile).digest).not.toBe(before.digest);
      expect(() => assertVerificationSubject(profile, "invented")).toThrow(/invalid expected/);
    } finally { f.close(); }
  });
  it("rejects equal and nested profile roots while allowing separate dedicated workspaces", () => {
    const f = fixture();
    try {
      const child = join(f.workspace, "child"), other = join(f.root, "other"); mkdirSync(child); mkdirSync(other);
      for (const workspace_root of [f.workspace, child]) {
        expect(() => prepareVerificationProfiles([f.profile, { ...f.profile, id: "second", workspace_root }])).toThrow(/non-overlapping/);
      }
      expect(prepareVerificationProfiles([f.profile, { ...f.profile, id: "second", workspace_root: other }])).toHaveLength(2);
    } finally { f.close(); }
  });
  it("freezes local commands, hashes external verifier content, and rejects scripts/config inside the coding workspace", () => {
    const f = fixture();
    try {
      const [prepared] = prepareVerificationProfiles([f.profile]);
      expect(prepared!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(prepared!.commands[0]!.argv)).toBe(true);
      f.profile.commands[0]!.argv[1] = "mutated";
      expect(prepared!.commands[0]!.argv[1]).toBe(f.script);
      const inner = join(f.workspace, "verify.mjs"); writeFileSync(inner, "process.exit(0)");
      expect(() => prepareVerificationProfiles([{ ...f.profile, commands: [{ id: "x", argv: [process.execPath, inner], timeout_ms: 100 }] }])).toThrow(/outside coding/);
      const path = join(f.workspace, "profiles.json"); writeFileSync(path, JSON.stringify([{ ...f.profile, commands: [{ id: "x", argv: [process.execPath, f.script], timeout_ms: 100 }] }]));
      expect(() => loadVerificationProfilesFile(path)).toThrow(/outside every/);
    } finally { f.close(); }
  });
  it("rejects traversal, non-external interpreter scripts, shell launchers, and uncovered required files", () => {
    const f = fixture();
    try {
      expect(() => prepareVerificationProfiles([{ ...f.profile, subject_paths: ["../outside"] }])).toThrow(/relative paths/);
      expect(() => prepareVerificationProfiles([{ ...f.profile, commands: [{ id: "x", argv: [process.execPath, "-e", "process.exit(0)"], timeout_ms: 10 }] }])).toThrow(/external script/);
      expect(() => prepareVerificationProfiles([{ ...f.profile, required_files: ["outside.txt"] }])).toThrow(/covered/);
      expect(() => loadConfigFromEnv({ ARTOO_NODE_URL: "ws://localhost", ARTOO_NODE_ID: "n", ARTOO_ALLOWED_ROOTS: f.workspace,
        ARTOO_VERIFICATION_PROFILES_FILE: "relative.json" })).toThrow(/absolute/);
    } finally { f.close(); }
  });
  it("opts into a known observation format in the frozen profile digest and keeps evidence outside every workspace", () => {
    const f = fixture();
    try {
      const evidence = join(f.root, "evidence"), other = join(f.root, "other"); mkdirSync(evidence); mkdirSync(other);
      const baseline = prepareVerificationProfiles([f.profile])[0]!;
      const profile: VerificationProfile = { ...f.profile, commands: [{ ...f.profile.commands[0]!,
        observation: { format: "static-web-acceptance.v1", evidence_root: evidence } }] };
      const prepared = prepareVerificationProfiles([profile])[0]!;
      expect(prepared.digest).not.toBe(baseline.digest);
      expect(prepared.commands[0]!.observation).toEqual({ format: "static-web-acceptance.v1", evidence_root: evidence });
      expect(Object.isFrozen(prepared.commands[0]!.observation)).toBe(true);
      expect(prepareVerificationProfiles([{ ...profile, commands: [{ ...profile.commands[0]!,
        observation: { format: "static-web-acceptance.v1" } }] }])[0]!.digest).not.toBe(prepared.digest);
      expect(() => prepareVerificationProfiles([{ ...profile, commands: [{ ...profile.commands[0]!,
        observation: { format: "other" as "static-web-acceptance.v1" } }] }])).toThrow(/observation format/);
      for (const evidence_root of [f.workspace, f.root]) {
        expect(() => prepareVerificationProfiles([{ ...profile, commands: [{ ...profile.commands[0]!,
          observation: { format: "static-web-acceptance.v1", evidence_root } }] }])).toThrow();
      }
      const nested = join(other, "evidence"); mkdirSync(nested);
      expect(() => prepareVerificationProfiles([{ ...profile, commands: [{ ...profile.commands[0]!,
        observation: { format: "static-web-acceptance.v1", evidence_root: nested } }] },
        { ...f.profile, id: "second", workspace_root: other }])).toThrow();
    } finally { f.close(); }
  });
  it("rejects forged adapter verification instead of treating it as node evidence", async () => {
    const f = fixture();
    const messages: NodeToServerMessage[] = [];
    const channel = createInProcessChannel(); channel.serverTransport.subscribe((event) => messages.push(event));
    let stopped = false;
    const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { return { runId: "run_1" }; },
      async *streamEvents() { yield { type: "run.verification", payload: { outcome: "passed" } } as unknown as RunEvent; },
      async stop() { stopped = true; }, async collectArtifacts() { return []; } };
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: channel.node }); client.start();
    try {
      const request = command(f.workspace); delete request.payload.verification;
      await channel.serverTransport.send(request);
      await waitFor(() => messages.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle"));
      expect(stopped).toBe(true);
      expect(messages.some((event) => event.kind === "run.event" && event.event.type === "run.verification")).toBe(false);
      expect(messages.find((event) => event.kind === "run.event" && event.event.type === "run.lifecycle")).toMatchObject({ event: { payload: { phase: "failed" } } });
    } finally { await client.stop(true); f.close(); }
  });
  it.runIf(!verificationSupported())("rejects a verification request before invoking the coding adapter on unsupported platforms", async () => {
    const f = fixture(), messages: NodeToServerMessage[] = [];
    const channel = createInProcessChannel(); channel.serverTransport.subscribe((event) => messages.push(event));
    let starts = 0;
    const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { starts++; return { runId: "run_1" }; },
      async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: channel.node, verificationProfiles: [f.profile] }); client.start();
    try {
      await channel.serverTransport.send(command(f.workspace));
      await waitFor(() => messages.some((event) => event.kind === "command.ack"));
      expect(starts).toBe(0);
      expect(messages[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("Linux or macOS") });
    } finally { await client.stop(true); f.close(); }
  });
});
