import { expect, it } from "vitest";
import { ApplicationPublicationRequestV1Schema } from "@artoo/domain";
import { applicationPublicationReceiptMessageSchema } from "./application-publication.js";
import { commandSchema, nodeHelloSchema, runStartCommandSchema, adapterRunEventBodySchema, runEventAckCommandSchema } from "./node-messages.js";

const digest = `sha256:${"a".repeat(64)}`, changed = `sha256:${"b".repeat(64)}`;
const grant = { version: 1, kind: "same-computer-local-application-publication", publication_profile_id: "publisher" };
const capabilities = { version: 1, binding: { version: 1, publication_profile_id: "publisher", publication_profile_digest: digest,
  publication_contract_digest: digest, project_id: "project", computer_id: "node", workspace_root_digest: digest,
  verification_profile_id: "verifier", verification_profile_digest: digest, application_config_digest: digest,
  application_contract_digest: digest, application_toolchain_digest: digest }, contract: { version: 1,
  kind: "same-computer-local-application-publication", claim: "bounded-local-application-publication", origin: "profile-fixed-loopback",
  lifecycle: "original-paired-session", normal_reopen: "once-same-version-url-database", failure_recovery: "unsupported", automatic_rotation: "unsupported",
  limits: { root_lifetime_ms: 3_600_000, startup_timeout_ms: 1000, health_timeout_ms: 1000, normal_drain_reserve_ms: 1000,
    health_interval_ms: 1000, health_freshness_ms: 30_000, maximum_service_generations: 2, maximum_requests_per_generation: 256,
    maximum_concurrent: 1, maximum_health_rounds: 8 } } };
const candidate = { version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest, toolchain_digest: digest,
  package_digest: digest, schema_digest: digest, qualified_for_product: false };
const request = ApplicationPublicationRequestV1Schema.parse({ version: 1, publication_id: "publication", goal_id: "goal", project_id: "project",
  computer_id: "node", publisher_session_id: "00000000-0000-4000-8000-000000000001", subject_digest: digest, application_definition_digest: digest,
  authorization: { version: 1, event_id: "authorization", actor_user_id: "user", consent_id: null, policy_version: "policy", grant }, capabilities,
  author: { run_id: "author", request_id: "author-request", evidence_id: "author-evidence", agent_id: "author-agent", agent_instance_id: "author-instance",
    stage: "validation", origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000002", candidate },
  reviewer: { run_id: "reviewer", request_id: "review-request", evidence_id: "review-evidence", agent_id: "review-agent", agent_instance_id: "review-instance",
    stage: "validation", origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000003", candidate },
  acceptance: { version: 1, plan: { id: "plan", version: 1 }, research_digest: digest, design_digest: digest, measurement_plan_digest: digest,
    accepted_review_event_id: "review-accepted", development_criteria: [{ requirement_id: "save", criterion_index: 0, criterion_digest: digest, case_ids: ["save"] }],
    publication_criteria: [{ requirement_id: "publish", criterion_index: 0, criterion_digest: digest, claim: "bounded-local-application-publication" }], unmet_criteria: [] } });
const envelope = { kind: "command", id: "command", idempotency_key: "publication:command" };

it("keeps ordinary publication sessions separate and gives start, stop and status one immutable request", () => {
  const session = { ...envelope, type: "application.publication.session.v1", payload: { version: 1, node_id: "node", session_id: request.publisher_session_id } };
  expect(commandSchema.parse(session)).toEqual(session);
  expect(commandSchema.safeParse({ ...session, payload: { ...session.payload, session_id: "not-a-uuid" } }).success).toBe(false);
  for (const command of [session, { ...envelope, type: "application.publication.start", payload: request },
    { ...envelope, type: "application.publication.status", payload: request },
    { ...envelope, type: "application.publication.stop", payload: { version: 1, request, reason: "authorization-invalid" } }])
    expect(commandSchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
  expect(commandSchema.safeParse({ ...envelope, type: "application.publication.start", payload: { ...request, argv: ["node", "untrusted.js"] } }).success).toBe(false);
});

it("advertises only the exact publishing node and leaves legacy hello unchanged", () => {
  const hello = { kind: "node.hello", node_id: "node", protocol_version: "v1", artood_version: "1", machine: { hostname: "local", os: "win32", arch: "x64" } };
  const profile = { profile_id: "publisher", project_id: "project", computer_id: "node", verification_profile_id: "verifier", capabilities };
  expect(nodeHelloSchema.parse(hello)).not.toHaveProperty("application_publication_profiles");
  const current = { ...hello, execution_features: ["application-publication.v1"], application_publication_profiles: [profile] };
  expect(nodeHelloSchema.parse(current)).toEqual(current);
  for (const change of [{ node_id: "other" }, { execution_features: [] }, { application_publication_profiles: [profile, profile] }])
    expect(nodeHelloSchema.safeParse({ ...current, ...change }).success).toBe(false);
});

it("reserves receipt facts for the node and ACKs for committed exact evidence", () => {
  const message = { kind: "application.publication.receipt", node_id: "node", payload: { version: 1,
    scope: "bounded-local-application-publication", outcome: "failed", request, request_digest: digest, lease: null, deployment: null,
    recorded_at: "2026-11-09T00:00:00.000Z", failure_stage: "admission", reason: "Original candidate unavailable",
    cleanup: { state: "not-started", closed_owners: [], unsettled_owner_ids: [] } } };
  expect(applicationPublicationReceiptMessageSchema.parse(message)).toEqual(message);
  expect(adapterRunEventBodySchema.safeParse({ type: message.kind, payload: message.payload }).success).toBe(false);
  const payload = { run_id: "author", sequence: 3, status: "accepted", application_verification: { version: 1,
    request_id: "author-request", evidence_id: "author-evidence", event_id: "verification-event", payload_digest: digest, publisher_session_id: request.publisher_session_id } };
  expect(runEventAckCommandSchema.parse({ ...envelope, type: "run.event.ack", payload }).payload).toEqual(payload);
  expect(runEventAckCommandSchema.safeParse({ ...envelope, type: "run.event.ack", payload: { ...payload, status: "rejected" } }).success).toBe(false);
  for (const type of ["application.publication.receipt.ack", "application.publication.observation.ack"]) {
    const ack = { ...envelope, type, payload: { version: 1, publication_id: "publication", publisher_session_id: request.publisher_session_id,
      request_digest: digest, status: "accepted", ...(type.endsWith("receipt.ack") ? { receipt_digest: changed }
        : { event_id: "observation", sequence: 1, observation_digest: changed }) } };
    expect(commandSchema.parse(ack)).toEqual(ack);
  }
});

it("does not run publication context with an absent inline original grant or verifier", () => {
  const command = { ...envelope, type: "run.start", payload: { run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "codex",
    workspace: { root: "C:\\work" }, context_pack: { id: "context", uri: "inline" },
    policy_snapshot: { filesystem_write_scope: ["C:\\work"], requires_approval: [] }, artifact_rules: { paths: [] },
    verification: { version: 1, request_id: "verification", profile_id: "verifier", application_publication: { version: 1,
      authorization_event_id: "authorization", publication_profile_id: "publisher", publication_profile_digest: digest,
      publication_contract_digest: digest, publisher_session_id: request.publisher_session_id } } } };
  expect(runStartCommandSchema.safeParse(command).success).toBe(false);
});
