import { describe, expect, it } from "vitest";
import { ApplicationCandidateV1Schema, ApplicationDeliveryV1Schema } from "./application-development.js";
import {
  APPLICATION_PUBLICATION_CLAIM_V1, ApplicationPublicationIdentifierV1Schema, ApplicationPublicationGrantV1Schema, ApplicationPublicationLimitsV1Schema,
  ApplicationPublicationCapabilitiesV1Schema, ApplicationPublicationRequestV1Schema, ApplicationPublicationRootLeaseV1Schema,
  ApplicationPublicationReceiptV1Schema, ApplicationPublicationObservationV1Schema,
  canonicalApplicationPublicationContract, canonicalApplicationPublicationRequest, applicationPublicationRequestsEqual,
} from "./application-publication.js";

const digest = `sha256:${"a".repeat(64)}`, changed = `sha256:${"b".repeat(64)}`, requestDigest = `sha256:${"c".repeat(64)}`;
const at = (seconds: number): string => new Date(Date.UTC(2026, 10, 9) + seconds * 1000).toISOString();
const candidate = () => ({ version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest,
  toolchain_digest: digest, package_digest: digest, schema_digest: digest, qualified_for_product: false });
const grant = () => ({ version: 1, kind: "same-computer-local-application-publication", publication_profile_id: "publication" });
const limits = () => ({ root_lifetime_ms: 3_600_000, startup_timeout_ms: 1000, health_timeout_ms: 1000,
  normal_drain_reserve_ms: 1000, health_interval_ms: 10_000, health_freshness_ms: 30_000,
  maximum_service_generations: 2, maximum_requests_per_generation: 256, maximum_concurrent: 1, maximum_health_rounds: 8 });
const capabilities = () => ({ version: 1,
  binding: { version: 1, publication_profile_id: "publication", publication_profile_digest: digest, publication_contract_digest: digest,
    project_id: "project", computer_id: "computer", workspace_root_digest: digest,
    verification_profile_id: "verifier", verification_profile_digest: digest,
    application_config_digest: digest, application_contract_digest: digest, application_toolchain_digest: digest },
  contract: { version: 1, kind: "same-computer-local-application-publication", claim: APPLICATION_PUBLICATION_CLAIM_V1,
    origin: "profile-fixed-loopback", lifecycle: "original-paired-session", normal_reopen: "once-same-version-url-database",
    failure_recovery: "unsupported", automatic_rotation: "unsupported", limits: limits() } });
const request = () => ({ version: 1, publication_id: "publication-1", goal_id: "goal", project_id: "project", computer_id: "computer",
  publisher_session_id: "session", subject_digest: digest, application_definition_digest: digest,
  authorization: { version: 1, event_id: "user-event", actor_user_id: "user", consent_id: "consent", policy_version: "v1", grant: grant() },
  capabilities: capabilities(),
  author: { run_id: "author", request_id: "author-request", evidence_id: "author-evidence", agent_id: "author-agent", stage: "validation",
    origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000001", candidate: candidate() },
  reviewer: { run_id: "reviewer", request_id: "review-request", evidence_id: "review-evidence", agent_id: "review-agent", stage: "validation",
    origin_run_id: "author", origin_request_id: "author-request", test_store_id: "00000000-0000-4000-8000-000000000002", candidate: candidate() },
  acceptance: { version: 1, plan: { id: "plan", version: 1 }, research_digest: digest, measurement_plan_digest: digest,
    accepted_review_event_id: "review-event", development_criteria: [{ requirement_id: "business", criterion_index: 0,
      criterion_digest: digest, case_ids: ["save-and-read"] }], publication_criteria: [{ requirement_id: "publish", criterion_index: 0,
      criterion_digest: digest, claim: APPLICATION_PUBLICATION_CLAIM_V1 }], unmet_criteria: [] } });
const lease = () => ({ version: 1, lease_id: "lease", publication_id: "publication-1", request_digest: requestDigest,
  publisher_session_id: "session", admitted_at: at(0), deadline_at: at(3600), root_lifetime_ms: 3_600_000 });
const deployment = () => ({ version: 1, deployment_generation: "deployment", store_id: "00000000-0000-4000-8000-000000000003",
  plan_digest: digest, relocation_proof_digest: digest, reopen_pin_digest: digest, database_identity: { device: "3", inode: "4" },
  schema_digest: digest, scope_digest: digest, data_generation: "candidate-data-generation", origin: "http://127.0.0.1:4173", client_entry_digest: digest });
const service = (generation: 1 | 2) => ({ publication_id: "publication-1", lease_id: "lease", owner_id: `service-${generation}`, generation,
  deployment_generation: "deployment", reopen_pin_digest: digest, database_identity: { device: "3", inode: "4" },
  schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin: "http://127.0.0.1:4173" });
const health = (generation: 1 | 2) => ({ version: 1, scope: "application-readiness-point-in-time", service: service(generation),
  checked_at: at(generation === 1 ? 2 : 4), broker_preflight: { existing_database: true, process_exit_confirmed: true },
  client: { status_code: 200, body_digest: digest }, persistence_read: { path: "/api/items", status_code: 200, body_digest: digest } });
const processClosure = (owner: string, seconds: number) => ({ owner_id: owner, closed_at: at(seconds), process_exit_confirmed: true,
  exit_code: 0, job_empty: true, stdout_eof: true, stderr_eof: true, helper_exit_code: 0, helper_closed: true });
const normalClosure = (generation: 1 | 2, seconds: number) => ({ ...processClosure(`service-${generation}`, seconds),
  kind: "normal-drain", service: service(generation), reason: "stdin-drain", input_ack_digest: digest,
  listener_closed: true, audit_complete: true, session_released: true,
  counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 1, runtime_closed: 1, broker_invocations: 1, broker_closed: 1 } });
