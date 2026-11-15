import { expect, it } from "vitest";
import { CreateTaskRequestSchema } from "./api.js";
import { TaskDelegationRequestV1Schema } from "./task-delegation.js";

it("keeps old parent provenance separate from strict explicit versioned delegation", () => {
  expect(
    CreateTaskRequestSchema.parse({ project_id: "p", title: "Follow up", parent_task_id: "old" }).delegation,
  ).toBeUndefined();
  expect(
    CreateTaskRequestSchema.parse({
      project_id: "p",
      title: "Child",
      delegation: { version: 1, parent_task_id: "parent" },
    }).delegation,
  ).toEqual({ version: 1, parent_task_id: "parent" });
  for (const input of [
    { parent_task_id: "p" },
    { version: 2, parent_task_id: "p" },
    { version: 1, parent_task_id: "" },
    { version: 1, parent_task_id: "p", root_task_id: "forged" },
    { version: 1, parent_task_id: "p", actor_user_id: "forged" },
  ])
    expect(TaskDelegationRequestV1Schema.safeParse(input).success).toBe(false);
});
