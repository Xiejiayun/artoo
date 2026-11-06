import type { Page } from "playwright";
import { BrowserOperationV2Schema, ProductBrowserProgramV2Schema, type BrowserOperationV2, type ProductBrowserProgramV2, type ProductBrowserStepV2 } from "@artoo/domain";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { createMainFrameFocusProbe, type MainFrameFocusProbe } from "./web-acceptance-focus.js";

type Action = ProductBrowserStepV2["action"];
type Observation = BrowserOperationV2["observation"];
type WithoutPage<T> = T extends { page: string } ? Omit<T, "page"> : never;
/** Concrete browser actions are shared; versioned programs, page ownership and trace identities are not converted. */
export type BrowserCoreStep = WithoutPage<ProductBrowserStepV2>;
type Handler<A extends Action> = (page: Page, origin: string, step: Extract<BrowserCoreStep, { action: A }>, timeout: number,
  focus: MainFrameFocusProbe | undefined) => Promise<Observation>;
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));

async function assertContent(page: Page, _origin: string,
  step: Extract<BrowserCoreStep, { action: "assert_text" | "assert_value" | "assert_count" }>, timeout: number): Promise<Observation> {
  const element = page.locator(step.selector), deadline = Date.now() + timeout;
  for (;;) {
    const actual = step.action === "assert_text" ? await element.textContent({ timeout })
      : step.action === "assert_value" ? await element.inputValue({ timeout }) : await element.count();
    if (step.action === "assert_text" ? typeof actual === "string" && actual.includes(step.text)
      : step.action === "assert_value" ? actual === step.value : actual === step.count) return { kind: "assertion", passed: true };
    if (Date.now() >= deadline) throw new Error(`${step.action} did not match`);
    await delay();
  }
}

async function focusStep(_page: Page, _origin: string,
  step: Extract<BrowserCoreStep, { action: "focus" | "assert_focused" | "assert_focus_within" }>, timeout: number,
  focus: MainFrameFocusProbe | undefined): Promise<Observation> {
  if (!focus) throw new Error("Missing protected focus probe");
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await focus.observe({ selector: step.selector, action: step.action })) return step.action === "focus"
      ? { kind: "programmatic-focus", focused: true } : { kind: "focus-assertion", passed: true };
    if (Date.now() >= deadline) throw new Error(`${step.action} failed for its unique main-frame DOM target; iframe/shadow targets are unsupported`);
    await delay();
  }
}

async function keyboardScope(focus: MainFrameFocusProbe | undefined): Promise<void> {
  if (!focus || !await focus.observe({ action: "keyboard-scope" })) throw new Error("Keyboard input has no protected main-frame focus scope");
}

// Exhaustiveness makes the advertised v2 actions come from executable handlers.
const handlers: { [A in Action]: Handler<A> } = Object.freeze({
  navigate: async (page, origin, step) => {
    const url = new URL(step.path, origin);
    if (url.origin !== origin) throw new Error("Browser navigation must stay on the product origin");
    const response = await page.goto(url.href, { waitUntil: "load" });
    if (!response?.ok()) throw new Error("Product navigation did not return HTTP 2xx");
    return { kind: "navigation", status_code: response.status() };
  },
  reload: async (page) => {
    const response = await page.reload({ waitUntil: "load" });
    if (!response?.ok()) throw new Error("Product reload did not return HTTP 2xx");
    return { kind: "navigation", status_code: response.status() };
  },
  click: async (page, _origin, step) => { await page.locator(step.selector).click(); return { kind: "action-completed" }; },
  fill: async (page, _origin, step) => { await page.locator(step.selector).fill(step.value); return { kind: "action-completed" }; },
  check: async (page, _origin, step) => { await page.locator(step.selector).setChecked(step.checked); return { kind: "action-completed" }; },
  assert_visible: async (page, _origin, step) => { await page.locator(step.selector).waitFor({ state: "visible" }); return { kind: "assertion", passed: true }; },
  assert_hidden: async (page, _origin, step) => { await page.locator(step.selector).waitFor({ state: "hidden" }); return { kind: "assertion", passed: true }; },
  assert_text: assertContent, assert_value: assertContent, assert_count: assertContent,
  press: async (page, _origin, step, _timeout, focus) => { await keyboardScope(focus); await page.keyboard.press(step.key); await keyboardScope(focus); return { kind: "key-press", key: step.key }; },
  type_text: async (page, _origin, step, _timeout, focus) => { await keyboardScope(focus); await page.keyboard.type(step.text); await keyboardScope(focus); return { kind: "keyboard-input", text_length: step.text.length }; },
  focus: focusStep, assert_focused: focusStep, assert_focus_within: focusStep,
});
export const BROWSER_V2_ACTIONS: readonly Action[] = Object.freeze(Object.keys(handlers) as Action[]);

/** A timeout never records completion. The owning caller closes the context/browser on failure. */
async function bounded<T>(operation: Promise<T>, timeout: number, label = "Browser action"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded the protected timeout`)), timeout);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
export { bounded as withBrowserActionTimeout };

export async function executeBrowserCoreAction(page: Page, origin: string, step: BrowserCoreStep, timeout: number,
  focus?: MainFrameFocusProbe): Promise<Observation> {
  const handler = handlers[step.action] as Handler<Action>;
  return bounded(handler(page, origin, step, timeout, focus), timeout, `Browser ${step.action}`);
}

export async function executeBrowserProgramV2(page: Page, origin: string, input: ProductBrowserProgramV2,
  timeout: number, operations: BrowserOperationV2[] = []): Promise<BrowserOperationV2[]> {
  const program = ProductBrowserProgramV2Schema.parse(input);
  if (operations.length) throw new Error("Browser operation trace must start empty");
  const needsFocus = program.steps.some((step) => ["focus", "assert_focused", "assert_focus_within", "press", "type_text"].includes(step.action));
  const focus = needsFocus ? await bounded(createMainFrameFocusProbe(page), timeout) : undefined;
  try {
    for (const [index, step] of program.steps.entries()) {
      const observation = await executeBrowserCoreAction(page, origin, step, timeout, focus);
      // This append occurs only after the actual operation has completed successfully.
      operations.push(BrowserOperationV2Schema.parse({ index, action: step.action, page_id: "main", planned_step_digest: sha(canonical(step)), observation }));
    }
    return operations;
  } finally { if (focus) await bounded(focus.close(), timeout); }
}
