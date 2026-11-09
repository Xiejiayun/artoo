import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ApplicationPublicationContextV1Schema, ApplicationPublicationRequestV1Schema,
  ApplicationPublicationVerificationAckV1Schema, ApplicationPublicationVerificationBindingV1Schema, canonicalReleaseJson, canonicalApplicationPublicationRequest,
  type ApplicationPublicationRequestV1, type ApplicationPublicationVerificationAckV1, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import type { AgentInstanceHandle } from "@artoo/protocol";
import { readFinalApplicationVerificationBinding, type PreparedVerificationProfile } from "./verification.js";
import { assertWindowsVerifiedExecutionExportBinding, type WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import { readApplicationPublicationProfile, type PreparedApplicationPublicationProfile } from "./application-publication-profile.js";
import type { PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import type { ApplicationVerificationDefinition } from "./application-verification-definition.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

export interface ApplicationPublicationSession { readonly id: string; readonly identity: object }
export interface ApplicationPublicationExecutionFacts {
  readonly candidate: PreparedApplicationVerificationCandidate;
  readonly publicationProfile: PreparedApplicationPublicationProfile;
  readonly applicationProfile: PreparedApplicationVerificationProfile;
  readonly backend: PreparedWindowsProcessBackend;
  readonly definition: ApplicationVerificationDefinition;
  readonly request: ApplicationPublicationRequestV1;
  readonly requestDigest: string;
}
declare const permitBrand: unique symbol;
export interface PreparedApplicationPublicationPermit { readonly [permitBrand]: true }
declare const executionBrand: unique symbol;
export interface PreparedApplicationPublicationExecution { readonly [executionBrand]: true }
interface Permit { facts: Readonly<ApplicationPublicationExecutionFacts>; current(): void; consumed: boolean }
const permits = new WeakMap<object, Permit>(), executions = new WeakMap<object, Permit>();
const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const snapshot = (value: unknown): string => canonicalReleaseJson(value);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function fail(reason: string): never { throw Error(`Application publication acceptance: ${reason}`); }

export function readApplicationPublicationPermit(permit: PreparedApplicationPublicationPermit): Readonly<ApplicationPublicationExecutionFacts> {
  const saved = permits.get(permit); if (!saved) fail("original local publication permit required");
  saved.current(); return saved.facts;
}
/** One original permit can enter one executor only. JSON and restart have no map entry. */
export function consumeApplicationPublicationPermit(permit: PreparedApplicationPublicationPermit): PreparedApplicationPublicationExecution {
  const saved = permits.get(permit); if (!saved || saved.consumed) fail("unused original publication permit required");
  saved.current(); saved.consumed = true;
  const execution = Object.freeze({}) as PreparedApplicationPublicationExecution; executions.set(execution, saved); return execution;
}
/** New execution work requires current authority. Already-created owners must
 * retain their own stop/closure paths when this read later rejects. */
export function readApplicationPublicationExecution(execution: PreparedApplicationPublicationExecution): Readonly<ApplicationPublicationExecutionFacts> {
  const saved = executions.get(execution); if (!saved?.consumed) fail("original consumed publication execution required");
  saved.current(); return saved.facts;
}

interface OriginalRun {
  runStart: RunStartPayload; runSnapshot: string; profile: PreparedVerificationProfile;
  publicationProfile: PreparedApplicationPublicationProfile; session: ApplicationPublicationSession;
  intent: ReturnType<typeof ApplicationPublicationContextV1Schema.parse>;
  pending?: { evidence: RunVerificationPayload; sequence: number; digest: string;
    admission: WindowsVerifiedExecutionAdmission; handle: AgentInstanceHandle; receipt?: ApplicationPublicationVerificationAckV1 };
  completed: boolean;
}

/** This controller accepts only local original objects at the run boundary.
 * Neither a committed evidence ACK nor a server publication request is sufficient
 * without actual final verification, completed lifecycle and native writer closure. */
export function createApplicationPublicationAcceptanceRegistry(options: {
  nodeId: string; profiles: readonly PreparedApplicationPublicationProfile[];
  getSession(): ApplicationPublicationSession | undefined;
}) {
  const profiles = [...options.profiles], runs = new Map<string, OriginalRun>();
  const issued = new Map<string, { digest: string; permit: PreparedApplicationPublicationPermit }>();
  const retired = new WeakSet<object>(); let epoch: ApplicationPublicationSession | undefined, stopped = false;
  if (!profiles.length || profiles.length > 64 || new Set(profiles).size !== profiles.length) fail("bounded original publication profiles required");
  const profileIds = new Map<string, PreparedApplicationPublicationProfile>();
  for (const profile of profiles) {
    const saved = readApplicationPublicationProfile(profile);
    if (saved.config.computer_id !== options.nodeId || profileIds.has(saved.config.id)) fail("publication profile node or identity differs");
    profileIds.set(saved.config.id, profile);
  }
  function current(): ApplicationPublicationSession {
    const next = options.getSession();
    if (stopped || !next || !next.id || typeof next.identity !== "object" || next.identity === null) {
      if (epoch) retired.add(epoch.identity); epoch = undefined; runs.clear(); issued.clear(); fail("original authenticated publication session unavailable");
    }
    if (epoch && (epoch.id !== next.id || epoch.identity !== next.identity)) { retired.add(epoch.identity); runs.clear(); issued.clear(); epoch = undefined; }
    if (retired.has(next.identity)) fail("retired publication session cannot resume");
    epoch ??= Object.freeze({ id: next.id, identity: next.identity }); return epoch;
  }
  function assertSession(session: ApplicationPublicationSession): void {
    const now = current(); if (now.id !== session.id || now.identity !== session.identity) fail("original publication session changed");
  }
  function original(run: OriginalRun) {
    assertSession(run.session);
    if (runs.get(run.runStart.run_id) !== run || snapshot(run.runStart) !== run.runSnapshot) fail("original publication run changed");
    const selected = readApplicationPublicationProfile(run.publicationProfile);
    if (selected.verifier !== run.profile || !isDeepStrictEqual(selected.capabilities, run.intent.capabilities)) fail("original publication profile changed");
    return selected;
  }
  function measurement(run: OriginalRun) {
    const selected = original(run), pending = run.pending;
    if (!pending || sha(snapshot(pending.evidence)) !== pending.digest) fail("original final verification frame required");
    assertWindowsVerifiedExecutionExportBinding(pending.admission, pending.handle, run.profile, run.runStart);
    const measured = readFinalApplicationVerificationBinding(run.profile, pending.evidence, { nodeId: options.nodeId, runStart: run.runStart });
    if (measured.profile !== selected.application || measured.backend !== selected.backend || !pending.evidence.application?.publication) {
      fail("original publication measurement and backend required");
    }
    assertSession(run.session); return measured;
  }
  function validate(request: ApplicationPublicationRequestV1): Readonly<ApplicationPublicationExecutionFacts> {
    const session = current();
    if (request.computer_id !== options.nodeId || request.publisher_session_id !== session.id) fail("request differs from current paired session");
    const author = runs.get(request.author.run_id), reviewer = runs.get(request.reviewer.run_id);
    if (!author?.completed || !reviewer?.completed || !author.pending?.receipt || !reviewer.pending?.receipt) fail("actual completed author and reviewer with committed verification receipts required");
    const a = measurement(author), b = measurement(reviewer);
    if (author.publicationProfile !== reviewer.publicationProfile || a.candidate !== b.candidate || a.profile !== b.profile || a.backend !== b.backend
      || !isDeepStrictEqual(a.definition, b.definition)) fail("independent review did not use the original final candidate");
    for (const [run, projection] of [[author, request.author], [reviewer, request.reviewer]] as const) {
      const observed = run.pending!.evidence.application!, receipt = run.pending!.receipt!, context = run.runStart.context_pack.payload!;
      const plan = context.goal_context?.plan;
      if (observed.stage !== "validation" || !isDeepStrictEqual(projection, { run_id: observed.run_id, request_id: observed.request_id,
        evidence_id: receipt.evidence_id, agent_id: run.intent.agent_id, agent_instance_id: run.runStart.agent_instance_id,
        stage: observed.stage, origin_run_id: observed.origin_run_id, origin_request_id: observed.origin_request_id,
        test_store_id: observed.acceptance.test_store_id, candidate: observed.candidate })
        || context.goal_context?.goal_id !== request.goal_id || context.project.id !== request.project_id
        || plan?.id !== request.acceptance.plan.id || plan.version !== request.acceptance.plan.version
        || !isDeepStrictEqual(run.intent.authorization, request.authorization) || !isDeepStrictEqual(run.intent.capabilities, request.capabilities)) {
        fail("request differs from original run, grant, plan, candidate or committed evidence");
      }
      const measured = observed.publication!;
      if (measured.authorization_event_id !== request.authorization.event_id
        || measured.publication_contract_digest !== request.capabilities.binding.publication_contract_digest
        || measured.application_definition_digest !== request.application_definition_digest
        || measured.research_digest !== request.acceptance.research_digest || measured.design_digest !== request.acceptance.design_digest
        || measured.measurement_plan_digest !== request.acceptance.measurement_plan_digest
        || !isDeepStrictEqual(measured.development_criteria, request.acceptance.development_criteria)
        || !isDeepStrictEqual(measured.publication_criteria, request.acceptance.publication_criteria)
        || !isDeepStrictEqual(measured.unmet_criteria, request.acceptance.unmet_criteria)) fail("accepted criterion coverage differs from actual original measurements");
    }
    const source = author.runStart.context_pack.payload!, review = reviewer.runStart.context_pack.payload!.review_subject;
    if (source.review_subject || !review || review.run_id !== author.runStart.run_id || review.evidence_id !== author.pending.receipt.evidence_id
      || review.subject_digest !== request.subject_digest || !isDeepStrictEqual(review.verification?.application, author.pending.evidence.application)
      || author.runStart.agent_instance_id === reviewer.runStart.agent_instance_id || author.intent.agent_id === reviewer.intent.agent_id
      || author.pending.evidence.application!.acceptance.test_store_id === reviewer.pending.evidence.application!.acceptance.test_store_id) {
      fail("original independent review lineage differs");
    }
    assertSession(author.session);
    return Object.freeze({ candidate: a.candidate, publicationProfile: author.publicationProfile, applicationProfile: a.profile,
      backend: a.backend, definition: a.definition, request, requestDigest: sha(canonicalApplicationPublicationRequest(request)) });
  }
  return {
    admitRun(profile: PreparedVerificationProfile, runStart: RunStartPayload): void {
      const session = current(), context = runStart.context_pack.payload;
      if (!context?.app_publication || context.app_delivery) fail("a separate original publication grant is required");
      const intent = freeze(ApplicationPublicationContextV1Schema.parse(context.application_publication));
      const binding = intent.capabilities.binding, verification = runStart.verification;
      if (intent.publisher_session_id !== session.id || intent.agent_instance_id !== runStart.agent_instance_id
        || !isDeepStrictEqual(context.app_publication, intent.authorization.grant) || binding.computer_id !== options.nodeId
        || binding.project_id !== profile.project_id || binding.verification_profile_id !== profile.id || binding.verification_profile_digest !== profile.digest
        || context.project.id !== profile.project_id || runStart.workspace.root !== profile.workspace_root || context.workspace.root !== profile.workspace_root
        || verification?.profile_id !== profile.id || verification.application?.config_digest !== binding.application_config_digest
        || verification.application.contract_digest !== binding.application_contract_digest
        || !isDeepStrictEqual(ApplicationPublicationVerificationBindingV1Schema.parse(verification.application_publication), {
          version: 1, authorization_event_id: intent.authorization.event_id, publication_profile_id: binding.publication_profile_id,
          publication_profile_digest: binding.publication_profile_digest, publication_contract_digest: binding.publication_contract_digest,
          publisher_session_id: intent.publisher_session_id })) fail("original publication intent and session differ");
      // Route using immutable preparation metadata; audit only the exact selected
      // original. An unrelated live publication must never be audited by a scan.
      const publicationProfile = profileIds.get(binding.publication_profile_id);
      if (!publicationProfile) fail("original configured publication profile required");
      const selected = readApplicationPublicationProfile(publicationProfile);
      if (selected.verifier !== profile || !isDeepStrictEqual(selected.capabilities, intent.capabilities)) fail("original configured publication profile differs");
      const previous = runs.get(runStart.run_id);
      if (previous) { if (previous.runStart !== runStart || previous.runSnapshot !== snapshot(runStart)) fail("run identity already reserved"); original(previous); return; }
      if (runs.size >= 256) fail("original publication completion registry limit exceeded");
      runs.set(runStart.run_id, { runStart, runSnapshot: snapshot(runStart), profile, publicationProfile, session, intent, completed: false });
    },
    expectVerificationReceipt(input: { runStart: RunStartPayload; evidence: RunVerificationPayload; sequence: number;
      admission: WindowsVerifiedExecutionAdmission; handle: AgentInstanceHandle }): void {
      const run = runs.get(input.runStart.run_id);
      if (!run || run.runStart !== input.runStart || run.pending || run.completed || !Number.isSafeInteger(input.sequence) || input.sequence < 0) fail("original unused pending verification frame required");
      run.pending = { evidence: input.evidence, sequence: input.sequence, digest: sha(snapshot(input.evidence)), admission: input.admission, handle: input.handle };
      try { measurement(run); } catch (error) { run.pending = undefined; throw error; }
    },
    acknowledgeVerification(runId: string, sequence: number, input: ApplicationPublicationVerificationAckV1): void {
      const receipt = freeze(ApplicationPublicationVerificationAckV1Schema.parse(input)), run = runs.get(runId);
      if (!run?.pending || sequence !== run.pending.sequence || receipt.publisher_session_id !== run.session.id
        || receipt.request_id !== run.pending.evidence.request_id || receipt.payload_digest !== run.pending.digest) fail("committed receipt differs from original pending verification frame");
      original(run);
      if (run.pending.receipt && !isDeepStrictEqual(run.pending.receipt, receipt)) fail("committed verification receipt is immutable");
      run.pending.receipt = receipt;
    },
    recordCompleted(runStart: RunStartPayload): void {
      const run = runs.get(runStart.run_id);
      if (!run || run.runStart !== runStart || run.completed || !run.pending?.receipt) fail("original completed lifecycle and committed verification required");
      measurement(run); run.completed = true;
    },
    prepare(input: ApplicationPublicationRequestV1): PreparedApplicationPublicationPermit {
      const request = freeze(ApplicationPublicationRequestV1Schema.parse(input)), prior = issued.get(request.publication_id);
      if (!prior && issued.size >= 64) fail("original publication permit registry limit exceeded");
      const facts = validate(request);
      if (prior) { if (prior.digest !== facts.requestDigest) fail("publication ID already has another immutable request"); readApplicationPublicationPermit(prior.permit); return prior.permit; }
      const permit = Object.freeze({}) as PreparedApplicationPublicationPermit;
      const saved: Permit = { facts, consumed: false, current() { const now = validate(request);
        if (now.candidate !== facts.candidate || now.publicationProfile !== facts.publicationProfile || now.requestDigest !== facts.requestDigest) fail("original permit lineage changed"); } };
      permits.set(permit, saved); issued.set(request.publication_id, { digest: facts.requestDigest, permit }); return permit;
    },
    discardRun(runId: string): void { const run = runs.get(runId); if (run && !run.completed) runs.delete(runId); },
    invalidate(): void { stopped = true; if (epoch) retired.add(epoch.identity); epoch = undefined; runs.clear(); issued.clear(); },
  };
}
