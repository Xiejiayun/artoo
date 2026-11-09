// Controlled original native owners only. This suite is not Windows, SQLite,
// live-provider, HTTP health, business acceptance or product publication evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { ApplicationInstallationPlan } from "./application-installation.js";
import type { ApplicationPublicationExecutionFacts, PreparedApplicationPublicationExecution } from "./application-publication-acceptance.js";
import type { OriginalTargetInputReceipt, OriginalTargetControlReceipt, WindowsOwnedClosureReceipt } from "./owned/windows-owned-process.js";
import { registerApplicationPublicationResources, claimApplicationPublicationResources, withApplicationPublicationAuditScope,
  releaseApplicationPublicationResources, assertApplicationPublicationAuditAvailable,
  type ApplicationPublicationReservation } from "./application-publication-coordination.js";
const state = vi.hoisted(() => ({ start: vi.fn(), execution: vi.fn(), profile: vi.fn(), application: vi.fn(), candidate: vi.fn(),
  owner: vi.fn(), audit: vi.fn(), pin: vi.fn(), native: vi.fn(), realpath: vi.fn(), scope: vi.fn(), reserve: vi.fn(), receipt: vi.fn(), input: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("No direct process launch"); } }));
vi.mock("node:path", async original => { const actual = await original<typeof import("node:path")>(); return { ...actual, ...actual.win32 }; });
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), realpathSync: { native: state.realpath } }));
vi.mock("./application-publication-acceptance.js", () => ({ readApplicationPublicationExecution: state.execution }));
vi.mock("./application-publication-profile.js", () => ({ readApplicationPublicationProfile: state.profile }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: state.application }));
vi.mock("./application-verification-candidate.js", () => ({ readApplicationVerificationCandidate: state.candidate }));
vi.mock("./application-installation.js", () => ({ createApplicationInstallationOwner: state.owner, auditApplicationInstallation: state.audit }));
vi.mock("./application-runtime-installation.js", () => ({ readApplicationRuntimePin: state.pin }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: state.native }));
vi.mock("./owned/windows-owned-process.js", () => ({ startWindowsOwnedProcess: state.start,
  isWindowsOwnedClosureReceipt: state.receipt, isWindowsOwnedTargetControlReceipt: state.input }));
vi.mock("./owned/windows-guardian-scope.js", () => ({ readWindowsGuardianOperation: state.scope, WINDOWS_GUARDIAN_JOB_BOUNDARY: "atomic-job-subtree.v1" }));
vi.mock("./owned/windows-runtime-guardian.js", () => ({ reserveWindowsGuardianSlot: state.reserve }));
import { prepareApplicationPublicationProcess, initializeApplicationPublicationProcess, readInitializedApplicationPublication,
  readApplicationPublicationProcessState, readApplicationPublicationProcessFailure,
  startApplicationPublicationService as startOriginalService } from "./application-publication-process.js";
import { decodeApplicationPublicationControlCommand } from "./application-publication-control-protocol.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const pin = (path: string) => ({ path, bytes: 42, sha256: sha(path) });
const root = "C:\\publication-controlled", origin = "http://127.0.0.1:31000";
const generation = "11111111-1111-4111-8111-111111111111";
const directory = win32.join(root, "deployments", generation, "code"), storage = win32.join(root, "deployments", generation, "store");
const reference = pin(win32.join(root, "deployments", generation, "control", "REOPEN.v1.json"));
const manifest = pin(win32.join(root, "candidate", "application-install-package.json"));
const identity = { version: 1, subject_digest: sha("subject"), source_digest: sha("source"), artifact_digest: sha("artifact"),
  toolchain_digest: sha("toolchain"), package_digest: manifest.sha256, schema_digest: sha("schema"), qualified_for_product: false };
const scope = { product_id: "project1", data_generation: "candidate-data-generation", service_generation: 1, artifact_digest: identity.artifact_digest };
const application = { config: { node: pin(win32.join(root, "node", "node.exe")), hostManifest: pin(win32.join(root, "host", "application-service-host-manifest.json")) },
  hostEntry: pin(win32.join(root, "host", "application-service-bootstrap.mjs")) };
const profile = { config: { deployment_parent: win32.join(root, "deployments"), selection_parent: win32.join(root, "selections"), origin,
  limits: { root_lifetime_ms: 60_000 } }, roots: [win32.join(root, "workspace")] };
