import { createHash } from "node:crypto";
import { recordWindowsStartupPhase, recordWindowsStartupFailure } from "./windows-startup-diagnostics.js";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalProductSourceTransferValueV1 as canonical, productSourceRecoveryRequestDigestV1,
  type ProductSourceRecoveryControlV1, type ProductSourceRecoveryResultV1, type ImportedRecoveryValidationRequestV1,
  type ProductSourceRecoveryRegistrationV1, type SourceCleanValidationOriginV1 } from "@artoo/domain";
import { productSourceRecoverySessionSchema, productSourceRecoveryRegisteredSchema, productSourceRecoveryCommandSchema,
  productSourceRecoveryStopSchema, productSourceRecoveryStatusSchema, productSourceRecoveryReceiptSchema,
  type NodeSideTransport, type ServerToNodeMessage } from "@artoo/protocol";
import { bootstrapWindowsGuardian, reconnectWindowsGuardian, createWindowsGuardianRegistration, acceptWindowsGuardianRegistration,
  readWindowsGuardianAvailability, transferWindowsGuardianEpoch, readWindowsGuardianLocalRuntime, type PreparedWindowsGuardian } from "./owned/windows-runtime-guardian.js";
import { windowsGuardianConfiguration, recoveryConfigurationBackend, prepareWindowsSourceRecoveryRuntime,
  prepareRecoveredWorkspace, readRecoveredWorkspaceResult, type PreparedRecoveredWorkspace,
  type PreparedWindowsSourceRecoveryConfiguration, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { createWindowsCleanDaemonClient, type PreparedCleanDaemonCheckpoint } from "./windows-clean-daemon-client.js";
import { bindCleanDaemonGuardian, type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import { bindCleanDaemonParent } from "./windows-clean-daemon-control.js";
import { withWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const reason = (error: unknown) => (error instanceof Error ? error.message : "Recovery unavailable").slice(0, 2000) || "Recovery unavailable";
function hasOwner(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Serialized control messages retain native tokens in this daemon only. An on-disk
 * checkpoint can locate evidence; it can never recreate the guardian or a completed owner. */
export function createProductSourceRecoveryClient(options: { nodeId: string; configuration: PreparedWindowsSourceRecoveryConfiguration;
  transport: NodeSideTransport; isCurrent(): boolean;
  cleanLifecycle?: PreparedCleanDaemonConfiguration;
  activate(runtime: PreparedWindowsSourceRecoveryRuntime, workspace?: PreparedRecoveredWorkspace, cleanCheckpoint?: PreparedCleanDaemonCheckpoint): void;
  suspend?(): void; onFailure?(error: Error): void }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Source recovery requires committed run-event receipts");
  type Slot = { control: ProductSourceRecoveryControlV1; workspace?: PreparedRecoveredWorkspace;
    result?: ProductSourceRecoveryResultV1; acknowledged?: string; stopped: boolean };
  let guardian: PreparedWindowsGuardian | undefined, runtime: PreparedWindowsSourceRecoveryRuntime | undefined;
  let originalRegistration: ProductSourceRecoveryRegistrationV1 | undefined;
  let clean: ReturnType<typeof createWindowsCleanDaemonClient> | undefined;
  let sessionId: string | undefined, invalidated = false, registered = false, acceptedRegistration: string | undefined;
  let slot: Slot | undefined, work: Promise<void> = Promise.resolve();
  let poll: ReturnType<typeof setTimeout> | undefined, pollDelay = 500, lastAvailability: string | undefined;
  const waiting = new Set<{ resolve(): void; reject(error: Error): void }>();
  function cancelWaiting() { for (const waiter of waiting) waiter.reject(new Error("Recovery activation was invalidated or stopped")); waiting.clear(); }
  function stopPolling() { if (poll) clearTimeout(poll); poll = undefined; }
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Source recovery session invalidated"); };
  const same = (control: ProductSourceRecoveryControlV1) => {
    if (!slot || canonical(slot.control) !== canonical(control)) throw Error("Original recovery control is unavailable or changed"); return slot;
  };
  async function sendRegistration() {
    current(); if (!guardian) throw Error("Original guardian is unavailable");
    originalRegistration = createWindowsGuardianRegistration(guardian);
    await options.transport.send({ kind: "product.source.recovery.register.v1", node_id: options.nodeId,
      payload: originalRegistration }); current();
  }
  async function sendResult(commandId: string) {
    current(); if (slot?.result) await options.transport.send({ kind: "product.source.recovery.result.v1", node_id: options.nodeId,
      command_id: commandId, payload: slot.result }); current();
  }
  async function ack(commandId: string, control: ProductSourceRecoveryControlV1) {
    current(); await options.transport.send({ kind: "product.source.recovery.ack.v1", node_id: options.nodeId,
      command_id: commandId, payload: control, status: "accepted" }); current();
  }
  async function publishAvailability() {
    current(); if (!guardian || readWindowsGuardianLocalRuntime(guardian).mode !== "recovery" || slot?.stopped) return;
    const payload = await readWindowsGuardianAvailability(guardian); current();
    if (hash(payload) !== lastAvailability) {
      await options.transport.send({ kind: "product.source.recovery.available.v1", node_id: options.nodeId, payload });
      current(); lastAvailability = hash(payload);
    }
    if (payload.state === "unknown") {
      stopPolling();
      poll = setTimeout(() => {
        poll = undefined;
        work = work.then(publishAvailability).catch(error => {
          invalidated = true; stopPolling(); cancelWaiting(); options.suspend?.();
          options.onFailure?.(error instanceof Error ? error : new Error("Guardian reconciliation failed"));
        });
      }, pollDelay);
      poll.unref?.(); pollDelay = Math.min(30_000, pollDelay * 2);
    }
  }
  async function activate() {
    current(); if (runtime || !registered || !guardian || slot && (!slot.workspace || !slot.result || slot.stopped
      || slot.result.outcome !== "recovered" || slot.acknowledged !== hash(slot.result))) return;
    if (options.cleanLifecycle) {
      if (slot || !originalRegistration || clean) throw Error("Clean lifecycle requires its unique fresh native Guardian activation");
      const owner = guardian, configuration = options.cleanLifecycle;
      // Registration has committed this exact Guardian epoch. Configuration
      // rechecks can launch fixed ACL observers even before the source factory.
      withWindowsGuardianOperation(owner, { operationId: "clean-lifecycle-" + originalRegistration.registration_id,
        bindingDigest: hash(originalRegistration), serverOperation: null }, () => bindCleanDaemonGuardian(configuration, owner));
    }
    const prepared = prepareWindowsSourceRecoveryRuntime(options.configuration, guardian, slot?.workspace);
    recordWindowsStartupPhase("source_activation");
    if (options.cleanLifecycle) {
      if (slot || !originalRegistration || clean) throw Error("Clean lifecycle requires its unique fresh native Guardian activation");
      clean = createWindowsCleanDaemonClient({ configuration: options.cleanLifecycle, guardian, runtime: prepared,
        registration: originalRegistration, transport: options.transport, isCurrent: options.isCurrent, bindParent: bindCleanDaemonParent,
        onFailure(error) { invalidated = true; readyFailure(error); },
        onReady() {
          current(); options.activate(prepared, undefined, clean!.readCheckpoint()); current(); runtime = prepared;
          for (const waiter of waiting) waiter.resolve(); waiting.clear();
        } });
      await clean.start(); current(); return;
    }
    options.activate(prepared, slot?.workspace); current(); runtime = prepared;
    for (const waiter of waiting) waiter.resolve(); waiting.clear();
  }
  function readyFailure(error: Error) { stopPolling(); cancelWaiting(); options.suspend?.(); options.onFailure?.(error); }
  async function handle(message: ServerToNodeMessage) {
    current();
    if (clean && await clean.handle(message)) return;
    if (message.type === "product.source.recovery.session.v1") {
      const command = productSourceRecoverySessionSchema.parse(message);
      if (command.payload.node_id !== options.nodeId || sessionId && sessionId !== command.payload.session_id)
        throw Error("Recovery announcement changed the current authenticated node session");
      if (sessionId) return;
      sessionId = command.payload.session_id;
      recordWindowsStartupPhase("guardian_session");
      const local = windowsGuardianConfiguration(options.configuration, sessionId), backend = recoveryConfigurationBackend(options.configuration);
      const owned = hasOwner(join(local.storeDirectory, "owner.lock"));
      if (options.cleanLifecycle && owned) throw Error("Clean lifecycle cannot adopt an existing Guardian owner; an exact fresh generation is required");
      guardian = owned
        ? await reconnectWindowsGuardian(backend, local) : await bootstrapWindowsGuardian(backend, local);
      current();
      // Bootstrap and reconnect return distinct native modes. Never fall back from
      // failed reconnect to deleting a fence or opening an ordinary runtime.
      if (readWindowsGuardianLocalRuntime(guardian).mode === "recovery") {
        await publishAvailability(); return;
      }
      await sendRegistration(); return;
    }
    if (!guardian || !sessionId) throw Error("Recovery requires the authenticated session announcement first");
    if (message.type === "product.source.recovery.registered.v1") {
      const command = productSourceRecoveryRegisteredSchema.parse(message), digest = hash(command.payload);
      if (acceptedRegistration === digest) return;
      if (registered || command.payload.session_id !== sessionId) throw Error("Recovery registration changed the current session or epoch");
      recordWindowsStartupPhase("guardian_registration");
      await acceptWindowsGuardianRegistration(guardian, command); current();
      registered = true; acceptedRegistration = digest; await activate(); return;
    }
    if (message.type === "product.source.recovery.v1") {
      const command = productSourceRecoveryCommandSchema.parse(message), request = command.payload;
      const control: ProductSourceRecoveryControlV1 = { version: 1, recovery_id: request.recovery_id,
        request_digest: productSourceRecoveryRequestDigestV1(request, sha) };
      if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Recovery command deadline expired");
      if (slot) { same(control); await ack(command.id, control); await sendResult(command.id); return; }
      if (request.binding.node_id !== options.nodeId || request.current_session_id !== sessionId || runtime || registered)
        throw Error("Recovery request does not belong to this replacement daemon session");
      slot = { control, stopped: false }; await ack(command.id, control);
      try {
        stopPolling();
        await readWindowsGuardianAvailability(guardian); current();
        const fence = await transferWindowsGuardianEpoch(guardian, request); current();
        slot.workspace = prepareRecoveredWorkspace(options.configuration, guardian, fence, request);
        slot.result = readRecoveredWorkspaceResult(slot.workspace);
        // Transfer creates a different epoch. Its own registration ACK and the
        // accepted checkpoint receipt are both required before any new process.
        await sendRegistration();
      } catch (error) { slot.result = { ...control, outcome: "unknown", closed: false, reason: reason(error) }; }
      await sendResult(command.id); return;
    }
    if (message.type === "product.source.recovery.receipt.v1") {
      const receipt = productSourceRecoveryReceiptSchema.parse(message), original = same(receipt.payload);
      if (!original.result || hash(original.result) !== receipt.result_digest) throw Error("Recovery receipt changed the original result");
      original.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined;
      if (receipt.status === "rejected" && runtime) { invalidated = true; throw Error("Recovery receipt was revoked after activation"); }
      await activate(); return;
    }
    const stopping = message.type === "product.source.recovery.stop.v1";
    const command = stopping ? productSourceRecoveryStopSchema.parse(message) : productSourceRecoveryStatusSchema.parse(message);
    if (!slot && stopping) slot = { control: command.payload, stopped: true,
      result: { ...command.payload, outcome: "unknown", closed: false, reason: "Recovery cancelled before native epoch transfer" } };
    const original = same(command.payload);
    if (stopping) { stopPolling(); original.stopped = true; cancelWaiting(); options.suspend?.(); }
    await ack(command.id, command.payload); await sendResult(command.id);
  }
  return {
    async handle(message: ServerToNodeMessage): Promise<boolean> {
      if (!message.type.startsWith("product.source.recovery.") && !message.type.startsWith("product.source.lifecycle.")
        && message.type !== "product.source.clean-restart.checkpointed.v1") return false;
      const next = work.then(() => handle(message)); work = next.catch(() => {});
      try { await next; return true; } catch (error) { recordWindowsStartupFailure(error); invalidated = true; stopPolling(); cancelWaiting(); options.suspend?.(); throw error; }
    },
    isActive() { return !invalidated && !!runtime && !slot?.stopped && (!options.cleanLifecycle || clean?.isActive() === true); },
    allowsOrdinary() { return !invalidated && !!runtime && !slot && (!options.cleanLifecycle || clean?.allowsOrdinary() === true); },
    async awaitRecoveredActivation() {
      current(); if (!slot?.workspace || slot.stopped || slot.result?.outcome !== "recovered") throw Error("Original recovery checkpoint is unavailable");
      if (runtime) return;
      await new Promise<void>((resolve, reject) => { waiting.add({ resolve, reject }); }); current();
    },
    async awaitCleanActivation() {
      current(); if (!options.cleanLifecycle || !clean || slot) throw Error("Original clean lifecycle is unavailable");
      if (runtime && clean.isActive()) return;
      await new Promise<void>((resolve, reject) => { waiting.add({ resolve, reject }); }); current();
    },
    readRuntime() { current(); if (!runtime || slot?.stopped || options.cleanLifecycle && !clean?.isActive()) throw Error("Registered recovery runtime is not active");
      clean?.allowsOrdinary(); return runtime; },
    readCleanAccepted(origin: SourceCleanValidationOriginV1) {
      current(); if (!runtime || !clean || slot) throw Error("Original clean successor activation is unavailable"); return clean.readAccepted(origin);
    },
    readAccepted(request: ImportedRecoveryValidationRequestV1) {
      current(); const original = slot;
      if (!runtime || !original?.workspace || original.stopped || original.result?.outcome !== "recovered"
        || original.acknowledged !== hash(original.result) || request.recovery_id !== original.control.recovery_id
        || canonical(request.checkpoint) !== canonical(original.result.checkpoint)) throw Error("Original accepted current recovery checkpoint is required");
      if (readRecoveredWorkspaceResult(original.workspace) !== original.result) throw Error("Recovery workspace projection changed");
      return original.workspace;
    },
    assertAccepted(request: ImportedRecoveryValidationRequestV1, original: PreparedRecoveredWorkspace) {
      if (this.readAccepted(request) !== original) throw Error("Recovery checkpoint original object changed");
    },
    invalidate() { invalidated = true; clean?.invalidate(); stopPolling(); cancelWaiting(); },
    async settled() { await work; await clean?.settled(); },
  };
}
