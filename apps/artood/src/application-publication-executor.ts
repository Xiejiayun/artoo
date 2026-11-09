import { createHash, randomUUID } from "node:crypto";
import { ApplicationPublicationRequestV1Schema, ApplicationPublicationReceiptV1Schema,
  ApplicationPublicationObservationV1Schema, ApplicationPublicationRootLeaseV1Schema, canonicalApplicationPublicationRequest,
  type ApplicationPublicationRequestV1, type ApplicationPublicationReceiptV1, type ApplicationPublicationObservationV1,
  type ApplicationPublicationRootLeaseV1, type ApplicationPublicationDeploymentV1 } from "@artoo/domain";
import { consumeApplicationPublicationPermit, readApplicationPublicationExecution, readApplicationPublicationPermit,
  type createApplicationPublicationAcceptanceRegistry, type PreparedApplicationPublicationExecution,
  type ApplicationPublicationSession } from "./application-publication-acceptance.js";
import { readApplicationPublicationProfile, type PreparedApplicationPublicationProfile } from "./application-publication-profile.js";
import { initializeApplicationPublicationProcess, readInitializedApplicationPublication, startApplicationPublicationService,
  prepareApplicationPublicationProcess, readApplicationPublicationProcessState, type InitializedApplicationPublication, type ApplicationPublicationService } from "./application-publication-process.js";
import { inspectApplicationPublicationHealth } from "./application-publication-health.js";
import { bindWindowsGuardianCallback } from "./owned/windows-guardian-scope.js";
import { claimApplicationPublicationResources, readApplicationPublicationResourceMetadata, releaseApplicationPublicationResources,
  withApplicationPublicationAuditScope, type ApplicationPublicationReservation } from "./application-publication-coordination.js";

type Registry = ReturnType<typeof createApplicationPublicationAcceptanceRegistry>;
type Published = Extract<ApplicationPublicationReceiptV1, { outcome: "published" }>;
type FailureStage = Extract<ApplicationPublicationReceiptV1, { outcome: "failed" }>["failure_stage"];
type Closure = Awaited<ApplicationPublicationService["closed"]>;
const digest = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const reason = (error: unknown): string => (error instanceof Error ? error.message : "Application publication failed").slice(0, 2000);
interface Entry {
  request: ApplicationPublicationRequestV1; digest: string; execution: PreparedApplicationPublicationExecution;
  profile: PreparedApplicationPublicationProfile; session: ApplicationPublicationSession;
  reservation: ApplicationPublicationReservation; released: boolean;
  externalResources?: { release(): void };
  lease: ApplicationPublicationRootLeaseV1; deadline: number; controller: AbortController;
  stage: FailureStage; initialized?: InitializedApplicationPublication; deployment?: ApplicationPublicationDeploymentV1;
  services: ApplicationPublicationService[]; closed: Map<ApplicationPublicationService, Closure | Error>;
  receipt?: ApplicationPublicationReceiptV1; sequence: number; healthRounds: number;
  starting: Promise<void>; stopping?: Promise<void>; work: Promise<void>; delivery: Promise<void>;
  outbox: Map<number, ApplicationPublicationObservationV1>;
  timer?: ReturnType<typeof setTimeout>; reserveTimer?: ReturnType<typeof setTimeout>; healthTimer?: ReturnType<typeof setTimeout>;
  retired: boolean; terminal?: ApplicationPublicationObservationV1; failure?: Error;
  /** Re-enters the captured original Guardian scope for later timer/transport callbacks. */
  run<T>(work: () => T): T;
}

/** One immutable request owns at most one initializer and two original services.
 * Replays share that invocation; they cannot extend its lease or create an owner.
 * The second service stays live until stop, budget exhaustion or lease drainage. */
