// Real NodeClient dispatch and delivery reentrancy with controlled publisher,
// source, checkpoint and clean permit boundaries. This does not exercise native
// closure, publisher health or construct a genuine accepted clean release permit.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductReleaseRequest, ProductReleaseReceipt } from "@artoo/domain";
import type { NodeSideTransport, NodeToServerMessage, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import * as recoveryClient from "./source-recovery-client.js";
import * as recovery from "./windows-source-recovery.js";
import * as source from "./product-source-runtime.js";
import * as clean from "./windows-clean-validation-runtime.js";
import * as cleanController from "./imported-clean-validation.js";
import * as verification from "./verification.js";
import * as publication from "./product-release.js";
import { createNodeClient } from "./node-client.js";
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const runtime = Object.freeze({}) as recovery.PreparedWindowsSourceRecoveryRuntime;
  const sourceRuntime = Object.freeze({}) as source.PreparedProductSourceRuntime;
  const cleanRuntime = Object.freeze({}) as clean.PreparedWindowsCleanValidationRuntime;
  const checkpoint = Object.freeze({}), profile = { id: "verify", project_id: "project", workspace_root: "C:\\controlled-clean-workspace" };
  const releaseProfile = { id: "release", verifier: profile };
  const events: string[] = [], sent: NodeToServerMessage[] = [], claims = new Map<string, object>(), permits = new Map<string, object>();
  const requests = new WeakMap<object, ProductReleaseRequest>();
  let active = true, settled = true, listener!: (message: ServerToNodeMessage) => void;
  let deliver: (message: NodeToServerMessage) => Promise<void> = async () => {};
  const prepareRelease = vi.fn((request: ProductReleaseRequest) => {
    let permit = permits.get(request.release_id);
    if (!permit) { permit = Object.freeze({}); permits.set(request.release_id, permit); requests.set(permit, request); }
    events.push("permit:" + request.release_id); return permit;
  });
  vi.spyOn(verification, "prepareVerificationProfiles").mockReturnValue([profile] as never);
  vi.spyOn(publication, "prepareReleaseProfiles").mockReturnValue([releaseProfile] as never);
  const publisher = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), requestStop: vi.fn(), getHealthReports: () => [],
    fenceCleanWorkspace: vi.fn(), replayReceipt: vi.fn(() => undefined), recordVerification: vi.fn(), prepareRetry: vi.fn(() => ({})),
    release: vi.fn(async (request: ProductReleaseRequest) => {
      events.push("release:" + request.release_id); return { request, outcome: "failed" } as ProductReleaseReceipt;
    }),
    isAttemptSettled: vi.fn((request: ProductReleaseRequest) => { events.push("settled:" + request.release_id); return settled; }),
  };
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue(publisher as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const registration = { handle: async () => false, isActive: () => active, allowsOrdinary: () => false, readRuntime: () => runtime,
    invalidate() { active = false; }, settled: async () => {} };
  const create = vi.spyOn(recoveryClient, "createProductSourceRecoveryClient")
    .mockReturnValue(registration as unknown as ReturnType<typeof recoveryClient.createProductSourceRecoveryClient>);
  vi.spyOn(recovery, "withWindowsSourceRecoveryOperation").mockImplementation((_runtime, _descriptor, work) => work());
  vi.spyOn(recovery, "readWindowsRecoverySourceRuntime").mockReturnValue(sourceRuntime);
  vi.spyOn(clean, "prepareWindowsCleanValidationRuntime").mockReturnValue(cleanRuntime);
  vi.spyOn(clean, "readPreparedCleanValidationRelease").mockImplementation(permit => {
    if (!requests.has(permit)) throw Error("Unknown controlled permit");
    return { start: { run_id: "author", context_pack: { payload: {} } }, profile, verification: {}, readReleaseCapabilities: () => ({}) } as never;
  });
  vi.spyOn(clean, "claimCleanValidationRelease").mockImplementation((owner, permit, id) => {
    if (owner !== cleanRuntime || !requests.has(permit) || claims.size) throw Error("Controlled original claim is still occupied");
    claims.set(id, permit); events.push("claim:" + requests.get(permit)!.release_id);
  });
  const releaseClaim = vi.spyOn(clean, "releaseCleanValidationClaim").mockImplementation((owner, permit, id) => {
    if (owner !== cleanRuntime || claims.get(id) !== permit) throw Error("Controlled cleanup changed the original claim owner");
    claims.delete(id); events.push("unclaim:" + requests.get(permit)!.release_id);
  });
  vi.spyOn(clean, "withWindowsCleanReleaseOperation").mockImplementation((_runtime, _permit, work) => work());
  vi.spyOn(cleanController, "createImportedCleanValidationClient").mockReturnValue({ handle: async () => false,
    prepareRelease, invalidate() {}, settled: async () => {} } as unknown as ReturnType<typeof cleanController.createImportedCleanValidationClient>);
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe(callback) { listener = callback; return () => {}; },
    async send(message) {
      if (message.kind === "product.release.receipt") events.push("receipt:" + message.payload.request.release_id);
      sent.push(message); await deliver(message);
    } };
  const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { throw Error("Models are forbidden in this fixture"); },
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node", transport, adapter, productSourceRecovery: { configuration: {} as never,
    features: [], isCurrent: () => active, activate: () => sourceRuntime } });
  client.start(); create.mock.calls[0]![0].activate(runtime, undefined, checkpoint as never);
  // Wire schemas and product acceptance are deliberately outside this ordering
  // fixture; the controlled adapters consume only these explicit request fields.
  const request = (id: string, retry = false) => ({ release_id: id, project_id: "project", run_id: "author",
    release_profile_id: "release", imported_clean: { clean_generation_id: "controlled-generation" },
    ...(retry ? { retry: { previous_release_id: "first" } } : {}) }) as unknown as ProductReleaseRequest;
  const send = (payload: ProductReleaseRequest) => listener({ kind: "command", id: payload.release_id,
    idempotency_key: payload.release_id, type: "product.release", payload });
  const acknowledged = (id: string, status: "accepted" | "rejected" = "accepted") => sent.some(message => message.kind === "command.ack" && message.command_id === id && message.status === status);
  return { client, publisher, events, sent, claims, permits, releaseClaim, request, send, acknowledged,
    setSettled(value: boolean) { settled = value; }, onDelivery(callback: typeof deliver) { deliver = callback; } };
}

