import { z } from "zod";
import { ApplicationCandidateV1Schema } from "./application-development.js";
import { canonicalReleaseJson } from "./release-capabilities.js";

export const ApplicationPublicationIdentifierV1Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const id = ApplicationPublicationIdentifierV1Schema;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime();
const duration = z.number().int().min(1).max(43_200_000);
const count = z.number().int().min(0).max(256);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const equal = (left: unknown, right: unknown): boolean => canonicalReleaseJson(left) === canonicalReleaseJson(right);
const issue = (ctx: z.RefinementCtx, path: (string | number)[], message: string): void =>
  ctx.addIssue({ code: "custom", path, message });

export const APPLICATION_PUBLICATION_FEATURE_V1 = "application-publication.v1" as const;
export const APPLICATION_PUBLICATION_CLAIM_V1 = "bounded-local-application-publication" as const;

/** A new original-user opt-in; it never upgrades the development-only v1 grant. */
export const ApplicationPublicationGrantV1Schema = z.object({
  version: z.literal(1), kind: z.literal("same-computer-local-application-publication"), publication_profile_id: id,
}).strict();
export type ApplicationPublicationGrantV1 = z.infer<typeof ApplicationPublicationGrantV1Schema>;

/** A health round includes both bounded HTTP reads. Local preparation must also validate actual cleanup reserves. */
export const ApplicationPublicationLimitsV1Schema = z.object({
  root_lifetime_ms: duration, startup_timeout_ms: duration, health_timeout_ms: duration,
  normal_drain_reserve_ms: duration, health_interval_ms: duration, health_freshness_ms: duration,
  maximum_service_generations: z.literal(2), maximum_requests_per_generation: z.literal(256),
  maximum_concurrent: z.literal(1), maximum_health_rounds: z.number().int().min(2).max(128),
}).strict().superRefine((value, ctx) => {
  // Initialization, two starts, two health rounds and both drains must leave a positive live window.
  if (3 * value.startup_timeout_ms + 2 * value.health_timeout_ms + 2 * value.normal_drain_reserve_ms >= value.root_lifetime_ms)
    issue(ctx, ["root_lifetime_ms"], "The original root lease must accommodate initialization, both services, health and drain reserves");
  for (const field of ["health_interval_ms", "health_freshness_ms"] as const)
    if (value[field] > value.root_lifetime_ms) issue(ctx, [field], "Observation timing cannot exceed the original root lease");
});
export type ApplicationPublicationLimitsV1 = z.infer<typeof ApplicationPublicationLimitsV1Schema>;

/** Exact protected-configuration identities, not paths or instructions to install a profile. */
export const ApplicationPublicationCapabilityBindingV1Schema = z.object({
  version: z.literal(1), publication_profile_id: id, publication_profile_digest: digest, publication_contract_digest: digest,
  project_id: id, computer_id: id, workspace_root_digest: digest,
  verification_profile_id: id, verification_profile_digest: digest,
  application_config_digest: digest, application_contract_digest: digest, application_toolchain_digest: digest,
}).strict();
export type ApplicationPublicationCapabilityBindingV1 = z.infer<typeof ApplicationPublicationCapabilityBindingV1Schema>;

export const ApplicationPublicationCapabilityContractV1Schema = z.object({
  version: z.literal(1), kind: z.literal("same-computer-local-application-publication"),
  claim: z.literal(APPLICATION_PUBLICATION_CLAIM_V1), origin: z.literal("profile-fixed-loopback"),
  lifecycle: z.literal("original-paired-session"), normal_reopen: z.literal("once-same-version-url-database"),
  failure_recovery: z.literal("unsupported"), automatic_rotation: z.literal("unsupported"),
  limits: ApplicationPublicationLimitsV1Schema,
}).strict();
export type ApplicationPublicationCapabilityContractV1 = z.infer<typeof ApplicationPublicationCapabilityContractV1Schema>;

