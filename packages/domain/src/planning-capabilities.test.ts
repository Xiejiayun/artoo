import { describe, expect, it } from "vitest";
import { CreateAutonomousGoalRequestSchema, GoalAutomationSchema } from "./autonomy.js";
import { AutonomousPlanningRequestV1Schema, GoalPlanningCapabilitySnapshotSchema } from "./planning-capabilities.js";

const digest = `sha256:${"a".repeat(64)}`;
const capabilities = { version: 1, profile_digest: digest, checks: [{ command_id: "browser", config_digest: digest,
  contract_digest: digest, contract: { version: 1, kind: "static-web", claim: "configured", browser_steps_version: 1,
    actions: ["navigate", "assert_text"], viewports: [{ id: "width-390", width: 390, height: 900 }],
    stage_policy: { research: "no-browser", design: "prototype-only", implementation: "declared-cases", validation: "declared-cases" },
    screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true },
    limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 }, checks: [],
    unavailable: ["keyboard-navigation", "multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"] } }] };
const snapshot = { version: 1, computer_id: "worker", project_id: "project", workspace_root: "/workspace/product",
  verification_profile_id: "acceptance", capabilities };

describe("durable autonomous planning scope", () => {
  it("preserves known configured scope and distinguishes captured unknown from historical absence", () => {
    expect(GoalPlanningCapabilitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const unknown = { ...snapshot, capabilities: null };
    expect(GoalPlanningCapabilitySnapshotSchema.parse(unknown)).toEqual(unknown);
    const original = "  Original requirement\r\nKeep this exact feedback.  ";
    for (const value of [snapshot, unknown, null]) {
      const envelope = { version: 1, kind: "autonomous-planning", request: original, planning_capability_snapshot: value };
      expect(AutonomousPlanningRequestV1Schema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    }
  });

  it("rejects missing scope, malformed identities and injected authority instead of guessing defaults", () => {
    const { capabilities: omitted, ...missingScope } = snapshot;
    expect(GoalPlanningCapabilitySnapshotSchema.safeParse(missingScope).success).toBe(false);
    for (const change of [{ version: 2 }, { computer_id: "" }, { project_id: "x".repeat(129) },
      { verification_profile_id: "" }, { workspace_root: "" }, { workspace_root: "x".repeat(4097) },
      { workspace_root: "/workspace\nother" }, { capabilities: undefined }, { capabilities: { ...capabilities, profile_digest: "unmeasured" } },
      { argv: ["node", "untrusted.js"] }, { run_verification: { outcome: "passed" } }]) {
      expect(GoalPlanningCapabilitySnapshotSchema.safeParse({ ...snapshot, ...change }).success).toBe(false);
    }
    const envelope = { version: 1, kind: "autonomous-planning", request: "Original", planning_capability_snapshot: snapshot };
    for (const change of [{ version: 2 }, { kind: "execution" }, { request: null },
      { planning_capability_snapshot: undefined }, { verification_capabilities: capabilities }, { filesystem_write_scope: ["/"] }]) {
      expect(AutonomousPlanningRequestV1Schema.safeParse({ ...envelope, ...change }).success).toBe(false);
    }
  });

  it("reads old automation payloads as unsampled without accepting client-selected planning authority", () => {
    const legacy = { goal_id: "goal", organization_id: "organization", actor_user_id: "user", consent_id: null,
      policy_version: "v1", status: "planning", discussion_id: null, plan_id: null, agent_instance_id: null,
      computer_id: null, workspace_root: null, verification_profile_id: "acceptance", last_error: null,
      created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z" };
    expect(GoalAutomationSchema.parse(legacy).planning_capability_snapshot).toBeNull();
    expect(GoalAutomationSchema.parse({ ...legacy, planning_capability_snapshot: snapshot }).planning_capability_snapshot).toEqual(snapshot);
    expect(GoalAutomationSchema.safeParse({ ...legacy, planning_capability_snapshot: { version: 2 } }).success).toBe(false);
    const clientRequest = CreateAutonomousGoalRequestSchema.parse({ project_id: "project", objective: "Make the product",
      planning_capability_snapshot: snapshot });
    expect(Object.hasOwn(clientRequest, "planning_capability_snapshot")).toBe(false);
  });
});