describe("clean publisher settlement precedes receipt-triggered retry", () => {
  it("relinquishes the settled original claim before a retry enters during receipt send", async () => {
    const f = fixture(); let finishFirst!: () => void;
    f.onDelivery(async message => {
      if (message.kind !== "product.release.receipt" || message.payload.request.release_id !== "first") return;
      expect(f.claims.size).toBe(0); f.send(f.request("retry", true));
      await new Promise<void>(resolve => { finishFirst = resolve; });
    });
    try {
      f.send(f.request("first"));
      await vi.waitFor(() => expect(f.acknowledged("retry")).toBe(true));
      expect(f.publisher.release).toHaveBeenCalledTimes(2);
      expect(f.events.indexOf("settled:first")).toBeLessThan(f.events.indexOf("unclaim:first"));
      expect(f.events.indexOf("unclaim:first")).toBeLessThan(f.events.indexOf("receipt:first"));
      expect(f.events.indexOf("receipt:first")).toBeLessThan(f.events.indexOf("claim:retry"));
      finishFirst(); await vi.waitFor(() => expect(f.acknowledged("first")).toBe(true));
      expect(f.releaseClaim).toHaveBeenCalledTimes(2); expect(f.claims.size).toBe(0);
    } finally { finishFirst?.(); await f.client.stop(true); }
  });
  it("keeps a claim when the executor has not confirmed settlement, even without a retry-session option", async () => {
    const f = fixture(); f.setSettled(false);
    try {
      f.send(f.request("first")); await vi.waitFor(() => expect(f.acknowledged("first")).toBe(true));
      expect(f.publisher.isAttemptSettled).toHaveBeenCalledWith(f.request("first"));
      expect(f.releaseClaim).not.toHaveBeenCalled(); expect(f.claims.get("product-release:first")).toBe(f.permits.get("first"));
    } finally { await f.client.stop(true); }
  });
  it("does not release before a pending original publisher returns its settled receipt", async () => {
    const f = fixture(); let finish!: () => void;
    f.publisher.release.mockImplementation(async request => {
      await new Promise<void>(resolve => { finish = resolve; }); return { request, outcome: "failed" } as ProductReleaseReceipt;
    });
    try {
      f.send(f.request("first")); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(f.publisher.isAttemptSettled).not.toHaveBeenCalled(); expect(f.releaseClaim).not.toHaveBeenCalled(); expect(f.claims.size).toBe(1);
      finish(); await vi.waitFor(() => expect(f.acknowledged("first")).toBe(true)); expect(f.releaseClaim).toHaveBeenCalledOnce();
    } finally { finish?.(); await f.client.stop(true); }
  });
  it("does not release the settled claim twice after receipt delivery fails", async () => {
    const f = fixture();
    f.onDelivery(async message => { if (message.kind === "product.release.receipt") throw Error("Controlled receipt delivery failure"); });
    try {
      f.send(f.request("first")); await vi.waitFor(() => expect(f.acknowledged("first", "rejected")).toBe(true));
      expect(f.sent).toContainEqual({ kind: "command.ack", node_id: "node", command_id: "first", status: "rejected",
        error_code: "process_start_failed", message: "Controlled receipt delivery failure" });
      expect(f.acknowledged("first", "accepted")).toBe(false);
      expect(f.releaseClaim).toHaveBeenCalledOnce(); expect(f.claims.size).toBe(0);
    } finally { await f.client.stop(true); }
  });
});