export const ApplicationPublicationCapabilitiesV1Schema = z.object({
  version: z.literal(1), binding: ApplicationPublicationCapabilityBindingV1Schema, contract: ApplicationPublicationCapabilityContractV1Schema,
}).strict();
export type ApplicationPublicationCapabilitiesV1 = z.infer<typeof ApplicationPublicationCapabilitiesV1Schema>;

export const ApplicationPublicationAuthorizationV1Schema = z.object({
  version: z.literal(1), event_id: id, actor_user_id: id, consent_id: id.nullable(), policy_version: id,
  grant: ApplicationPublicationGrantV1Schema,
}).strict();
export type ApplicationPublicationAuthorizationV1 = z.infer<typeof ApplicationPublicationAuthorizationV1Schema>;

/** Server-issued run routing. These data projections never recreate a node-private permit. */
export const ApplicationPublicationContextV1Schema = z.object({
  version: z.literal(1), authorization: ApplicationPublicationAuthorizationV1Schema,
  capabilities: ApplicationPublicationCapabilitiesV1Schema, publisher_session_id: id, agent_id: id, agent_instance_id: id,
}).strict().superRefine((value, ctx) => {
  if (value.authorization.grant.publication_profile_id !== value.capabilities.binding.publication_profile_id)
    issue(ctx, ["capabilities"], "Publication context must retain the original authorized profile");
});
export type ApplicationPublicationContextV1 = z.infer<typeof ApplicationPublicationContextV1Schema>;

export const ApplicationPublicationVerificationBindingV1Schema = z.object({
  version: z.literal(1), authorization_event_id: id, publication_profile_id: id,
  publication_profile_digest: digest, publication_contract_digest: digest, publisher_session_id: id,
}).strict();
export type ApplicationPublicationVerificationBindingV1 = z.infer<typeof ApplicationPublicationVerificationBindingV1Schema>;

/** A committed server evidence identity, matched to the node's original pending event body and session. */
export const ApplicationPublicationVerificationAckV1Schema = z.object({
  version: z.literal(1), request_id: id, evidence_id: id, event_id: id, payload_digest: digest, publisher_session_id: id,
}).strict();
export type ApplicationPublicationVerificationAckV1 = z.infer<typeof ApplicationPublicationVerificationAckV1Schema>;

export const ApplicationPublicationProfileAdvertisementV1Schema = z.object({
  profile_id: id, project_id: id, computer_id: id, verification_profile_id: id,
  capabilities: ApplicationPublicationCapabilitiesV1Schema,
}).strict().superRefine((value, ctx) => {
  const binding = value.capabilities.binding;
  if (value.profile_id !== binding.publication_profile_id || value.project_id !== binding.project_id
    || value.computer_id !== binding.computer_id || value.verification_profile_id !== binding.verification_profile_id)
    issue(ctx, ["capabilities"], "Publication advertisement must retain its exact protected capability binding");
});
export type ApplicationPublicationProfileAdvertisementV1 = z.infer<typeof ApplicationPublicationProfileAdvertisementV1Schema>;
export const ApplicationPublicationProfileAdvertisementsV1Schema = z.array(ApplicationPublicationProfileAdvertisementV1Schema).max(64)
  .refine(values => new Set(values.map(value => value.profile_id)).size === values.length, "Duplicate application publication profile ID");

/** These projections must be checked against original node-private completion records and server evidence. */
export const ApplicationPublicationVerificationSourceV1Schema = z.object({
  run_id: id, request_id: id, evidence_id: id, agent_id: id, agent_instance_id: id, stage: z.literal("validation"),
  origin_run_id: id, origin_request_id: id, test_store_id: z.string().guid(), candidate: ApplicationCandidateV1Schema,
}).strict();
export type ApplicationPublicationVerificationSourceV1 = z.infer<typeof ApplicationPublicationVerificationSourceV1Schema>;

