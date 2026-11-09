// Controlled NodeClient wiring with real message codecs and a temporary empty
// workspace. Native ownership, final verification and publication are stand-ins.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalReleaseJson, type RunStartPayload } from "@artoo/domain";
import type { NodeToServerMessage, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { createNodeClient } from "./node-client.js";
import * as verification from "./verification.js";
import * as execution from "./process-adapter.js";
import * as sourceRuntime from "./product-source-runtime.js";
import * as productRelease from "./product-release.js";
import * as acceptance from "./application-publication-acceptance.js";
import * as executor from "./application-publication-executor.js";
import * as publicationProfiles from "./application-publication-profile.js";
import { registerApplicationPublicationResources, claimApplicationPublicationResources,
  releaseApplicationPublicationResources } from "./application-publication-coordination.js";
import { applicationPublicationRequestFixture, applicationPublicationRunFixture, applicationPublicationVerificationFixture,
  applicationPublicationFixtureSha as sha } from "./test-fixtures/application-publication-request.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform);
  const parent = `${realpathSync.native(tmpdir())}${sep}artoo-publication-node-`;
  for (const root of roots.splice(0)) { if (!root.startsWith(parent)) throw Error("Unexpected node publication fixture path"); rmSync(root, { recursive: true, force: true }); }
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(options: { phase?: "completed" | "failed" | "cancelled"; deliveryFailure?: boolean; verificationFailure?: boolean; pauseCompletion?: boolean } = {}) {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-publication-node-"))); roots.push(workspace);
  const request = applicationPublicationRequestFixture(), start = applicationPublicationRunFixture(request, "author", workspace);
  const evidence = applicationPublicationVerificationFixture(request, "author"), pendingCompletion = deferred(), completedDelivery = deferred();
  if (!options.pauseCompletion) pendingCompletion.resolve();
  const events: string[] = [], messages: NodeToServerMessage[] = [];
  const profile: verification.PreparedVerificationProfile = { id: "verifier", project_id: "project", workspace_root: workspace, digest: evidence.profile_digest,
    commands: [], required_files: [], subject_paths: [], trustedFiles: [] };
  const publicationProfile = Object.freeze({}) as publicationProfiles.PreparedApplicationPublicationProfile;
  registerApplicationPublicationResources(publicationProfile, { id: request.capabilities.binding.publication_profile_id,
    workspace, verifier: profile, directories: [] });
  const registry = { admitRun: vi.fn(), expectVerificationReceipt: vi.fn(() => { events.push("pending-verification"); }),
    acknowledgeVerification: vi.fn(() => { events.push("committed-verification"); }),
    recordCompleted: vi.fn(() => { events.push("record-completed"); }), discardRun: vi.fn(), invalidate: vi.fn(), prepare: vi.fn() };
  const publisher = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), status: vi.fn(async () => {}), invalidate: vi.fn(), shutdown: vi.fn(async () => {}) };
  vi.spyOn(acceptance, "createApplicationPublicationAcceptanceRegistry").mockReturnValue(registry);
  const createPublisher = vi.spyOn(executor, "createApplicationPublicationExecutor").mockReturnValue(publisher);
  vi.spyOn(publicationProfiles, "readApplicationPublicationProfile").mockReturnValue({ verifier: profile } as ReturnType<typeof publicationProfiles.readApplicationPublicationProfile>);
  vi.spyOn(verification, "prepareVerificationProfiles").mockReturnValue([profile]);
  vi.spyOn(verification, "readPreparedApplicationVerificationProfile").mockReturnValue(undefined);
  vi.spyOn(verification, "selectVerificationProfile").mockReturnValue(profile);
  vi.spyOn(verification, "assertVerificationWorkspaceBoundary").mockImplementation(() => {});
  const verify = vi.spyOn(verification, "runVerification").mockImplementation(async () => {
    events.push("verify"); if (options.verificationFailure) throw Error("Controlled verifier failed"); return evidence;
  });
  const admission = Object.freeze({}) as execution.WindowsVerifiedExecutionAdmission;
  vi.spyOn(execution, "bindWindowsVerifiedExecution").mockReturnValue(admission);
  const closed = vi.spyOn(execution, "assertWindowsVerifiedExecutionClosed").mockImplementation(() => { events.push("native-closed"); });
  vi.spyOn(sourceRuntime, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
  vi.spyOn(sourceRuntime, "assertProductSourceWorkspaceBoundary").mockImplementation(() => {});
  const claim = vi.spyOn(sourceRuntime, "claimProductSourceRun").mockImplementation(() => {});
  const release = vi.spyOn(sourceRuntime, "releaseProductSourceRun").mockImplementation(() => { events.push("release-source"); });
  const exportBytes = vi.spyOn(sourceRuntime, "captureProductSourceExport"), exportSemantic = vi.spyOn(sourceRuntime, "captureProductSourceExportV2");
  const staticPublisher = productRelease.createProductReleaseExecutor([]), recordStatic = vi.spyOn(staticPublisher, "recordVerification");
  vi.spyOn(productRelease, "createProductReleaseExecutor").mockReturnValue(staticPublisher);
  let originalRun: RunStartPayload | undefined, receive!: (message: ServerToNodeMessage) => void;
  const adapter: RuntimeAdapter = { runtimeId: "controlled", start: vi.fn(async config => { originalRun = config.runStart; return { runId: config.runId }; }),
    async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: options.phase ?? "completed" } }; },
    stop: vi.fn(async () => { events.push("adapter-stop"); }), collectArtifacts: async () => [] };
  const transport = { acknowledgesRunEvents: true, send: async (message: NodeToServerMessage) => {
    messages.push(message);
    if (message.kind === "run.event" && message.event.type === "run.verification") {
      events.push("verification-send");
      receive({ kind: "command", id: "verification-ack", idempotency_key: "author:verification", type: "run.event.ack", payload: {
        run_id: message.run_id, sequence: message.sequence, status: "accepted", application_verification: { version: 1, request_id: evidence.request_id,
          evidence_id: "author-evidence", event_id: "verification-event", payload_digest: sha(canonicalReleaseJson(evidence)), publisher_session_id: "session" } } });
      expect(registry.acknowledgeVerification).toHaveBeenCalledOnce();
    }
    if (message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed") {
      events.push("completion-send"); completedDelivery.resolve(); await pendingCompletion.promise;
      if (options.deliveryFailure) throw Error("Controlled completion delivery failed");
      events.push("completion-delivered");
    }
  }, subscribe: (handler: (message: ServerToNodeMessage) => void) => { receive = handler; return () => {}; } };
  const client = createNodeClient({ nodeId: "node", adapter, transport, workspace: { allowedRoots: [workspace] }, productSourceRuntime: {} as sourceRuntime.PreparedProductSourceRuntime,
    verificationProfiles: [profile], applicationPublication: { profiles: [publicationProfile], getSession: () => ({ id: "session", identity: publicationProfile }) } });
  client.start(); let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; pendingCompletion.resolve(); await client.stop(true); } };
  cleanups.push(stop);
  return { request, start, evidence, registry, publisher, createPublisher, verify, closed, claim, release, exportBytes, exportSemantic, recordStatic, staticPublisher, publicationProfile,
    messages, events, adapter, admission, client, stop, completedDelivery, pendingCompletion, receive: (message: ServerToNodeMessage) => receive(message),
    run: () => receive({ kind: "command", id: "author-start", idempotency_key: "author:start", type: "run.start", payload: start }), originalRun: () => originalRun };
}