const provenance = () => ({ version: 1, format: "artoo.application-installation-relocation.v1", scope: "fixed-configuration-plan-only",
  source: { manifest, directory: win32.join(root, "candidate"), storage_directory: win32.join(root, "candidate-store"),
    profile: pin(win32.join(root, "candidate", "profile.json")), plan_digest: sha("source-plan") },
  target: { generation_id: generation, directory, storage_directory: storage, profile: pin(win32.join(directory, "profile.json")), plan_digest: sha("target-plan") },
  rewritten: ["runtime", "broker-create", "broker-open", "service-profile"].map(role => ({ role, path: role + ".json",
    source: { bytes: 10, sha256: sha(role) }, target: { bytes: 10, sha256: sha(role + "target") } })), retained: [],
  preserved: { source_members_digest: sha("source-members"), artifact_members_digest: sha("artifacts"), toolchain_members_digest: sha("tools"),
    runtime_expectation_digest: sha("expectation"), schema_json_digest: identity.schema_digest, http_digest: sha("http"), http_origin: origin,
    maximum_access: "write", candidate_scope: scope } });
function initialized() { return { version: 1, kind: "application-publication.initialized", reference, provenance: provenance(),
  installation: { version: 1, generation_id: generation, reference, database: { path: win32.join(storage, "application.sqlite"), dev: "1", ino: "77" },
    scope, schema_digest: identity.schema_digest, origin, client_entry_digest: sha("client") },
  closure: { version: 1, scope: "original-native-owners", create_broker_normal: true, installation_audited: true, session_released: true } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let nativeReceipts = new WeakSet<object>(), inputReceipts = new WeakSet<object>();
class Child extends EventEmitter {
  readonly pid = 1234; readonly creationTime = "133806600000000000"; readonly token = randomUUID();
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly started = Promise.resolve({ pid: this.pid, creationTime: this.creationTime });
  readonly done = deferred<WindowsOwnedClosureReceipt>(); readonly closed = this.done.promise;
  readonly cancel = vi.fn(); complete = false; written?: Buffer; forgedInput = false;
  readonly controlReceipts: OriginalTargetControlReceipt[] = []; readonly controlCommands: ReturnType<typeof decodeApplicationPublicationControlCommand>[] = [];
  used = 0; autoControl = true;
  readonly writeControl = vi.fn(async (value: Uint8Array, options: { final: boolean }) => {
    const command = decodeApplicationPublicationControlCommand(Buffer.from(value).toString("utf8")); this.controlCommands.push(command);
    const receipt: OriginalTargetControlReceipt = Object.freeze({ version: 1, token: this.token, requestId: randomUUID(), sequence: command.sequence,
      bytesWritten: value.length, sha256: sha(value), final: options.final, inputClosed: options.final });
    this.controlReceipts.push(receipt); if (!this.forgedInput) inputReceipts.add(receipt);
    if (this.autoControl && command.kind !== "drain") this.control(command.kind === "probe" ? "probe-ready" : command.kind === "resume" ? "resumed" : "quiesced");
    return receipt;
  });
  control(state: "quiesced" | "probe-ready" | "resumed") {
    const command = this.controlCommands.at(-1)!;
    this.send({ version: 1, kind: "application-publication.control", identity: command.identity, sequence: command.sequence, cycle: command.cycle, state,
      counters: { observed_at: new Date().toISOString(), requests_used: this.used, in_flight: 0, closed_transports: this.used },
      closure: { version: 1, scope: "original-native-owners", invocations: 0, runtime_normal_closures: 0, broker_normal_closures: 0 } });
  }
  readonly endInput = vi.fn(async (value: Uint8Array) => {
    this.written = Buffer.from(value);
    const receipt: OriginalTargetInputReceipt = Object.freeze({ version: 1, token: this.token, requestId: this.token,
      bytesWritten: value.length, sha256: sha(value), inputClosed: true });
    if (!this.forgedInput) inputReceipts.add(receipt); return receipt;
  });
  readonly observeMembers = vi.fn(async (members: { pid: number; creationTime: string }[]) => ({ version: 1, token: this.token,
    requestId: randomUUID(), observedElapsedMs: 1, members: members.map(member => ({ ...member, status: "observed", jobMember: true })) }));
  send(value: unknown) { this.stdout.write(Buffer.from(JSON.stringify(value) + "\n")); }
  close(changes: Partial<WindowsOwnedClosureReceipt> = {}) {
    if (this.complete) return; this.complete = true; this.stdout.end(); this.stderr.end();
    const receipt = Object.freeze({ version: 1, token: this.token, elapsedMs: 1, rootCreated: true, rootStarted: true,
      rootPid: this.pid, rootCreationTime: this.creationTime, atomicJobMember: true, rootWaitObserved: true, rootExitCode: 0,
      stdoutEof: true, stderrEof: true, jobEmptyObserved: true, noTargetCreated: false, terminationReason: null,
      nativeTerminationReason: null, failureCode: null, nativeError: null, outputBytesObserved: 0, outputBytesCaptured: 0,
      helperSpawnObserved: true, helperExitObserved: true, helperCloseObserved: true, helperExitCode: 0, helperSignal: null, cleanupConfirmed: true,
      targetInput: { version: 1, pipeCreated: true, writeRequested: !!this.written, requestId: this.written ? this.token : null,
        bytesWritten: this.written?.length ?? 0, inputClosed: true },
      targetControl: { version: 1, pipeCreated: true, messagesRequested: this.controlReceipts.length, messagesAcknowledged: this.controlReceipts.length,
        bytesWritten: this.controlReceipts.reduce((sum, ack) => sum + ack.bytesWritten, 0), inputClosed: true,
        finalAcknowledgement: this.controlReceipts.at(-1)?.final ? (() => { const { version: _version, token: _token, ...last } = this.controlReceipts.at(-1)!; return last; })() : null },
      ...changes } as WindowsOwnedClosureReceipt);
    nativeReceipts.add(receipt); this.done.resolve(receipt);
  }
}
const children: Child[] = [], plans: ApplicationInstallationPlan[] = [], tasks: Promise<unknown>[] = [];
let execution: PreparedApplicationPublicationExecution, facts: ApplicationPublicationExecutionFacts, controller: AbortController;
let reservation: ApplicationPublicationReservation;
const startApplicationPublicationService: typeof startOriginalService = token => withApplicationPublicationAuditScope(reservation, () => startOriginalService(token));
const observe = <T>(work: Promise<T>) => { tasks.push(work); void work.catch(() => {}); return work; };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function selection(index = plans.length - 1) {
  const member = plans[index]!.files.find(file => file.path === "selection.json")!;
  if (!("content" in member)) throw Error("controlled selection missing"); return JSON.parse(Buffer.from(member.content).toString("utf8"));
}
function begin() {
  const now = new Date(), deadline = performance.now() + 60_000;
  const lease = { version: 1 as const, lease_id: "lease1", publication_id: "publication1", request_digest: facts.requestDigest,
    publisher_session_id: "session1", admitted_at: now.toISOString(), deadline_at: new Date(now.getTime() + 60_000).toISOString(), root_lifetime_ms: 60_000 };
  const work = observe(withApplicationPublicationAuditScope(reservation,
    () => initializeApplicationPublicationProcess(execution, { lease, deadline, signal: controller.signal, reservation })));
  return { work, child: children.at(-1)!, deadline };
}
async function store() { const started = begin(); started.child.send(initialized()); started.child.close(); return started.work; }
function listening(child: Child) { child.send({ version: 1, kind: "application-publication.listening", identity: selection().publication.identity,
  preflight: { existing_database: true, process_exit_confirmed: true }, counters: { observed_at: new Date().toISOString(), requests_used: 0, in_flight: 0, closed_transports: 0 },
  maximum_requests: 256, maximum_concurrent: 1, control: { version: 1, kind: "application-publication.control", identity: selection().publication.identity,
    sequence: -1, cycle: 0, state: "quiesced", counters: { observed_at: new Date().toISOString(), requests_used: 0, in_flight: 0, closed_transports: 0 },
    closure: { version: 1, scope: "original-native-owners", invocations: 0, runtime_normal_closures: 0, broker_normal_closures: 0 } } }); }
function drained(child: Child, selected = selection()) { child.send({ version: 1, kind: "application-publication.closed", identity: selected.publication.identity,
  reason: "stdin-drain", counters: { observed_at: new Date().toISOString(), requests_used: 0, in_flight: 0, closed_transports: 0 },
  closure: { version: 1, scope: "original-native-owners", invocations: 0, runtime_normal_closures: 0, broker_normal_closures: 0,
    listener_closed: true, preflight_normal: true, installation_audited: true, session_released: true } }); }
function progress(child: Child, used: number, active: number, closedTransports: number) {
  child.used = used;
  child.send({ version: 1, kind: "application-publication.progress", identity: selection().publication.identity,
    counters: { observed_at: new Date().toISOString(), requests_used: used, in_flight: active, closed_transports: closedTransports } });
}
async function running() {
  const token = await store(), work = observe(startApplicationPublicationService(token)), child = children.at(-1)!;
  listening(child); const service = await work; return { token, service, child };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const mock of Object.values(state)) mock.mockReset();
  execution = Object.freeze({}) as PreparedApplicationPublicationExecution; controller = new AbortController();
  facts = Object.freeze({ candidate: {}, publicationProfile: {}, applicationProfile: {}, backend: {}, definition: { persistence: { read: { path: "/api/items" } } }, requestDigest: sha("request"),
    request: { publication_id: "publication1", computer_id: "computer1", publisher_session_id: "session1", project_id: "project1",
      capabilities: { contract: { limits: { health_timeout_ms: 10_000, normal_drain_reserve_ms: 20_000 } } },
      author: { candidate: identity, test_store_id: "author-test" }, reviewer: { test_store_id: "reviewer-test" } } }) as unknown as ApplicationPublicationExecutionFacts;
  registerApplicationPublicationResources(facts.publicationProfile, { id: "profile", workspace: `${root}\\${randomUUID()}`, verifier: {}, directories: [] });
  reservation = claimApplicationPublicationResources(facts.publicationProfile);
  nativeReceipts = new WeakSet(); inputReceipts = new WeakSet();
  state.execution.mockImplementation(value => { if (value !== execution) throw Error("Original execution required"); return facts; });
  state.profile.mockReturnValue(profile); state.application.mockReturnValue(application); state.candidate.mockReturnValue({ manifest, identity });
  state.native.mockReturnValue({ directory: win32.join(root, "native"), manifestSha256: sha("native") }); state.realpath.mockReturnValue("C:\\Windows");
  state.pin.mockReturnValue(Buffer.from("original bytes")); state.receipt.mockImplementation(value => nativeReceipts.has(value));
  state.input.mockImplementation(value => inputReceipts.has(value));
  state.owner.mockImplementation(() => ({ generationId: randomUUID(), directory: win32.join(root, "selections", String(plans.length)),
    install: (plan: ApplicationInstallationPlan) => { plans.push(plan); return Object.freeze({}); }, describeAttempt: () => ({ phase: "claimed" }), abandon: vi.fn() }));
  state.start.mockImplementation(() => { const child = new Child(); children.push(child); return child; });
});
afterEach(async () => {
  for (const child of children) child.close({ rootExitCode: 1, helperExitCode: 1 });
  await Promise.allSettled(tasks);
  if (!readApplicationPublicationProcessState(execution).unsettled_owner_ids.length) releaseApplicationPublicationResources(reservation);
  children.length = 0; plans.length = 0; tasks.length = 0; vi.clearAllTimers(); vi.useRealTimers();
});
describe("bounded publication original process ownership", () => {
  it("keeps audits excluded until the original pause acknowledgement and retains captured observation", async () => {
    const live = await running(); await withApplicationPublicationAuditScope(reservation, () => live.service.resume());
    expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(facts.publicationProfile))).toThrow(/quiescent/);
    const reads = state.execution.mock.calls.length; await live.service.observe(); expect(state.execution).toHaveBeenCalledTimes(reads);
    live.child.autoControl = false; const paused = observe(live.service.quiesce()); await tick();
    expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(facts.publicationProfile))).toThrow(/quiescent/);
    await vi.advanceTimersByTimeAsync(10_001); expect(live.child.cancel).not.toHaveBeenCalled();
    live.child.control("quiesced"); await paused;
    expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(facts.publicationProfile))).not.toThrow();
  });
  it("waits for the one-shot probe owner settlement before admitting another full audit", async () => {
    const live = await running(); let requested = false;
    const probe = observe(withApplicationPublicationAuditScope(reservation, () => live.service.runProbe("/api/items", async headers => {
      expect(headers["x-artoo-publication-control-probe"]).toMatch(/^[a-f0-9-]{36}$/u); requested = true; return "read-only result";
    })));
    await tick(); expect(requested).toBe(true);
    expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(facts.publicationProfile))).toThrow(/quiescent/);
    live.child.used++; live.child.control("quiesced"); await expect(probe).resolves.toBe("read-only result");
    expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(facts.publicationProfile))).not.toThrow();
  });
  it("denies resume when original authorization changes during quiescence", async () => {
    const live = await running(); state.execution.mockImplementation(() => { throw Error("Original execution revoked"); });
    await expect(withApplicationPublicationAuditScope(reservation, () => live.service.resume())).rejects.toThrow(/revoked/);
    expect(live.child.writeControl).not.toHaveBeenCalled(); expect(live.child.cancel).toHaveBeenCalledOnce();
  });
  it("initializes a distinct protected deployment and keeps legacy stores outside the publication protocol", async () => {
    const start = begin(); expect(selection()).toMatchObject({ format: "artoo.application-publication-initialize-selection.v1",
      installation_parent: profile.config.deployment_parent, source_manifest: manifest });
    start.child.send(initialized()); await tick(); expect(start.child.endInput).not.toHaveBeenCalled();
    expect(readApplicationPublicationProcessState(execution).unsettled_owner_ids).toHaveLength(1);
    start.child.close(); const token = await start.work;
    expect(readInitializedApplicationPublication(token)).toMatchObject({ execution, deadline: start.deadline,
      deployment: { deployment_generation: generation, data_generation: scope.data_generation, database_identity: { device: "1", inode: "77" } } });
    expect(() => readInitializedApplicationPublication({ ...token })).toThrow("Original");
    await expect(initializeApplicationPublicationProcess(execution, {} as never)).rejects.toThrow("already initialized");
  });
  it("requires actual normal first closure, reopens once with the same descriptor, and retains the second owner live", async () => {
    const first = await running(); const firstSelection = selection(), draining = observe(first.service.drain());
    await tick(); expect(first.child.writeControl).toHaveBeenCalledOnce(); expect(first.child.controlCommands[0]!.kind).toBe("drain");
    drained(first.child); await tick();
    await expect(startApplicationPublicationService(first.token)).rejects.toThrow("exactly one normal");
    first.child.close(); expect(await draining).toMatchObject({ kind: "normal-drain", service: first.service.identity });
    const work = observe(startApplicationPublicationService(first.token)), second = children.at(-1)!;
    expect(selection().installation_reference).toEqual(firstSelection.installation_reference); listening(second); const service = await work;
    expect(service.generation).toBe(2); expect(second.complete).toBe(false); expect(second.cancel).not.toHaveBeenCalled();
    expect(await service.observe()).toMatchObject({ closed: false, native: { observed: true, job_member: true } });
    expect(second.observeMembers).toHaveBeenCalledWith([{ pid: second.pid, creationTime: second.creationTime }], expect.any(Number));
    await expect(startApplicationPublicationService(first.token)).rejects.toThrow("exactly one normal");
    expect(children).toHaveLength(3);
    const budgets = state.start.mock.calls.map(call => call[1].timeoutMs as number);
    expect(budgets[1]).toBeLessThanOrEqual(budgets[0]!); expect(budgets[2]).toBeLessThanOrEqual(budgets[1]!);
  });
  it("rejects forged input ACK while recording the actual original root closure", async () => {
    const live = await running(); live.child.forgedInput = true;
    const stopping = observe(live.service.drain()); await tick(); drained(live.child); live.child.close();
    await expect(stopping).rejects.toThrow("normal drain");
    expect(await live.service.closed).toMatchObject({ kind: "aborted" });
    expect(readApplicationPublicationProcessState(execution)).toMatchObject({ unsettled_owner_ids: [], closed_owners: [
      { generation: 0, process_exit_confirmed: true }, { generation: 1, process_exit_confirmed: true } ] });
    await expect(startApplicationPublicationService(live.token)).rejects.toThrow("exactly one normal");
  });
  it("waits for the original stdout admissions and idle counter fact without inventing health requests", async () => {
    const live = await running(); await live.service.resume();
    const waiting = observe(live.service.waitForRequestCounters(2,
      { deadline: performance.now() + 10_000, signal: controller.signal }));
    let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
    await tick(); expect(settled).toBe(false);
    progress(live.child, 2, 1, 1); await tick(); expect(settled).toBe(false);
    progress(live.child, 2, 0, 2);
    await tick(); expect(settled).toBe(false); await live.service.quiesce();
    expect(await waiting).toMatchObject({ requests_used: 2, in_flight: 0, closed_transports: 2 });
    expect(live.child.endInput).not.toHaveBeenCalled(); expect(children).toHaveLength(2);
  });
  it("bounds the original counter barrier by the supplied health deadline and observes independent cancellation", async () => {
    const live = await running(), signal = new AbortController();
    const timeout = observe(live.service.waitForRequestCounters(2, { deadline: performance.now() + 100, signal: signal.signal }));
    await vi.advanceTimersByTimeAsync(101); await expect(timeout).rejects.toThrow("counter deadline");
    const cancelled = observe(live.service.waitForRequestCounters(2, { deadline: performance.now() + 10_000, signal: signal.signal }));
    signal.abort(Error("health cancelled")); await expect(cancelled).rejects.toThrow("health cancelled");
    expect(live.child.endInput).not.toHaveBeenCalled(); expect(live.child.cancel).not.toHaveBeenCalled();
  });
  it("does not satisfy a pending counter barrier after the original owner closes", async () => {
    const live = await running(), waiting = observe(live.service.waitForRequestCounters(2,
      { deadline: performance.now() + 10_000, signal: controller.signal }));
    live.child.close({ rootExitCode: 1 }); await expect(waiting).rejects.toThrow(/owner (?:stopped|closed)/u);
    expect((await live.service.closed).kind).toBe("aborted");
  });
  it("keeps original drain and closure facts readable after session revocation while denying probes and new owners", async () => {
    const live = await running(); state.execution.mockImplementation(() => { throw Error("Original session revoked"); });
    await expect(live.service.observe()).resolves.toMatchObject({ closed: false });
    const stopping = observe(live.service.drain()); await tick(); drained(live.child); live.child.close();
    expect(await stopping).toMatchObject({ kind: "normal-drain" });
    expect(readApplicationPublicationProcessState(execution).unsettled_owner_ids).toEqual([]);
    await expect(startApplicationPublicationService(live.token)).rejects.toThrow("revoked");
  });
  it.each([{ jobEmptyObserved: false }, { rootWaitObserved: false }, { stdoutEof: false }, { stderrEof: false },
    { helperCloseObserved: false }, { rootPid: 4321 }, { rootCreationTime: "1" }])("retains uncertain original owners for %j", async changes => {
    const start = begin(); start.child.send(initialized()); start.child.close(changes);
    const error = await start.work.catch(error => error);
    expect(readApplicationPublicationProcessFailure(error, execution)).toMatchObject({ closed_owners: [], unsettled_owner_ids: [expect.any(String)] });
    expect(() => readApplicationPublicationProcessFailure({ ...error }, execution)).toThrow("Original");
  });
  it("joins the original startup owner after cancellation before rejecting the caller", async () => {
    const token = await store(), work = observe(startApplicationPublicationService(token)), child = children.at(-1)!;
    let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
    controller.abort(Error("cancel startup")); await tick();
    expect(child.cancel).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    expect(readApplicationPublicationProcessState(execution).unsettled_owner_ids).toHaveLength(1);
    child.close({ rootExitCode: 1 }); await expect(work).rejects.toThrow("cancel startup");
    expect(readApplicationPublicationProcessState(execution).unsettled_owner_ids).toEqual([]);
  });
  it("records known empty admission before profile failure and does not infer unknown objects are closed", async () => {
    prepareApplicationPublicationProcess(execution); state.profile.mockImplementation(() => { throw Error("profile changed"); });
    const start = begin(); await expect(start.work).rejects.toThrow("profile changed");
    state.execution.mockImplementation(() => { throw Error("session ended"); });
    expect(readApplicationPublicationProcessState(execution)).toEqual({ closed_owners: [], unsettled_owner_ids: [] });
    expect(() => readApplicationPublicationProcessState({} as PreparedApplicationPublicationExecution)).toThrow("Original");
    expect(state.start).not.toHaveBeenCalled();
  });
  it("rejects legacy verifier status and binds the failure to its original execution", async () => {
    const start = begin(); start.child.send({ version: 1, kind: "application-service.initialized", qualified_for_product: false });
    expect(start.child.cancel).toHaveBeenCalledOnce(); start.child.close({ rootExitCode: 1 });
    const error = await start.work.catch(error => error);
    expect(readApplicationPublicationProcessFailure(error, execution).closed_owners).toHaveLength(1);
  });
});
