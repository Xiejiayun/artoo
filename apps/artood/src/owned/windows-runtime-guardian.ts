// H9 native boundary only. This module does not advertise product recovery or mint
// verifier/reviewer/publication evidence. Production lifecycle wiring is separate.
import { createHash, randomUUID } from "node:crypto";
import { readWindowsDaemonSupervisorAuthority, type PreparedWindowsDaemonSupervisorAuthority } from "../windows-supervisor-authority.js";
import { lstatSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import {
  RecoveryNodeBindingV1Schema, RecoveryEpochV1Schema, RecoveryNativeSlotV1Schema, RecoveryOperationRefV1Schema,
  ProductSourceRecoveryRegistrationV1Schema, ProductSourceRecoveryAvailabilityV1Schema, ProductSourceRecoveryRequestV1Schema,
  productSourceRecoveryRegistrationDigestV1, productSourceRecoveryRequestDigestV1,
  canonicalProductSourceTransferValueV1 as canonical,
  type RecoveryNodeBindingV1, type RecoveryEpochV1, type RecoveryOperationRefV1,
  type ProductSourceRecoveryRegistrationV1, type ProductSourceRecoveryAvailabilityV1, type ProductSourceRecoveryRequestV1,
} from "@artoo/domain";
// Installation admission also loads this module in the early service bootstrap.
// Keep unrelated transport envelope initialization out of that static graph.
import { productSourceRecoveryRegisteredSchema } from "@artoo/protocol/dist/source-recovery.js";
import { auditWindowsReleaseStorage, assertWindowsReleaseStorage, assertWindowsReleaseStorageWorkspace, type PreparedWindowsReleaseStorage } from "../windows-release-storage.js";
import { physicalWindowsDirectory, windowsPathsOverlap } from "../windows-local-acl.js";
import { assertWindowsProcessBackend, assertWindowsProcessBackendImage, invokeWindowsGuardianNative, invokeWindowsGuardianNativeSync, type PreparedWindowsProcessBackend } from "./windows-owned-process.js";

const CAPABILITY = "artoo.windows-runtime-guardian.v1";
const sha = (text: string | Uint8Array) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0");
function fail(reason: string): never { throw new Error(`Windows guardian: ${reason}`); }
function immutable<T>(input: T): T {
  const copied = structuredClone(input);
  const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(copied); return copied;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid native frame"); return input as Record<string, unknown>;
}
interface Endpoint { version: 1; capability: typeof CAPABILITY; pipeName: string; guardianInstanceId: string;
  guardianPid: number; guardianCreationTime: string; executableDigest: string }
function endpoint(input: unknown): Endpoint {
  const value = object(input);
  if (Object.keys(value).length !== 7 || value.version !== 1 || value.capability !== CAPABILITY || !uuid(value.guardianInstanceId)
    || value.pipeName !== `artoo-guardian-${value.guardianInstanceId}` || !Number.isSafeInteger(value.guardianPid)
    || (value.guardianPid as number) < 1 || (value.guardianPid as number) > 0xffffffff
    || typeof value.guardianCreationTime !== "string" || !/^\d{1,20}$/.test(value.guardianCreationTime) || !hash(value.executableDigest)) fail("invalid native endpoint");
  return Object.freeze(value) as unknown as Endpoint;
}
interface Enrollment { version: 1; endpoint: Endpoint; epochId: string; slotId: string; ticket: string }
function enrollment(input: unknown): Enrollment {
  const value = object(input);
  if (Object.keys(value).length !== 5 || value.version !== 1 || !uuid(value.epochId) || !uuid(value.slotId) || !uuid(value.ticket)) fail("invalid native reservation");
  return Object.freeze({ version: 1, endpoint: endpoint(value.endpoint), epochId: value.epochId, slotId: value.slotId, ticket: value.ticket });
}
declare const guardianBrand: unique symbol, slotBrand: unique symbol, fenceBrand: unique symbol;
export interface PreparedWindowsGuardian { readonly [guardianBrand]: true }
export interface PreparedWindowsGuardianSlot { readonly [slotBrand]: true }
export interface WindowsRecoveryFence { readonly [fenceBrand]: true }

/** Fixed local bootstrap configuration. The topology must be qualified by the caller's
 * startup implementation; this transport is not exposed through task/remote options. */
export interface WindowsGuardianLocalConfiguration {
  readonly nodeId: string; readonly deviceId: string; readonly sessionId: string;
  readonly configurationDigest: string; readonly storeDirectory: string; readonly workspaceRoot: string;
  readonly storage: PreparedWindowsReleaseStorage;
  readonly controlDirectory: string; readonly controlStorage: PreparedWindowsReleaseStorage;
  readonly supervisor: PreparedWindowsDaemonSupervisorAuthority;
  readonly topology: "supervisor-plain-daemon.v1";
}
interface GuardianState {
  backend: PreparedWindowsProcessBackend; local: WindowsGuardianLocalConfiguration; endpoint: Endpoint;
  binding: RecoveryNodeBindingV1; epoch: RecoveryEpochV1; mode: "registration" | "active" | "recovery" | "transferred";
  registration?: ProductSourceRecoveryRegistrationV1; availability?: ProductSourceRecoveryAvailabilityV1;
}
const guardians = new WeakMap<object, GuardianState>();
const backendGuardians = new WeakMap<object, PreparedWindowsGuardian>();
const retainedGuardians = new Set<PreparedWindowsGuardian>();
const reservations = new WeakMap<object, { guardian: PreparedWindowsGuardian; enrollment: Enrollment; consumed: boolean;
  operationKind: "author" | "verifier" | "browser" | "observer" | "git" | "tool" }>();
const fences = new WeakMap<object, { guardian: PreparedWindowsGuardian; request: ProductSourceRecoveryRequestV1;
  facts: Readonly<Record<string, unknown>>; consumed: boolean }>();
function localConfiguration(input: WindowsGuardianLocalConfiguration, backend: PreparedWindowsProcessBackend): WindowsGuardianLocalConfiguration {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !["nodeId", "deviceId", "sessionId", "configurationDigest", "storeDirectory", "workspaceRoot", "storage", "controlDirectory", "controlStorage", "topology", "supervisor"].includes(key))
    || !identifier(input.nodeId) || !identifier(input.deviceId) || !identifier(input.sessionId) || !hash(input.configurationDigest)
    || input.topology !== "supervisor-plain-daemon.v1") fail("invalid fixed local configuration");
  readWindowsDaemonSupervisorAuthority(input.supervisor, backend);
  const storeDirectory = physicalWindowsDirectory(input.storeDirectory), workspaceRoot = physicalWindowsDirectory(input.workspaceRoot), controlDirectory = physicalWindowsDirectory(input.controlDirectory);
  if (windowsPathsOverlap(storeDirectory, workspaceRoot) || windowsPathsOverlap(controlDirectory, workspaceRoot) || windowsPathsOverlap(controlDirectory, storeDirectory)) fail("guardian store overlaps product workspace or control audit store");
  auditWindowsReleaseStorage(input.storage, storeDirectory);
  auditWindowsReleaseStorage(input.controlStorage, controlDirectory);
  assertWindowsReleaseStorageWorkspace(input.storage, storeDirectory, workspaceRoot);
  return Object.freeze({ ...input, storeDirectory, workspaceRoot, controlDirectory });
}
function localCurrent(guardian: PreparedWindowsGuardian): GuardianState {
  const saved = guardians.get(guardian);
  if (!saved || backendGuardians.get(saved.backend) !== guardian) fail("original same-process guardian authority required");
  readWindowsDaemonSupervisorAuthority(saved.local.supervisor, saved.backend);
  assertWindowsReleaseStorage(saved.local.storage, saved.local.storeDirectory);
  assertWindowsReleaseStorage(saved.local.controlStorage, saved.local.controlDirectory);
  assertWindowsProcessBackendImage(saved.backend);
  assertWindowsReleaseStorageWorkspace(saved.local.storage, saved.local.storeDirectory, saved.local.workspaceRoot);
  if (physicalWindowsDirectory(saved.local.workspaceRoot) !== saved.local.workspaceRoot) fail("fixed workspace path changed");
  return saved;
}
function current(guardian: PreparedWindowsGuardian): GuardianState {
  const saved = localCurrent(guardian);
  assertWindowsProcessBackend(saved.backend); auditWindowsReleaseStorage(saved.local.storage, saved.local.storeDirectory); return saved;
}
/** Same-process binding only. This is not an audit bypass flag: callers receive no new
 * authority and fixed storage identities are checked before returning the original token. */
