import { expect, it } from "vitest";
import { adapterRunEventBodySchema, nodeHelloSchema, runEventMessageSchema, runStartCommandSchema } from "./node-messages.js";

const hash = `sha256:${"a".repeat(64)}`;
const event = { type: "run.verification", payload: { version: 1, request_id: "verify_1", profile_id: "default",
  profile_digest: hash, subject_digest: hash, outcome: "passed",
  checks: [{ id: "check", exit_code: 0, duration_ms: 1, output_digest: hash }], required_files: [] } };

it("accepts bounded public profile routing metadata while preserving legacy hello", () => {
  const hello = { kind: "node.hello", node_id: "node_1", protocol_version: "v1", artood_version: "1",
    machine: { hostname: "worker", os: "linux", arch: "x64" } };
  const profile = { profile_id: "default", project_id: "project_1", workspace_root: "/work/product" };
  expect(nodeHelloSchema.parse(hello).verification_profiles).toBeUndefined();
  expect(nodeHelloSchema.parse({ ...hello, verification_profiles: [profile] }).verification_profiles).toEqual([profile]);
  for (const profiles of [[profile, profile], Array.from({ length: 65 }, (_, i) => ({ ...profile, profile_id: `p${i}` })),
    [{ ...profile, profile_id: "" }], [{ ...profile, project_id: "x".repeat(129) }],
    [{ ...profile, workspace_root: "x".repeat(4097) }], [{ ...profile, workspace_root: "/work\u0000product" }],
    [{ ...profile, argv: ["secret-command"] }]]) {
    expect(nodeHelloSchema.safeParse({ ...hello, verification_profiles: profiles }).success).toBe(false);
  }
});

it("reserves verification for node events and never grants agent output that authority", () => {
  expect(runEventMessageSchema.parse({ kind: "run.event", node_id: "node_1", run_id: "run_1", sequence: 2, event }).event).toEqual(event);
  expect(adapterRunEventBodySchema.safeParse(event).success).toBe(false);
  const output = { type: "run.output", payload: { stream: "stdout", text: JSON.stringify(event) } };
  expect(adapterRunEventBodySchema.parse(output)).toEqual(output);
  const observed = { ...event, payload: { ...event.payload, checks: [{ ...event.payload.checks[0], observation: {
    version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "design",
    cases: [{ case_id: "prototype", viewport: 390, assertions: 0, screenshot_digest: hash }],
  } }] } };
  expect(runEventMessageSchema.parse({ kind: "run.event", node_id: "node_1", run_id: "run_1", sequence: 3, event: observed }).event).toEqual(observed);
  expect(adapterRunEventBodySchema.safeParse(observed).success).toBe(false);
});

it("preserves a verification requirement on run.start while older requests remain valid", () => {
  const command = { kind: "command", id: "command_1", idempotency_key: "run_1:start", type: "run.start", payload: {
    run_id: "run_1", task_id: "task_1", agent_instance_id: "instance_1", runtime: "codex", workspace: { root: "/work" },
    context_pack: { id: "context_1", uri: "inline" }, policy_snapshot: { filesystem_write_scope: ["/work"], requires_approval: [] },
    artifact_rules: { paths: [] },
  } };
  expect(runStartCommandSchema.parse(command).payload.verification).toBeUndefined();
  const requirement = { version: 1, request_id: "verify_1", profile_id: "default" };
  expect(runStartCommandSchema.parse({ ...command, payload: { ...command.payload, verification: requirement } }).payload.verification).toEqual(requirement);
  expect(runStartCommandSchema.safeParse({ ...command, payload: { ...command.payload, verification: { ...requirement, version: 2 } } }).success).toBe(false);
  const application = { version: 1, config_digest: hash, contract_digest: hash };
  const bound = { ...requirement, capability_binding: { version: 1, profile_digest: hash,
    checks: [{ command_id: "browser", config_digest: hash, contract_digest: hash }] }, application };
  // An old URI-only path must not silently strip the application extension and execute an ordinary run.
  expect(runStartCommandSchema.safeParse({ ...command, payload: { ...command.payload, verification: bound } }).success).toBe(false);
});
