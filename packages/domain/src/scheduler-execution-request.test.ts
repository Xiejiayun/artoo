import { expect, it } from "vitest";
import { CreateSchedulerIntentV1Schema, SchedulerIntentSnapshotV1Schema } from "./scheduler-intent.js";
import {
  CreateSchedulerExecutionRequestV2Schema,
  SchedulerExecutionRequestSnapshotV2Schema,
} from "./scheduler-execution-request.js";

const request = {
  version: 2,
  permission: "execute_once",
  request_key: "request",
  base_version: 1,
  agent_id: "agent",
  branch_backed: true,
  write_paths: ["src/main.ts"],
};

it("requires fresh explicit permission and cannot reinterpret a version 1 shadow request", () => {
  expect(CreateSchedulerExecutionRequestV2Schema.parse(request)).toEqual(request);
  const { permission: _permission, ...old } = request;
  expect(CreateSchedulerIntentV1Schema.parse({ ...old, version: 1 })).toEqual({ ...old, version: 1 });
  expect(CreateSchedulerExecutionRequestV2Schema.safeParse({ ...old, version: 1 }).success).toBe(false);
  expect(CreateSchedulerExecutionRequestV2Schema.safeParse(old).success).toBe(false);
  expect(CreateSchedulerIntentV1Schema.safeParse(request).success).toBe(false);
});

it.each([
  { version: 1 },
  { version: 3 },
  { permission: "review_and_publish" },
  { base_version: 0 },
  { base_version: Number.MAX_SAFE_INTEGER + 1 },
  { branch_backed: false },
  { actor_user_id: "forged" },
  { consent_id: "forged" },
  { agent_instance_id: "fixed" },
  { computer_id: "fixed" },
  { policy_revisions: { project: 1 } },
  { profile_id: "verifier" },
  { argv: ["sh"] },
  { write_paths: [""] },
  { execution_authorized: true },
])("rejects unsupported permission or caller authority %#", (invalid) => {
  expect(CreateSchedulerExecutionRequestV2Schema.safeParse({ ...request, ...invalid }).success).toBe(false);
});

it("records bounded server bindings without manufacturing an attempt or verifier grant", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const snapshot = {
    version: 2,
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
  };
  expect(SchedulerExecutionRequestSnapshotV2Schema.parse(snapshot)).toEqual(snapshot);
  expect(SchedulerIntentSnapshotV1Schema.safeParse(snapshot).success).toBe(false);
  for (const invalid of [
    { execution_authorized: true },
    { queue_revision: 0 },
    { configuration_digest: "model-output" },
    { ai_sharing: { consent_id: null, policy_version: "policy", private_key: "secret" } },
  ])
    expect(SchedulerExecutionRequestSnapshotV2Schema.safeParse({ ...snapshot, ...invalid }).success).toBe(false);
});