export function readWindowsGuardianLocalRuntime(guardian: PreparedWindowsGuardian) {
  const saved = localCurrent(guardian);
  return { backend: saved.backend, local: saved.local, binding: immutable(saved.binding), epoch: immutable(saved.epoch), mode: saved.mode };
}
export function windowsGuardianForBackend(backend: PreparedWindowsProcessBackend): PreparedWindowsGuardian | undefined {
  const guardian = backendGuardians.get(backend); if (guardian) localCurrent(guardian); return guardian;
}
export function hasPreparedWindowsGuardian(): boolean { return retainedGuardians.size > 0; }
export function auditWindowsGuardianRuntime(guardian: PreparedWindowsGuardian): void { current(guardian); }
function checkBinding(local: WindowsGuardianLocalConfiguration, value: RecoveryNodeBindingV1, ep: Endpoint): void {
  if (value.node_id !== local.nodeId || value.device_id !== local.deviceId || value.configuration_digest !== local.configurationDigest
    || value.workspace_root !== local.workspaceRoot || value.guardian_instance_id !== ep.guardianInstanceId) fail("native fixed binding changed");
}
async function command(saved: GuardianState, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return object(await invokeWindowsGuardianNative(saved.backend, "command", { version: 1, endpoint: saved.endpoint,
    request: { version: 1, nonce: randomUUID(), ...payload } }));
}
function retain(saved: GuardianState): PreparedWindowsGuardian {
  if (backendGuardians.has(saved.backend)) fail("backend already belongs to a guardian epoch");
  const guardian = Object.freeze({}) as PreparedWindowsGuardian; guardians.set(guardian, saved); backendGuardians.set(saved.backend, guardian); retainedGuardians.add(guardian); return guardian;
}

