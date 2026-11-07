import { ContextPackSchema } from "@artoo/domain";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../context.js";
import { verificationCapabilitiesFixture } from "../test-fixtures/verification-capabilities.js";
import { assertPlanningContext, assertSelectedPlanningCapabilities, capturePlanningSnapshot, persistedPlanningSnapshot,
  planningRequest, recheckPlanningSnapshot, type PlanningCapabilityOwner } from "./planning-capabilities.js";

const project = "project", owner = (): PlanningCapabilityOwner => ({ computerId: "computer", workspaceRoot: "/workspace",
  verificationProfileId: "default", executionMode: "single_agent", planningCapabilitySnapshot: null });
const context = (request: string) => ContextPackSchema.parse({ task: { id: "task", title: "Planning", description: "", acceptance_criteria: [] },
  project: { id: project, name: "Project", default_workspace: "/workspace" }, workspace: { root: "/workspace", file_scope: [] },
  policy: { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] },
  memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
  conversation: { room_id: "room", thread_root_id: null, turn_id: "turn", current_request: request, messages: [], history_truncated: false } });
function fixture() {
  const capabilities = verificationCapabilitiesFixture(), getter = vi.fn(() => capabilities);
  const ctx = { supportsExecutionFeature: () => true, supportsVerificationProfile: () => true, getVerificationCapabilities: getter } as unknown as ServerContext;
  const stored = owner(); stored.planningCapabilitySnapshot = capturePlanningSnapshot(ctx, stored, project); getter.mockClear();
  return { ctx, stored, capabilities, getter };
}

describe("planning scope boundary helpers", () => {
  it.each(["computerId", "workspaceRoot", "verificationProfileId"] as const)("rejects changed fixed target %s without querying another node", key => {
    const f = fixture(); f.stored[key] = "changed";
    expect(() => recheckPlanningSnapshot(f.ctx, f.stored, project)).toThrow("target changed"); expect(f.getter).not.toHaveBeenCalled();
  });
  it("rejects a project substitution and malformed stored schema instead of treating either as historical NULL", () => {
    const f = fixture(); expect(() => persistedPlanningSnapshot(f.stored, "other-project")).toThrow("target changed");
    for (const invalid of [undefined, {}, { version: 1 }, { version: 2 }]) {
      f.stored.planningCapabilitySnapshot = invalid; expect(() => recheckPlanningSnapshot(f.ctx, f.stored, project)).toThrow("invalid");
    }
    expect(f.getter).not.toHaveBeenCalled();
  });
  it("preserves historical NULL without consulting today's advertisement", () => {
    const f = fixture(); f.stored.planningCapabilitySnapshot = null;
    f.ctx.supportsVerificationProfile = () => false; recheckPlanningSnapshot(f.ctx, f.stored, project);
    expect(f.getter).not.toHaveBeenCalled(); assertSelectedPlanningCapabilities(f.stored, project, f.capabilities);
  });
  it("never turns a disconnected or unsupported target into captured unknown scope", () => {
    const f = fixture(); f.ctx.supportsVerificationProfile = () => false;
    expect(() => capturePlanningSnapshot(f.ctx, f.stored, project)).toThrow("no longer advertises"); expect(f.getter).not.toHaveBeenCalled();
    f.ctx.supportsVerificationProfile = () => true; f.ctx.supportsExecutionFeature = () => false;
    expect(() => capturePlanningSnapshot(f.ctx, f.stored, project)).toThrow("no longer advertises"); expect(f.getter).not.toHaveBeenCalled();
  });
  it("defensively captures the complete structured scope and reads it once at each recheck", () => {
    const f = fixture(); recheckPlanningSnapshot(f.ctx, f.stored, project); expect(f.getter).toHaveBeenCalledTimes(1);
    f.capabilities.checks[0]!.contract.viewports[0]!.width = 987;
    expect(() => recheckPlanningSnapshot(f.ctx, f.stored, project)).toThrow("fixed planning capability snapshot");
    expect(f.getter).toHaveBeenCalledTimes(2);
  });
  it("requires the fixed target to enforce an advertised measurement policy before capturing it", () => {
    const f = fixture(); f.capabilities.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    f.ctx.supportsExecutionFeature = (_node, feature) => feature !== "measurement-plan.v1";
    expect(() => capturePlanningSnapshot(f.ctx, f.stored, project)).toThrow("cannot enforce its measurement-plan policy");
    expect(f.getter).toHaveBeenCalledOnce(); f.getter.mockClear();
    f.ctx.supportsExecutionFeature = () => true;
    const captured = capturePlanningSnapshot(f.ctx, f.stored, project);
    expect(captured.capabilities).toEqual(f.capabilities); expect(f.getter).toHaveBeenCalledOnce();
  });
  it("keeps exact request characters and rejects execution authority in an otherwise valid envelope", () => {
    const f = fixture(), snapshot = persistedPlanningSnapshot(f.stored, project), request = "  Original\nrequest\t ";
    const payload = context(planningRequest(request, snapshot)); assertPlanningContext(payload, request, snapshot);
    expect(JSON.parse(payload.conversation!.current_request).request).toBe(request);
    payload.verification_capabilities = { ...f.capabilities, profile_id: "default" };
    expect(() => assertPlanningContext(payload, request, snapshot)).toThrow("original request and capability snapshot");
  });
});
