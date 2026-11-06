import type { Page } from "playwright";

type FocusAction = "focus" | "assert_focused" | "assert_focus_within" | "keyboard-scope";
interface FocusInput { action: FocusAction; selector?: string }
interface FocusObservation { passed: boolean; active: Element | null }
export interface MainFrameFocusProbe {
  observe(input: FocusInput): Promise<boolean>;
  close(): Promise<void>;
}

/** Fixed verifier code. It runs in a CDP isolated world, never the product's JavaScript world. */
function observeFocus(input: FocusInput): FocusObservation {
  const activeUnsupported = () => {
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement || active?.shadowRoot) throw new Error("Focus inside iframe/shadow DOM is unsupported");
    return active;
  };
  if (input.action === "keyboard-scope") return { passed: true, active: activeUnsupported() };
  let matches: NodeListOf<Element>;
  try { matches = document.querySelectorAll(input.selector!); } catch { throw new Error("Focus requires a native main-frame CSS selector; iframe/shadow targets are unsupported"); }
  if (matches.length > 1) throw new Error("Focus requires exactly one main-frame DOM target");
  const target = matches[0];
  if (!target) return { passed: false, active: activeUnsupported() };
  if (!(target instanceof HTMLElement) || target instanceof HTMLIFrameElement || target.shadowRoot) throw new Error("Focus iframe/shadow targets are unsupported");
  if (input.action === "focus") target.focus();
  const active = activeUnsupported();
  return { passed: input.action === "assert_focus_within" ? active !== null && target.contains(active) : active === target, active };
}

/** Product scripts can override main-world DOM getters/methods, so focus evidence uses native isolated wrappers. */
export async function createMainFrameFocusProbe(page: Page): Promise<MainFrameFocusProbe> {
  const session = await page.context().newCDPSession(page);
  return {
    async observe(input) {
      // Re-resolve the current main frame/world after navigation; stale contexts fail closed.
      const { frameTree } = await session.send("Page.getFrameTree");
      const { executionContextId } = await session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id, worldName: "artoo-protected-main-frame-focus-v2", grantUniveralAccess: false,
      });
      const objectGroup = "artoo-protected-focus-v2";
      try {
        const result = await session.send("Runtime.callFunctionOn", {
          functionDeclaration: observeFocus.toString(), executionContextId, arguments: [{ value: input }],
          objectGroup, returnByValue: false, awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(`Protected focus observation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        if (!result.result.objectId) throw new Error("Invalid protected focus observation");
        const properties = await session.send("Runtime.getProperties", { objectId: result.result.objectId, ownProperties: true });
        if (properties.exceptionDetails) throw new Error("Could not read the protected focus observation");
        const passed = properties.result.find((property) => property.name === "passed")?.value;
        const active = properties.result.find((property) => property.name === "active")?.value;
        if (passed?.type !== "boolean" || typeof passed.value !== "boolean" || !active) throw new Error("Invalid protected focus observation fields");
        if (active.objectId) {
          // DOM wrappers cannot see a closed author shadow root. CDP can, while native input
          // controls' user-agent roots remain valid main-frame controls.
          const { node } = await session.send("DOM.describeNode", { objectId: active.objectId, depth: 1, pierce: true });
          if (node.shadowRoots?.some((root) => root.shadowRootType !== "user-agent")) throw new Error("Focus inside iframe/shadow DOM is unsupported");
        } else if (active.subtype !== "null") throw new Error("Invalid protected active element");
        return passed.value;
      } finally { await session.send("Runtime.releaseObjectGroup", { objectGroup }); }
    },
    close: () => session.detach(),
  };
}