/** New store only. Existing owner.lock is never removed, rewritten or promoted. */
export async function bootstrapWindowsGuardian(backend: PreparedWindowsProcessBackend,
  input: WindowsGuardianLocalConfiguration): Promise<PreparedWindowsGuardian> {
  const local = localConfiguration(input, backend); assertWindowsProcessBackend(backend);
  if (backendGuardians.has(backend)) fail("backend already has a guardian");
  const result = object(await invokeWindowsGuardianNative(backend, "bootstrap", { version: 1, kind: "bootstrap", nodeId: local.nodeId,
    deviceId: local.deviceId, sessionId: local.sessionId, configurationDigest: local.configurationDigest, storeDirectory: local.storeDirectory,
    workspaceRoot: local.workspaceRoot, topology: local.topology, controlDirectory: local.controlDirectory,
    supervisorLaunchIdentityDigest: readWindowsDaemonSupervisorAuthority(local.supervisor, backend).launchIdentityDigest }));
  const ep = endpoint(result.endpoint), binding = RecoveryNodeBindingV1Schema.parse(result.binding), epoch = RecoveryEpochV1Schema.parse(result.epoch);
  checkBinding(local, binding, ep);
  if (epoch.generation !== 0 || epoch.session_id !== local.sessionId || epoch.roster_revision !== 0) fail("invalid initial guardian epoch");
  return retain({ backend, local, endpoint: ep, binding, epoch, mode: "registration" });
}

/** Recovery-only discovery precedes ordinary source runtime preparation. Disk contents
 * locate the pipe; only the newly spawned fixed native relay verifies its live identity. */