export function createApplicationPublicationExecutor(options: {
  profiles: readonly PreparedApplicationPublicationProfile[]; getSession(): ApplicationPublicationSession | undefined;
  acceptance: Registry; onReceipt(value: ApplicationPublicationReceiptV1): Promise<void>;
  onObservation(value: ApplicationPublicationObservationV1): Promise<void>;
  assertResourcesIdle?(profile: PreparedApplicationPublicationProfile): void;
  claimExternalResources?(profile: PreparedApplicationPublicationProfile): { release(): void } | undefined;
}) {
  const entries = new Map<string, Entry>(), activeProfiles = new Map<PreparedApplicationPublicationProfile, Entry>();
  const profiles = new Set(options.profiles); let ended = false;
  const routing = new Map(options.profiles.map(profile => [readApplicationPublicationResourceMetadata(profile).id, profile]));
  function currentSession(entry: Entry): void {
    entry.controller.signal.throwIfAborted();
    const session = options.getSession();
    if (ended || entry.retired || !session || session.id !== entry.session.id || session.identity !== entry.session.identity
      || performance.now() >= entry.deadline) throw Error("Application publication original session or lease ended");
    if (entry.failure) throw entry.failure;
  }
  function current(entry: Entry): void {
    currentSession(entry);
    const original = readApplicationPublicationExecution(entry.execution);
    if (original.requestDigest !== entry.digest || original.publicationProfile !== entry.profile) throw Error("Application publication original execution changed");
    if (entry.failure) throw entry.failure;
  }
  function release(entry: Entry): void {
    if (entry.released) return;
    const facts = readApplicationPublicationProcessState(entry.execution);
    if (facts.unsettled_owner_ids.length) return;
    entry.externalResources?.release();
    releaseApplicationPublicationResources(entry.reservation); entry.released = true; activeProfiles.delete(entry.profile);
  }
  function clear(entry: Entry): void { clearTimeout(entry.timer); clearTimeout(entry.reserveTimer); clearTimeout(entry.healthTimer); }
  async function startup<T>(entry: Entry, work: () => Promise<T>, joinLate?: (value: T) => Promise<unknown>): Promise<T> {
    const deadline = Math.min(entry.deadline, performance.now() + entry.request.capabilities.contract.limits.startup_timeout_ms);
    const timeout = () => entry.controller.abort(Error("Application publication original startup deadline elapsed"));
    const timer = setTimeout(timeout, Math.max(1, deadline - performance.now()));
    try {
      // Await the original operation after cancellation too: a timer is not
      // process closure, and Promise.race must not discard an outstanding owner.
      const value = await work();
      if (performance.now() >= deadline) {
        timeout(); await joinLate?.(value);
        throw Error("Application publication original startup deadline elapsed");
      }
      return value;
    } finally { clearTimeout(timer); }
  }
  function deliver(entry: Entry, value: ApplicationPublicationObservationV1): Promise<void> {
    if (!entry.outbox.has(value.sequence)) entry.outbox.set(value.sequence, value);
    const next = entry.delivery.catch(() => {}).then(async () => {
      for (const [sequence, retained] of [...entry.outbox.entries()].sort(([a], [b]) => a - b)) {
        // An interrupted receipt never lets a later sequence overtake it. Every
        // subsequent delivery attempt uses the same retained original body.
        await options.onObservation(structuredClone(retained)); entry.outbox.delete(sequence);
      }
    });
    entry.delivery = next; void next.catch(() => {}); return next;
  }
  function observation(entry: Entry, fields: Pick<ApplicationPublicationObservationV1, "state" | "reason" | "health" | "live" | "closure">): ApplicationPublicationObservationV1 {
    if (!entry.deployment) throw Error("Application publication observation lacks original deployment");
    const value = ApplicationPublicationObservationV1Schema.parse({ version: 1, event_id: randomUUID(), sequence: ++entry.sequence,
      generation: 2, request: entry.request, request_digest: entry.digest, lease: entry.lease, deployment: entry.deployment,
      observed_at: new Date().toISOString(), ...fields });
    if (["closed-normal", "closed-aborted", "expired", "unknown"].includes(value.state)) entry.terminal = value;
    return value;
  }
  async function terminal(entry: Entry, service: ApplicationPublicationService): Promise<void> {
    clear(entry);
    let closure: Closure | null = null, failure: unknown;
    try { closure = await service.closed; } catch (error) { failure = error; }
    if (entry.receipt?.outcome !== "published" || entry.terminal) return;
    const state = closure ? performance.now() >= entry.deadline ? "expired" : closure.kind === "normal-drain" ? "closed-normal" : "closed-aborted" : "unknown";
    const value = observation(entry, { state, reason: failure ? reason(failure) : closure!.kind === "normal-drain" ? "Original service drained normally" : closure!.reason,
      health: null, live: null, closure });
    if (closure) release(entry);
    await deliver(entry, value);
  }
  function watch(entry: Entry, service: ApplicationPublicationService): void {
    entry.services.push(service);
    void service.closed.then(closure => {
      entry.closed.set(service, closure);
      if (service.generation === 2) void terminal(entry, service).catch(() => {});
    }, error => {
      const failure = error instanceof Error ? error : Error("Original application service closure is uncertain");
      entry.closed.set(service, failure); entry.failure ??= failure;
      if (service.generation === 2) void terminal(entry, service).catch(() => {});
    });
  }
  async function closeOwners(entry: Entry, error: Error): Promise<void> {
    clear(entry); entry.controller.abort(error);
    for (const service of entry.services) service.cancel(error);
    // The original native helper retains its own finite closure deadline. No PID
    // search, replacement owner, deadline reset or synthetic exit is permitted.
    await Promise.allSettled(entry.services.map(service => service.closed));
  }
  async function failure(entry: Entry, error: unknown): Promise<void> {
    await closeOwners(entry, error instanceof Error ? error : Error(reason(error)));
    if (entry.receipt) {
      const second = entry.services.find(service => service.generation === 2);
      if (second) await terminal(entry, second);
      return;
    }
    const facts = readApplicationPublicationProcessState(entry.execution);
    const receipt = ApplicationPublicationReceiptV1Schema.parse({ version: 1, scope: "bounded-local-application-publication", outcome: "failed",
      request: entry.request, request_digest: entry.digest, lease: entry.lease, deployment: facts.deployment ?? entry.deployment ?? null,
      recorded_at: new Date().toISOString(), failure_stage: entry.stage, reason: reason(error),
      cleanup: { state: facts.unsettled_owner_ids.length ? "unconfirmed" : "closed-confirmed",
        closed_owners: facts.closed_owners, unsettled_owner_ids: facts.unsettled_owner_ids } });
    entry.receipt = receipt;
    if (!facts.unsettled_owner_ids.length) release(entry);
    await options.onReceipt(structuredClone(receipt));
  }
  async function observe(entry: Entry, health: boolean): Promise<void> {
    if (entry.receipt?.outcome !== "published") return;
    if (entry.terminal) { await deliver(entry, entry.terminal); return; }
    const service = entry.services.find(value => value.generation === 2)!;
    if (entry.closed.has(service)) { await terminal(entry, service); return; }
    await service.quiesce();
    let measured: Awaited<ReturnType<typeof inspectApplicationPublicationHealth>> | null = null;
    let live: Awaited<ReturnType<ApplicationPublicationService["observe"]>>;
    try {
      current(entry);
      const limits = entry.request.capabilities.contract.limits;
      measured = health && entry.healthRounds < limits.maximum_health_rounds
        ? (++entry.healthRounds, await inspectApplicationPublicationHealth(entry.execution, service,
          { deadline: entry.deadline - limits.normal_drain_reserve_ms, signal: entry.controller.signal, clientEntryDigest: entry.deployment!.client_entry_digest })) : null;
      current(entry);
      await service.resume(); currentSession(entry);
      live = await service.observe(); currentSession(entry);
    } catch (error) {
      // An integrity/session failure after pausing cannot leave a hidden paused
      // product or resume under stale authority. Stop the same original owner.
      if (!entry.retired) service.cancel(error);
      throw error;
    }
    await deliver(entry, observation(entry, { state: measured ? "healthy" : "live", reason: null, health: measured, live, closure: null }));
  }
  function enqueue(entry: Entry, work: () => Promise<void>): Promise<void> {
    const next = entry.work.catch(() => {}).then(() => entry.released || entry.terminal ? work() : entry.run(work));
    entry.work = next; void next.catch(() => {}); return next;
  }
  function schedule(entry: Entry): void {
    if (entry.retired || entry.terminal || entry.controller.signal.aborted) return;
    const limits = entry.request.capabilities.contract.limits;
    entry.healthTimer = setTimeout(() => {
      void enqueue(entry, () => observe(entry, true)).then(() => schedule(entry), error => entry.retired ? undefined : failure(entry, error)).catch(() => {});
    }, limits.health_interval_ms);
  }
  async function execute(entry: Entry): Promise<void> {
    try {
      current(entry); entry.stage = "initialization";
      entry.initialized = await startup(entry, () => initializeApplicationPublicationProcess(entry.execution,
        { lease: entry.lease, deadline: entry.deadline, signal: entry.controller.signal, reservation: entry.reservation }));
      current(entry);
      const installed = readInitializedApplicationPublication(entry.initialized);
      entry.deployment = installed.deployment;
      entry.stage = "first-start";
      const first = await startup(entry, () => startApplicationPublicationService(entry.initialized!), service => service.closed); watch(entry, first); current(entry);
      entry.stage = "first-health"; entry.healthRounds++;
      const firstHealth = await inspectApplicationPublicationHealth(entry.execution, first,
        { deadline: entry.deadline, signal: entry.controller.signal, clientEntryDigest: entry.deployment.client_entry_digest });
      current(entry); entry.stage = "first-drain";
      const firstClosure = await first.drain(); current(entry);
      entry.stage = "reopen";
      const second = await startup(entry, () => startApplicationPublicationService(entry.initialized!), service => service.closed); watch(entry, second); current(entry);
      entry.stage = "second-health"; entry.healthRounds++;
      const secondHealth = await inspectApplicationPublicationHealth(entry.execution, second,
        { deadline: entry.deadline - entry.request.capabilities.contract.limits.normal_drain_reserve_ms,
          signal: entry.controller.signal, clientEntryDigest: entry.deployment.client_entry_digest });
      current(entry); await second.resume(); currentSession(entry);
      const live = await second.observe(); currentSession(entry);
      if (entry.closed.has(second)) throw Error("Application publication second owner already closed");
      entry.stage = "publication-settlement";
      const receipt: Published = ApplicationPublicationReceiptV1Schema.parse({ version: 1, scope: "bounded-local-application-publication", outcome: "published",
        request: entry.request, request_digest: entry.digest, lease: entry.lease, deployment: entry.deployment,
        initialization: installed.initialization, first_service: { health: firstHealth, closure: firstClosure },
        second_service: { health: secondHealth, live }, settled_publication_criteria: entry.request.acceptance.publication_criteria,
        recorded_at: new Date().toISOString() }) as Published;
      entry.receipt = receipt; await options.onReceipt(structuredClone(receipt));
      if (entry.retired) return;
      currentSession(entry);
      const afterReceipt = await second.observe(); currentSession(entry);
      const fresh = Date.now() - Date.parse(secondHealth.checked_at) <= entry.request.capabilities.contract.limits.health_freshness_ms;
      await deliver(entry, observation(entry, { state: fresh ? "healthy" : "live", reason: null,
        health: fresh ? secondHealth : null, live: afterReceipt, closure: null }));
      schedule(entry);
    } catch (error) { await failure(entry, error); }
  }
  function lookup(input: ApplicationPublicationRequestV1): Entry {
    const request = ApplicationPublicationRequestV1Schema.parse(input), entry = entries.get(request.publication_id);
    if (!entry || entry.digest !== digest(canonicalApplicationPublicationRequest(request))) throw Error("Application publication original request is unavailable or changed");
    return entry;
  }
  async function stopEntry(entry: Entry, message: string, abort: boolean): Promise<void> {
    // Escalation always reaches original owners immediately, including while a
    // previous normal stop is awaiting a server receipt or normal drain.
    if (abort || entry.receipt?.outcome !== "published") {
      entry.controller.abort(Error(message));
      for (const service of entry.services) service.cancel(Error(message));
    }
    if (entry.stopping) return entry.stopping.then(() => entry.terminal ? deliver(entry, entry.terminal) : entry.delivery);
    entry.retired = true; clear(entry);
    const originalSecond = entry.services.find(service => service.generation === 2);
    let draining: Promise<unknown> | undefined;
    if (!abort && entry.receipt?.outcome === "published" && originalSecond && !entry.closed.has(originalSecond)) {
      void deliver(entry, observation(entry, { state: "draining", reason: message, health: null, live: null, closure: null })).catch(() => {});
      draining = originalSecond.drain().catch(error => { originalSecond.cancel(error); });
    }
    entry.stopping = (async () => {
      await draining;
      await entry.starting.catch(() => {});
      const second = entry.services.find(service => service.generation === 2);
      if (entry.receipt?.outcome === "published" && second && !entry.closed.has(second)) {
        if (abort) second.cancel(Error(message));
        else if (!draining) try { await second.drain(); } catch (error) { second.cancel(error instanceof Error ? error : Error(message)); }
        await terminal(entry, second).catch(error => { if (!entry.terminal) throw error; });
      } else if (second) await terminal(entry, second).catch(error => { if (!entry.terminal) throw error; });
      const facts = readApplicationPublicationProcessState(entry.execution);
      if (facts.unsettled_owner_ids.length) throw Error("Application publication closure remains uncertain; original owners retained");
      release(entry);
    })();
    void entry.stopping.catch(() => {});
    return entry.stopping.then(() => entry.terminal ? deliver(entry, entry.terminal) : entry.delivery);
  }
  return {
    start(input: ApplicationPublicationRequestV1): Promise<void> {
      const request = ApplicationPublicationRequestV1Schema.parse(input), hash = digest(canonicalApplicationPublicationRequest(request));
      const previous = entries.get(request.publication_id);
      if (previous) {
        if (previous.digest !== hash) return Promise.reject(Error("Application publication request is immutable"));
        return previous.starting.then(() => previous.receipt ? options.onReceipt(structuredClone(previous.receipt)) : undefined,
          error => previous.receipt ? options.onReceipt(structuredClone(previous.receipt)) : Promise.reject(error));
      }
      if (ended || entries.size >= 64) return Promise.reject(Error("Application publication executor is closed or full"));
      const selected = routing.get(request.capabilities.binding.publication_profile_id);
      if (!selected || !profiles.has(selected)) return Promise.reject(Error("Original configured publication profile required"));
      let reservation: ApplicationPublicationReservation;
      try { options.assertResourcesIdle?.(selected); reservation = claimApplicationPublicationResources(selected); }
      catch (error) { return Promise.reject(error); }
      let externalResources: { release(): void } | undefined, preparedExecution: PreparedApplicationPublicationExecution | undefined, admittedEntry: Entry | undefined;
      try { return withApplicationPublicationAuditScope(reservation, () => {
      externalResources = options.claimExternalResources?.(selected);
      const permit = options.acceptance.prepare(request), saved = readApplicationPublicationPermit(permit), session = options.getSession();
      if (!session || session.id !== request.publisher_session_id || !profiles.has(saved.publicationProfile) || activeProfiles.has(saved.publicationProfile))
        throw Error("Application publication original profile/session is unavailable or busy");
      if (saved.publicationProfile !== selected) throw Error("Publication resource routing differs from current authorization");
      const configured = readApplicationPublicationProfile(saved.publicationProfile), admitted = Date.now(), begun = performance.now();
      const execution = consumeApplicationPublicationPermit(permit);
      prepareApplicationPublicationProcess(execution); preparedExecution = execution;
      const lease = ApplicationPublicationRootLeaseV1Schema.parse({ version: 1, lease_id: randomUUID(), publication_id: request.publication_id,
        request_digest: hash, publisher_session_id: session.id, admitted_at: new Date(admitted).toISOString(),
        deadline_at: new Date(admitted + configured.config.limits.root_lifetime_ms).toISOString(), root_lifetime_ms: configured.config.limits.root_lifetime_ms });
      const run = bindWindowsGuardianCallback(<T>(work: () => T): T => withApplicationPublicationAuditScope(reservation, work));
      const entry: Entry = { request: saved.request, digest: hash, execution, profile: saved.publicationProfile, session: Object.freeze({ ...session }), lease,
        reservation, released: false, ...(externalResources ? { externalResources } : {}),
        deadline: begun + lease.root_lifetime_ms, controller: new AbortController(), stage: "admission", services: [], closed: new Map(),
        sequence: 0, healthRounds: 0, starting: Promise.resolve(), work: Promise.resolve(), delivery: Promise.resolve(), outbox: new Map(), retired: false, run };
      admittedEntry = entry; entries.set(request.publication_id, entry); activeProfiles.set(entry.profile, entry);
      entry.timer = setTimeout(() => { void stopEntry(entry, "Original application publication lease expired", true).catch(() => {}); }, Math.max(1, entry.deadline - performance.now()));
      entry.reserveTimer = setTimeout(() => { void stopEntry(entry, "Original application publication lease drain reserve reached", false).catch(() => {}); },
        Math.max(1, entry.deadline - configured.config.limits.normal_drain_reserve_ms - performance.now()));
      entry.starting = entry.run(() => execute(entry)); entry.work = entry.starting; void entry.starting.catch(() => {}); return entry.starting;
      }); } catch (error) {
        if (!preparedExecution || !readApplicationPublicationProcessState(preparedExecution).unsettled_owner_ids.length) {
          externalResources?.release(); releaseApplicationPublicationResources(reservation);
          if (admittedEntry) { clear(admittedEntry); entries.delete(request.publication_id); activeProfiles.delete(selected); }
        }
        return Promise.reject(error);
      }
    },
    stop(request: ApplicationPublicationRequestV1, message: string): Promise<void> {
      // These owners already exist. Requiring a fresh Guardian scope here would
      // deny their drain/cancellation precisely when authorization is revoked.
      return stopEntry(lookup(request), message, false);
    },
    status(request: ApplicationPublicationRequestV1): Promise<void> {
      const entry = lookup(request);
      return enqueue(entry, async () => { if (entry.receipt) await options.onReceipt(structuredClone(entry.receipt)); await observe(entry, false); });
    },
    invalidate(): void {
      ended = true;
      for (const entry of entries.values()) void stopEntry(entry, "Original application publication session ended", true).catch(() => {});
    },
    async shutdown(): Promise<void> {
      ended = true;
      const outcomes = await Promise.allSettled([...entries.values()].map(entry => stopEntry(entry, "Application publication executor stopped", true)));
      const failures = outcomes.filter((value): value is PromiseRejectedResult => value.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(value => value.reason), "Application publication shutdown has unsettled owner or evidence delivery results");
    },
  };
}
