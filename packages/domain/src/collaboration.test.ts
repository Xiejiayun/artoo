import { describe, expect, it } from "vitest";

import {
  BlockerRecordSchema,
  DecisionRecordSchema,
  HandoffRecordSchema,
  blockerNeedsHuman,
  isActiveBlocker,
  isOpenHandoff,
  resumeStateFromBlockers,
  waitEdgesFromHandoffs,
} from "./collaboration.js";
import { CORE_EVENT_TYPES, MESSAGE_KINDS } from "./events.js";

describe("#114 collaboration taxonomy", () => {
  it("adds collaboration message kinds", () => {
    for (const k of ["status_update", "decision", "blocker", "handoff", "review", "agent_proposal"]) {
      expect(MESSAGE_KINDS).toContain(k);
    }
  });
  it("adds decision/handoff/blocker/mention core events", () => {
    for (const e of [
      "decision.proposed",
      "decision.accepted",
      "decision.rejected",
      "decision.superseded",
      "handoff.opened",
      "handoff.completed",
      "blocker.opened",
      "blocker.resolved",
      "message.mention",
    ]) {
      expect(CORE_EVENT_TYPES).toContain(e);
    }
  });
});

describe("#114 blocker classification", () => {
  it("blockerNeedsHuman: approval/human_input/policy/budget need a human", () => {
    expect(blockerNeedsHuman("approval")).toBe(true);
    expect(blockerNeedsHuman("human_input")).toBe(true);
    expect(blockerNeedsHuman("policy")).toBe(true);
    expect(blockerNeedsHuman("budget")).toBe(true);
    expect(blockerNeedsHuman("dependency")).toBe(false);
    expect(blockerNeedsHuman("lease_conflict")).toBe(false);
    expect(blockerNeedsHuman("offline_agent")).toBe(false);
    expect(blockerNeedsHuman("stale_runtime")).toBe(false);
  });
  it("isActiveBlocker: open/mitigated are active; resolved/accepted_risk not", () => {
    expect(isActiveBlocker("open")).toBe(true);
    expect(isActiveBlocker("mitigated")).toBe(true);
    expect(isActiveBlocker("resolved")).toBe(false);
    expect(isActiveBlocker("accepted_risk")).toBe(false);
  });
  it("resumeStateFromBlockers: human-gated vs deterministic vs none", () => {
    expect(resumeStateFromBlockers([])).toBe("no_active_blockers");
    expect(resumeStateFromBlockers([{ type: "dependency", status: "open" }])).toBe("safe_to_resume");
    expect(
      resumeStateFromBlockers([
        { type: "dependency", status: "open" },
        { type: "approval", status: "open" },
      ]),
    ).toBe("needs_human_decision");
    // resolved blockers don't count
    expect(resumeStateFromBlockers([{ type: "approval", status: "resolved" }])).toBe("no_active_blockers");
  });
});

describe("#114 who-waits-on-whom", () => {
  it("isOpenHandoff: open/accepted are waiting; completed/cancelled/expired not", () => {
    expect(isOpenHandoff("open")).toBe(true);
    expect(isOpenHandoff("accepted")).toBe(true);
    expect(isOpenHandoff("completed")).toBe(false);
    expect(isOpenHandoff("cancelled")).toBe(false);
    expect(isOpenHandoff("expired")).toBe(false);
  });
  it("waitEdgesFromHandoffs derives sender->recipient edges for open handoffs only", () => {
    const edges = waitEdgesFromHandoffs([
      { id: "h1", sender_type: "agent", sender_id: "a1", recipient_type: "user", recipient_id: "u1", expected_action: "approve push", status: "open" },
      { id: "h2", sender_type: "agent", sender_id: "a2", recipient_type: "agent", recipient_id: "a3", expected_action: "do x", status: "completed" },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ waiter_id: "a1", blocked_on_id: "u1", expected_action: "approve push", handoff_id: "h1" });
  });
});

describe("#114 record schemas (secret-safe shapes)", () => {
  const links = { room_id: "room_1", task_id: null, run_id: null, goal_id: null, plan_id: null };
  it("DecisionRecord validates", () => {
    const d = DecisionRecordSchema.parse({
      id: "dec_1", organization_id: "org_default", ...links, source_message_id: "m1",
      status: "accepted", actor_type: "agent", actor_id: "a1", summary: "use approach A",
      rationale: "faster", alternatives: ["B"], evidence_refs: ["m1", "art_1"], impact_summary: null,
      superseded_by_id: null, created_at: "t", updated_at: "t",
    });
    expect(d.status).toBe("accepted");
    expect(JSON.stringify(d)).not.toMatch(/token|secret|hash/i);
  });
  it("HandoffRecord validates", () => {
    const h = HandoffRecordSchema.parse({
      id: "ho_1", organization_id: "org_default", ...links, sender_type: "agent", sender_id: "a1",
      recipient_type: "user", recipient_id: "u1", expected_action: "approve", blocking_condition: "needs sign-off",
      priority: "high", due_at: null, status: "open", next_action: "ping", latest_status: null,
      created_at: "t", updated_at: "t",
    });
    expect(h.status).toBe("open");
  });
  it("BlockerRecord validates + links a source", () => {
    const b = BlockerRecordSchema.parse({
      id: "blk_1", organization_id: "org_default", ...links, type: "approval", owner_type: "user", owner_id: "u1",
      source_kind: "approval", source_id: "approval_1", summary: "awaiting approval", mitigation: null,
      next_action: "resolve approval", status: "open", created_at: "t", updated_at: "t",
    });
    expect(b.type).toBe("approval");
    expect(b.source_kind).toBe("approval");
  });
});
