import type { EventEnvelope } from "@artoo/domain";
import { describe, expect, it } from "vitest";

import { invalidationsForEvent } from "./invalidation.js";

function event(partial: Partial<EventEnvelope> & Pick<EventEnvelope, "type">): EventEnvelope {
  return {
    id: "evt_1",
    schema_version: "2026-06-11",
    organization_id: "org_default",
    actor: { type: "agent", id: "agent_1" },
    occurred_at: "2026-06-13T00:00:00Z",
    correlation_id: "corr_1",
    payload: {},
    ...partial,
  };
}

describe("invalidationsForEvent", () => {
  it("invalidates the task snapshot for an event carrying task_id", () => {
    const keys = invalidationsForEvent("task:task_1", event({ type: "run.completed", task_id: "task_1" }));
    expect(keys).toContainEqual(["task", "task_1"]);
  });

  it("invalidates messages for a room event (and the task snapshot)", () => {
    const keys = invalidationsForEvent(
      "room:room_1",
      event({ type: "message.created", room_id: "room_1", task_id: "task_1" }),
    );
    expect(keys).toContainEqual(["messages", "room_1"]);
    expect(keys).toContainEqual(["task", "task_1"]);
  });

  it("invalidates the project task list on task.created/updated", () => {
    const keys = invalidationsForEvent(
      "task:task_1",
      event({ type: "task.created", task_id: "task_1", project_id: "proj_artoo" }),
    );
    expect(keys).toContainEqual(["tasks", "proj_artoo"]);
  });

  it("invalidates pending approvals for inbox topic or approval events", () => {
    expect(
      invalidationsForEvent("inbox:user_1", event({ type: "approval.requested", task_id: "task_1" })),
    ).toContainEqual(["approvals", "pending"]);
    expect(
      invalidationsForEvent("task:task_1", event({ type: "approval.resolved", task_id: "task_1" })),
    ).toContainEqual(["approvals", "pending"]);
  });

  it("dedupes repeated keys", () => {
    const keys = invalidationsForEvent("task:task_1", event({ type: "task.updated", task_id: "task_1" }));
    const taskKeys = keys.filter((k) => JSON.stringify(k) === JSON.stringify(["task", "task_1"]));
    expect(taskKeys).toHaveLength(1);
  });
});