const criterion = z.object({ requirement_id: id, criterion_index: z.number().int().min(0).max(99), criterion_digest: digest }).strict();
const criterionKey = (value: { requirement_id: string; criterion_index: number }): string => `${value.requirement_id}:${value.criterion_index}`;
export const ApplicationPublicationCriterionV1Schema = criterion.extend({ claim: z.literal(APPLICATION_PUBLICATION_CLAIM_V1) }).strict();
export type ApplicationPublicationCriterionV1 = z.infer<typeof ApplicationPublicationCriterionV1Schema>;

/** The server must additionally prove exhaustive coverage of the exact accepted plan and actual case IDs. */
export const ApplicationPublicationAcceptanceBindingV1Schema = z.object({
  version: z.literal(1), plan: z.object({ id, version: z.number().int().min(1).max(2_147_483_647) }).strict(),
  research_digest: digest, design_digest: digest, measurement_plan_digest: digest, accepted_review_event_id: id,
  development_criteria: z.array(criterion.extend({
    case_ids: z.array(id).min(1).max(400).refine(values => new Set(values).size === values.length, "Duplicate verification case ID"),
  }).strict()).min(1).max(10_000),
  publication_criteria: z.array(ApplicationPublicationCriterionV1Schema).min(1).max(10_000),
  unmet_criteria: z.array(criterion).max(0),
}).strict().superRefine((value, ctx) => {
  const all = [...value.development_criteria, ...value.publication_criteria];
  if (new Set(all.map(criterionKey)).size !== all.length)
    issue(ctx, ["publication_criteria"], "Each accepted criterion must have one explicit development or publication binding");
});
export type ApplicationPublicationAcceptanceBindingV1 = z.infer<typeof ApplicationPublicationAcceptanceBindingV1Schema>;

/** Persist this exact request once. Parsing JSON does not grant publication, candidate or process authority. */
export const ApplicationPublicationRequestV1Schema = z.object({
  version: z.literal(1), publication_id: id, goal_id: id, project_id: id, computer_id: id, publisher_session_id: id,
  subject_digest: digest, application_definition_digest: digest,
  authorization: ApplicationPublicationAuthorizationV1Schema, capabilities: ApplicationPublicationCapabilitiesV1Schema,
  author: ApplicationPublicationVerificationSourceV1Schema, reviewer: ApplicationPublicationVerificationSourceV1Schema,
  acceptance: ApplicationPublicationAcceptanceBindingV1Schema,
}).strict().superRefine((value, ctx) => {
  const binding = value.capabilities.binding;
  if (binding.publication_profile_id !== value.authorization.grant.publication_profile_id
    || binding.project_id !== value.project_id || binding.computer_id !== value.computer_id)
    issue(ctx, ["capabilities"], "Publication must retain the original authorized profile, project and computer");
  if (value.author.candidate.subject_digest !== value.subject_digest || !equal(value.author.candidate, value.reviewer.candidate)
    || value.author.candidate.toolchain_digest !== binding.application_toolchain_digest)
    issue(ctx, ["reviewer"], "Publication requires the exact original candidate, subject and configured toolchain");
  if (value.author.origin_run_id !== value.author.run_id || value.author.origin_request_id !== value.author.request_id
    || value.reviewer.origin_run_id !== value.author.run_id || value.reviewer.origin_request_id !== value.author.request_id)
    issue(ctx, ["reviewer"], "Both verification sources must retain the final author's original run and request");
  for (const field of ["run_id", "request_id", "evidence_id", "agent_id", "agent_instance_id", "test_store_id"] as const)
    if (value.author[field] === value.reviewer[field]) issue(ctx, ["reviewer", field], "Independent review requires a distinct agent, run, request, evidence and test store");
  if (value.acceptance.accepted_review_event_id === value.authorization.event_id)
    issue(ctx, ["acceptance", "accepted_review_event_id"], "The system review decision is separate from the original user's authorization");
});
export type ApplicationPublicationRequestV1 = z.infer<typeof ApplicationPublicationRequestV1Schema>;