export async function reconnectWindowsGuardian(backend: PreparedWindowsProcessBackend,
  input: WindowsGuardianLocalConfiguration): Promise<PreparedWindowsGuardian> {
  const local = localConfiguration(input, backend); assertWindowsProcessBackend(backend);
  const path = win32.join(local.storeDirectory, "owner.lock"), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) fail("unsupported guardian discovery fence");
  const descriptor = object(JSON.parse(readFileSync(path, "utf8"))), after = lstatSync(path);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || descriptor.version !== 1 || descriptor.capability !== CAPABILITY) fail("old or changed owner fence cannot recover");
  const ep = endpoint(descriptor.endpoint), binding = RecoveryNodeBindingV1Schema.parse(descriptor.binding); checkBinding(local, binding, ep);
  // Placeholder epoch is never admitted: the live result below replaces it before retain.
  const live = object(await invokeWindowsGuardianNative(backend, "command", { version: 1, endpoint: ep,
    request: { version: 1, kind: "status", nonce: randomUUID() } }));
  const epoch = RecoveryEpochV1Schema.parse(live.epoch);
  if (canonical(live.binding) !== canonical(binding) || live.callerIsCurrentDaemon !== false || epoch.session_id === local.sessionId)
    fail("reconnect requires a new same-supervisor daemon and session");
  const saved: GuardianState = { backend, local, endpoint: ep, binding, epoch, mode: "recovery" };
  const guardian = retain(saved); await readWindowsGuardianAvailability(guardian); return guardian;
}

export function createWindowsGuardianRegistration(guardian: PreparedWindowsGuardian): ProductSourceRecoveryRegistrationV1 {
  const saved = localCurrent(guardian);
  if (saved.mode !== "registration") fail("epoch is not awaiting registration");
  return saved.registration ??= immutable(ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: randomUUID(), binding: saved.binding, epoch: saved.epoch }));
}
/** Called only after the current authenticated Node client receives the dedicated ACK.
 * Merely sending registration never enables target reservations. */
export async function acceptWindowsGuardianRegistration(guardian: PreparedWindowsGuardian, input: unknown): Promise<void> {
  const saved = localCurrent(guardian), message = productSourceRecoveryRegisteredSchema.parse(input), registration = saved.registration;
  if (!registration || saved.mode !== "registration" || message.payload.status !== "accepted"
    || canonical(registration.binding) !== canonical(saved.binding) || canonical(registration.epoch) !== canonical(saved.epoch)
    || message.payload.registration_id !== registration.registration_id || message.payload.session_id !== saved.local.sessionId
    || message.payload.registration_digest !== productSourceRecoveryRegistrationDigestV1(registration, sha)) fail("registration ACK differs from this current epoch");
  const result = await command(saved, { kind: "activate", epochId: saved.epoch.epoch_id, sessionId: saved.local.sessionId,
    registrationId: registration.registration_id, registrationDigest: message.payload.registration_digest });
  if (result.activated !== true) fail("native epoch activation failed"); saved.mode = "active";
}

export async function reserveWindowsGuardianSlot(guardian: PreparedWindowsGuardian, input: {
  operationKind: "author" | "verifier" | "browser" | "observer" | "git" | "tool";
  operationId: string; bindingDigest: string; serverOperation: RecoveryOperationRefV1 | null;
}): Promise<PreparedWindowsGuardianSlot> {
  const saved = current(guardian), operation = input.serverOperation === null ? null : RecoveryOperationRefV1Schema.parse(input.serverOperation);
  if (saved.mode !== "active" || !["author", "verifier", "browser", "observer", "git", "tool"].includes(input.operationKind)
    || !identifier(input.operationId) || !hash(input.bindingDigest)) fail("active registered epoch and bound operation required");
  const native = enrollment(await command(saved, { kind: "reserve", epochId: saved.epoch.epoch_id, sessionId: saved.local.sessionId,
    operationKind: input.operationKind, operationId: input.operationId, bindingDigest: input.bindingDigest,
    serverOperation: operation ? { kind: operation.kind, operationId: operation.operation_id, requestDigest: operation.request_digest, runId: operation.run_id ?? null } : null }));
  if (native.epochId !== saved.epoch.epoch_id || canonical(native.endpoint) !== canonical(saved.endpoint)) fail("native reservation changed guardian or epoch");
  const slot = Object.freeze({}) as PreparedWindowsGuardianSlot; reservations.set(slot, { guardian, enrollment: native, consumed: false, operationKind: input.operationKind }); return slot;
}