const live = () => ({ service: service(2), observed_at: at(5), closed: false,
  native: { root_pid: 123, root_creation_time: "133000000000000001", observed: true, job_member: true }, requests_used: 2, in_flight: 0 });
const published = () => ({ version: 1, scope: APPLICATION_PUBLICATION_CLAIM_V1, outcome: "published", request: request(), request_digest: requestDigest,
  lease: lease(), deployment: deployment(), initialization: { ...processClosure("initializer", 1), broker_invocations: 1, broker_closed: 1 },
  first_service: { health: health(1), closure: normalClosure(1, 3) }, second_service: { health: health(2), live: live() },
  settled_publication_criteria: request().acceptance.publication_criteria, recorded_at: at(6) });
const failed = () => ({ version: 1, scope: APPLICATION_PUBLICATION_CLAIM_V1, outcome: "failed", request: request(), request_digest: requestDigest,
  lease: lease(), deployment: deployment(), recorded_at: at(6), failure_stage: "reopen", reason: "Original owner closure remains unconfirmed",
  cleanup: { state: "unconfirmed", closed_owners: [{ ...processClosure("initializer", 1), generation: 0 }], unsettled_owner_ids: ["service-1"] } });
const observation = () => ({ version: 1, event_id: "observation", sequence: 1, generation: 2, request: request(), request_digest: requestDigest,
  lease: lease(), deployment: deployment(), state: "healthy", observed_at: at(7), reason: null, health: health(2), live: live(), closure: null });