/** The executor enforces its original monotonic deadline; these timestamps are its immutable wire projection. */
export const ApplicationPublicationRootLeaseV1Schema = z.object({
  version: z.literal(1), lease_id: id, publication_id: id, request_digest: digest, publisher_session_id: id,
  admitted_at: time, deadline_at: time, root_lifetime_ms: duration,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.deadline_at) - Date.parse(value.admitted_at) !== value.root_lifetime_ms)
    issue(ctx, ["deadline_at"], "The root deadline must retain the original admitted lifetime without renewal");
});
export type ApplicationPublicationRootLeaseV1 = z.infer<typeof ApplicationPublicationRootLeaseV1Schema>;

const origin = z.string().max(64).refine(value => {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  return !!match && Number(match[1]) <= 65_535;
}, "Expected the exact configured loopback origin with an explicit port");
const databaseIdentity = z.object({ device: decimal, inode: decimal }).strict();
// Match the existing application definition's API path contract, including canonical queries.
const apiPath = z.string().min(4).max(1024).refine(value => {
  if (!/^\/api(?:\/|\?|$)/u.test(value) || /[\\#\u0000-\u0020\u007f]/u.test(value)) return false;
  const parsed = new URL(value, "http://127.0.0.1:1234");
  return parsed.origin === "http://127.0.0.1:1234" && parsed.pathname + parsed.search === value;
}, "Expected the captured application definition's bounded same-origin API path");
export const ApplicationPublicationDeploymentV1Schema = z.object({
  version: z.literal(1), deployment_generation: id, store_id: z.string().guid(),
  plan_digest: digest, relocation_proof_digest: digest, reopen_pin_digest: digest,
  database_identity: databaseIdentity, schema_digest: digest, scope_digest: digest,
  data_generation: id, origin, client_entry_digest: digest,
}).strict();
export type ApplicationPublicationDeploymentV1 = z.infer<typeof ApplicationPublicationDeploymentV1Schema>;

export const ApplicationPublicationServiceIdentityV1Schema = z.object({
  publication_id: id, lease_id: id, owner_id: id, generation: z.union([z.literal(1), z.literal(2)]),
  deployment_generation: id, reopen_pin_digest: digest, database_identity: databaseIdentity,
  schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin,
}).strict();
export type ApplicationPublicationServiceIdentityV1 = z.infer<typeof ApplicationPublicationServiceIdentityV1Schema>;

/** Readiness is distinct from full business acceptance; no deployment write or fixture expectation is implied. */
export const ApplicationPublicationHealthV1Schema = z.object({
  version: z.literal(1), scope: z.literal("application-readiness-point-in-time"), service: ApplicationPublicationServiceIdentityV1Schema,
  checked_at: time, broker_preflight: z.object({ existing_database: z.literal(true), process_exit_confirmed: z.literal(true) }).strict(),
  client: z.object({ status_code: z.literal(200), body_digest: digest }).strict(),
  persistence_read: z.object({
    path: apiPath,
    status_code: z.literal(200), body_digest: digest,
  }).strict(),
}).strict();
export type ApplicationPublicationHealthV1 = z.infer<typeof ApplicationPublicationHealthV1Schema>;

/** An original Job observation says live at this instant; it intentionally has no exit-confirmed field. */
export const ApplicationPublicationLiveOwnerV1Schema = z.object({
  service: ApplicationPublicationServiceIdentityV1Schema, counters_observed_at: time, observed_at: time, closed: z.literal(false),
  native: z.object({ root_pid: z.number().int().min(1).max(4_294_967_295), root_creation_time: decimal,
    observed: z.literal(true), job_member: z.literal(true) }).strict(),
  requests_used: count, in_flight: z.number().int().min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.counters_observed_at) > Date.parse(value.observed_at))
    issue(ctx, ["counters_observed_at"], "Service counters must be sampled before the accompanying original native observation");
  if (value.in_flight > value.requests_used) issue(ctx, ["in_flight"], "An active request must have consumed the original owner's request budget");
});
export type ApplicationPublicationLiveOwnerV1 = z.infer<typeof ApplicationPublicationLiveOwnerV1Schema>;

