import { isDeepStrictEqual } from "node:util";
import type { CDPSession, Page } from "playwright";
import { ProductStorageChecksV1Schema, StorageFaultTraceV1Schema, validateProductStorageChecksV1,
  ProductStoragePreconditionBindingV1Schema, StoragePreconditionTraceV1Schema, validateProductStoragePreconditionV1,
  type ProductStoragePreconditionBindingV1, type StoragePreconditionTraceV1,
  type ProductBrowserStepV3, type ProductStorageChecksV1, type StorageCheckWindowV1,
  type StorageFaultModeV1, type StorageFaultTraceV1, type StorageFaultTraceWindowV1 } from "@artoo/domain";
import { withBrowserActionTimeout as bounded } from "./web-acceptance-executor.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { STORAGE_FAULT_INITIALIZER_SOURCE, STORAGE_FAULT_INITIALIZER_DIGEST, STORAGE_FAULT_MAX_EVENTS,
  nativeStorageSnapshotV1, type NativeStorageSnapshotV1 } from "./web-acceptance-storage-source.js";

type Mode = StorageFaultModeV1 | "none";
interface Counts { installed: true; mode: Mode; read_hits: number; write_hits: number; controls: number }
interface Epoch { number: number; unique: string; contextId: number; handle: string; counts: Counts }
interface PendingNavigation { index: number; epoch: number; unique?: string; committed: boolean; admitted: boolean }
interface ActiveWindow {
  spec: StorageCheckWindowV1;
  before?: NativeStorageSnapshotV1;
  epoch?: Epoch;
  armed?: Counts;
  sequence: string[];
  observedMutations: number;
}
interface ExecutionContext { id: number; uniqueId: string; origin: string; auxData?: { frameId?: string; isDefault?: boolean } }
export interface StorageFaultController {
  beforeStep(index: number): Promise<void>;
  afterStep(index: number): Promise<void>;
  finish(): Promise<StorageFaultTraceV1>;
  /** Keep protocol guards attached while the owner closes the actual context. */
  prepareContextClose(): Promise<void>;
  /** Called after actual context closure; errors are never hidden by detachment. */
  close(): Promise<void>;
}

export interface StorageMeasurementResult {
  storage_fault?: StorageFaultTraceV1;
  storage_precondition?: StoragePreconditionTraceV1;
}
export interface StoragePreconditionController extends Omit<StorageFaultController, "finish"> {
  finish(): Promise<StorageMeasurementResult>;
  /** Synchronous latch: timed-out CDP work may not resume a document during cleanup. */
  abortPending(): void;
}

/** The legacy entry point retains its exact fault-only result and behavior. */
export async function createStorageFaultController(page: Page, origin: string, steps: readonly ProductBrowserStepV3[],
  input: ProductStorageChecksV1, timeout: number): Promise<StorageFaultController> {
  const controller = await createStorageController(page, origin, steps, input, timeout);
  return { beforeStep: controller.beforeStep, afterStep: controller.afterStep,
    prepareContextClose: controller.prepareContextClose, close: controller.close,
    async finish() { const result = await controller.finish();
      if (!result.storage_fault) throw new Error("Storage fault controller omitted its required trace");
      return result.storage_fault; } };
}

/** Called only with source-bound data derived by the protected v3 plan. */
export async function createStoragePreconditionController(page: Page, origin: string, steps: readonly ProductBrowserStepV3[],
  binding: ProductStoragePreconditionBindingV1, programDigest: string, timeout: number,
  input?: ProductStorageChecksV1): Promise<StoragePreconditionController> {
  return createStorageController(page, origin, steps, input, timeout, binding, programDigest);
}

