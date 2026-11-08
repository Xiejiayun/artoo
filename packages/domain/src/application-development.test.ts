import { describe, expect, it } from "vitest";
import { ApplicationCapabilitiesV1Schema, ApplicationCandidateV1Schema, ApplicationDeliveryV1Schema,
  ApplicationVerificationObservationV1Schema, applicationDevelopmentInstructions } from "./application-development.js";
import { APPLICATION_SDK_V1_SOURCE } from "./application-sdk-v1.js";
import { CreateAutonomousGoalRequestSchema, RunVerificationPayloadSchema, VerificationRequirementSchema } from "./autonomy.js";
import { PreparedGoalRequestV1Schema } from "./goal-entry.js";

const digest = `sha256:${"a".repeat(64)}`, changed = `sha256:${"b".repeat(64)}`;
const delivery = { version: 1, kind: "local-application-development" } as const;
const candidate = { version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest,
  toolchain_digest: digest, package_digest: digest, schema_digest: digest, qualified_for_product: false } as const;
const observation = { version: 1, scope: "local-development-api-browser-reopen", stage: "implementation", run_id: "author", request_id: "request",
  origin_run_id: "author", origin_request_id: "request", candidate, qualified_for_product: false,
  acceptance: { version: 1, cases: [{ case_id: "save", program_digest: digest, trace_digest: digest, assertions: 1, capture_digests: [digest] }],
    persistence: { request_digest: digest, before_read_digest: digest, after_read_digest: digest, replay_response_digest: digest,
      after_replay_read_digest: digest, browser_trace_digest: digest },
    closures: { compiler: true, initialize: true, services: 2, browser: true }, test_store_id: "00000000-0000-4000-8000-000000000001" } };

describe("optional application development contracts", () => {
  it("gives authors the exact compiler declaration bytes and stable business-reply guidance", () => {
    const instructions = applicationDevelopmentInstructions();
    expect(instructions.some(line => line.includes(APPLICATION_SDK_V1_SOURCE))).toBe(true);
    expect(instructions.join("\n")).toContain("DataReply.result.scope, request_digest and replayed");
    expect(instructions.join("\n")).toContain("Broker-reserved id/revision");
  });
  it("keeps original goals unchanged and requires an explicit compatible new authorization", () => {
    const legacy = CreateAutonomousGoalRequestSchema.parse({ project_id: "project", objective: "Make a product" });
    expect(legacy).not.toHaveProperty("app_delivery");
    expect(ApplicationDeliveryV1Schema.parse(delivery)).toEqual(delivery);
    const request = { ...legacy, execution_mode: "agent_team", app_delivery: delivery };
    expect(CreateAutonomousGoalRequestSchema.parse(request)).toEqual(request);
    for (const change of [{ execution_mode: "single_agent" }, { release_profile_id: "static" },
      { source_handoff: { version: 1, mode: "automatic" } }, { app_delivery: { ...delivery, command: "untrusted" } }]) {
      expect(CreateAutonomousGoalRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
    expect(PreparedGoalRequestV1Schema.parse({ execution_mode: "agent_team", verification_profile_id: "app", max_retries: 3,
      app_delivery: delivery })).toMatchObject({ app_delivery: delivery });
  });

  it("describes only the fixed normal development scope and never grants product qualification", () => {
    const capability = { ...delivery, claim: "configured", config_digest: digest, contract_digest: digest,
      source_paths: ["product/client", "product/server", ".artoo/product/application.json"], definition_format: "artoo.application-definition.v1",
      test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported", browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 },
      publication: "unsupported", qualified_for_product: false };
    expect(ApplicationCapabilitiesV1Schema.parse(capability)).toEqual(capability);
    for (const change of [{ qualified_for_product: true }, { publication: "supported" }, { failure_recovery: "supported" },
      { source_paths: ["../outside"] }, { command: "run arbitrary binary" }]) {
      expect(ApplicationCapabilitiesV1Schema.safeParse({ ...capability, ...change }).success).toBe(false);
    }
    expect(ApplicationCandidateV1Schema.safeParse({ ...candidate, qualified_for_product: true }).success).toBe(false);
  });

  it("binds review to the original immutable candidate and preserves current observation identity", () => {
    const application = { version: 1, config_digest: digest, contract_digest: digest,
      expected_candidate: { candidate, origin_run_id: "author", origin_request_id: "request" } };
    const requirement = { version: 1, request_id: "review-request", profile_id: "app", expected_subject_digest: digest,
      capability_binding: { version: 1, profile_digest: digest, checks: [{ command_id: "static", config_digest: digest, contract_digest: digest }] }, application };
    expect(VerificationRequirementSchema.parse(requirement)).toEqual(requirement);
    expect(VerificationRequirementSchema.safeParse({ ...requirement, expected_subject_digest: changed }).success).toBe(false);
    expect(VerificationRequirementSchema.safeParse({ ...requirement, capability_binding: undefined }).success).toBe(false);
    const review = { ...observation, run_id: "reviewer", request_id: "review-request" };
    expect(ApplicationVerificationObservationV1Schema.parse(review)).toEqual(review);
  });

  it("rejects incomplete closure, changed reopened data, wrong request/source and successful failure claims", () => {
    const payload = { version: 1, request_id: "request", profile_id: "app", profile_digest: digest, subject_digest: digest,
      outcome: "passed", checks: [{ id: "static", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [], application: observation };
    expect(RunVerificationPayloadSchema.parse(payload)).toEqual(payload);
    for (const change of [{ outcome: "failed" }, { subject_digest: changed }, { request_id: "another" },
      { application: { ...observation, acceptance: { ...observation.acceptance, closures: { ...observation.acceptance.closures, compiler: false } } } },
      { application: { ...observation, acceptance: { ...observation.acceptance, persistence: { ...observation.acceptance.persistence, after_read_digest: changed } } } }]) {
      expect(RunVerificationPayloadSchema.safeParse({ ...payload, ...change }).success).toBe(false);
    }
    expect(RunVerificationPayloadSchema.safeParse({ ...payload, outcome: "failed", checks: [], application: undefined }).success).toBe(true);
  });
});
