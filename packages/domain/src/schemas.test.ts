import { describe, expect, it } from "vitest";

import {
  ApprovalSchema,
  ArtifactSchema,
  MessageSchema,
  RoomSchema,
  RunSchema,
  TaskDependencySchema,
  TaskSchema,
} from "./schemas.js";

describe("entity schemas", () => {
  it("Task applies defaults and accepts a valid row", () => {
    const task = TaskSchema.parse({
      id: "task_1",
      organization_id: "org_default",
      project_id: "proj_artoo",
      title: "Build inbox",
      status: "backlog",
      created_by_type: "user",
      created_by_id: "user_1",
      created_at: "2026-06-13T00:00:00Z",
      updated_at: "2026-06-13T00:00:00Z",
    });
    expect(task.priority).toBe("p2");
    expect(task.description).toBe("");
    expect(task.required_capabilities).toEqual([]);
    expect(task.acceptance_criteria).toEqual([]);
  });

  it("Task rejects an invalid status", () => {
    const result = TaskSchema.safeParse({
      id: "task_1",
      organization_id: "org_default",
      project_id: "proj_artoo",
      title: "t",
      status: "not_a_status",
      created_by_type: "user",
      created_by_id: "user_1",
      created_at: "2026-06-13T00:00:00Z",
      updated_at: "2026-06-13T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("Run/Approval/Room/Message/Artifact/Dependency parse minimal rows", () => {
    expect(
      RunSchema.parse({
        id: "run_1",
        organization_id: "org_default",
        task_id: "task_1",
        computer_id: "computer_1",
        agent_instance_id: "ai_1",
        runtime_id: "mock",
        status: "queued",
        created_at: "2026-06-13T00:00:00Z",
      }).sequence,
    ).toBe(0);

    expect(
      ApprovalSchema.parse({
        id: "approval_1",
        organization_id: "org_default",
        task_id: "task_1",
        requested_by_type: "agent",
        requested_by_id: "agent_1",
        action: "git.push",
        risk: "high",
        summary: "Push branch",
        status: "pending",
        created_at: "2026-06-13T00:00:00Z",
      }).status,
    ).toBe("pending");

    expect(
      RoomSchema.parse({
        id: "room_1",
        organization_id: "org_default",
        type: "goal",
        name: "goal room",
        created_at: "2026-06-13T00:00:00Z",
      }).type,
    ).toBe("goal");

    expect(
      MessageSchema.parse({
        id: "msg_1",
        organization_id: "org_default",
        room_id: "room_1",
        actor_type: "user",
        actor_id: "user_1",
        kind: "text",
        created_at: "2026-06-13T00:00:00Z",
      }).body,
    ).toBe("");

    expect(
      ArtifactSchema.parse({
        id: "artifact_1",
        organization_id: "org_default",
        task_id: "task_1",
        type: "patch",
        uri: "fix.patch",
        created_at: "2026-06-13T00:00:00Z",
      }).metadata,
    ).toEqual({});

    expect(
      TaskDependencySchema.parse({
        id: "dep_1",
        organization_id: "org_default",
        from_task_id: "task_1",
        to_task_id: "task_2",
        type: "blocks",
        created_at: "2026-06-13T00:00:00Z",
      }).type,
    ).toBe("blocks");
  });
});
