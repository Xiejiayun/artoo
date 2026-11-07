import { contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, productDevelopmentContext, type VerificationProfileAdvertisement } from "@artoo/domain";
import type { NodeTransport, ServerToNodeMessage } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { verificationCapabilitiesFixture } from "./test-fixtures/verification-capabilities.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";

const computer = "computer_local_mock", root = "/work/product";
const profile = { profile_id: "default", project_id: "proj_artoo", workspace_root: root };
describe("verified dispatch requires the current node's public profile binding", () => {
  let server: TestServer;
  const bindings: NodeBinding[] = [], sent: ServerToNodeMessage[] = [];
  beforeEach(async () => { server = await buildTestServer({ workspaceRoot: root }); server.ctx.onRunQueued = async () => {}; });
  afterEach(async () => { for (const binding of bindings.splice(0)) binding.close(); sent.length = 0; await server.close(); });
  function wire(profiles: readonly VerificationProfileAdvertisement[] = [], features = ["run-verification.v1"]) {
    const transport: NodeTransport = { async send(message) { sent.push(structuredClone(message)); }, subscribe() { return () => {}; }, async close() {} };
    const binding: NodeBinding = attachNodeBinding(server.ctx, transport, computer, features,
      () => server.nodeRegistry.get(computer) === binding, profiles);
    bindings.push(binding); server.nodeRegistry.register(computer, binding); return binding;
  }
  async function queued(verified = true) {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Dispatch fixture", acceptance_criteria: ["Verify the stored request"], required_capabilities: [],
    } });
    const taskId = created.json().task.id;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const run = assigned.json().run as { id: string; context_pack_id: string };
    // Binding-level fixture for an already committed autonomous assignment; no coding process is launched.
    if (verified) await server.db.db.update(runs).set({ verificationRequirement: { version: 1, request_id: "verify_1", profile_id: "default" } }).where(eq(runs.id, run.id));
    return run;
  }
  it("dispatches an exact match and preserves manual dispatch with legacy hello", async () => {
    const run = await queued(), binding = wire([profile]);
    expect(server.ctx.supportsVerificationProfile?.(computer, "default", "proj_artoo", root)).toBe(true);
    await binding.dispatchRunStart(run.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "run.start", payload: { verification: { request_id: "verify_1" }, workspace: { root } } });
    await server.db.db.update(runs).set({ verificationRequirement: null }).where(eq(runs.id, run.id));
    await wire().dispatchRunStart(run.id);
    expect(sent).toHaveLength(2); expect(sent[1]).not.toHaveProperty("payload.verification");
  });
  it("returns an isolated capability snapshot only from the matching current authenticated connection", () => {
    const capabilities = verificationCapabilitiesFixture();
    const advertised = { ...profile, capabilities };
    const binding = wire([advertised], ["run-verification.v1", "verification-capabilities.v1"]);
    const snapshot = server.ctx.getVerificationCapabilities?.(computer, "default", "proj_artoo", root);
    expect(snapshot).toEqual(verificationCapabilitiesFixture());
    capabilities.checks[0]!.contract.viewports[0]!.width = 400;
    snapshot!.checks[0]!.contract.viewports[0]!.width = 500;
    expect(binding.getVerificationCapabilities?.("default", "proj_artoo", root)).toEqual(verificationCapabilitiesFixture());
    for (const [id, project, workspace] of [["other", "proj_artoo", root], ["default", "other", root], ["default", "proj_artoo", `${root}/other`]]) {
      expect(binding.getVerificationCapabilities?.(id!, project!, workspace!)).toBeUndefined();
    }
    wire([profile]);
    expect(binding.getVerificationCapabilities?.("default", "proj_artoo", root)).toBeUndefined();
    const unfeatured = wire([{ ...profile, capabilities: verificationCapabilitiesFixture() }]);
    expect(unfeatured.getVerificationCapabilities?.("default", "proj_artoo", root)).toBeUndefined();
    const closed = wire([{ ...profile, capabilities: verificationCapabilitiesFixture() }], ["run-verification.v1", "verification-capabilities.v1"]);
    closed.close();
    expect(closed.getVerificationCapabilities?.("default", "proj_artoo", root)).toBeUndefined();
  });
  it("leaves ordinary manual runs unbound when the node also advertises opt-in capabilities", async () => {
    const binding = wire([{ ...profile, capabilities: verificationCapabilitiesFixture() }], ["run-verification.v1", "verification-capabilities.v1"]);
    const run = await queued(false);
    await binding.dispatchRunStart(run.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("payload.verification");
    expect(sent[0]).not.toHaveProperty("payload.context_pack.payload.verification_capabilities");
  });
  it.each(["matching", "missing_context", "changed_context", "missing_binding", "changed_binding", "changed_advertisement", "missing_feature"])(
    "dispatch checks the exact stored capability context and requirement: %s", async (scenario) => {
      const run = await queued(), capabilities = verificationCapabilitiesFixture();
      const request = { version: 1, request_id: "verify_1", profile_id: "default", capability_binding: verificationCapabilityBinding(capabilities) };
      const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
      const context = ContextPackSchema.parse(stored!.payload);
      context.verification_capabilities = { ...structuredClone(capabilities), profile_id: "default" };
      if (scenario === "missing_context") delete context.verification_capabilities;
      if (scenario === "changed_context") context.verification_capabilities!.checks[0]!.contract.viewports[0]!.width = 900;
      if (scenario === "changed_binding") request.capability_binding.checks[0]!.config_digest = `sha256:${"d".repeat(64)}`;
      await server.db.db.update(runs).set({ verificationRequirement: scenario === "missing_binding"
        ? { version: 1, request_id: "verify_1", profile_id: "default" } : request }).where(eq(runs.id, run.id));
      await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.context_pack_id));
      if (scenario === "changed_advertisement") capabilities.profile_digest = `sha256:${"e".repeat(64)}`;
      const binding = wire([{ ...profile, capabilities }], scenario === "missing_feature" ? ["run-verification.v1"] : ["run-verification.v1", "verification-capabilities.v1"]);
      if (scenario === "matching") { await binding.dispatchRunStart(run.id); expect(sent).toHaveLength(1); }
      else { await expect(binding.dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "verification_capability_mismatch" } }); expect(sent).toHaveLength(0); }
      expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("queued");
    });
  it("blocks absent or mismatched profiles without mutating the queued run", async () => {
    const run = await queued();
    const before = (await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0];
    for (const profiles of [[], [{ ...profile, profile_id: "other" }], [{ ...profile, project_id: "other" }], [{ ...profile, workspace_root: `${root}/other` }]]) {
      await expect(wire(profiles).dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "verification_profile_mismatch" } });
    }
    expect(sent).toHaveLength(0);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]).toEqual(before);
  });
  it.each([false, true])("requires the measurement-plan feature exactly when the bound policy is configured: policy=%s", async enabled => {
    const run = await queued(), capabilities = verificationCapabilitiesFixture();
    if (enabled) capabilities.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    const request = { version: 1, request_id: "verify_measurement", profile_id: "default", capability_binding: verificationCapabilityBinding(capabilities) };
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    const context = ContextPackSchema.parse(stored!.payload); context.verification_capabilities = { ...capabilities, profile_id: "default" };
    await server.db.db.update(runs).set({ verificationRequirement: request }).where(eq(runs.id, run.id));
    await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.context_pack_id));
    const before = (await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0];
    const unsupported = wire([{ ...profile, capabilities }], ["run-verification.v1", "verification-capabilities.v1"]);
    if (enabled) {
      await expect(unsupported.dispatchRunStart(run.id)).rejects.toMatchObject({ httpStatus: 409, details: { reason: "unsupported_measurement_plan_verification" } });
      expect(sent).toHaveLength(0);
      expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]).toEqual(before);
      await wire([{ ...profile, capabilities }], ["run-verification.v1", "verification-capabilities.v1", "measurement-plan.v1"]).dispatchRunStart(run.id);
    } else await unsupported.dispatchRunStart(run.id);
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: run.id } });
  });
  it.each(["author", "reviewer"] as const)("requires stage input verification support before dispatching a staged %s to the node", async (role) => {
    const run = await queued();
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    const context = ContextPackSchema.parse(stored!.payload);
    if (role === "author") context.product_development = productDevelopmentContext("research");
    else context.review_subject = { version: 1, task_id: "task_author", run_id: "run_author", evidence_id: "evidence_author",
      subject_digest: `sha256:${"a".repeat(64)}`, development_stage: "research" };
    await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.context_pack_id));
    await expect(wire([profile]).dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "unsupported_product_stage_verification" } });
    expect(sent).toHaveLength(0);
    await wire([profile], ["run-verification.v1", "product-stage-verification.v1"]).dispatchRunStart(run.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: run.id } });
  });
  it("does not trust a ContextPack project that differs from the persisted task", async () => {
    const run = await queued();
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    const payload = structuredClone(pack!.payload) as { project: { id: string } }; payload.project.id = "other";
    await server.db.db.update(contextPacks).set({ payload }).where(eq(contextPacks.id, run.context_pack_id));
    await expect(wire([{ ...profile, project_id: "other" }]).dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "verification_profile_mismatch" } });
    expect(sent).toHaveLength(0);
  });
});