/** One private CDP controller owns seed admission and fault baselines in a fixed order. */
async function createStorageController(page: Page, origin: string, steps: readonly ProductBrowserStepV3[],
  input: ProductStorageChecksV1 | undefined, timeout: number, seedInput?: ProductStoragePreconditionBindingV1,
  programDigest?: string): Promise<StoragePreconditionController> {
  const checks = input === undefined ? undefined : ProductStorageChecksV1Schema.parse(input);
  if (checks) validateProductStorageChecksV1(steps, checks);
  const seed = seedInput === undefined ? undefined : ProductStoragePreconditionBindingV1Schema.parse(seedInput);
  if (!checks && !seed) throw new Error("Storage measurement requires explicit checks or a precondition");
  if (seed) {
    validateProductStoragePreconditionV1(steps, seed.precondition);
    if (!programDigest || !/^sha256:[a-f0-9]{64}$/.test(programDigest)) throw new Error("Storage precondition requires its full program digest");
  }
  if (page.url() !== "about:blank") throw new Error("Storage controller must be installed before the first product document");
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.origin !== origin) throw new Error("Storage controller requires the protected product origin");
  if (seed && target.hostname !== "127.0.0.1") throw new Error("Storage preconditions require the node-owned loopback product origin");
  let abortRequested = false;
  const session = await bounded(page.context().newCDPSession(page), timeout, "Storage CDP session setup");
  const send: CDPSession["send"] = async (method, params) => {
    if (seed && abortRequested) throw new Error("Storage precondition execution is closing");
    const result = await bounded(session.send(method, params), timeout, "Storage CDP " + method);
    if (seed && abortRequested) throw new Error("Storage precondition execution closed during a CDP operation");
    return result;
  };
  const contexts = new Map<number, ExecutionContext>(), scripts = new Map<string, { executionContextId: number }>();
  const admitted = new Set<string>(), completed = new Set<number>(), windows: StorageFaultTraceWindowV1[] = [];
  const failures: Error[] = [];
  let seedPhase: "unstarted" | "writing" | "ready" | "resumed" = "unstarted";
  let seedEventSeen = false, confirmSeedEvent: (() => void) | undefined;
  let seedBefore: NativeStorageSnapshotV1 | undefined, seeded: NativeStorageSnapshotV1 | undefined;
  const preserved: StoragePreconditionTraceV1["preservation_checks"] = [];
  let mainFrame = "", current: Epoch | undefined, pending: PendingNavigation | undefined, active: ActiveWindow | undefined;
  let queue = Promise.resolve(), nextStep = 0, inFlight: number | undefined, events = 0;
  let preparing = true, finished = false, closingContext = false, sessionClosed = false, paused = false;
  let confirmSessionClosed!: () => void;
  const observedSessionClosed = new Promise<void>(resolve => { confirmSessionClosed = resolve; });
  const fail = (error: unknown) => { if (failures.length < 8) failures.push(error instanceof Error ? error : new Error(String(error))); };
  const healthy = () => { if (failures.length) throw new Error(`Storage measurement failed: ${failures.map(error => error.message).join("; ")}`); };
  const drain = () => bounded((async () => {
    for (;;) { const previous = queue; await previous; if (queue === previous) break; }
  })(), timeout, "Storage pause queue");
  const snapshot = async () => {
    const result = await send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } });
    return nativeStorageSnapshotV1(result.entries);
  };
  async function control(epoch: Epoch, operation: "inspect" | "arm" = "inspect", value: Mode = "none"): Promise<Counts> {
    const called = await send("Runtime.callFunctionOn", { objectId: epoch.handle,
      functionDeclaration: "function(operation,value){return this(operation,value);}",
      arguments: [{ value: operation }, { value }], returnByValue: false });
    if (called.exceptionDetails || called.result.type !== "object" || !called.result.objectId) throw new Error("Private storage controller invocation failed");
    const objectId = called.result.objectId;
    try {
      const properties = await send("Runtime.getProperties", { objectId, ownProperties: true });
      if (properties.exceptionDetails) throw new Error("Private storage controller result could not be read");
      const values = new Map<string, unknown>();
      for (const property of properties.result) {
        if (!property.isOwn || !property.enumerable || property.get || property.set || !property.value
          || property.value.objectId || values.has(property.name)) throw new Error("Storage controller returned non-data properties");
        values.set(property.name, property.value.value);
      }
      if (!isDeepStrictEqual([...values.keys()].sort(), ["controls", "installed", "mode", "read_hits", "write_hits"])) throw new Error("Storage controller returned unknown or missing fields");
      const actualMode = values.get("mode");
      if (values.get("installed") !== true || typeof actualMode !== "string" || !["none", "read-security", "write-quota"].includes(actualMode)) throw new Error("Storage initializer installation or mode is invalid");
      for (const key of ["controls", "read_hits", "write_hits"]) {
        const actual = values.get(key);
        if (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) throw new Error("Storage controller returned an invalid counter");
      }
      return Object.fromEntries(values) as unknown as Counts;
    } finally { await send("Runtime.releaseObject", { objectId }); }
  }
  async function arm(window: ActiveWindow, epoch: Epoch) {
    if (!window.before || window.sequence.length !== 1) throw new Error("Storage arm requires the actual earlier baseline");
    const before = await control(epoch);
    if (before.mode !== "none" || before.controls !== epoch.counts.controls) throw new Error("Storage controller was not in its confirmed none state");
    const armed = await control(epoch, "arm", window.spec.mode);
    if (armed.mode !== window.spec.mode || armed.controls !== before.controls + 1
      || armed.read_hits !== before.read_hits || armed.write_hits !== before.write_hits) throw new Error("Storage fault arming was not confirmed");
    epoch.counts = armed; window.epoch = epoch; window.armed = armed; window.sequence.push("armed");
  }
  function invalidate(contextId?: number) {
    if (current && (contextId === undefined || contextId === current.contextId) && !pending && !closingContext) {
      fail(new Error("Product document disappeared outside an explicit navigation"));
    }
  }
  session.on("Runtime.executionContextCreated", ({ context }) => {
    if (contexts.size >= 512) { fail(new Error("Storage execution-context metadata exceeded its bound")); return; }
    // CDP declares auxData as an embedder-specific map, while Chromium's
    // isDefault is a boolean. Validate the actual values, not the broad typing.
    const auxData = context.auxData as unknown as ExecutionContext["auxData"];
    contexts.set(context.id, { ...context, auxData });
    if (auxData?.isDefault !== true || auxData?.frameId !== mainFrame) return;
    if (preparing && context.origin !== origin) return;
    if (!pending || pending.unique !== undefined || !context.uniqueId || context.origin !== origin || admitted.has(context.uniqueId)) {
      fail(new Error("Product created an unauthorized main document context")); return;
    }
    pending.unique = context.uniqueId;
  });
  session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    invalidate(executionContextId); contexts.delete(executionContextId);
    for (const [id, script] of scripts) if (script.executionContextId === executionContextId) scripts.delete(id);
  });
  session.on("Runtime.executionContextsCleared", () => { invalidate(); contexts.clear(); scripts.clear(); });
  session.on("Debugger.scriptParsed", event => {
    if (scripts.size >= 4096) { fail(new Error("Storage script metadata exceeded its bound")); return; }
    scripts.set(event.scriptId, { executionContextId: event.executionContextId });
  });
  session.on("Page.frameNavigated", ({ frame }) => {
    // Page.enable may announce the already-created blank main document before
    // getFrameTree replies. This setup document never receives an admission.
    if (preparing && frame.url === "about:blank" && !frame.parentId && (!mainFrame || frame.id === mainFrame)) return;
    if (frame.id !== mainFrame || frame.parentId) { fail(new Error("Storage fault cases cannot add a document realm")); return; }
    let local = false;
    try { local = new URL(frame.url).origin === origin; } catch { /* Invalid document URLs are rejected below. */ }
    if (!pending || pending.committed || !local) { fail(new Error("Product changed documents outside an explicit navigation")); return; }
    pending.committed = true;
  });
  session.on("close", () => { sessionClosed = true; confirmSessionClosed(); if (!closingContext) fail(new Error("Storage CDP session disconnected before context closure")); });
  for (const name of ["DOMStorage.domStorageItemAdded", "DOMStorage.domStorageItemUpdated", "DOMStorage.domStorageItemRemoved", "DOMStorage.domStorageItemsCleared"] as const) {
    session.on(name, event => {
      if (event.storageId.isLocalStorage !== true) return;
      if (typeof event.storageId.securityOrigin !== "string") { fail(new Error("Storage mutation has no trustworthy origin")); return; }
      if (event.storageId.securityOrigin !== origin) {
        if (seed && seedPhase !== "resumed") fail(new Error("Native mutation has a different origin during storage seed admission"));
        return;
      }
      if (++events > STORAGE_FAULT_MAX_EVENTS) { fail(new Error("Storage mutation observations exceeded the case bound")); return; }
      if (seed && seedPhase === "writing") {
        const added = event as { key?: unknown; newValue?: unknown };
        if (name !== "DOMStorage.domStorageItemAdded" || added.key !== seed.precondition.local_storage.key
          || added.newValue !== seed.precondition.local_storage.value || seedEventSeen || !paused
          || pending?.index !== 0 || pending.epoch !== 1 || !pending.admitted || abortRequested) {
          fail(new Error("Unexpected native mutation during the one-time storage seed")); return;
        }
        seedEventSeen = true; confirmSeedEvent?.(); return;
      }
      if (seed && seedPhase !== "resumed") { fail(new Error("Native storage changed outside its exact seed write")); return; }
      if (active) { active.observedMutations++; fail(new Error("Native localStorage mutation observed during a fault window")); }
    });
  }
  session.on("Debugger.paused", event => {
    // Fail synchronously so an earlier pending seed cannot resume before the duplicate is dequeued.
    if (seed && paused) fail(new Error("A second debugger pause interrupted the active storage admission"));
    paused = true;
    queue = queue.then(async () => {
      try {
        healthy();
        const frame = event.callFrames[0], admission = pending;
        if (!frame || !admission || admission.admitted) throw new Error("Unexpected or duplicate debugger pause cannot install a controller");
        const metadata = scripts.get(frame.location.scriptId), execution = metadata && contexts.get(metadata.executionContextId);
        if (!execution || execution.auxData?.frameId !== mainFrame || execution.auxData.isDefault !== true
          || execution.origin !== origin || !execution.uniqueId || execution.uniqueId !== admission.unique
          || admitted.has(execution.uniqueId)) throw new Error("Storage initializer is not the first authorized main/default document epoch");
        const source = await send("Debugger.getScriptSource", { scriptId: frame.location.scriptId });
        if (source.scriptSource !== STORAGE_FAULT_INITIALIZER_SOURCE) throw new Error("Paused initializer source differs from the protected source");
        // Consume admission before evaluating any remote object. A copied script
        // or a second pause can never replace this document's private controller.
        admission.admitted = true; admitted.add(execution.uniqueId);
        const result = await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "controller", returnByValue: false });
        if (result.exceptionDetails || result.result.type !== "function" || !result.result.objectId) throw new Error("Protected initializer did not provide its private controller");
        const epoch: Epoch = { number: admission.epoch, unique: execution.uniqueId, contextId: execution.id, handle: result.result.objectId,
          counts: { installed: true, mode: "none", read_hits: 0, write_hits: 0, controls: 0 } };
        const initial = await control(epoch);
        if (!isDeepStrictEqual(initial, epoch.counts)) throw new Error("Storage initializer did not start with fresh zero counters");
        if (seed && admission.index === 0) {
          if (admission.epoch !== 1 || seedPhase !== "unstarted" || seedBefore || seeded || abortRequested) {
            throw new Error("Storage precondition can only seed the first admitted main document once");
          }
          seedBefore = await snapshot(); healthy();
          if (seedBefore.entries.length !== 0) throw new Error("Storage precondition requires an empty native origin");
          const observedSeedEvent = new Promise<void>(resolve => { confirmSeedEvent = resolve; });
          seedPhase = "writing";
          await send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: origin, isLocalStorage: true },
            key: seed.precondition.local_storage.key, value: seed.precondition.local_storage.value });
          healthy();
          seeded = await snapshot(); healthy();
          if (!isDeepStrictEqual(seeded.entries, [[seed.precondition.local_storage.key, seed.precondition.local_storage.value]])) {
            throw new Error("Native storage seed readback differs from the bound raw document");
          }
          await bounded(observedSeedEvent, timeout, "Native storage seed mutation confirmation");
          healthy();
          if (!seedEventSeen || abortRequested) throw new Error("Storage seed mutation was not confirmed before closure");
          seedPhase = "ready";
        } else if (seed && seedPhase !== "resumed") {
          throw new Error("Later documents require the already completed one-time storage seed");
        }
        if (active && active.spec.arm_before_step === 0) {
          if (active.before) throw new Error("First-document native baseline was already populated");
          active.before = await snapshot(); active.sequence.push("baseline");
        }
        current = epoch;
        if (active) await arm(active, epoch);
        healthy();
      } catch (error) { fail(error); }
      finally {
        // Legacy behavior is unchanged. A seed failure leaves the product paused until owned context closure.
        if (!seed || (!failures.length && !abortRequested && (seedPhase === "ready" || seedPhase === "resumed"))) {
          try {
            // Native events caused by product code after resume are no longer seed events.
            if (seed) seedPhase = "resumed";
            await send("Debugger.resume"); paused = false;
          } catch (error) { fail(error); }
          finally { if (!seed) paused = false; }
        }
      }
    }).catch(fail);
  });
  try {
    await send("Page.enable");
    mainFrame = (await send("Page.getFrameTree")).frameTree.frame.id;
    if (!mainFrame) throw new Error("Storage controller could not identify the main frame");
    await send("Runtime.enable"); await send("Debugger.enable"); await send("DOMStorage.enable");
    const registration = await send("Page.addScriptToEvaluateOnNewDocument", { source: STORAGE_FAULT_INITIALIZER_SOURCE });
    if (!registration.identifier) throw new Error("Storage initializer registration was not confirmed");
    preparing = false; healthy();
  } catch (error) {
    closingContext = true;
    try { await bounded(session.detach(), timeout, "Storage setup session closure"); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Storage setup and session closure failed"); }
    throw error;
  }
  return {
    async beforeStep(index) {
      await drain(); healthy();
      if (finished || inFlight !== undefined || index !== nextStep || !steps[index]) throw new Error("Storage step order differs from the fixed program");
      if (seed && abortRequested) throw new Error("Storage precondition cannot execute after cleanup starts");
      const step = steps[index]!, spec = checks?.windows.find(window => window.arm_before_step === index);
      if (spec) {
        if (active) throw new Error("Storage fault windows overlap");
        active = { spec, sequence: [], observedMutations: 0 };
        if (index > 0) {
          if (!current) throw new Error("Storage baseline requires the preceding actual product document");
          active.before = await snapshot(); active.sequence.push("baseline"); healthy();
        }
      }
      if ((step.action === "navigate" || step.action === "reload") && (!seed || step.page === "main")) {
        if (pending || active && active.spec.arm_before_step !== index) throw new Error("Storage window cannot change its document after its first step");
        pending = { index, epoch: (current?.number ?? 0) + 1, committed: false, admitted: false };
      } else if (spec) {
        if (!current) throw new Error("Storage fault has no actual product document");
        await arm(active!, current);
      }
      inFlight = index; healthy();
    },
    async afterStep(index) {
      await drain(); healthy();
      if (inFlight !== index || index !== nextStep) throw new Error("Storage step completion is out of order");
      if (pending) {
        if (pending.index !== index || !pending.committed || !pending.admitted || current?.number !== pending.epoch) throw new Error("Explicit navigation did not confirm one protected storage installation");
        pending = undefined;
      }
      completed.add(index);
      if (active?.spec.settle_after_step === index) {
        const window = active, epoch = window.epoch;
        if (!epoch || current !== epoch || !window.before || !window.armed || window.sequence.length !== 2) throw new Error("Storage window is missing its measured baseline and arm");
        if (!window.spec.ui_assertion_steps.every(stepIndex => completed.has(stepIndex))) throw new Error("Storage window UI assertions were not executed successfully");
        const final = await control(epoch);
        if (final.mode !== window.spec.mode || final.controls !== window.armed.controls) throw new Error("Storage controller changed mode during the window");
        const key = window.spec.mode === "read-security" ? "read_hits" : "write_hits";
        const baseline = window.armed[key], delta = final[key] - baseline;
        if (!Number.isSafeInteger(delta) || delta < window.spec.min_hits) throw new Error("Storage window has no fresh fault hit");
        const after = await snapshot(); healthy();
        if (!isDeepStrictEqual(window.before.entries, after.entries)) throw new Error("Native localStorage snapshots differ across the fault window");
        if (window.observedMutations !== 0) throw new Error("Native localStorage mutation observed during a fault window");
        window.sequence.push("settled");
        const disarmed = await control(epoch, "arm", "none");
        if (disarmed.mode !== "none" || disarmed.controls !== final.controls + 1
          || disarmed.read_hits !== final.read_hits || disarmed.write_hits !== final.write_hits) throw new Error("Storage fault disarming was not confirmed");
        epoch.counts = disarmed; window.sequence.push("disarmed"); healthy();
        windows.push({ id: window.spec.id, page_id: "main", mode: window.spec.mode,
          arm_before_step: window.spec.arm_before_step, settle_after_step: window.spec.settle_after_step,
          start_step_digest: sha(canonical(steps[window.spec.arm_before_step])), end_step_digest: sha(canonical(steps[index])),
          requirement_criteria: window.spec.requirement_criteria, ui_assertion_steps: window.spec.ui_assertion_steps,
          baseline_phase: window.spec.arm_before_step === 0 ? "first-document-paused" : "before-step", document_epoch: epoch.number,
          installation: { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true },
          sequence: window.sequence as StorageFaultTraceWindowV1["sequence"], hits: { baseline, final: final[key], delta },
          native_storage: { scope: "all", comparison: "sampled-equal", before: window.before.summary, after: after.summary, equal: true },
          events: { coverage: "observed-only", observed_mutations: 0 } });
        active = undefined;
      }
      const checkpoint = seed?.precondition.preservation_checks?.find(item => item.after_step === index);
      if (checkpoint) {
        if (!seeded || seedPhase !== "resumed" || !current || abortRequested
          || !checkpoint.ui_assertion_steps.every(step => completed.has(step))) throw new Error("Storage preservation checkpoint is not admitted");
        const actual = await snapshot(); healthy();
        if (!isDeepStrictEqual(actual.entries, seeded.entries)) throw new Error("Native storage no longer equals the actual seeded document");
        preserved.push({ after_step: index, step_digest: sha(canonical(steps[index])), document_epoch: current.number,
          requirement_criteria: checkpoint.requirement_criteria, ui_assertion_steps: checkpoint.ui_assertion_steps,
          native_storage: { scope: "all", comparison: "sampled-equal", snapshot: actual.summary, equal: true } });
      }
      inFlight = undefined; nextStep++; healthy();
    },
    async finish() {
      await drain(); healthy();
      if (inFlight !== undefined || pending || active || nextStep !== steps.length || windows.length !== (checks?.windows.length ?? 0) || !current) throw new Error("Storage measurement did not finish its complete fixed plan");
      const final = await control(current);
      if (final.mode !== "none" || final.controls !== current.counts.controls) throw new Error("Storage controller did not finish in its confirmed none state");
      healthy(); finished = true;
      let precondition: StoragePreconditionTraceV1 | undefined;
      if (seed) {
        if (abortRequested || !seedBefore || !seeded || seedPhase !== "resumed" || !seedEventSeen
          || !seed.precondition.ui_assertion_steps.every(step => completed.has(step))
          || preserved.length !== (seed.precondition.preservation_checks?.length ?? 0)) throw new Error("Storage precondition did not finish its complete fixed plan");
        precondition = StoragePreconditionTraceV1Schema.parse({ version: 1, descriptor_digest: sha(canonical(seed.precondition)),
          source: seed.source, program_digest: programDigest, page_id: "main", document_epoch: 1, origin,
          initial_step_digest: sha(canonical(steps[0])), installation: { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true },
          seed_apply_count: 1, sequence: ["empty-baseline", "native-seed-readback", "resumed"],
          requirement_criteria: seed.precondition.requirement_criteria, ui_assertion_steps: seed.precondition.ui_assertion_steps,
          native_storage: { scope: "all", before: seedBefore.summary, seeded: seeded.summary }, preservation_checks: preserved });
      }
      return { ...(checks ? { storage_fault: StorageFaultTraceV1Schema.parse({ version: 1, checks_digest: sha(canonical(checks)), windows }) } : {}),
        ...(precondition ? { storage_precondition: precondition } : {}) };
    },
    abortPending() { if (seed) { abortRequested = true; closingContext = true; } },
    async prepareContextClose() {
      if (seed) { abortRequested = true; closingContext = true; }
      try { await drain(); healthy(); if (paused) throw new Error("Storage debugger pause remains unresolved before closure"); }
      finally { closingContext = true; }
    },
    async close() {
      await drain();
      await bounded(observedSessionClosed, timeout, "Storage CDP session closure");
      if (!page.isClosed() || !sessionClosed) throw new Error("Storage controller did not observe actual page and CDP session closure");
      healthy();
    },
  };
}