/** Fixed synchronous collectors use the current scope and original prepared backend.
 * Only physical identity checks run here; their enclosing admission owns the full ACL
 * audit. Re-entering that same audit would recursively create more collectors. */
export function reserveWindowsGuardianSlotSync(guardian: PreparedWindowsGuardian, input: {
  operationKind: "observer"; operationId: string; bindingDigest: string; serverOperation: RecoveryOperationRefV1 | null;
}): PreparedWindowsGuardianSlot {
  const saved = localCurrent(guardian), operation = input.serverOperation === null ? null : RecoveryOperationRefV1Schema.parse(input.serverOperation);
  if (saved.mode !== "active" || input.operationKind !== "observer" || !identifier(input.operationId) || !hash(input.bindingDigest))
    fail("synchronous collector requires its current active operation");
  const native = enrollment(invokeWindowsGuardianNativeSync(saved.backend, "command", { version: 1, endpoint: saved.endpoint, request: {
    version: 1, nonce: randomUUID(), kind: "reserve", epochId: saved.epoch.epoch_id, sessionId: saved.local.sessionId,
    operationKind: input.operationKind, operationId: input.operationId, bindingDigest: input.bindingDigest,
    serverOperation: operation ? { kind: operation.kind, operationId: operation.operation_id, requestDigest: operation.request_digest, runId: operation.run_id ?? null } : null,
  } }));
  if (native.epochId !== saved.epoch.epoch_id || canonical(native.endpoint) !== canonical(saved.endpoint)) fail("synchronous reservation changed guardian epoch");
  const slot = Object.freeze({}) as PreparedWindowsGuardianSlot; reservations.set(slot, { guardian, enrollment: native, consumed: false, operationKind: input.operationKind }); return slot;
}

/** Bridge-only consumption. Binding a backend disables all unregistered process starts. */
export function consumeWindowsGuardianSlot(backend: PreparedWindowsProcessBackend, slot: PreparedWindowsGuardianSlot | undefined, cwd: string,
  expectedOperationKind?: "observer"): Enrollment | undefined {
  const guardian = backendGuardians.get(backend);
  if (!guardian) { if (slot !== undefined) fail("slot belongs to a different backend"); return undefined; }
  const saved = localCurrent(guardian), reservation = slot && reservations.get(slot);
  const relative = win32.relative(saved.local.workspaceRoot, physicalWindowsDirectory(cwd));
  if (saved.mode !== "active" || !reservation || reservation.guardian !== guardian || reservation.consumed
    || expectedOperationKind !== undefined && reservation.operationKind !== expectedOperationKind
    || reservation.enrollment.epochId !== saved.epoch.epoch_id || win32.isAbsolute(relative) || relative === ".." || relative.startsWith("..\\"))
    fail("original unused registered launch slot in the fixed workspace required");
  reservation.consumed = true; return reservation.enrollment;
}

export async function readWindowsGuardianAvailability(guardian: PreparedWindowsGuardian): Promise<ProductSourceRecoveryAvailabilityV1> {
  const saved = localCurrent(guardian); if (saved.mode !== "recovery") fail("only recovery-only mode can reconcile old epochs");
  const live = await command(saved, { kind: "status" }), epoch = RecoveryEpochV1Schema.parse(live.epoch);
  if (canonical(live.binding) !== canonical(saved.binding) || epoch.epoch_id !== saved.epoch.epoch_id || epoch.session_id !== saved.epoch.session_id
    || live.callerIsCurrentDaemon !== false || !uuid(live.registrationId)) fail("live previous registered epoch changed");
  saved.epoch = epoch;
  const base = { version: 1 as const, registration_id: live.registrationId, binding: saved.binding, previous_epoch: epoch, current_session_id: saved.local.sessionId };
  const available = immutable(ProductSourceRecoveryAvailabilityV1Schema.parse(live.frozen === true && live.closed === true
    ? { ...base, state: "recoverable", new_daemon_identity_digest: live.newDaemonIdentityDigest, operations: live.operations }
    : { ...base, state: "unknown", reason: "The surviving guardian has not confirmed every old host, root, Job and pipe closed with terminal ACK." }));
  saved.availability = available; return available;
}

