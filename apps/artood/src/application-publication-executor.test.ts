// Controlled lifecycle owners and transport promises with real domain codecs.
// No native process, installation, HTTP health probe or provider is executed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { registerApplicationPublicationResources, assertApplicationPublicationRunAdmission } from "./application-publication-coordination.js";
import { canonicalApplicationPublicationRequest, type ApplicationPublicationDeploymentV1, type ApplicationPublicationHealthV1,
  type ApplicationPublicationInitializationV1, type ApplicationPublicationLiveOwnerV1, type ApplicationPublicationNormalClosureV1,
  type ApplicationPublicationAbortedClosureV1, type ApplicationPublicationObservationV1, type ApplicationPublicationReceiptV1,
  type ApplicationPublicationRequestV1, type ApplicationPublicationRootLeaseV1 } from "@artoo/domain";
import type { ApplicationPublicationExecutionFacts, PreparedApplicationPublicationExecution, PreparedApplicationPublicationPermit,
  createApplicationPublicationAcceptanceRegistry } from "./application-publication-acceptance.js";
import type { PreparedApplicationPublicationProfile } from "./application-publication-profile.js";
import type { ApplicationPublicationService, InitializedApplicationPublication } from "./application-publication-process.js";
import { applicationPublicationRequestFixture, applicationPublicationFixtureDigest as digest,
  applicationPublicationFixtureSha as sha } from "./test-fixtures/application-publication-request.js";

const controlled = vi.hoisted(() => ({ permit: vi.fn(), consume: vi.fn(), execution: vi.fn(), profile: vi.fn(), prepare: vi.fn(),
  initialize: vi.fn(), initialized: vi.fn(), start: vi.fn(), state: vi.fn(), health: vi.fn(), scopeCurrent: true }));
vi.mock("./application-publication-acceptance.js", () => ({ readApplicationPublicationPermit: controlled.permit,
  consumeApplicationPublicationPermit: controlled.consume, readApplicationPublicationExecution: controlled.execution }));
vi.mock("./application-publication-profile.js", () => ({ readApplicationPublicationProfile: controlled.profile }));
vi.mock("./application-publication-process.js", () => ({ prepareApplicationPublicationProcess: controlled.prepare,
  initializeApplicationPublicationProcess: controlled.initialize, readInitializedApplicationPublication: controlled.initialized,
  startApplicationPublicationService: controlled.start, readApplicationPublicationProcessState: controlled.state }));
vi.mock("./application-publication-health.js", () => ({ inspectApplicationPublicationHealth: controlled.health }));
vi.mock("./owned/windows-guardian-scope.js", () => ({
  bindWindowsGuardianCallback: <Args extends unknown[], Result>(callback: (...args: Args) => Result) => (...args: Args): Result => {
    if (!controlled.scopeCurrent) throw Error("Original Guardian scope is no longer active"); return callback(...args);
  },
}));
import { createApplicationPublicationExecutor } from "./application-publication-executor.js";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function flush() { for (let count = 0; count < 30; count++) await Promise.resolve(); }
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.resetAllMocks(); controlled.scopeCurrent = true;
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z")); });
afterEach(async () => { try { for (const cleanup of cleanups.splice(0)) await cleanup(); } finally { vi.useRealTimers(); } });