const processClosure = z.object({
  owner_id: id, closed_at: time, process_exit_confirmed: z.literal(true), exit_code: z.number().int().nullable(),
  job_empty: z.literal(true), stdout_eof: z.literal(true), stderr_eof: z.literal(true),
  helper_exit_code: z.number().int().nullable(), helper_closed: z.literal(true),
}).strict();
export const ApplicationPublicationInitializationV1Schema = processClosure.extend({
  exit_code: z.literal(0), helper_exit_code: z.literal(0), broker_invocations: z.literal(1), broker_closed: z.literal(1),
}).strict();
export type ApplicationPublicationInitializationV1 = z.infer<typeof ApplicationPublicationInitializationV1Schema>;

export const ApplicationPublicationNormalClosureV1Schema = processClosure.extend({
  kind: z.literal("normal-drain"), service: ApplicationPublicationServiceIdentityV1Schema,
  reason: z.literal("stdin-drain"), exit_code: z.literal(0), helper_exit_code: z.literal(0),
  input_ack_digest: digest, listener_closed: z.literal(true), audit_complete: z.literal(true), session_released: z.literal(true),
  counters: z.object({ accepted_transports: count, closed_transports: count, runtime_invocations: count,
    runtime_closed: count, broker_invocations: count, broker_closed: count }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.owner_id !== value.service.owner_id) issue(ctx, ["owner_id"], "Drain must close its original service owner");
  const counts = value.counters;
  if (counts.accepted_transports !== counts.closed_transports || counts.runtime_invocations !== counts.runtime_closed
    || counts.broker_invocations !== counts.broker_closed || counts.runtime_invocations !== counts.broker_invocations
    || counts.runtime_invocations > counts.accepted_transports)
    issue(ctx, ["counters"], "Normal drain requires every admitted transport and actual invocation to close");
});
export type ApplicationPublicationNormalClosureV1 = z.infer<typeof ApplicationPublicationNormalClosureV1Schema>;

export const ApplicationPublicationAbortedClosureV1Schema = processClosure.extend({
  kind: z.literal("aborted"), service: ApplicationPublicationServiceIdentityV1Schema,
  reason: z.enum(["cancelled", "deadline", "request-limit", "health-failed", "native-failure", "control-failure"]),
}).strict().superRefine((value, ctx) => {
  if (value.owner_id !== value.service.owner_id) issue(ctx, ["owner_id"], "Abort must settle its original service owner");
});
export type ApplicationPublicationAbortedClosureV1 = z.infer<typeof ApplicationPublicationAbortedClosureV1Schema>;

function inspectLease(request: ApplicationPublicationRequestV1, requestDigest: string, lease: ApplicationPublicationRootLeaseV1,
  ctx: z.RefinementCtx): void {
  if (lease.publication_id !== request.publication_id || lease.request_digest !== requestDigest
    || lease.publisher_session_id !== request.publisher_session_id
    || lease.root_lifetime_ms !== request.capabilities.contract.limits.root_lifetime_ms)
    issue(ctx, ["lease"], "Publication must retain its exact request, original publisher session and configured root lifetime");
}

function inspectDeployment(request: ApplicationPublicationRequestV1, deployment: ApplicationPublicationDeploymentV1, ctx: z.RefinementCtx): void {
  if (deployment.schema_digest !== request.author.candidate.schema_digest)
    issue(ctx, ["deployment", "schema_digest"], "The deployment must retain the exact reviewed candidate schema");
  if ([request.author.test_store_id, request.reviewer.test_store_id].includes(deployment.store_id))
    issue(ctx, ["deployment", "store_id"], "Publication creates its own deployment store and cannot promote a verification store");
}

