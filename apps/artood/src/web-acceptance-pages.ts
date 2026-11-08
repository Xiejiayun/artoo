import type { BrowserContext, Page } from "playwright";
import { BrowserOperationV3Schema, ProductBrowserProgramV3Schema, ProductStorageChecksV1Schema, validateProductStorageChecksV1,
  type BrowserCaptureV3, type BrowserOperationV3, type ProductBrowserProgramV3, type ProductBrowserStepV3,
  type ProductStorageChecksV1, type StorageFaultTraceV1, type ProductStoragePreconditionBindingV1, type StoragePreconditionTraceV1 } from "@artoo/domain";
import { BROWSER_V2_ACTIONS, executeBrowserCoreAction, withBrowserActionTimeout as bounded } from "./web-acceptance-executor.js";
import { createMainFrameFocusProbe, type MainFrameFocusProbe } from "./web-acceptance-focus.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { createStorageFaultController, createStoragePreconditionController, type StorageFaultController, type StoragePreconditionController } from "./web-acceptance-storage.js";
import { acceptanceCleanupFailure, withAcceptanceCleanup } from "./web-acceptance-cleanup.js";

interface PageState { page: Page; id: string; closed: boolean; closing: boolean; navigationStarted: boolean; focus?: MainFrameFocusProbe }
export interface BrowserProgramV3Result {
  operations: BrowserOperationV3[];
  captures: BrowserCaptureV3[];
  screenshots: Map<string, Buffer>;
  storage_fault?: StorageFaultTraceV1;
  storage_precondition?: StoragePreconditionTraceV1;
}
type LifecycleAction = Extract<ProductBrowserStepV3["action"], "open_page" | "close_page">;
interface LifecycleEnvironment {
  create(id: string): Promise<PageState>;
  live(id: string): PageState;
  close(state: PageState, index: number): Promise<void>;
  origin: string;
  timeout: number;
}
type LifecycleHandler<A extends LifecycleAction> = (environment: LifecycleEnvironment,
  step: Extract<ProductBrowserStepV3, { action: A }>, index: number) => Promise<BrowserOperationV3["observation"]>;
const lifecycleHandlers: { [A in LifecycleAction]: LifecycleHandler<A> } = Object.freeze({
  open_page: async (environment, step) => {
    const state = await environment.create(step.page); state.navigationStarted = true;
    const result = await executeBrowserCoreAction(state.page, environment.origin, { action: "navigate", path: step.path }, environment.timeout);
    if (result.kind !== "navigation") throw new Error("Invalid browser page opening result");
    return { kind: "page-opened", status_code: result.status_code };
  },
  close_page: async (environment, step, index) => {
    await environment.close(environment.live(step.page), index);
    return { kind: "page-closed", closed: true };
  },
});
export const BROWSER_V3_ACTIONS = Object.freeze([...BROWSER_V2_ACTIONS, ...Object.keys(lifecycleHandlers) as LifecycleAction[]]);