function fixture(options: { pauseReceipt?: boolean; pauseSecondDrain?: boolean; pauseTerminal?: boolean; healthFailure?: 1 | 2; uncertainSecondClosure?: boolean } = {}) {
  const request = applicationPublicationRequestFixture(), publicationProfile = Object.freeze({}) as PreparedApplicationPublicationProfile;
  const workspace = `C:\\publication-executor-tests\\${randomUUID()}`;
  registerApplicationPublicationResources(publicationProfile, { id: request.capabilities.binding.publication_profile_id,
    workspace, verifier: {}, directories: [`${workspace}-store`] });
  const session = { id: "session", identity: Object.freeze({}) }, permits = new Map<string, PreparedApplicationPublicationPermit>();
  const facts = new WeakMap<object, ApplicationPublicationExecutionFacts>(), executions = new WeakSet<object>(); let current = true;
  const receiptGate = deferred<void>(), terminalGate = deferred<void>(); if (!options.pauseReceipt) receiptGate.resolve(); if (!options.pauseTerminal) terminalGate.resolve();
  const events: string[] = [], receipts: ApplicationPublicationReceiptV1[] = [], observations: ApplicationPublicationObservationV1[] = [];
  const applicationProfile = Object.freeze({}), candidate = Object.freeze({}), backend = Object.freeze({}), definition = Object.freeze({});
  const prepare = vi.fn((input: ApplicationPublicationRequestV1) => {
    let token = permits.get(input.publication_id); if (!token) {
      token = Object.freeze({}) as PreparedApplicationPublicationPermit; permits.set(input.publication_id, token);
      facts.set(token, Object.freeze({ candidate, publicationProfile, applicationProfile, backend, definition, request: structuredClone(input),
        requestDigest: sha(canonicalApplicationPublicationRequest(input)) }) as ApplicationPublicationExecutionFacts);
    }
    return token;
  });
  controlled.permit.mockImplementation(token => { if (!current || !facts.has(token)) throw Error("Original authority revoked"); return facts.get(token); });
  const consumed = new WeakSet<object>();
  controlled.consume.mockImplementation(token => { const original = controlled.permit(token); if (consumed.has(token)) throw Error("Permit was already consumed");
    consumed.add(token); const execution = Object.freeze({}) as PreparedApplicationPublicationExecution; facts.set(execution, original); executions.add(execution); return execution; });
  controlled.execution.mockImplementation(token => { if (!current || !executions.has(token)) throw Error("Original authority revoked"); return facts.get(token); });
  controlled.profile.mockImplementation(token => { if (!current || token !== publicationProfile) throw Error("Original profile unavailable");
    return { config: { limits: request.capabilities.contract.limits } }; });
  let lease: ApplicationPublicationRootLeaseV1, initialized: ApplicationPublicationInitializationV1;
  const initializedToken = Object.freeze({}) as InitializedApplicationPublication;
  const deployment: ApplicationPublicationDeploymentV1 = { version: 1, deployment_generation: "deployment", store_id: "00000000-0000-4000-8000-000000000003",
    plan_digest: digest, relocation_proof_digest: digest, reopen_pin_digest: digest, database_identity: { device: "3", inode: "4" }, schema_digest: digest,
    scope_digest: digest, data_generation: "fresh-deployment-data", origin: "http://127.0.0.1:4173", client_entry_digest: digest };
  type Closure = ApplicationPublicationNormalClosureV1 | ApplicationPublicationAbortedClosureV1;
  const services: Array<ApplicationPublicationService & { closeNormal(): void; rejectClose(): void; cancel: ReturnType<typeof vi.fn>; drain: ReturnType<typeof vi.fn> }> = [];
  const closedOwners: Array<Pick<ApplicationPublicationInitializationV1, "owner_id" | "closed_at" | "process_exit_confirmed" | "exit_code" | "job_empty" |
    "stdout_eof" | "stderr_eof" | "helper_exit_code" | "helper_closed"> & { generation: 0 | 1 | 2 }> = [];
  const unsettled = new Set<string>();
  const processClosure = (ownerId: string) => ({ owner_id: ownerId, closed_at: new Date().toISOString(), process_exit_confirmed: true as const,
    exit_code: 0 as const, job_empty: true as const, stdout_eof: true as const, stderr_eof: true as const, helper_exit_code: 0 as const, helper_closed: true as const });
  controlled.prepare.mockImplementation(token => { controlled.execution(token); events.push("prepare-ledger"); });
  controlled.initialize.mockImplementation(async (token, input) => {
    controlled.execution(token); lease = input.lease; events.push("initialize");
    initialized = { ...processClosure("initializer"), broker_invocations: 1, broker_closed: 1 };
    closedOwners.push({ ...processClosure("initializer"), generation: 0 }); return initializedToken;
  });
  controlled.initialized.mockImplementation(token => { if (token !== initializedToken) throw Error("Original initialized store required"); return { deployment, initialization: initialized }; });
  controlled.start.mockImplementation(async token => {
    if (token !== initializedToken || services.length >= 2) throw Error("No replacement generation permitted");
    const generation = (services.length + 1) as 1 | 2, ownerId = `owner-${generation}`, closed = deferred<Closure>(); let settled = false, paused = true;
    events.push(`start-${generation}`); unsettled.add(ownerId);
    const identity = { publication_id: request.publication_id, lease_id: lease.lease_id, owner_id: ownerId, generation,
      deployment_generation: deployment.deployment_generation, reopen_pin_digest: deployment.reopen_pin_digest, database_identity: deployment.database_identity,
      schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin: deployment.origin };
    const normal = (): ApplicationPublicationNormalClosureV1 => ({ ...processClosure(ownerId), kind: "normal-drain", service: identity, reason: "stdin-drain",
      input_ack_digest: digest, listener_closed: true, audit_complete: true, session_released: true,
      counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 1, runtime_closed: 1, broker_invocations: 1, broker_closed: 1 } });
    const close = (value: Closure) => { if (settled) return; settled = true; unsettled.delete(ownerId);
      closedOwners.push({ ...processClosure(ownerId), generation }); events.push(`closed-${generation}-${value.kind}`); closed.resolve(value); };
    const rejectClose = () => { if (settled) return; settled = true; events.push(`uncertain-${generation}`); closed.reject(Error("Original native closure unconfirmed")); };
    const service = { identity, generation, origin: deployment.origin, preflight: { existing_database: true as const, process_exit_confirmed: true as const },
      probe: { requestHeaders: {}, responseHeaders: {} }, closed: closed.promise,
      quiesce: vi.fn(async () => { if (settled) throw Error("Original owner closed"); paused = true; events.push(`paused-${generation}`); }),
      resume: vi.fn(async () => { if (settled || !paused || !current) throw Error("Original owner cannot resume");
        paused = false; events.push(`resumed-${generation}`); }),
      runProbe: async <T>(_path: string, work: (headers: Readonly<Record<string, string>>) => Promise<T>) => work({}),
      waitForRequestCounters: vi.fn(async () => ({ observed_at: new Date().toISOString(), requests_used: 2, in_flight: 0, closed_transports: 2 })),
      observe: vi.fn(async (): Promise<ApplicationPublicationLiveOwnerV1> => {
        if (!current || settled) throw Error("Cannot observe retired owner"); events.push(`live-${generation}`);
        return { service: identity, counters_observed_at: new Date().toISOString(), observed_at: new Date().toISOString(), closed: false,
          native: { root_pid: generation + 10, root_creation_time: "133000000000000001", observed: true, job_member: true }, requests_used: 2, in_flight: 0 };
      }), drain: vi.fn(async (): Promise<ApplicationPublicationNormalClosureV1> => {
        events.push(`drain-${generation}`); if (!(generation === 2 && options.pauseSecondDrain)) close(normal());
        const result = await closed.promise; if (result.kind !== "normal-drain") throw Error("Original drain aborted"); return result;
      }), cancel: vi.fn((_error: unknown) => {
        events.push(`cancel-${generation}`); if (generation === 2 && options.uncertainSecondClosure) { rejectClose(); return; }
        close({ ...processClosure(ownerId), kind: "aborted", service: identity, reason: "cancelled" });
      }), closeNormal: () => close(normal()), rejectClose };
    services.push(service); return service;
  });
  controlled.state.mockImplementation(token => { if (!executions.has(token)) throw Error("Original execution ledger required");
    return { closed_owners: [...closedOwners], unsettled_owner_ids: [...unsettled], ...(initialized ? { deployment } : {}) }; });
  controlled.health.mockImplementation(async (_token, service: ApplicationPublicationService): Promise<ApplicationPublicationHealthV1> => {
    events.push(`health-${service.generation}`); if (options.healthFailure === service.generation) throw Error("Controlled readiness failed");
    return { version: 1, scope: "application-readiness-point-in-time", service: service.identity, checked_at: new Date().toISOString(),
      broker_preflight: service.preflight, client: { status_code: 200, body_digest: deployment.client_entry_digest },
      persistence_read: { path: "/api/items", status_code: 200, body_digest: digest } };
  });
  const onReceipt = vi.fn(async (value: ApplicationPublicationReceiptV1) => { receipts.push(value); events.push(`receipt-${value.outcome}`); await receiptGate.promise; });
  const onObservation = vi.fn(async (value: ApplicationPublicationObservationV1) => { observations.push(value); events.push(`observation-${value.state}`);
    if (["closed-normal", "closed-aborted", "expired", "unknown"].includes(value.state)) await terminalGate.promise; });
  const externalRelease = vi.fn();
  const executor = createApplicationPublicationExecutor({ profiles: [publicationProfile], getSession: () => current ? session : undefined,
    acceptance: { prepare } as unknown as ReturnType<typeof createApplicationPublicationAcceptanceRegistry>, onReceipt, onObservation,
    claimExternalResources: () => ({ release: externalRelease }) });
  cleanups.push(async () => { receiptGate.resolve(); terminalGate.resolve();
    if (options.uncertainSecondClosure) await expect(executor.shutdown()).rejects.toThrow(/unsettled.*owner/); else await executor.shutdown(); });
  return { request, executor, events, receipts, observations, services, receiptGate, terminalGate, onReceipt, onObservation, workspace,
    prepare, permits, consumed, current: () => { current = false; }, closedOwners, unsettled, externalRelease };
}