function inspectService(service: ApplicationPublicationServiceIdentityV1, request: ApplicationPublicationRequestV1,
  lease: ApplicationPublicationRootLeaseV1, deployment: ApplicationPublicationDeploymentV1, ctx: z.RefinementCtx, path: string[]): void {
  if (service.publication_id !== request.publication_id || service.lease_id !== lease.lease_id
    || service.artifact_digest !== request.author.candidate.artifact_digest
    || service.deployment_generation !== deployment.deployment_generation || service.reopen_pin_digest !== deployment.reopen_pin_digest
    || !equal(service.database_identity, deployment.database_identity) || service.schema_digest !== deployment.schema_digest
    || service.scope_digest !== deployment.scope_digest || service.origin !== deployment.origin)
    issue(ctx, path, "Both services must use the exact original deployment, lease, artifact, URL, database, schema and scope");
}

function inspectHealth(health: ApplicationPublicationHealthV1, deployment: ApplicationPublicationDeploymentV1,
  ctx: z.RefinementCtx, path: string[]): void {
  if (health.client.body_digest !== deployment.client_entry_digest)
    issue(ctx, path, "Readiness must measure the exact deployed client entry bytes");
}

const publishedReceipt = z.object({
  version: z.literal(1), scope: z.literal(APPLICATION_PUBLICATION_CLAIM_V1), outcome: z.literal("published"),
  request: ApplicationPublicationRequestV1Schema, request_digest: digest, lease: ApplicationPublicationRootLeaseV1Schema,
  deployment: ApplicationPublicationDeploymentV1Schema, initialization: ApplicationPublicationInitializationV1Schema,
  first_service: z.object({ health: ApplicationPublicationHealthV1Schema, closure: ApplicationPublicationNormalClosureV1Schema }).strict(),
  second_service: z.object({ health: ApplicationPublicationHealthV1Schema, live: ApplicationPublicationLiveOwnerV1Schema }).strict(),
  settled_publication_criteria: z.array(ApplicationPublicationCriterionV1Schema).min(1).max(10_000), recorded_at: time,
}).strict().superRefine((value, ctx) => {
  const { request, lease, deployment, first_service: first, second_service: second } = value;
  inspectLease(request, value.request_digest, lease, ctx); inspectDeployment(request, deployment, ctx);
  for (const [label, service] of [["first_service", first.health.service], ["second_service", second.health.service]] as const) {
    inspectService(service, request, lease, deployment, ctx, [label]);
  }
  inspectHealth(first.health, deployment, ctx, ["first_service", "health"]);
  inspectHealth(second.health, deployment, ctx, ["second_service", "health"]);
  if (first.health.service.generation !== 1 || second.health.service.generation !== 2
    || !equal(first.health.service, first.closure.service) || !equal(second.health.service, second.live.service))
    issue(ctx, ["second_service"], "One initial service must drain normally before the same deployment's second service stays live");
  const owners = [value.initialization.owner_id, first.closure.owner_id, second.live.service.owner_id];
  if (new Set(owners).size !== owners.length) issue(ctx, ["second_service"], "Initialization and both services require distinct original process owners");
  if (first.closure.counters.accepted_transports < 2 || first.closure.counters.runtime_invocations < 1
    || second.live.requests_used < 2 || second.live.requests_used >= 256 || second.live.in_flight !== 0)
    issue(ctx, ["second_service", "live"], "Both health reads must settle and the published second owner must retain usable request capacity");
  if (first.health.persistence_read.path !== second.health.persistence_read.path)
    issue(ctx, ["second_service", "health"], "Reopen readiness must retain the captured definition's read path");
  if (!equal(value.settled_publication_criteria, request.acceptance.publication_criteria))
    issue(ctx, ["settled_publication_criteria"], "Publication can settle only the exact pending bounded-publication criteria");
  const timeline = [lease.admitted_at, value.initialization.closed_at, first.health.checked_at, first.closure.closed_at,
    second.health.checked_at, second.live.observed_at, value.recorded_at].map(Date.parse);
  if (timeline.some((entry, index) => index > 0 && entry < timeline[index - 1]!) || timeline[timeline.length - 1]! >= Date.parse(lease.deadline_at))
    issue(ctx, ["recorded_at"], "Publication must follow actual initialization, drain, reopen and live observation within the original lease");
  if (Date.parse(value.recorded_at) - Date.parse(second.health.checked_at) > request.capabilities.contract.limits.health_freshness_ms)
    issue(ctx, ["second_service", "health"], "Publication requires a fresh second-service readiness observation");
});

