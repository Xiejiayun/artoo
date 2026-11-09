// Controlled original-object boundaries. These tests run no native writer,
// browser, provider or publisher and do not qualify a Windows installation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalReleaseJson, type ApplicationPublicationVerificationAckV1, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import type { AgentInstanceHandle } from "@artoo/protocol";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedApplicationPublicationProfile } from "./application-publication-profile.js";
import type { PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import type { ApplicationVerificationDefinition } from "./application-verification-definition.js";
import { applicationPublicationRequestFixture, applicationPublicationRunFixture, applicationPublicationVerificationFixture,
  applicationPublicationFixtureSha as sha } from "./test-fixtures/application-publication-request.js";

const controlled = vi.hoisted(() => ({ profile: vi.fn(), native: vi.fn(), final: vi.fn() }));
vi.mock("./application-publication-profile.js", () => ({ readApplicationPublicationProfile: controlled.profile }));
vi.mock("./process-adapter.js", () => ({ assertWindowsVerifiedExecutionExportBinding: controlled.native }));
vi.mock("./verification.js", () => ({ readFinalApplicationVerificationBinding: controlled.final }));
import { createApplicationPublicationAcceptanceRegistry, consumeApplicationPublicationPermit, readApplicationPublicationExecution,
  readApplicationPublicationPermit, type ApplicationPublicationSession, type PreparedApplicationPublicationPermit,
  type PreparedApplicationPublicationExecution } from "./application-publication-acceptance.js";

beforeEach(() => vi.resetAllMocks());
function fixture() {
  const request = applicationPublicationRequestFixture();
  const publicationProfile = Object.freeze({}) as PreparedApplicationPublicationProfile;
  const applicationProfile = Object.freeze({}) as PreparedApplicationVerificationProfile;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend, candidate = Object.freeze({}) as PreparedApplicationVerificationCandidate;
  const definition = Object.freeze({ schemaDigest: request.author.candidate.schema_digest }) as ApplicationVerificationDefinition;
  const profile: PreparedVerificationProfile = { id: "verifier", project_id: "project", workspace_root: "C:\\work", digest: request.capabilities.binding.verification_profile_digest,
    commands: [], required_files: [], subject_paths: [], trustedFiles: [] };
  const configured = { config: { id: "publication", computer_id: "node" }, verifier: profile, application: applicationProfile, backend, capabilities: request.capabilities };
  controlled.profile.mockImplementation(token => { if (token !== publicationProfile) throw Error("Original controlled profile required"); return configured; });
  let session: ApplicationPublicationSession | undefined = { id: "session", identity: Object.freeze({}) };
  const originalSession = session;
  const options = { nodeId: "node", profiles: [publicationProfile], getSession: () => session };
  const registry = createApplicationPublicationAcceptanceRegistry(options);
  type Bound = { run: RunStartPayload; evidence: RunVerificationPayload; admission: WindowsVerifiedExecutionAdmission; handle: AgentInstanceHandle;
    sequence: number; nativeClosed: boolean; snapshot: string;
    measured: { profile: PreparedApplicationVerificationProfile; backend: PreparedWindowsProcessBackend; candidate: PreparedApplicationVerificationCandidate;
      definition: ApplicationVerificationDefinition } };
  const sources = new Map<string, Bound>();
  for (const who of ["author", "reviewer"] as const) {
    const run = applicationPublicationRunFixture(request, who), evidence = applicationPublicationVerificationFixture(request, who);
    sources.set(who, { run, evidence, admission: Object.freeze({}) as WindowsVerifiedExecutionAdmission, handle: Object.freeze({ runId: run.run_id }),
      sequence: who === "author" ? 9 : 14, nativeClosed: true, snapshot: canonicalReleaseJson(evidence),
      measured: { profile: applicationProfile, backend, candidate, definition } });
  }
  controlled.native.mockImplementation((admission, handle, selected, run) => {
    const bound = sources.get(run.run_id);
    if (!bound || bound.admission !== admission || bound.handle !== handle || selected !== profile || bound.run !== run || !bound.nativeClosed)
      throw Error("Original native writer closure required");
  });
  controlled.final.mockImplementation((selected, evidence, original) => {
    const bound = sources.get(original.runStart.run_id);
    if (!bound || selected !== profile || original.nodeId !== "node" || bound.run !== original.runStart || bound.evidence !== evidence
      || bound.snapshot !== canonicalReleaseJson(evidence)) throw Error("Original final verification and unchanged source required");
    return bound.measured;
  });
  const author = sources.get("author")!, reviewer = sources.get("reviewer")!;
  const receipt = (source: Bound): ApplicationPublicationVerificationAckV1 => ({ version: 1, request_id: source.evidence.request_id,
    evidence_id: request[source === author ? "author" : "reviewer"].evidence_id, event_id: source.run.run_id + "-verification-event",
    payload_digest: sha(canonicalReleaseJson(source.evidence)), publisher_session_id: "session" });
  const enroll = (source: Bound) => { registry.admitRun(profile, source.run); registry.expectVerificationReceipt({ runStart: source.run, evidence: source.evidence,
    sequence: source.sequence, admission: source.admission, handle: source.handle }); };
  const acknowledge = (source: Bound) => registry.acknowledgeVerification(source.run.run_id, source.sequence, receipt(source));
  const complete = (source: Bound) => { enroll(source); acknowledge(source); registry.recordCompleted(source.run); };
  const ready = () => { complete(author); complete(reviewer); return registry.prepare(request); };
  return { request, registry, options, profile, publicationProfile, applicationProfile, backend, candidate, definition, configured,
    author, reviewer, receipt, enroll, acknowledge, complete, ready, originalSession,
    session: (value: ApplicationPublicationSession | undefined) => { session = value; } };
}

describe("original local application publication acceptance", () => {
  it("routes the selected profile without auditing an unrelated live profile", () => {
    const f = fixture(), other = Object.freeze({}) as PreparedApplicationPublicationProfile;
    controlled.profile.mockImplementation(token => token === other
      ? { ...f.configured, config: { ...f.configured.config, id: "other-publication" } } : f.configured);
    const registry = createApplicationPublicationAcceptanceRegistry({ ...f.options, profiles: [other, f.publicationProfile] });
    controlled.profile.mockImplementation(token => { if (token === other) throw Error("Unrelated owner is writing"); return f.configured; });
    expect(() => registry.admitRun(f.profile, f.author.run)).not.toThrow();
  });
  it("needs both committed final frames and actual completed lifecycles", () => {
    const f = fixture(); f.enroll(f.author); f.enroll(f.reviewer);
    expect(() => f.registry.prepare(f.request)).toThrow(/actual completed/);
    expect(() => f.registry.recordCompleted(f.author.run)).toThrow(/committed verification/);
    f.acknowledge(f.author); f.acknowledge(f.reviewer);
    expect(() => f.registry.prepare(f.request)).toThrow(/actual completed/);
    f.registry.recordCompleted(f.author.run);
    expect(() => f.registry.prepare(f.request)).toThrow(/actual completed/);
    f.registry.recordCompleted(f.reviewer.run);
    expect(readApplicationPublicationPermit(f.registry.prepare(f.request)).candidate).toBe(f.candidate);
  });
  it("retains one frozen facts snapshot and consumes its original permit once", () => {
    const f = fixture(), permit = f.ready(), facts = readApplicationPublicationPermit(permit);
    expect(f.registry.prepare(structuredClone(f.request))).toBe(permit);
    expect(facts).toMatchObject({ candidate: f.candidate, publicationProfile: f.publicationProfile, applicationProfile: f.applicationProfile, backend: f.backend });
    expect(facts.definition).toBe(f.definition); expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.request.acceptance.development_criteria)).toBe(true);
    const execution = consumeApplicationPublicationPermit(permit);
    expect(readApplicationPublicationExecution(execution)).toBe(facts);
    expect(() => consumeApplicationPublicationPermit(permit)).toThrow(/unused original/);
    expect(() => readApplicationPublicationPermit({ ...permit } as PreparedApplicationPublicationPermit)).toThrow(/original local/);
    expect(() => consumeApplicationPublicationPermit(JSON.parse(JSON.stringify(permit)) as PreparedApplicationPublicationPermit)).toThrow(/unused original/);
    expect(() => readApplicationPublicationExecution({ ...execution } as PreparedApplicationPublicationExecution)).toThrow(/original consumed/);
  });
  it.each(["run", "sequence", "request", "digest", "session"])("rejects a receipt for a different %s", changed => {
    const f = fixture(); f.enroll(f.author); const ack = f.receipt(f.author);
    if (changed === "request") ack.request_id = "other";
    if (changed === "digest") ack.payload_digest = sha("wrong frame");
    if (changed === "session") ack.publisher_session_id = "other";
    expect(() => f.registry.acknowledgeVerification(changed === "run" ? "other" : "author", changed === "sequence" ? 10 : 9, ack)).toThrow(/original pending/);
    expect(() => f.registry.recordCompleted(f.author.run)).toThrow(/committed verification/);
  });
  it("binds immutable committed IDs and does not retain the caller's mutable ACK", () => {
    const f = fixture(); f.enroll(f.author); const ack = f.receipt(f.author);
    f.registry.acknowledgeVerification("author", 9, ack); ack.evidence_id = "caller-mutated";
    f.acknowledge(f.author);
    expect(() => f.registry.acknowledgeVerification("author", 9, ack)).toThrow(/immutable/);
    f.registry.recordCompleted(f.author.run); f.complete(f.reviewer);
    expect(() => f.registry.prepare(f.request)).not.toThrow();
  });
  it("rejects cloned runs, evidence and native handles at the original object boundaries", () => {
    const f = fixture(); f.registry.admitRun(f.profile, f.author.run);
    expect(() => f.registry.admitRun(f.profile, structuredClone(f.author.run))).toThrow(/identity already reserved/);
    const input = { runStart: f.author.run, evidence: f.author.evidence, sequence: 9, admission: f.author.admission, handle: f.author.handle };
    expect(() => f.registry.expectVerificationReceipt({ ...input, runStart: structuredClone(f.author.run) })).toThrow(/original unused/);
    expect(() => f.registry.expectVerificationReceipt({ ...input, evidence: structuredClone(f.author.evidence) })).toThrow(/Original final/);
    expect(() => f.registry.expectVerificationReceipt({ ...input, handle: { ...f.author.handle } })).toThrow(/Original native/);
    f.registry.expectVerificationReceipt(input); f.acknowledge(f.author);
    expect(() => f.registry.recordCompleted(structuredClone(f.author.run))).toThrow(/original completed/);
  });
  it.each(["run", "evidence", "native", "profile", "source"])("rechecks %s on every later permit and execution read", changed => {
    const f = fixture(), permit = f.ready(), execution = consumeApplicationPublicationPermit(permit);
    if (changed === "run") f.author.run.task_id = "changed";
    if (changed === "evidence") f.author.evidence.reason = "changed";
    if (changed === "native") f.author.nativeClosed = false;
    if (changed === "profile") controlled.profile.mockImplementation(() => { throw Error("Original profile audit failed"); });
    if (changed === "source") controlled.final.mockImplementation(() => { throw Error("Original source audit failed"); });
    expect(() => readApplicationPublicationPermit(permit)).toThrow();
    expect(() => readApplicationPublicationExecution(execution)).toThrow();
  });
  it.each(["candidate", "definition", "backend"])("requires the reviewer's same original %s", changed => {
    const f = fixture(); f.complete(f.author); f.complete(f.reviewer);
    if (changed === "candidate") f.reviewer.measured.candidate = Object.freeze({}) as PreparedApplicationVerificationCandidate;
    if (changed === "definition") f.reviewer.measured.definition = { ...f.definition, schemaDigest: sha("different definition") };
    if (changed === "backend") f.reviewer.measured.backend = Object.freeze({}) as PreparedWindowsProcessBackend;
    expect(() => f.registry.prepare(f.request)).toThrow();
  });
  it.each(["review-subject", "agent", "instance", "test-store"])("cannot replace independent %s lineage with request assertions", changed => {
    const f = fixture();
    if (changed === "review-subject") f.reviewer.run.context_pack.payload!.review_subject!.evidence_id = "another-evidence";
    if (changed === "agent") f.reviewer.run.context_pack.payload!.application_publication!.agent_id = f.request.author.agent_id;
    if (changed === "instance") { f.reviewer.run.agent_instance_id = f.request.author.agent_instance_id;
      f.reviewer.run.context_pack.payload!.application_publication!.agent_instance_id = f.request.author.agent_instance_id; }
    if (changed === "test-store") { f.reviewer.evidence.application!.acceptance.test_store_id = f.request.author.test_store_id;
      f.reviewer.snapshot = canonicalReleaseJson(f.reviewer.evidence); }
    f.complete(f.author); f.complete(f.reviewer);
    expect(() => f.registry.prepare(f.request)).toThrow(/original|independent/);
  });
  it.each(["research_digest", "design_digest", "measurement_plan_digest", "development_criteria", "publication_criteria"] as const)
    ("binds accepted %s to original actual measurements", field => {
      const f = fixture(); f.ready(); const request = structuredClone(f.request);
      if (field === "development_criteria" || field === "publication_criteria") request.acceptance[field][0]!.criterion_digest = sha("other criterion");
      else request.acceptance[field] = sha("other accepted input");
      expect(() => f.registry.prepare(request)).toThrow(/coverage differs/);
    });
  it("prevents an existing publication ID from changing its accepted review decision", () => {
    const f = fixture(); f.ready();
    expect(() => f.registry.prepare({ ...f.request, acceptance: { ...f.request.acceptance, accepted_review_event_id: "other-review" } })).toThrow(/another immutable request/);
  });
  it("bounds unused permits even when an executor repeatedly rejects a busy profile", () => {
    const f = fixture(), original = f.ready();
    for (let index = 1; index < 64; index++) f.registry.prepare({ ...f.request, publication_id: `other-${index}` });
    expect(() => f.registry.prepare({ ...f.request, publication_id: "one-too-many" })).toThrow(/permit registry limit/);
    expect(f.registry.prepare(f.request)).toBe(original);
  });
  it.each(["missing", "new-id", "new-identity"])("retires the original session after %s and cannot restore it", changed => {
    const f = fixture(), permit = f.ready(), execution = consumeApplicationPublicationPermit(permit);
    f.session(changed === "missing" ? undefined : { id: changed === "new-id" ? "new-session" : "session", identity: changed === "new-identity" ? {} : f.originalSession.identity });
    expect(() => readApplicationPublicationPermit(permit)).toThrow(); f.session(f.originalSession);
    expect(() => readApplicationPublicationExecution(execution)).toThrow(/retired|unavailable/);
    expect(() => f.registry.admitRun(f.profile, f.author.run)).toThrow(/retired|unavailable/);
  });
  it("does not recover completion from equal requests, a new registry or explicit invalidation", () => {
    const f = fixture(), permit = f.ready();
    expect(() => createApplicationPublicationAcceptanceRegistry(f.options).prepare(f.request)).toThrow(/actual completed/);
    f.registry.invalidate(); expect(() => readApplicationPublicationPermit(permit)).toThrow(/unavailable/);
  });
  it("discards incomplete runs and never lets cleanup erase an accepted original completion", () => {
    const f = fixture(); f.enroll(f.author); f.registry.discardRun("author");
    expect(() => f.acknowledge(f.author)).toThrow(/original pending/);
    f.complete(f.author); f.complete(f.reviewer); f.registry.discardRun("author");
    expect(() => f.registry.prepare(f.request)).not.toThrow();
  });
  it("requires explicit original publication intent and exact configured bindings at admission", () => {
    const f = fixture(); const original = f.author.run;
    for (const change of ["legacy", "both", "binding", "session", "profile"] as const) {
      const run = structuredClone(original);
      if (change === "legacy" || change === "both") run.context_pack.payload!.app_delivery = { version: 1, kind: "local-application-development" };
      if (change === "legacy") delete run.context_pack.payload!.app_publication;
      if (change === "binding") run.verification!.application_publication!.authorization_event_id = "other";
      if (change === "session") run.context_pack.payload!.application_publication!.publisher_session_id = "other";
      if (change === "profile") run.verification!.profile_id = "other";
      expect(() => f.registry.admitRun(f.profile, run)).toThrow();
    }
  });
});
