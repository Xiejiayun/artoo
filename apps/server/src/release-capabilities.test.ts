import { describe, expect, it, vi } from "vitest";
import type { NodeTransport } from "@artoo/protocol";
import { attachNodeBinding } from "./node-binding.js";
import type { ServerContext } from "./context.js";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";
import { capturePlanningSnapshot, persistedPlanningSnapshot, recheckPlanningSnapshot, type PlanningCapabilityOwner } from "./services/planning-capabilities.js";

const transport: NodeTransport = { async send() {}, subscribe() { return () => {}; }, async close() {} };
function fixture() {
  const f = releaseAcceptanceFixture(), getter = vi.fn(() => structuredClone(f.release));
  const ctx = { supportsExecutionFeature: () => true, supportsVerificationProfile: () => true, supportsReleaseProfile: () => true,
    getVerificationCapabilities: () => structuredClone(f.capabilities), getReleaseCapabilities: getter } as unknown as ServerContext;
  const owner: PlanningCapabilityOwner = { computerId: "computer", workspaceRoot: "/workspace/product", verificationProfileId: "default",
    releaseProfileId: "site", executionMode: "agent_team", planningCapabilitySnapshot: null };
  return { ...f, ctx, getter, owner };
}
describe("authenticated configured-publication capability snapshots", () => {
  it("keeps the durable envelope at v1 and freezes nested publication scope across reconnects", () => {
    const f = fixture(); f.owner.planningCapabilitySnapshot = capturePlanningSnapshot(f.ctx, f.owner, "proj_artoo");
    expect(f.owner.planningCapabilitySnapshot).toMatchObject({ version: 1, release: { version: 1, capabilities: f.release } });
    expect(f.getter).toHaveBeenCalledOnce(); recheckPlanningSnapshot(f.ctx, f.owner, "proj_artoo");
    f.release.binding.release_profile_digest = `sha256:${"9".repeat(64)}`;
    expect(() => recheckPlanningSnapshot(f.ctx, f.owner, "proj_artoo")).toThrow("fixed planning capability snapshot");
  });
  it.each(["feature", "missing", "profile", "verifier"])("does not downgrade new publication planning to unknown: %s", change => {
    const f = fixture();
    if (change === "feature") f.ctx.supportsExecutionFeature = (_node, feature) => feature !== "product-release.acceptance.v1";
    if (change === "missing") f.ctx.getReleaseCapabilities = () => undefined;
    if (change === "profile") f.ctx.supportsReleaseProfile = () => false;
    if (change === "verifier") f.release.binding.verification_profile_digest = `sha256:${"9".repeat(64)}`;
    expect(() => capturePlanningSnapshot(f.ctx, f.owner, "proj_artoo")).toThrow("publication acceptance contract");
  });
  it("rejects removed snapshots or a changed selected publisher without backfilling legacy goals", () => {
    const f = fixture(), snapshot = capturePlanningSnapshot(f.ctx, f.owner, "proj_artoo");
    f.owner.planningCapabilitySnapshot = snapshot; f.owner.releaseProfileId = "other";
    expect(() => persistedPlanningSnapshot(f.owner, "proj_artoo")).toThrow("release target changed");
    f.owner.releaseProfileId = "site"; delete snapshot.release;
    expect(() => persistedPlanningSnapshot(f.owner, "proj_artoo")).toThrow("snapshot is missing");
    f.owner.planningCapabilitySnapshot = null; f.getter.mockClear();
    recheckPlanningSnapshot(f.ctx, f.owner, "proj_artoo"); expect(f.getter).not.toHaveBeenCalled();
    f.capabilities.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    expect(capturePlanningSnapshot(f.ctx, f.owner, "proj_artoo").release).toBeUndefined();
    expect(f.getter).not.toHaveBeenCalled();
  });
  it("serves defensive full snapshots only on the exact current authenticated node binding", () => {
    const f = fixture(); let current = true;
    const binding = attachNodeBinding(f.ctx, transport, "computer", ["run-verification.v1", "verification-capabilities.v1",
      "product-release.static.v1", "product-release.acceptance.v1"], () => current,
    [{ profile_id: "default", project_id: "proj_artoo", workspace_root: "/workspace/product", capabilities: f.capabilities }],
    [{ profile_id: "site", project_id: "proj_artoo", workspace_root: "/workspace/product", verification_profile_id: "default",
      target_kind: "static_site", capabilities: f.release }]);
    try {
      const read = () => binding.getReleaseCapabilities!("site", "proj_artoo", "/workspace/product", "default");
      const first = read()!; first.contract.health_checks[0]!.path = "/caller-mutation";
      f.release.contract.health_checks[0]!.path = "/advertisement-mutation";
      expect(read()!.contract.health_checks[0]!.path).toBe("/");
      expect(binding.getReleaseCapabilities!("site", "other", "/workspace/product", "default")).toBeUndefined();
      current = false; expect(read()).toBeUndefined(); current = true; binding.close(); expect(read()).toBeUndefined();
    } finally { binding.close(); }
  });
});