describe("NodeClient application publication wiring", () => {
  it("rejects conflicting new work before selecting or auditing the verification profile", async () => {
    const f = fixture(), reservation = claimApplicationPublicationResources(f.publicationProfile);
    try {
      f.run(); await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "author-start", status: "rejected" })));
      expect(verification.selectVerificationProfile).not.toHaveBeenCalled(); expect(f.registry.admitRun).not.toHaveBeenCalled();
      expect(f.adapter.start).not.toHaveBeenCalled();
    } finally { releaseApplicationPublicationResources(reservation); }
  });
  it("checks existing run ownership before a publisher can claim the source resources", async () => {
    const f = fixture({ pauseCompletion: true }); f.run(); await f.completedDelivery.promise;
    const check = f.createPublisher.mock.calls[0]![0].assertResourcesIdle!;
    expect(() => check(f.publicationProfile)).toThrow(/active run owner/);
    f.pendingCompletion.resolve(); await vi.waitFor(() => expect(f.registry.recordCompleted).toHaveBeenCalled());
    await vi.waitFor(() => expect(() => check(f.publicationProfile)).not.toThrow());
  });
  it("registers completion only after final native verification, exact ACK and completed lifecycle delivery", async () => {
    const f = fixture({ pauseCompletion: true }); f.run(); await f.completedDelivery.promise;
    expect(f.registry.recordCompleted).not.toHaveBeenCalled(); expect(f.registry.acknowledgeVerification).toHaveBeenCalledOnce();
    expect(f.registry.expectVerificationReceipt).toHaveBeenCalledWith({ runStart: f.originalRun(), evidence: f.evidence, sequence: 0,
      admission: f.admission, handle: { runId: "author" } });
    expect(f.registry.admitRun.mock.calls[0]?.[1]).toBe(f.originalRun());
    f.pendingCompletion.resolve(); await vi.waitFor(() => expect(f.registry.recordCompleted).toHaveBeenCalledWith(f.originalRun()));
    expect(f.events.indexOf("adapter-stop")).toBeLessThan(f.events.indexOf("verify"));
    expect(f.events.indexOf("committed-verification")).toBeLessThan(f.events.indexOf("completion-delivered"));
    expect(f.events.indexOf("completion-delivered")).toBeLessThan(f.events.indexOf("record-completed"));
    expect(f.events.indexOf("release-source")).toBeLessThan(f.events.indexOf("record-completed"));
    expect(f.recordStatic).not.toHaveBeenCalled(); expect(f.exportBytes).not.toHaveBeenCalled(); expect(f.exportSemantic).not.toHaveBeenCalled();
  });
  it.each(["failed", "cancelled", "delivery-failure", "verification-failure"] as const)("cannot register a %s run as publication-ready", async kind => {
    const f = fixture({ ...(kind === "failed" || kind === "cancelled" ? { phase: kind } : {}),
      deliveryFailure: kind === "delivery-failure", verificationFailure: kind === "verification-failure" });
    f.run(); await vi.waitFor(() => expect(f.registry.discardRun).toHaveBeenCalledWith("author"));
    expect(f.registry.recordCompleted).not.toHaveBeenCalled();
    if (kind === "failed" || kind === "cancelled") expect(f.verify).not.toHaveBeenCalled();
    expect(f.recordStatic).not.toHaveBeenCalled(); expect(f.exportBytes).not.toHaveBeenCalled();
  });
  it("discards incomplete publication admission when the source workspace claim rejects", async () => {
    const f = fixture(); f.claim.mockImplementation(() => { throw Error("Original source claim denied"); }); f.run();
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "author-start", status: "rejected" })));
    expect(f.registry.discardRun).toHaveBeenCalledWith("author"); expect(f.adapter.start).not.toHaveBeenCalled();
  });
  it("parses publication start, stop and status independently from fresh run admission", async () => {
    const f = fixture();
    f.receive({ kind: "command", id: "publish", idempotency_key: "publish", type: "application.publication.start", payload: f.request });
    await vi.waitFor(() => expect(f.publisher.start).toHaveBeenCalledWith(f.request));
    f.client.invalidateApplicationPublicationSession();
    f.receive({ kind: "command", id: "status", idempotency_key: "status", type: "application.publication.status", payload: f.request });
    f.receive({ kind: "command", id: "stop", idempotency_key: "stop", type: "application.publication.stop", payload: { version: 1, request: f.request, reason: "authorization-invalid" } });
    await vi.waitFor(() => { expect(f.publisher.status).toHaveBeenCalledWith(f.request); expect(f.publisher.stop).toHaveBeenCalledWith(f.request, "authorization-invalid"); });
    expect(f.registry.admitRun).not.toHaveBeenCalled(); expect(f.registry.recordCompleted).not.toHaveBeenCalled();
    f.receive({ kind: "command", id: "expired", idempotency_key: "expired", deadline_at: "2000-01-01T00:00:00.000Z", type: "application.publication.start", payload: f.request });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "expired", status: "rejected" })));
    expect(f.publisher.start).toHaveBeenCalledOnce();
  });
  it("invalidates original publication authority and still joins shutdown after ordinary publisher cleanup fails", async () => {
    const f = fixture(); vi.spyOn(f.staticPublisher, "stop").mockRejectedValue(Error("Controlled ordinary cleanup failed"));
    await expect(f.stop()).rejects.toThrow("Controlled ordinary cleanup failed");
    expect(f.publisher.invalidate).toHaveBeenCalled(); expect(f.registry.invalidate).toHaveBeenCalled(); expect(f.publisher.shutdown).toHaveBeenCalledOnce();
  });
});
