import { expect, it } from "vitest";
import { CreateSchedulerIntentV1Schema, SchedulerIntentSnapshotV1Schema } from "./scheduler-intent.js";

const request = {
  version: 1,
  request_key: "request",
  base_version: 1,
  agent_id: "agent",
  branch_backed: true,
  write_paths: ["src/main.ts"],
};
const digest = `sha256:${"a".repeat(64)}`;

it("accepts only explicit pooled shadow requests and server-captured bounded provenance", () => {
  expect(CreateSchedulerIntentV1Schema.parse(request)).toEqual(request);
  for (const invalid of [
    { version: 2 },
    { base_version: 0 },
    { base_version: Number.MAX_SAFE_INTEGER + 1 },
    { base_version: 1.5 },
    { actor_user_id: "forged" },
    { consent_id: "forged" },
    { branch_backed: false },
    { agent_instance_id: "fixed" },
    { argv: ["sh"] },
    { write_paths: [""] },
  ])
    expect(CreateSchedulerIntentV1Schema.safeParse({ ...request, ...invalid }).success).toBe(false);
  const snapshot = {
    version: 1,
    organization_id: "org",
    project_id: "project",
    task_id: "task",
    actor_user_id: "user",
    request,
    ai_sharing: { consent_id: null, policy_version: "policy" },
    task_input_version: 1,
    task_input_digest: digest,
    queue_revision: null,
    policy_revisions: { project: 1, agent: 1, computers: { host: 1 } },
    configuration_digest: digest,
    execution_authorized: false,
  };
  expect(SchedulerIntentSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
  for (const invalid of [
    { execution_authorized: true },
    { queue_revision: 0 },
    { task_input_version: Number.MAX_SAFE_INTEGER + 1 },
    { configuration_digest: "model-output" },
    { policy_revisions: { project: 1, agent: 0, computers: {} } },
    { ai_sharing: { consent_id: null, policy_version: "policy", private_key: "forged" } },
  ])
    expect(SchedulerIntentSnapshotV1Schema.safeParse({ ...snapshot, ...invalid }).success).toBe(false);
});
