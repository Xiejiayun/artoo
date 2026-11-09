// Controlled wire projections only. No fixture value grants process or publication authority.
import { createHash } from "node:crypto";
import { ApplicationPublicationRequestV1Schema, RunStartPayloadSchema, RunVerificationPayloadSchema,
  VerificationCapabilitiesContextSchema, productDevelopmentContext, type ApplicationPublicationRequestV1 } from "@artoo/domain";
import { runStartCommandSchema } from "@artoo/protocol";

export const applicationPublicationFixtureSha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const applicationPublicationFixtureDigest = `sha256:${"a".repeat(64)}`;

export function applicationPublicationRequestFixture(): ApplicationPublicationRequestV1 {
  const digest = applicationPublicationFixtureDigest;
  const candidate = { version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest,
    toolchain_digest: digest, package_digest: digest, schema_digest: digest, qualified_for_product: false };
  return ApplicationPublicationRequestV1Schema.parse({ version: 1, publication_id: "publication-1", goal_id: "goal", project_id: "project", computer_id: "node",
    publisher_session_id: "session", subject_digest: digest, application_definition_digest: digest,
    authorization: { version: 1, event_id: "user-event", actor_user_id: "user", consent_id: null, policy_version: "v1",
      grant: { version: 1, kind: "same-computer-local-application-publication", publication_profile_id: "publication" } },
    capabilities: { version: 1,
      binding: { version: 1, publication_profile_id: "publication", publication_profile_digest: digest, publication_contract_digest: digest,
        project_id: "project", computer_id: "node", workspace_root_digest: digest, verification_profile_id: "verifier", verification_profile_digest: digest,
        application_config_digest: digest, application_contract_digest: digest, application_toolchain_digest: digest },
      contract: { version: 1, kind: "same-computer-local-application-publication", claim: "bounded-local-application-publication",
        origin: "profile-fixed-loopback", lifecycle: "original-paired-session", normal_reopen: "once-same-version-url-database",
        failure_recovery: "unsupported", automatic_rotation: "unsupported", limits: { root_lifetime_ms: 600_000, startup_timeout_ms: 1000,
          health_timeout_ms: 1000, normal_drain_reserve_ms: 10_000, health_interval_ms: 30_000, health_freshness_ms: 10_000,
          maximum_service_generations: 2, maximum_requests_per_generation: 256, maximum_concurrent: 1, maximum_health_rounds: 8 } } },
    author: { run_id: "author", request_id: "author-request", evidence_id: "author-evidence", agent_id: "author-agent", agent_instance_id: "author-instance",
      stage: "validation", origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000001", candidate },
    reviewer: { run_id: "reviewer", request_id: "reviewer-request", evidence_id: "reviewer-evidence", agent_id: "reviewer-agent", agent_instance_id: "reviewer-instance",
      stage: "validation", origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000002", candidate },
    acceptance: { version: 1, plan: { id: "plan", version: 1 }, research_digest: digest, design_digest: digest, measurement_plan_digest: digest,
      accepted_review_event_id: "review-event", development_criteria: [{ requirement_id: "business", criterion_index: 0, criterion_digest: digest, case_ids: ["saved"] }],
      publication_criteria: [{ requirement_id: "publication", criterion_index: 0, criterion_digest: digest, claim: "bounded-local-application-publication" }], unmet_criteria: [] } });
}

export function applicationPublicationVerificationFixture(request: ApplicationPublicationRequestV1, who: "author" | "reviewer") {
  const source = request[who], binding = request.capabilities.binding, digest = applicationPublicationFixtureDigest;
  return RunVerificationPayloadSchema.parse({ version: 1, request_id: source.request_id, profile_id: binding.verification_profile_id,
    profile_digest: binding.verification_profile_digest, subject_digest: request.subject_digest, outcome: "passed",
    checks: [{ id: "application", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [],
    application: { version: 1, scope: "local-development-api-browser-reopen", stage: source.stage, run_id: source.run_id, request_id: source.request_id,
      origin_run_id: source.origin_run_id, origin_request_id: source.origin_request_id, candidate: source.candidate, qualified_for_product: false,
      publication: { version: 1, authorization_event_id: request.authorization.event_id, publication_contract_digest: binding.publication_contract_digest,
        research_digest: request.acceptance.research_digest, design_digest: request.acceptance.design_digest,
        measurement_plan_digest: request.acceptance.measurement_plan_digest, application_definition_digest: request.application_definition_digest,
        development_criteria: request.acceptance.development_criteria, publication_criteria: request.acceptance.publication_criteria, unmet_criteria: [] },
      acceptance: { version: 1, test_store_id: source.test_store_id,
        cases: [{ case_id: "saved", program_digest: digest, trace_digest: digest, assertions: 1, capture_digests: [digest] }],
        persistence: { request_digest: digest, before_read_digest: digest, after_read_digest: digest, replay_response_digest: digest,
          after_replay_read_digest: digest, browser_trace_digest: digest }, closures: { compiler: true, initialize: true, services: 2, browser: true } } } });
}

export function applicationPublicationRunFixture(request: ApplicationPublicationRequestV1, who: "author" | "reviewer", workspace = "C:\\work") {
  const source = request[who], binding = request.capabilities.binding, author = applicationPublicationVerificationFixture(request, "author");
  // The wire codec requires the complete public verifier snapshot, even when
  // the local verifier/native owners are controlled doubles in the caller.
  const capabilities = VerificationCapabilitiesContextSchema.parse({ version: 1, profile_id: binding.verification_profile_id,
    profile_digest: binding.verification_profile_digest,
    application: { version: 1, kind: "local-application-development", claim: "configured",
      config_digest: binding.application_config_digest, contract_digest: binding.application_contract_digest,
      source_paths: ["product/client", "product/server", ".artoo/product/application.json"], definition_format: "artoo.application-definition.v1",
      test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported", publication: "unsupported", qualified_for_product: false,
      browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 } },
    checks: [{ command_id: "application", config_digest: binding.application_config_digest, contract_digest: binding.application_contract_digest,
      contract: { version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3, legacy_browser_steps: "rejected",
        actions: ["navigate", "assert_text"], viewports: [{ id: "desktop", width: 1280, height: 900 }], device_scale_factor: 1,
        stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
        screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
          same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
        limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 500 }, checks: ["horizontal-overflow", "dom-control-name-heuristic"],
        keyboard: { allowed_keys: ["Tab"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
        unavailable: ["storage-exception-injection", "native-screen-reader", "browser-zoom"] } }] });
  const payload = RunStartPayloadSchema.parse({ run_id: source.run_id, task_id: `task-${who}`, agent_instance_id: source.agent_instance_id, runtime: "controlled",
    workspace: { root: workspace }, verification: { version: 1, request_id: source.request_id, profile_id: binding.verification_profile_id,
      capability_binding: { version: 1, profile_digest: binding.verification_profile_digest,
        checks: [{ command_id: "application", config_digest: binding.application_config_digest, contract_digest: binding.application_contract_digest }] },
      application: { version: 1, config_digest: binding.application_config_digest, contract_digest: binding.application_contract_digest,
        ...(who === "reviewer" ? { expected_candidate: { candidate: source.candidate, origin_run_id: source.origin_run_id, origin_request_id: source.origin_request_id } } : {}) },
      ...(who === "reviewer" ? { expected_subject_digest: request.subject_digest } : {}),
      application_publication: { version: 1, authorization_event_id: request.authorization.event_id, publication_profile_id: binding.publication_profile_id,
        publication_profile_digest: binding.publication_profile_digest, publication_contract_digest: binding.publication_contract_digest, publisher_session_id: request.publisher_session_id } },
    policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
    context_pack: { id: `${who}-context`, payload: { app_publication: request.authorization.grant,
      application_publication: { version: 1, authorization: request.authorization, capabilities: request.capabilities, publisher_session_id: request.publisher_session_id,
        agent_id: source.agent_id, agent_instance_id: source.agent_instance_id }, product_development: productDevelopmentContext("validation"),
      verification_capabilities: capabilities,
      task: { id: `task-${who}`, title: "Validate application", description: "Controlled publication fixture", acceptance_criteria: [] },
      project: { id: request.project_id, name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      goal_context: { version: 1, goal_id: request.goal_id, objective: "Controlled application", acceptance_criteria: [],
        plan: { ...request.acceptance.plan, rationale: "Controlled plan", spec_ref: null } },
      ...(who === "reviewer" ? { review_subject: { version: 1, task_id: "task-author", run_id: request.author.run_id, evidence_id: request.author.evidence_id,
        subject_digest: request.subject_digest, development_stage: "validation", verification: { version: 1, request_id: author.request_id, profile_id: author.profile_id,
          profile_digest: author.profile_digest, application: author.application, checks: [{ id: "application", output_digest: applicationPublicationFixtureDigest }] } } } : {}) } } });
  return runStartCommandSchema.parse({ kind: "command", id: `${source.run_id}-fixture`, idempotency_key: `${source.run_id}:start`,
    type: "run.start", payload }).payload;
}