/** Owns and closes one context. A successful return includes actual context closure and complete page captures. */
export async function executeBrowserProgramV3(context: BrowserContext, origin: string, input: ProductBrowserProgramV3,
  timeout: number, inspectPage: (page: Page) => Promise<void>, storageChecks?: ProductStorageChecksV1,
  storagePrecondition?: ProductStoragePreconditionBindingV1): Promise<BrowserProgramV3Result> {
  const states = new Map<string, PageState>(), observed = new Set<Page>(), claimed = new Map<Page, PageState>();
  const violations = new Set<string>(), rejectedClosures = new Map<Page, Promise<void>>();
  const operations: BrowserOperationV3[] = [], captures = new Map<string, BrowserCaptureV3>(), screenshots = new Map<string, Buffer>();
  let creating = false, cleaningUp = false;
  let storage: StorageFaultController | StoragePreconditionController | undefined, storageFault: StorageFaultTraceV1 | undefined;
  let storagePreconditionTrace: StoragePreconditionTraceV1 | undefined;
  const healthy = () => { if (violations.size) throw new Error(`Unsupported product behavior: ${[...violations].join(", ")}`); };
  const local = (url: string) => {
    try { const target = new URL(url); return target.protocol === "http:" && target.origin === origin; }
    catch { return false; }
  };
  function rejectPage(page: Page) {
    violations.add("unexpected page or popup");
    if (!rejectedClosures.has(page)) rejectedClosures.set(page, bounded(page.close(), timeout, "Rejected page closure")
      .catch(() => { violations.add("unconfirmed rejected page closure"); }));
  }
  function guard(page: Page) {
    if (observed.has(page)) return;
    observed.add(page);
    page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
    page.on("pageerror", () => violations.add("product JavaScript error"));
    page.on("download", () => violations.add("download"));
    page.on("popup", () => violations.add("unexpected page or popup"));
    page.on("frameattached", () => violations.add("iframe"));
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) { violations.add("iframe"); return; }
      const state = claimed.get(page), url = frame.url();
      if (url === "about:blank" && !state?.navigationStarted) return;
      if (!local(url)) violations.add("non-product navigation");
    });
    page.on("close", () => {
      const state = claimed.get(page);
      if (!cleaningUp && state && !state.closing) violations.add("unexpected page closure");
    });
    // A popup can finish its first document before Playwright emits its page event.
    if (page.frames().some((frame) => frame !== page.mainFrame())) violations.add("iframe");
    if (page.url() !== "about:blank" && !local(page.url())) violations.add("non-product navigation");
  }
  async function create(id: string): Promise<PageState> {
    if (states.has(id) || states.size >= 3) throw new Error("Browser page names cannot be reused and only three cumulative pages are supported");
    healthy(); creating = true;
    let page: Page;
    try { page = await bounded(context.newPage(), timeout, "Browser page creation"); }
    finally { creating = false; }
    guard(page);
    const state: PageState = { id, page, closed: false, closing: false, navigationStarted: false };
    // The returned Page, never the first page event, owns this program's name.
    states.set(id, state); claimed.set(page, state);
    for (const candidate of observed) if (!claimed.has(candidate)) rejectPage(candidate);
    healthy();
    if (page.isClosed()) throw new Error("The created browser page already closed");
    return state;
  }
  function live(id: string): PageState {
    const state = states.get(id);
    if (!state || state.closed || state.page.isClosed()) throw new Error(`Browser page ${id} is unknown or closed`);
    return state;
  }
  async function capture(state: PageState, timing: BrowserCaptureV3["timing"]) {
    if (captures.has(state.id)) throw new Error("Browser pages must be captured exactly once");
    healthy(); await bounded(inspectPage(state.page), timeout, "Browser page inspection");
    const bytes = await state.page.screenshot({ fullPage: false, animations: "disabled", timeout });
    healthy(); screenshots.set(state.id, bytes);
    captures.set(state.id, { page_id: state.id, timing, screenshot_digest: sha(bytes) });
  }
  async function close(state: PageState, index: number) {
    if (state.id === "main") throw new Error("The main browser page cannot be closed by a program");
    await capture(state, { kind: "before-close", step_index: index });
    if (state.focus) { await bounded(state.focus.close(), timeout, "Browser focus probe closure"); state.focus = undefined; }
    healthy(); state.closing = true;
    await bounded(state.page.close(), timeout, "Browser close_page");
    if (!state.page.isClosed()) throw new Error("Browser close_page did not confirm actual closure");
    state.closed = true;
  }
  let programFailed = false, programFailure: unknown;
  try {
    const program = ProductBrowserProgramV3Schema.parse(input);
    const checks = storageChecks === undefined ? undefined : ProductStorageChecksV1Schema.parse(storageChecks);
    if (checks) validateProductStorageChecksV1(program.steps, checks);
    context.on("page", (page) => {
      guard(page);
      if (!creating && !claimed.has(page)) rejectPage(page);
    });
    await context.route("**/*", (route) => {
      if (local(route.request().url())) return route.continue();
      violations.add("external network request"); return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => { violations.add("WebSocket request"); socket.close(); });
    // A supplied context cannot smuggle an existing untracked page into this case.
    for (const page of context.pages()) { guard(page); rejectPage(page); }
    const main = await create("main");
    if (storagePrecondition) {
      // Do not race away from controller setup: its bounded CDP operations own cleanup on failure.
      storage = await createStoragePreconditionController(main.page, origin, program.steps, storagePrecondition, sha(canonical(program)), timeout, checks);
    } else if (checks) storage = await bounded(createStorageFaultController(main.page, origin, program.steps, checks, timeout), timeout, "Storage measurement setup");
    for (const [index, step] of program.steps.entries()) {
      healthy();
      if (storage) await bounded(storage.beforeStep(index), timeout, "Storage before-step preparation");
      let observation: BrowserOperationV3["observation"];
      if (step.action === "open_page" || step.action === "close_page") {
        const handler = lifecycleHandlers[step.action] as LifecycleHandler<LifecycleAction>;
        observation = await bounded(handler({ create, live, close, origin, timeout }, step, index), timeout, `Browser ${step.action}`);
      } else {
        const state = live(step.page);
        if (step.action === "navigate" || step.action === "reload") state.navigationStarted = true;
        if (["focus", "assert_focused", "assert_focus_within", "press", "type_text"].includes(step.action) && !state.focus) {
          state.focus = await bounded(createMainFrameFocusProbe(state.page), timeout, "Browser focus probe setup");
        }
        observation = await executeBrowserCoreAction(state.page, origin, step, timeout, state.focus);
      }
      healthy();
      if (storage) await bounded(storage.afterStep(index), timeout, "Storage after-step measurement");
      operations.push(BrowserOperationV3Schema.parse({ index, action: step.action, page_id: step.page,
        planned_step_digest: sha(canonical(step)), observation }));
    }
    for (const state of states.values()) if (!state.closed) await capture(live(state.id), { kind: "case-end" });
    if (storage && "abortPending" in storage) {
      const measured = await bounded(storage.finish(), timeout, "Storage measurement finalization");
      storageFault = measured.storage_fault; storagePreconditionTrace = measured.storage_precondition;
    } else if (storage) storageFault = await bounded(storage.finish(), timeout, "Storage measurement finalization");
  } catch (error) { programFailed = true; programFailure = error; throw error; }
  finally {
    cleaningUp = true;
    try {
      // Keep this latch in the original finally continuation, before any async wrapper or cleanup await.
      if (storage && "abortPending" in storage) storage.abortPending();
      await withAcceptanceCleanup("context", async () => {
        await withAcceptanceCleanup("context", async () => {
          for (const state of states.values()) if (state.focus) await bounded(state.focus.close(), timeout, "Browser focus probe closure");
        }, async () => { if (storage) await storage.prepareContextClose(); });
      }, async () => {
        await withAcceptanceCleanup("context", () => context.close(), async () => {
          await withAcceptanceCleanup("context", async () => { if (storage) await storage.close(); },
            async () => { await Promise.all(rejectedClosures.values()); });
        });
      });
    } catch (error) { throw acceptanceCleanupFailure("context", error, programFailed, programFailure); }
  }
  healthy();
  return { operations, captures: [...states.keys()].map((id) => {
    const record = captures.get(id); if (!record) throw new Error("Browser page has no measured capture"); return record;
  }), screenshots, ...(storageFault ? { storage_fault: storageFault } : {}),
    ...(storagePreconditionTrace ? { storage_precondition: storagePreconditionTrace } : {}) };
}
