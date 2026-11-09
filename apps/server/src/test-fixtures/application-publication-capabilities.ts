import { createHash } from "node:crypto";
import { ApplicationPublicationCapabilitiesV1Schema, ApplicationPublicationReceiptV1Schema, ApplicationPublicationObservationV1Schema,
  canonicalReleaseJson, type ApplicationPublicationRequestV1, type VerificationCapabilities } from "@artoo/domain";

/** Controlled profile advertisement only; these identities are not native execution or publication evidence. */
export function applicationPublicationCapabilitiesFixture(verifier: VerificationCapabilities,
  computerId = "computer_local_mock", projectId = "proj_artoo", profileId = "default") {
  if (!verifier.application) throw new Error("Application verifier fixture required");
  const digest = `sha256:${"a".repeat(64)}`;
  return ApplicationPublicationCapabilitiesV1Schema.parse({ version: 1,
    binding: { version: 1, publication_profile_id: "application-publisher", publication_profile_digest: digest,
      publication_contract_digest: digest, project_id: projectId, computer_id: computerId, workspace_root_digest: digest,
      verification_profile_id: profileId, verification_profile_digest: verifier.profile_digest,
      application_config_digest: verifier.application.config_digest, application_contract_digest: verifier.application.contract_digest,
      application_toolchain_digest: digest },
    contract: { version: 1, kind: "same-computer-local-application-publication", claim: "bounded-local-application-publication",
      origin: "profile-fixed-loopback", lifecycle: "original-paired-session", normal_reopen: "once-same-version-url-database",
      failure_recovery: "unsupported", automatic_rotation: "unsupported",
      limits: { root_lifetime_ms: 3_600_000, startup_timeout_ms: 10_000, health_timeout_ms: 1_000,
        normal_drain_reserve_ms: 5_000, health_interval_ms: 60_000, health_freshness_ms: 30_000,
        maximum_service_generations: 2, maximum_requests_per_generation: 256, maximum_concurrent: 1, maximum_health_rounds: 50 } } });
}

/** Schema-valid controlled ledger facts. No native compiler, process, browser or service is executed by this fixture. */
export function applicationPublicationLedgerFixture(request: ApplicationPublicationRequestV1, admittedAt: string) {
  const digest = `sha256:${"a".repeat(64)}`, at = (seconds: number) => new Date(Date.parse(admittedAt) + seconds * 1000).toISOString();
  const requestDigest = `sha256:${createHash("sha256").update(canonicalReleaseJson(request)).digest("hex")}`;
  const lease = { version: 1, lease_id: "controlled-lease", publication_id: request.publication_id, request_digest: requestDigest,
    publisher_session_id: request.publisher_session_id, admitted_at: admittedAt,
    deadline_at: new Date(Date.parse(admittedAt) + request.capabilities.contract.limits.root_lifetime_ms).toISOString(),
    root_lifetime_ms: request.capabilities.contract.limits.root_lifetime_ms };
  const deployment = { version: 1, deployment_generation: "controlled-deployment", store_id: "00000000-0000-4000-8000-000000000003",
    plan_digest: digest, relocation_proof_digest: digest, reopen_pin_digest: digest, database_identity: { device: "3", inode: "4" },
    schema_digest: request.author.candidate.schema_digest, scope_digest: digest, data_generation: "controlled-data",
    origin: "http://127.0.0.1:4173", client_entry_digest: digest };
  const service = (generation: 1 | 2) => ({ publication_id: request.publication_id, lease_id: lease.lease_id, owner_id: `controlled-service-${generation}`,
    generation, deployment_generation: deployment.deployment_generation, reopen_pin_digest: digest, database_identity: deployment.database_identity,
    schema_digest: deployment.schema_digest, scope_digest: digest, artifact_digest: request.author.candidate.artifact_digest, origin: deployment.origin });
  const health = (generation: 1 | 2, seconds: number) => ({ version: 1, scope: "application-readiness-point-in-time", service: service(generation),
    checked_at: at(seconds), broker_preflight: { existing_database: true, process_exit_confirmed: true },
    client: { status_code: 200, body_digest: digest }, persistence_read: { path: "/api/items", status_code: 200, body_digest: digest } });
  const process = (owner: string, seconds: number) => ({ owner_id: owner, closed_at: at(seconds), process_exit_confirmed: true,
    exit_code: 0, job_empty: true, stdout_eof: true, stderr_eof: true, helper_exit_code: 0, helper_closed: true });
  const closure = (generation: 1 | 2, seconds: number) => ({ ...process(service(generation).owner_id, seconds), kind: "normal-drain",
    service: service(generation), reason: "stdin-drain", input_ack_digest: digest, listener_closed: true, audit_complete: true, session_released: true,
    counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 1, runtime_closed: 1, broker_invocations: 1, broker_closed: 1 } });
  const live = (seconds: number) => ({ service: service(2), counters_observed_at: at(seconds), observed_at: at(seconds), closed: false,
    native: { root_pid: 123, root_creation_time: "133000000000000001", observed: true, job_member: true }, requests_used: 2, in_flight: 0 });
  const receipt = ApplicationPublicationReceiptV1Schema.parse({ version: 1, scope: "bounded-local-application-publication", outcome: "published",
    request, request_digest: requestDigest, lease, deployment,
    initialization: { ...process("controlled-initializer", 1), broker_invocations: 1, broker_closed: 1 },
    first_service: { health: health(1, 2), closure: closure(1, 3) }, second_service: { health: health(2, 4), live: live(5) },
    settled_publication_criteria: request.acceptance.publication_criteria, recorded_at: at(6) });
  const observation = (sequence: number, seconds: number, stopped = false) => ApplicationPublicationObservationV1Schema.parse({
    version: 1, event_id: `controlled-observation-${sequence}`, sequence, generation: 2, request, request_digest: requestDigest, lease, deployment,
    state: stopped ? "closed-normal" : "healthy", observed_at: at(seconds), reason: stopped ? "User requested stop" : null,
    health: stopped ? null : health(2, seconds), live: stopped ? null : live(seconds), closure: stopped ? closure(2, seconds) : null });
  return { receipt, observation, at };
}