/** A fence proves old writers closed. It carries no passed verifier, accepted product
 * review, workspace snapshot or publication permission. */
export async function transferWindowsGuardianEpoch(guardian: PreparedWindowsGuardian, input: unknown): Promise<WindowsRecoveryFence> {
  const saved = localCurrent(guardian), request = ProductSourceRecoveryRequestV1Schema.parse(input), available = saved.availability;
  if (saved.mode !== "recovery" || available?.state !== "recoverable" || request.registration_id !== available.registration_id
    || canonical(request.binding) !== canonical(available.binding) || canonical(request.previous_epoch) !== canonical(available.previous_epoch)
    || canonical(request.operations) !== canonical(available.operations) || request.current_session_id !== saved.local.sessionId
    || request.new_daemon_identity_digest !== available.new_daemon_identity_digest) fail("current authorized recovery request changed the live complete roster");
  const requestDigest = productSourceRecoveryRequestDigestV1(request, sha);
  const facts = await command(saved, { kind: "transfer", epochId: request.previous_epoch.epoch_id, sessionId: request.current_session_id,
    challengeId: request.challenge_id, requestDigest, expectedRosterRevision: request.previous_epoch.roster_revision,
    expectedRosterDigest: request.previous_epoch.roster_digest, expectedNewDaemonIdentityDigest: request.new_daemon_identity_digest });
  const next = RecoveryEpochV1Schema.parse(facts.epoch);
  if (canonical(facts.binding) !== canonical(request.binding) || facts.oldEpochId !== request.previous_epoch.epoch_id
    || !uuid(facts.newEpochId) || facts.newEpochId === facts.oldEpochId || next.epoch_id !== facts.newEpochId
    || facts.generation !== request.previous_epoch.generation + 1 || next.generation !== facts.generation
    || next.session_id !== request.current_session_id || next.roster_revision !== 0 || facts.currentSessionId !== request.current_session_id
    || facts.newDaemonIdentityDigest !== request.new_daemon_identity_digest || facts.challengeId !== request.challenge_id || facts.requestDigest !== requestDigest
    || facts.rosterRevision !== request.previous_epoch.roster_revision || facts.rosterDigest !== request.previous_epoch.roster_digest
    || !Array.isArray(facts.slots) || facts.slots.length > 4096 || !hash(facts.closureSetDigest)
    || sha(JSON.stringify(facts.slots)) !== facts.closureSetDigest || canonical(facts.operations) !== canonical(request.operations)) fail("native transfer changed complete request binding");
  const slots = facts.slots.map(value => RecoveryNativeSlotV1Schema.parse(value));
  if (new Set(slots.map(slot => slot.slot_id)).size !== slots.length) fail("native closure roster repeats a slot");
  const fence = Object.freeze({}) as WindowsRecoveryFence;
  fences.set(fence, { guardian, request: immutable(request), facts: immutable(facts), consumed: false });
  saved.epoch = next; saved.mode = "registration"; saved.registration = undefined; saved.availability = undefined; return fence;
}

/** Only a future protected recovered-workspace factory may consume this authority.
 * A JSON clone, old epoch, another backend or repeated consumption is rejected. */
export function consumeWindowsRecoveryFence(guardian: PreparedWindowsGuardian, fence: WindowsRecoveryFence): Readonly<Record<string, unknown>> {
  const saved = localCurrent(guardian), owner = fences.get(fence);
  if (!owner || owner.guardian !== guardian || owner.consumed || owner.facts.newEpochId !== saved.epoch.epoch_id
    || owner.request.current_session_id !== saved.local.sessionId) fail("original unused current recovery fence required");
  owner.consumed = true; return owner.facts;
}