describe("bounded application publication executor over controlled owners", () => {
  it("initializes once, health-checks both original generations, normally drains one and retains generation two", async () => {
    const f = fixture(); await f.executor.start(f.request);
    expect(f.receipts).toHaveLength(1); expect(f.receipts[0]!.outcome).toBe("published");
    expect(f.events.indexOf("closed-1-normal-drain")).toBeLessThan(f.events.indexOf("start-2"));
    expect(f.services).toHaveLength(2); expect(f.services[1]!.cancel).not.toHaveBeenCalled();
    expect(f.unsettled).toEqual(new Set(["owner-2"])); expect(f.observations[0]!.state).toBe("healthy");
    expect(f.events.indexOf("resumed-2")).toBeLessThan(f.events.indexOf("receipt-published"));
    await f.executor.stop(f.request, "User stopped application");
    expect(f.unsettled.size).toBe(0); expect(f.observations.at(-1)!.state).toBe("closed-normal");
  });
  it("replays the same immutable receipt without new owners or a renewed lease", async () => {
    const f = fixture(); await f.executor.start(f.request); const receipt = f.receipts[0]!;
    await f.executor.start(structuredClone(f.request));
    expect(f.receipts[1]).toEqual(receipt); expect(controlled.initialize).toHaveBeenCalledOnce(); expect(controlled.start).toHaveBeenCalledTimes(2);
    await expect(f.executor.start({ ...f.request, acceptance: { ...f.request.acceptance, accepted_review_event_id: "different" } })).rejects.toThrow(/immutable/);
    expect(controlled.consume).toHaveBeenCalledOnce();
  });
  it("retains immutable receipt bytes when an outbound callback mutates its own projection", async () => {
    const f = fixture(); await f.executor.start(f.request); const original = structuredClone(f.receipts[0]!);
    f.receipts[0]!.request.goal_id = "changed-by-consumer";
    await f.executor.start(f.request); expect(f.receipts[1]).toEqual(original);
  });
  it("checks a busy profile before consuming another one-shot permit", async () => {
    const f = fixture(); await f.executor.start(f.request); const second = { ...f.request, publication_id: "second-publication" };
    await expect(f.executor.start(second)).rejects.toThrow(/busy/);
    expect(f.consumed.has(f.permits.get(second.publication_id)!)).toBe(false); expect(controlled.consume).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
  });
  it("retains conflicting resources until actual closure and permits unrelated work", async () => {
    const f = fixture({ pauseSecondDrain: true }); await f.executor.start(f.request);
    expect(() => assertApplicationPublicationRunAdmission([f.workspace])).toThrow(/busy/);
    expect(() => assertApplicationPublicationRunAdmission([`${f.workspace}-unrelated`])).not.toThrow();
    const stop = f.executor.stop(f.request, "Close original owner"); await flush();
    expect(() => assertApplicationPublicationRunAdmission([f.workspace])).toThrow(/busy/);
    expect(f.externalRelease).not.toHaveBeenCalled();
    f.services[1]!.closeNormal(); await stop;
    expect(() => assertApplicationPublicationRunAdmission([f.workspace])).not.toThrow();
    expect(f.externalRelease).toHaveBeenCalledOnce();
  });
  it("retries the retained terminal outbox on Stop without draining a second time", async () => {
    const f = fixture(); await f.executor.start(f.request); let rejectDelivery = true;
    f.onObservation.mockImplementation(async value => { f.observations.push(value);
      if (rejectDelivery && value.state === "closed-normal") throw Error("Controlled terminal delivery unavailable"); });
    await expect(f.executor.stop(f.request, "Stop original owner")).rejects.toThrow(/delivery unavailable/);
    const original = structuredClone(f.observations.find(value => value.state === "closed-normal")!);
    rejectDelivery = false; await f.executor.stop(f.request, "Retry retained delivery");
    expect(f.observations.at(-1)).toEqual(original); expect(f.services[1]!.drain).toHaveBeenCalledOnce();
  });
  it("starts draining an existing second owner without waiting for a blocked publication receipt", async () => {
    const f = fixture({ pauseReceipt: true, pauseSecondDrain: true }), started = f.executor.start(f.request); await flush();
    expect(f.receipts[0]!.outcome).toBe("published");
    const stopped = f.executor.stop(f.request, "Stop while receipt is pending"); await flush();
    expect(f.services[1]!.drain).toHaveBeenCalledOnce();
    f.current(); f.executor.invalidate();
    expect(f.services[1]!.cancel).toHaveBeenCalled();
    f.receiptGate.resolve(); await started; await stopped;
    expect(f.observations.at(-1)!.state).toBe("closed-aborted"); expect(f.unsettled.size).toBe(0);
  });
  it("joins the original terminal observation delivery even when another callback already recorded closure", async () => {
    const f = fixture({ pauseTerminal: true }); await f.executor.start(f.request); f.services[1]!.closeNormal(); await flush();
    expect(f.observations.at(-1)!.state).toBe("closed-normal");
    let joined = false; const shutdown = f.executor.shutdown().then(() => { joined = true; }); await flush();
    expect(joined).toBe(false); f.terminalGate.resolve(); await shutdown; expect(joined).toBe(true);
  });
  it("keeps cancellation and factual closure reachable after original authorization is revoked", async () => {
    const f = fixture(); await f.executor.start(f.request); f.current(); f.executor.invalidate();
    expect(f.services[1]!.cancel).toHaveBeenCalled(); await f.executor.shutdown();
    expect(f.observations.at(-1)!.state).toBe("closed-aborted"); expect(f.unsettled.size).toBe(0);
    expect(f.receipts[0]!.outcome).toBe("published");
  });
  it("routes explicit Stop to original owners even after the captured Guardian operation is no longer active", async () => {
    const f = fixture(); await f.executor.start(f.request); controlled.scopeCurrent = false; f.current();
    await f.executor.stop(f.request, "Original authorization revoked");
    expect(f.services[1]!.drain.mock.calls.length + f.services[1]!.cancel.mock.calls.length).toBeGreaterThan(0);
    expect(f.unsettled.size).toBe(0); expect(f.observations.at(-1)!.closure).not.toBeNull();
  });
  it.each([1, 2] as const)("reports a generation %i readiness failure with actual owner cleanup facts", async generation => {
    const f = fixture({ healthFailure: generation }); await f.executor.start(f.request);
    expect(f.receipts).toHaveLength(1); expect(f.receipts[0]).toMatchObject({ outcome: "failed", failure_stage: generation === 1 ? "first-health" : "second-health",
      cleanup: { state: "closed-confirmed", unsettled_owner_ids: [] } });
    expect(f.services).toHaveLength(generation); expect(f.services.at(-1)!.cancel).toHaveBeenCalled();
    expect(f.observations).toHaveLength(0);
  });
  it("retains unknown native closure without inventing closed-confirmed cleanup", async () => {
    const f = fixture({ uncertainSecondClosure: true }); await f.executor.start(f.request); f.executor.invalidate();
    await expect(f.executor.shutdown()).rejects.toThrow(/unsettled.*owner/);
    expect(f.unsettled.has("owner-2")).toBe(true); expect(f.observations.at(-1)).toMatchObject({ state: "unknown", closure: null });
    expect(f.closedOwners.some(owner => owner.generation === 2)).toBe(false);
    expect(f.externalRelease).not.toHaveBeenCalled();
    controlled.scopeCurrent = false;
    await f.executor.status(f.request);
    expect(f.observations.at(-1)).toMatchObject({ state: "unknown", closure: null });
  });
  it("retains the original absolute lease and drains within its reserve without rotating a third owner", async () => {
    const f = fixture(); await f.executor.start(f.request); const admitted = f.receipts[0]!.lease!;
    await vi.advanceTimersByTimeAsync(f.request.capabilities.contract.limits.root_lifetime_ms - f.request.capabilities.contract.limits.normal_drain_reserve_ms);
    expect(f.observations.at(-1)!.state).toBe("closed-normal"); expect(controlled.start).toHaveBeenCalledTimes(2);
    await f.executor.status(f.request);
    expect(f.receipts.at(-1)!.lease).toEqual(admitted); expect(f.observations.at(-1)!.state).toBe("closed-normal");
    expect(f.unsettled.size).toBe(0);
  });
  it("reaches reserve drainage after Guardian revocation without throwing from its timer callback", async () => {
    const f = fixture(); await f.executor.start(f.request);
    const reserveAt = f.request.capabilities.contract.limits.root_lifetime_ms - f.request.capabilities.contract.limits.normal_drain_reserve_ms;
    await vi.advanceTimersByTimeAsync(reserveAt - 1000); controlled.scopeCurrent = false; f.current();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.services[1]!.drain).toHaveBeenCalledOnce(); expect(f.unsettled.size).toBe(0);
    expect(f.observations.at(-1)!.state).toBe("closed-normal");
  });
});