const failedReceipt = z.object({
  version: z.literal(1), scope: z.literal(APPLICATION_PUBLICATION_CLAIM_V1), outcome: z.literal("failed"),
  request: ApplicationPublicationRequestV1Schema, request_digest: digest, lease: ApplicationPublicationRootLeaseV1Schema.nullable(),
  deployment: ApplicationPublicationDeploymentV1Schema.nullable(), recorded_at: time,
  failure_stage: z.enum(["admission", "initialization", "first-start", "first-health", "first-drain", "reopen", "second-health", "publication-settlement"]),
  reason: z.string().min(1).max(2000),
  cleanup: z.object({ state: z.enum(["not-started", "closed-confirmed", "unconfirmed"]),
    closed_owners: z.array(processClosure.extend({ generation: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict()).max(3),
    unsettled_owner_ids: z.array(id).max(3) }).strict(),
}).strict().superRefine((value, ctx) => {
  const { cleanup, lease } = value;
  if (lease) inspectLease(value.request, value.request_digest, lease, ctx);
  if (value.deployment) { inspectDeployment(value.request, value.deployment, ctx); if (!lease) issue(ctx, ["lease"], "A deployment requires its original admitted lease"); }
  const closed = cleanup.closed_owners.map(owner => owner.owner_id), all = [...closed, ...cleanup.unsettled_owner_ids];
  if (all.length > 3 || new Set(all).size !== all.length
    || new Set(cleanup.closed_owners.map(owner => owner.generation)).size !== cleanup.closed_owners.length)
    issue(ctx, ["cleanup"], "Each of the initializer and at most two service owners must have one unambiguous settlement");
  if (cleanup.state === "not-started" && (lease !== null || value.deployment !== null || all.length !== 0 || value.failure_stage !== "admission"))
    issue(ctx, ["cleanup"], "Not-started failure cannot claim an admitted lease, deployment or process");
  if (cleanup.state !== "not-started" && !lease) issue(ctx, ["lease"], "Started work must retain its original lease even when closure is unknown");
  if ((cleanup.state === "unconfirmed") !== (cleanup.unsettled_owner_ids.length > 0))
    issue(ctx, ["cleanup"], "An unconfirmed failure must retain its unsettled owners and cannot claim confirmed cleanup");
  if (cleanup.closed_owners.some(owner => Date.parse(owner.closed_at) > Date.parse(value.recorded_at)
    || lease && Date.parse(owner.closed_at) < Date.parse(lease.admitted_at)))
    issue(ctx, ["cleanup", "closed_owners"], "Closure facts must fall between original admission and failure recording");
});

/** Terminal publication history. A later closed/expired observation does not rewrite a published receipt. */
export const ApplicationPublicationReceiptV1Schema = z.discriminatedUnion("outcome", [publishedReceipt, failedReceipt]);
export type ApplicationPublicationReceiptV1 = z.infer<typeof ApplicationPublicationReceiptV1Schema>;

/** Later facts about generation two only. Sequence/session continuity requires trusted server state, not JSON. */
export const ApplicationPublicationObservationV1Schema = z.object({
  version: z.literal(1), event_id: id, sequence: z.number().int().min(1).max(2_147_483_647), generation: z.literal(2),
  request: ApplicationPublicationRequestV1Schema, request_digest: digest, lease: ApplicationPublicationRootLeaseV1Schema,
  deployment: ApplicationPublicationDeploymentV1Schema,
  state: z.enum(["healthy", "live", "draining", "closed-normal", "closed-aborted", "expired", "unknown"]),
  observed_at: time, reason: z.string().min(1).max(2000).nullable(),
  health: ApplicationPublicationHealthV1Schema.nullable(), live: ApplicationPublicationLiveOwnerV1Schema.nullable(),
  closure: z.discriminatedUnion("kind", [ApplicationPublicationNormalClosureV1Schema, ApplicationPublicationAbortedClosureV1Schema]).nullable(),
}).strict().superRefine((value, ctx) => {
  const { request, lease, deployment, health, live, closure, state } = value;
  inspectLease(request, value.request_digest, lease, ctx); inspectDeployment(request, deployment, ctx);
  for (const [field, evidence] of [["health", health], ["live", live], ["closure", closure]] as const) {
    if (!evidence) continue;
    inspectService(evidence.service, request, lease, deployment, ctx, [field]);
    if (evidence.service.generation !== 2) issue(ctx, [field], "Later observations cannot rotate, replace or revert the published second owner");
  }
  if (health) inspectHealth(health, deployment, ctx, ["health"]);
  const observed = Date.parse(value.observed_at), admitted = Date.parse(lease.admitted_at), deadline = Date.parse(lease.deadline_at);
  if (observed < admitted) issue(ctx, ["observed_at"], "A runtime observation cannot predate original admission");
  if (closure?.kind === "normal-drain" && Date.parse(closure.closed_at) >= deadline)
    issue(ctx, ["closure"], "Normal drain must actually close within its original root deadline");
  if (state === "healthy" || state === "live") {
    if (!live || closure || (state === "healthy") !== (health !== null) || observed >= deadline || live.requests_used >= 256)
      issue(ctx, ["state"], "A usable live state requires its original unclosed second owner, remaining lease and request budget");
    if (live && observed - Date.parse(live.observed_at) > request.capabilities.contract.limits.health_freshness_ms)
      issue(ctx, ["live"], "A live state requires a fresh original native observation");
  } else if (state === "draining") {
    if (health || closure || observed >= deadline || !value.reason) issue(ctx, ["state"], "Draining retains an unfinished original owner and its stop reason before the deadline");
  } else {
    if (health || live || !value.reason) issue(ctx, ["state"], "Closed, expired and unknown states cannot assert current healthy/live availability");
    if (state === "closed-normal" && closure?.kind !== "normal-drain" || state === "closed-aborted" && closure?.kind !== "aborted"
      || state === "unknown" && closure || state === "expired" && observed < deadline)
      issue(ctx, ["closure"], "Runtime state must match its actual normal, aborted, expired or unknown settlement");
  }
  if (health && live && !equal(health.service, live.service)) issue(ctx, ["health"], "Health and liveness must observe the same original service owner");
  if (health && (observed - Date.parse(health.checked_at) > request.capabilities.contract.limits.health_freshness_ms
    || live && Date.parse(health.checked_at) > Date.parse(live.observed_at)))
    issue(ctx, ["health"], "Readiness must be fresh and precede the accompanying native liveness observation");
  for (const [field, timestamp] of [["health", health?.checked_at], ["live", live?.observed_at], ["closure", closure?.closed_at]] as const)
    if (timestamp && (Date.parse(timestamp) < admitted || Date.parse(timestamp) > observed))
      issue(ctx, [field], "Evidence must fall between original admission and this observation");
});
export type ApplicationPublicationObservationV1 = z.infer<typeof ApplicationPublicationObservationV1Schema>;

// Canonicalization is shared JSON machinery only; no static publication contract or authority is reused.
export function canonicalApplicationPublicationContract(value: ApplicationPublicationCapabilityContractV1): string {
  return canonicalReleaseJson(ApplicationPublicationCapabilityContractV1Schema.parse(value));
}
export function canonicalApplicationPublicationRequest(value: ApplicationPublicationRequestV1): string {
  return canonicalReleaseJson(ApplicationPublicationRequestV1Schema.parse(value));
}
export function applicationPublicationRequestsEqual(left: ApplicationPublicationRequestV1, right: ApplicationPublicationRequestV1): boolean {
  return canonicalApplicationPublicationRequest(left) === canonicalApplicationPublicationRequest(right);
}