describe("bounded local application publication contracts", () => {
  it("keeps publication a separate explicit opt-in and preserves old candidate/development meanings", () => {
    expect(ApplicationPublicationIdentifierV1Schema.parse("profile:local-v1")).toBe("profile:local-v1");
    expect(ApplicationPublicationIdentifierV1Schema.safeParse("profile/local").success).toBe(false);
    expect(ApplicationPublicationGrantV1Schema.parse(grant())).toEqual(grant());
    expect(ApplicationDeliveryV1Schema.safeParse(grant()).success).toBe(false);
    expect(ApplicationPublicationGrantV1Schema.safeParse({ version: 1, kind: "local-application-development" }).success).toBe(false);
    expect(ApplicationCandidateV1Schema.parse(candidate()).qualified_for_product).toBe(false);
    expect(ApplicationPublicationGrantV1Schema.safeParse({ ...grant(), command: "publish" }).success).toBe(false);
    const source = request();
    expect(ApplicationPublicationRequestV1Schema.safeParse({ ...source, author: { ...source.author,
      candidate: { ...source.author.candidate, qualified_for_product: true } } }).success).toBe(false);
  });

  it("has fixed finite limits with enough room for both service owners and all normal drains", () => {
    expect(ApplicationPublicationLimitsV1Schema.parse(limits())).toEqual(limits());
    for (const change of [{ root_lifetime_ms: Infinity }, { root_lifetime_ms: 43_200_001 }, { root_lifetime_ms: 7000 },
      { root_lifetime_ms: 0 }, { startup_timeout_ms: 1.5 }, { maximum_service_generations: 3 }, { maximum_requests_per_generation: 257 },
      { maximum_concurrent: 2 }, { maximum_health_rounds: 1 }, { maximum_health_rounds: 129 },
      { health_freshness_ms: 3_600_001 }, { health_interval_ms: 3_600_001 }]) {
      expect(ApplicationPublicationLimitsV1Schema.safeParse({ ...limits(), ...change }).success).toBe(false);
    }
    const value = capabilities();
    expect(ApplicationPublicationCapabilitiesV1Schema.parse(value)).toEqual(value);
    for (const change of [{ failure_recovery: "supported" }, { automatic_rotation: "supported" }, { lifecycle: "restartable" },
      { claim: "configured-static-publication" }]) {
      expect(ApplicationPublicationCapabilitiesV1Schema.safeParse({ ...value, contract: { ...value.contract, ...change } }).success).toBe(false);
    }
  });

  it("rejects remote path/URL/argv overrides and mismatched authorization or source bindings", () => {
    const value = request();
    expect(ApplicationPublicationRequestV1Schema.parse(value)).toEqual(value);
    for (const change of [{ workspace_root: "C:/other" }, { argv: ["untrusted"] }, { endpoint: "http://127.0.0.1:9000" },
      { database_path: "C:/other/data.db" }, { app_delivery: { version: 1, kind: "local-application-development" } },
      { project_id: "other" }, { computer_id: "other" }, { subject_digest: changed },
      { authorization: { ...value.authorization, grant: { ...value.authorization.grant, publication_profile_id: "other" } } },
      { capabilities: { ...value.capabilities, binding: { ...value.capabilities.binding, application_toolchain_digest: changed } } },
      { reviewer: { ...value.reviewer, origin_request_id: "other" } },
      { reviewer: { ...value.reviewer, candidate: { ...value.reviewer.candidate, package_digest: changed } } },
      { author: { ...value.author, origin_run_id: "another-author" } }]) {
      expect(ApplicationPublicationRequestV1Schema.safeParse({ ...value, ...change }).success).toBe(false);
    }
    for (const field of ["run_id", "request_id", "evidence_id", "agent_id", "test_store_id"] as const)
      expect(ApplicationPublicationRequestV1Schema.safeParse({ ...value, reviewer: { ...value.reviewer, [field]: value.author[field] } }).success).toBe(false);
  });

  it("requires explicit disjoint accepted criteria and rejects unmet requirements", () => {
    const value = request(), acceptance = value.acceptance;
    for (const change of [{ development_criteria: [] }, { publication_criteria: [] },
      { accepted_review_event_id: value.authorization.event_id },
      { unmet_criteria: [{ requirement_id: "missing", criterion_index: 0, criterion_digest: digest }] },
      { publication_criteria: [...acceptance.publication_criteria, ...acceptance.publication_criteria] },
      { publication_criteria: [{ ...acceptance.publication_criteria[0], requirement_id: "business" }] },
      { development_criteria: [{ ...acceptance.development_criteria[0], case_ids: ["same", "same"] }] }]) {
      expect(ApplicationPublicationRequestV1Schema.safeParse({ ...value, acceptance: { ...acceptance, ...change } }).success).toBe(false);
    }
  });

  it("canonicalizes order without silently dropping unknown authority fields", () => {
    const value = ApplicationPublicationRequestV1Schema.parse(request());
    const reordered = { ...value, capabilities: { contract: value.capabilities.contract, binding: value.capabilities.binding, version: 1 as const } };
    expect(applicationPublicationRequestsEqual(value, reordered)).toBe(true);
    expect(canonicalApplicationPublicationRequest(value)).toBe(canonicalApplicationPublicationRequest(reordered));
    expect(canonicalApplicationPublicationContract(value.capabilities.contract)).toContain(APPLICATION_PUBLICATION_CLAIM_V1);
    expect(applicationPublicationRequestsEqual(value, { ...value, publication_id: "another" })).toBe(false);
  });

  it("records initial closure, one actual normal drain and a distinct still-live second owner", () => {
    const value = published();
    const result = ApplicationPublicationReceiptV1Schema.parse(value);
    expect(result).toEqual(value);
    expect(result.outcome).toBe("published");
    if (result.outcome === "published") {
      expect(result.second_service.live).not.toHaveProperty("process_exit_confirmed");
      expect(result.request.author.candidate.qualified_for_product).toBe(false);
    }
    for (const change of [
      { initialization: { ...value.initialization, exit_code: 1 } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure, reason: "stdin-shutdown" } } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure, process_exit_confirmed: false } } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure,
        counters: { ...value.first_service.closure.counters, runtime_closed: 0 } } } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure,
        counters: { ...value.first_service.closure.counters, broker_invocations: 2, broker_closed: 2 } } } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure,
        counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 3, runtime_closed: 3, broker_invocations: 3, broker_closed: 3 } } } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure,
        counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 0, runtime_closed: 0, broker_invocations: 0, broker_closed: 0 } } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live, process_exit_confirmed: true } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live, closed: true } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live, requests_used: 256 } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live, in_flight: 1 } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live,
        native: { ...value.second_service.live.native, job_member: false } } } },
      { settled_publication_criteria: [{ ...value.settled_publication_criteria[0], criterion_digest: changed }] },
    ]) expect(ApplicationPublicationReceiptV1Schema.safeParse({ ...value, ...change }).success).toBe(false);
  });

  it("requires the same immutable deployment, physical DB, descriptor, version and URL after drain", () => {
    const value = published();
    for (const change of [{ database_identity: { device: "3", inode: "999" } }, { reopen_pin_digest: changed },
      { artifact_digest: changed }, { schema_digest: changed }, { scope_digest: changed }, { deployment_generation: "replacement" },
      { origin: "http://127.0.0.1:4174" }, { generation: 1 }, { owner_id: "service-1" }]) {
      const identity = { ...value.second_service.live.service, ...change };
      expect(ApplicationPublicationReceiptV1Schema.safeParse({ ...value, second_service: {
        health: { ...value.second_service.health, service: identity }, live: { ...value.second_service.live, service: identity },
      } }).success).toBe(false);
    }
    for (const change of [{ store_id: value.request.author.test_store_id }, { store_id: value.request.reviewer.test_store_id },
      { schema_digest: changed }, { client_entry_digest: changed }, { origin: "https://example.com" }, { origin: "http://127.0.0.1:65536" }])
      expect(ApplicationPublicationReceiptV1Schema.safeParse({ ...value, deployment: { ...value.deployment, ...change } }).success).toBe(false);
  });

  it("retains the application's canonical /api read paths including queries without admitting new paths", () => {
    const value = published();
    const withPath = (path: string) => ({ ...value,
      first_service: { ...value.first_service, health: { ...value.first_service.health,
        persistence_read: { ...value.first_service.health.persistence_read, path } } },
      second_service: { ...value.second_service, health: { ...value.second_service.health,
        persistence_read: { ...value.second_service.health.persistence_read, path } } },
    });
    for (const path of ["/api", "/api?filter=active", "/api/items?filter=active&limit=10", "/api/items?text=a%20b"])
      expect(ApplicationPublicationReceiptV1Schema.safeParse(withPath(path)).success).toBe(true);
    for (const path of ["/other", "/apianother", "//elsewhere/api", "/api#fragment", "/api/items value", "/api\\items",
      "/api/../other", "/api/%2e%2e/other", "/api/items?", "/api/items?filter=a\nb"])
      expect(ApplicationPublicationReceiptV1Schema.safeParse(withPath(path)).success).toBe(false);
  });

  it("cannot renew the root lease or publish before the original normal closure and live observation", () => {
    const value = published();
    expect(ApplicationPublicationRootLeaseV1Schema.parse(lease())).toEqual(lease());
    expect(ApplicationPublicationRootLeaseV1Schema.safeParse({ ...lease(), deadline_at: at(3601) }).success).toBe(false);
    for (const change of [{ lease: { ...value.lease, request_digest: changed } }, { lease: { ...value.lease, publisher_session_id: "new-session" } },
      { lease: { ...value.lease, root_lifetime_ms: 7_200_000, deadline_at: at(7200) } }, { recorded_at: at(3600) }, { recorded_at: at(35) },
      { initialization: { ...value.initialization, closed_at: at(3) } },
      { first_service: { ...value.first_service, closure: { ...value.first_service.closure, closed_at: at(5) } } },
      { second_service: { ...value.second_service, live: { ...value.second_service.live, observed_at: at(7) } } }])
      expect(ApplicationPublicationReceiptV1Schema.safeParse({ ...value, ...change }).success).toBe(false);
  });

  it("retains failed cleanup uncertainty and never turns a failure into publication", () => {
    const value = failed();
    expect(ApplicationPublicationReceiptV1Schema.parse(value)).toEqual(value);
    const refused = { ...value, lease: null, deployment: null, failure_stage: "admission",
      cleanup: { state: "not-started", closed_owners: [], unsettled_owner_ids: [] } };
    expect(ApplicationPublicationReceiptV1Schema.parse(refused)).toEqual(refused);
    for (const change of [{ outcome: "published" }, { lease: null },
      { cleanup: { ...value.cleanup, state: "closed-confirmed" } }, { cleanup: { ...value.cleanup, unsettled_owner_ids: [] } },
      { cleanup: { ...value.cleanup, unsettled_owner_ids: ["initializer"] } },
      { cleanup: { ...value.cleanup, closed_owners: [...value.cleanup.closed_owners, ...value.cleanup.closed_owners] } },
      { cleanup: { ...value.cleanup, closed_owners: [{ ...value.cleanup.closed_owners[0], process_exit_confirmed: false }] } }])
      expect(ApplicationPublicationReceiptV1Schema.safeParse({ ...value, ...change }).success).toBe(false);
  });

  it("keeps historical publication separate from later normal, aborted, expired and unknown states", () => {
    const value = observation(), history = published();
    expect(ApplicationPublicationObservationV1Schema.parse(value)).toEqual(value);
    const normal = { ...value, state: "closed-normal", observed_at: at(10), reason: "User stopped the original publication",
      health: null, live: null, closure: normalClosure(2, 9) };
    expect(ApplicationPublicationObservationV1Schema.parse(normal)).toEqual(normal);
    const aborted = { ...value, state: "closed-aborted", observed_at: at(10), reason: "Cancellation escalated",
      health: null, live: null, closure: { ...processClosure("service-2", 9), kind: "aborted", service: service(2), reason: "cancelled" } };
    expect(ApplicationPublicationObservationV1Schema.parse(aborted)).toEqual(aborted);
    for (const later of [
      { ...value, state: "expired", observed_at: at(3600), reason: "Original deadline elapsed", health: null, live: null },
      { ...value, state: "unknown", reason: "Original paired connection lost", health: null, live: null },
      { ...value, state: "live", health: null },
      { ...value, state: "draining", health: null, reason: "Original lease ending" },
    ]) expect(ApplicationPublicationObservationV1Schema.safeParse(later).success).toBe(true);
    expect(ApplicationPublicationReceiptV1Schema.parse(history)).toEqual(history);
    for (const change of [{ live: value.live }, { health: value.health }, { closure: null },
      { closure: { ...normal.closure, kind: "aborted" } }, { observed_at: at(8) },
      { observed_at: at(3601), closure: { ...normal.closure, closed_at: at(3600) } }])
      expect(ApplicationPublicationObservationV1Schema.safeParse({ ...normal, ...change }).success).toBe(false);
  });

  it("rejects stale/future health, exhausted budgets, third owners and renewed sessions in later observations", () => {
    const value = observation();
    for (const change of [{ generation: 3 }, { sequence: 0 }, { sequence: 2_147_483_648 }, { observed_at: at(3600) }, { observed_at: at(36) },
      { state: "unknown" }, { state: "expired", health: null, live: null, reason: "Too early" },
      { live: { ...value.live, requests_used: 256 } }, { live: { ...value.live, observed_at: at(8) } },
      { health: { ...value.health, checked_at: at(6) } }, { live: null }, { closure: normalClosure(2, 6) },
      { lease: { ...value.lease, publisher_session_id: "new-session" } },
      { health: { ...value.health, client: { ...value.health.client, body_digest: changed } } }])
      expect(ApplicationPublicationObservationV1Schema.safeParse({ ...value, ...change }).success).toBe(false);
  });
});
