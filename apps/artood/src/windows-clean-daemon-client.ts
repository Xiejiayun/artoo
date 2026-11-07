import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProductSourceTransferValueV1 as canonical, SourceLifecycleRegistrationV1Schema,
  inspectSourceCleanCheckpointV1, inspectSourceCleanValidationOriginV1, sourceCleanDigestV1,
  importedExecutionAcceptedInputsV1, inspectProductSourceVerificationEnvelope,
  type ProductSourceRecoveryRegistrationV1, type SourceSupervisorLaunchV1, type SourceLifecycleRegistrationV1,
  type SourceCleanRestartGrantV1, type SourceCleanRestartCheckpointV1, type SourceCleanRestartReceiptV1,
  type SourceCleanValidationOriginV1, type ProductResearchReport } from "@artoo/domain";
import { sourceLifecycleRegisteredCommandSchema, sourceCleanCheckpointCommittedCommandSchema,
  sourceLifecycleRejectedCommandSchema, type NodeSideTransport, type ServerToNodeMessage } from "@artoo/protocol";
import { readWindowsGuardianLocalRuntime, type PreparedWindowsGuardian } from "./owned/windows-runtime-guardian.js";
import { readWindowsRecoverySourceRuntime, withWindowsSourceRecoveryOperation, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { readCleanGuardianProductSourceConfiguration } from "./product-source-runtime.js";
import { readProductFile } from "./product-stage.js";
import { subjectManifest, assertLocallyPreparedVerificationProfile, type PreparedVerificationProfile } from "./verification.js";
import { retainImportedValidationBaseline, assertImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
import { describeCleanDaemonLaunch, readCleanDaemonQuarantine, readCleanDaemonVerificationProfile,
  type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import { physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sourceCleanDigestV1(value, sha);
function immutable<T>(input: T): T {
  const value = structuredClone(input), freeze = (part: unknown): void => {
    if (part && typeof part === "object") { Object.values(part).forEach(freeze); Object.freeze(part); }
  }; freeze(value); return value;
}
function writeOnce(file: string, value: unknown): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
declare const checkpointBrand: unique symbol;
export interface PreparedCleanDaemonCheckpoint { readonly [checkpointBrand]: true }
interface Checkpoint {
  assertCurrent(): void; grant: SourceCleanRestartGrantV1; checkpoint: SourceCleanRestartCheckpointV1; receipt: SourceCleanRestartReceiptV1;
  runtime: PreparedWindowsSourceRecoveryRuntime; guardian: PreparedWindowsGuardian; configuration: PreparedCleanDaemonConfiguration;
  profile: PreparedVerificationProfile; baseline: PreparedValidationBaseline; research: Buffer; design: Buffer;
  effectivePlan: ProductResearchReport["measurement_plan"]; paths: { file: string; digest: string }[];
  restart?: SourceCleanValidationOriginV1;
}
const checkpoints = new WeakMap<object, Checkpoint>();
function checkpointState(token: PreparedCleanDaemonCheckpoint): Checkpoint {
  const saved = checkpoints.get(token); if (!saved) throw Error("Original accepted clean daemon checkpoint required");
  saved.assertCurrent(); assertLocallyPreparedVerificationProfile(saved.profile); assertImportedValidationBaseline(saved.baseline);
  for (const pin of saved.paths) if (sha(readFileSync(pin.file)) !== pin.digest) throw Error("Clean daemon checkpoint history changed");
  if (!readProductFile(saved.profile.workspace_root, ".artoo/product/research.json").equals(saved.research)
    || !readProductFile(saved.profile.workspace_root, ".artoo/product/design.json").equals(saved.design))
    throw Error("Clean daemon accepted research or design changed");
  return saved;
}
/** Consumer only. There is no exported JSON-to-checkpoint producer. No source
 * runtime, parent observer, surviving-Guardian fence or release permit escapes. */
export function readCleanDaemonCheckpoint(token: PreparedCleanDaemonCheckpoint) {
  const saved = checkpointState(token);
  return Object.freeze({ grant: saved.grant, checkpoint: saved.checkpoint, receipt: saved.receipt,
    profile: saved.profile, baseline: saved.baseline, research: Buffer.from(saved.research), design: Buffer.from(saved.design),
    effectivePlan: immutable(saved.effectivePlan), assertCurrent: () => { checkpointState(token); } });
}

/** Internal execution consumer: both original objects must belong to this daemon.
 * It does not interpret disk metadata or create a release/verification permit. */
export function readCleanDaemonCheckpointSource(token: PreparedCleanDaemonCheckpoint, runtime: PreparedWindowsSourceRecoveryRuntime) {
  const saved = checkpointState(token);
  if (saved.runtime !== runtime) throw Error("Clean checkpoint does not belong to this original source runtime");
  const source = readCleanGuardianProductSourceConfiguration(readWindowsRecoverySourceRuntime(runtime), saved.guardian, saved.configuration);
  const lineage = readCleanDaemonQuarantine(saved.configuration);
  if (!lineage.predecessor_operations) throw Error("Clean validation source lost its retained original stop operation set");
  return { ...source, guardian: saved.guardian, epochId: saved.checkpoint.lifecycle_registration.registration.epoch.epoch_id,
    predecessorOperations: immutable(lineage.predecessor_operations) };
}
export function readAcceptedCleanDaemonOrigin(token: PreparedCleanDaemonCheckpoint): SourceCleanValidationOriginV1 {
  const saved = checkpointState(token);
  if (!saved.restart) throw Error("Clean validation requires its current Server settlement and original checkpoint receipt");
  return saved.restart;
}

/** Created by the recovery client's actual original-registration handler. The
 * original Guardian must already have consumed its ordinary registration ACK;
 * the separate clean ACK and (for successors) checkpoint ACK gate activation.
 * bindParent writes/awaits the existing private daemon pipe and grants no work. */
export function createWindowsCleanDaemonClient(options: { configuration: PreparedCleanDaemonConfiguration;
  guardian: PreparedWindowsGuardian; runtime: PreparedWindowsSourceRecoveryRuntime;
  registration: ProductSourceRecoveryRegistrationV1; transport: NodeSideTransport; isCurrent(): boolean;
  bindParent(launch: SourceSupervisorLaunchV1): Promise<void>; onReady(): void; onFailure(error: Error): void }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Clean lifecycle requires the original committed execution transport");
  const registration = immutable(options.registration);
  const descriptor = { operationId: "clean-lifecycle-" + registration.registration_id,
    bindingDigest: hash(registration), serverOperation: null };
  // These public lifecycle entry points run before node command dispatch has an
  // operation scope. Restore the original registered runtime for fixed observers;
  // the complete source/configuration checks remain inside the admitted scope.
  const inLifecycle = <T>(work: () => T): T => withWindowsSourceRecoveryOperation(options.runtime, descriptor, work);
  const { original, local } = inLifecycle(() => {
    const original = readWindowsGuardianLocalRuntime(options.guardian), local = readCleanDaemonQuarantine(options.configuration);
    if (original.mode !== "active" || canonical(original.binding) !== canonical(registration.binding)
      || canonical(original.epoch) !== canonical(registration.epoch) || original.binding.node_id !== local.node_id)
      throw Error("Clean lifecycle requires this daemon's actual registered Guardian");
    readCleanGuardianProductSourceConfiguration(readWindowsRecoverySourceRuntime(options.runtime), options.guardian, options.configuration);
    return { original, local };
  });
  const epoch = immutable(original.epoch);
  let invalidated = false, started = false, announced = false, ready = false, registrationAck: string | undefined;
  let lifecycle: SourceLifecycleRegistrationV1 | undefined, grant: SourceCleanRestartGrantV1 | undefined;
  let candidate: Omit<Checkpoint, "receipt"> | undefined, accepted: PreparedCleanDaemonCheckpoint | undefined;
  let work: Promise<void> = Promise.resolve();
  const current = () => {
    if (invalidated || !options.isCurrent()) throw Error("Original clean daemon session is unavailable");
    const now = readWindowsGuardianLocalRuntime(options.guardian);
    if (now.mode !== "active" || canonical(now.epoch) !== canonical(epoch) || canonical(now.binding) !== canonical(registration.binding))
      throw Error("Clean daemon lost its actual original epoch");
    readCleanDaemonQuarantine(options.configuration);
    readCleanGuardianProductSourceConfiguration(readWindowsRecoverySourceRuntime(options.runtime), options.guardian, options.configuration);
  };
  const fail = (error: unknown) => {
    invalidated = true; ready = false;
    options.onFailure(error instanceof Error ? error : Error("Original clean lifecycle failed"));
  };
  const activate = () => { current(); if (ready) return; ready = true; options.onReady(); current(); };
  async function captureCheckpoint() {
    current(); if (!grant || !lifecycle || candidate) throw Error("Clean checkpoint has no unique authenticated successor registration");
    const verification = grant.origin.execution_request.run_start.verification;
    if (!verification?.capability_binding) throw Error("Clean successor requires the accepted H6 verifier binding");
    const configured = readCleanDaemonVerificationProfile(options.configuration, verification.profile_id);
    const source = readCleanGuardianProductSourceConfiguration(readWindowsRecoverySourceRuntime(options.runtime), options.guardian, options.configuration);
    const profile = source.options.profiles.find(item => item.id === configured.id && item.project_id === configured.project_id
      && item.workspace_root === configured.workspace_root && item.digest === configured.digest);
    if (!profile || profile.digest !== verification.capability_binding.profile_digest || profile.workspace_root !== local.workspace_root)
      throw Error("Clean successor changed its protected verifier");
    const research = readProductFile(local.workspace_root, ".artoo/product/research.json");
    const design = readProductFile(local.workspace_root, ".artoo/product/design.json");
    const inputs = importedExecutionAcceptedInputsV1(grant.origin.execution_request);
    for (const pin of inputs.files) {
      const bytes = pin.path === ".artoo/product/research.json" ? research : pin.path === ".artoo/product/design.json" ? design : undefined;
      if (!bytes || bytes.length !== pin.size || sha(bytes) !== pin.checksum) throw Error("Clean successor accepted input bytes changed");
    }
    const prior = grant.origin.execution_request.review_request.continuation_request.review_result;
    if (prior.outcome !== "reviewed") throw Error("Clean successor has no accepted research mapping");
    const effectivePlan = inspectProductSourceVerificationEnvelope(prior.after.admission, research, sha).effective_plan;
    const subject = subjectManifest(profile);
    const stable = () => { current();
      if (subjectManifest(profile).digest !== subject.digest || !readProductFile(local.workspace_root, ".artoo/product/research.json").equals(research)
        || !readProductFile(local.workspace_root, ".artoo/product/design.json").equals(design)) throw Error("Clean checkpoint source changed during capture"); };
    const baseline = retainImportedValidationBaseline(profile, local.store_root, "clean-" + grant.generation_id, subject.digest, stable);
    const checkpoint = immutable(inspectSourceCleanCheckpointV1(grant, { version: 1, lineage_id: grant.lineage_id,
      generation_id: grant.generation_id, grant_digest: hash(grant), lifecycle_registration: lifecycle,
      predecessor_history_digest: grant.predecessor_history_digest, subject_digest: subject.digest,
      baseline: assertImportedValidationBaseline(baseline), accepted_inputs: inputs, source_state: "unverified" }, sha));
    const key = sha(grant.generation_id).slice(7), grantPath = join(local.store_root, "attestations", "clean-grant-" + key + ".json");
    const checkpointPath = join(local.store_root, "attestations", "clean-checkpoint-" + key + ".json");
    stable(); writeOnce(grantPath, grant); writeOnce(checkpointPath, checkpoint); stable();
    candidate = { assertCurrent: current, grant, checkpoint, profile, baseline, runtime: options.runtime, guardian: options.guardian,
      configuration: options.configuration, research: Buffer.from(research), design: Buffer.from(design),
      effectivePlan: immutable(effectivePlan), paths: [{ file: grantPath, digest: hash(grant) }, { file: checkpointPath, digest: hash(checkpoint) }] };
    await options.transport.send({ kind: "product.source.clean-restart.checkpoint.v1", node_id: local.node_id, payload: checkpoint }); current();
  }
  async function handle(message: ServerToNodeMessage) {
    current();
    if (message.type === "product.source.lifecycle.rejected.v1") {
      const value = sourceLifecycleRejectedCommandSchema.parse(message).payload;
      const expected = value.control === "register" ? registration.registration_id : grant?.generation_id;
      if (value.correlation_id !== expected) throw Error("Clean rejection has no original pending operation");
      throw Error("Server rejected the original clean lifecycle operation");
    }
    if (message.type === "product.source.lifecycle.registered.v1") {
      const value = sourceLifecycleRegisteredCommandSchema.parse(message).payload, observed = hash(value);
      if (registrationAck === observed) return;
      if (!announced || !lifecycle || registrationAck || value.observer_id !== lifecycle.launch.observer_id
        || value.registration_id !== registration.registration_id || value.registration_digest !== hash(lifecycle))
        throw Error("Clean registration ACK changed its original daemon submission");
      const expected = readCleanDaemonQuarantine(options.configuration).expected_grant;
      if (canonical(value.restart_grant ?? null) !== canonical(expected ?? null)
        || value.restart_grant && value.lineage_id !== value.restart_grant.lineage_id)
        throw Error("Clean registration ACK changed the locally retained successor binding");
      registrationAck = observed;
      if (!value.restart_grant) { activate(); return; }
      // Only this actual handler records the Server-returned grant. The public
      // grant file was an integrity comparison input, never a native authority.
      grant = immutable(value.restart_grant); await captureCheckpoint(); return;
    }
    const value = sourceCleanCheckpointCommittedCommandSchema.parse(message).payload;
    if (!candidate || !grant || !lifecycle || value.lineage_id !== grant.lineage_id || value.generation_id !== grant.generation_id
      || value.grant_digest !== hash(grant) || value.checkpoint_digest !== hash(candidate.checkpoint)
      || value.registration_id !== registration.registration_id || value.session_id !== epoch.session_id)
      throw Error("Clean checkpoint receipt changed its original actual submission");
    if (accepted) {
      if (canonical(checkpointState(accepted).receipt) !== canonical(value)) throw Error("Clean checkpoint receipt changed after acceptance");
      return;
    }
    const receipt = immutable(value), file = join(local.store_root, "attestations", "clean-receipt-" + sha(grant.generation_id).slice(7) + ".json");
    current(); writeOnce(file, receipt); current();
    const token = Object.freeze({}) as PreparedCleanDaemonCheckpoint;
    checkpoints.set(token, { ...candidate, receipt, paths: [...candidate.paths, { file, digest: hash(receipt) }] });
    checkpointState(token); accepted = token; activate();
  }
  return Object.freeze({
    async start(): Promise<void> {
      return inLifecycle(async () => {
      current(); if (started) throw Error("Clean lifecycle can announce only its original daemon once"); started = true;
      const launch = immutable(describeCleanDaemonLaunch(options.configuration, options.guardian));
      await options.bindParent(launch); current();
      if (canonical(launch) !== canonical(describeCleanDaemonLaunch(options.configuration, options.guardian)))
        throw Error("Original clean daemon descriptor changed during parent binding");
      const expected = readCleanDaemonQuarantine(options.configuration).expected_grant;
      lifecycle = immutable(SourceLifecycleRegistrationV1Schema.parse({ version: 1, launch, registration,
        ...(expected ? { successor_grant_digest: hash(expected) } : {}) }));
      announced = true;
      try { await options.transport.send({ kind: "product.source.lifecycle.register.v1", node_id: local.node_id, payload: lifecycle }); current(); }
      catch (error) { fail(error); throw error; }
      });
    },
    async handle(message: ServerToNodeMessage): Promise<boolean> {
      if (!["product.source.lifecycle.registered.v1", "product.source.lifecycle.rejected.v1", "product.source.clean-restart.checkpointed.v1"].includes(message.type)) return false;
      const next = work.then(() => inLifecycle(() => handle(message))); work = next.catch(() => {});
      try { await next; return true; } catch (error) { fail(error); throw error; }
    },
    isActive() { return !invalidated && ready; },
    readCheckpoint(): PreparedCleanDaemonCheckpoint | undefined {
      return inLifecycle(() => { current(); if (accepted) checkpointState(accepted); return accepted; });
    },
    allowsOrdinary() { return inLifecycle(() => { current(); return ready && local.expected_grant === undefined; }); },
    assertOrdinaryWorkspace(workspace: string): void {
      inLifecycle(() => {
      current(); if (!ready || local.expected_grant && windowsPathsOverlap(physicalWindowsDirectory(workspace), local.workspace_root))
        throw Error("Clean successor workspace is quarantined from ordinary execution");
      });
    },
    readAccepted(input: SourceCleanValidationOriginV1): PreparedCleanDaemonCheckpoint {
      return inLifecycle(() => {
      current(); if (!ready || !accepted) throw Error("Clean validation requires this daemon's actual committed checkpoint receipt");
      const value = immutable(inspectSourceCleanValidationOriginV1(input, sha)), saved = checkpointState(accepted);
      if (canonical(value.grant) !== canonical(saved.grant) || canonical(value.checkpoint) !== canonical(saved.checkpoint)
        || canonical(value.receipt) !== canonical(saved.receipt) || saved.restart && canonical(saved.restart) !== canonical(value))
        throw Error("Clean validation origin differs from the original in-process generation");
      saved.restart ??= value; return accepted;
      });
    },
    invalidate() { invalidated = true; ready = false; },
    async settled() { await work; },
  });
}
