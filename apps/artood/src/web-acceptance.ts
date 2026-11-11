import { createServer } from "node:http";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Page } from "playwright";
import { ProductResearchReportSchema, ProductDesignSchema, ProductValidationReportSchema,
  StaticWebCapabilitiesSchema, StaticWebCapabilityBindingSchema, AllowedBrowserKeySchema, BrowserOperationTraceV2Schema,
  StaticWebAcceptanceReportV2Schema, StaticWebAcceptanceReportV3Schema, BrowserOperationTraceV3Schema, MAX_BROWSER_OPERATION_TRACE_BYTES,
  storageFaultCapabilitiesV1, storageFaultReportFromTraceV1, storagePreconditionCapabilitiesV1, storagePreconditionReportFromTraceV1,
  type ContextPack, type ProductBrowserStep, type ProductDesign, type StaticWebAcceptanceReportV1, type StaticWebAcceptanceReportV2, type StaticWebAcceptanceReportV3,
  type StaticWebCapabilities, type StaticWebCapabilityBinding, type VerificationObservation } from "@artoo/domain";
import { readProductFile } from "./product-stage.js";
import { launchOwnedBrowser } from "./owned-browser.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { normalizeWebAcceptanceOptions, isV2WebAcceptanceOptions, isV3WebAcceptanceOptions, StaticWebCapabilitySnapshotSchema, STATIC_WEB_DEFAULT_TIMEOUT, STATIC_WEB_DEFAULT_VIEWPORTS,
  STATIC_WEB_FULL_PAGE_SCREENSHOT, STATIC_WEB_MAX_CASES, STATIC_WEB_MAX_STEPS, STATIC_WEB_VIEWPORT_HEIGHT,
  type NormalizedWebAcceptanceOptions, type NormalizedWebAcceptanceOptionsV2, type NormalizedWebAcceptanceOptionsV3, type StaticWebCapabilitySnapshot, type WebAcceptanceOptions } from "./web-acceptance-config.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { BROWSER_V2_ACTIONS, executeBrowserProgramV2 } from "./web-acceptance-executor.js";
import { deriveWebAcceptanceV2Plan, type ExpectedWebAcceptanceV2 } from "./web-acceptance-plan.js";
import { deriveWebAcceptanceV3Plan, type ExpectedWebAcceptanceV3 } from "./web-acceptance-plan-v3.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";
import { BROWSER_V3_ACTIONS, executeBrowserProgramV3 } from "./web-acceptance-pages.js";
import { browserTraceV2Filename, browserCaptureV2Filename, browserTraceV3Filename, browserCaptureV3Filename } from "./browser-evidence.js";
import { AcceptanceCleanupError, withAcceptanceCleanup } from "./web-acceptance-cleanup.js";
import { validateWebAcceptanceHandoff } from "./web-acceptance-handoff.js";
export type { NormalizedWebAcceptanceOptions, StaticWebCapabilitySnapshot, WebAcceptanceOptions } from "./web-acceptance-config.js";

const inside = (path: string, root: string): boolean => { const tail = relative(root, path); return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)); };
const substantive = new Set(["assert_text", "assert_value", "assert_count"]);

export function validateBrowserCases(design: ProductDesign): void {
  if (design.version !== 1) throw new Error("Version 2 product design requires a protected browser program v3 check");
  if (design.validation_cases.length > STATIC_WEB_MAX_CASES) throw new Error("Browser acceptance supports at most 50 cases");
  for (const test of design.validation_cases) {
    if (!test.browser_steps || test.browser_steps[0]?.action !== "navigate" || !test.browser_steps.some((step) => substantive.has(step.action))) {
      throw new Error(`Validation case ${test.id} needs a local navigation and a content, value or count assertion`);
    }
  }
}

/** Serves only regular files under product/. No shell, source imports, proxying or product-selected ports. */
export async function serveAcceptanceProduct(workspace: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405).end(); return; }
    try {
      const url = new URL(request.url ?? "/", "http://local.invalid");
      let path = decodeURIComponent(url.pathname).slice(1);
      if (!path || path.endsWith("/")) path += "index.html";
      if (path.split("/").some((part) => part.startsWith("."))) throw new Error("Private path");
      const bytes = readProductFile(workspace, `product/${path}`, 10 * 1024 * 1024);
      const extension = path.split(".").pop() ?? "";
      const mime: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", ico: "image/x-icon" };
      response.writeHead(200, { "content-type": mime[extension] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Acceptance server could not bind");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}

type BrowserAction = ProductBrowserStep["action"];
type StepHandler<Action extends BrowserAction> = (page: Page, origin: string,
  step: Extract<ProductBrowserStep, { action: Action }>, timeout: number) => Promise<void>;
type ContentAssertion = Extract<ProductBrowserStep, { action: "assert_text" | "assert_value" | "assert_count" }>;
async function assertContent(page: Page, _origin: string, step: ContentAssertion, timeout: number): Promise<void> {
  const element = page.locator(step.selector), started = Date.now();
  // Poll dynamic application output within the same operator-defined action timeout.
  for (;;) {
    const actual = step.action === "assert_text" ? await element.textContent({ timeout })
      : step.action === "assert_value" ? await element.inputValue({ timeout }) : await element.count();
    const passed = step.action === "assert_text" ? typeof actual === "string" && actual.includes(step.text)
      : step.action === "assert_value" ? actual === step.value : actual === step.count;
    if (passed) break;
    if (Date.now() - started >= timeout) throw new Error(`${step.action} failed for ${step.selector}; observed ${JSON.stringify(actual).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// Exhaustive handlers are both the dispatcher and the source of advertised actions.
// A new schema action cannot be advertised without adding its implementation here.
const browserStepHandlers: { [Action in BrowserAction]: StepHandler<Action> } = Object.freeze({
  navigate: async (page, origin, step) => {
    const url = new URL(step.path, origin);
    if (url.origin !== origin) throw new Error("Browser navigation must stay on the product origin");
    const response = await page.goto(url.href, { waitUntil: "load" });
    if (!response?.ok()) throw new Error(`Product returned HTTP ${response?.status() ?? "no response"}`);
  },
  reload: async (page) => { const response = await page.reload({ waitUntil: "load" }); if (!response?.ok()) throw new Error("Product reload failed"); },
  click: async (page, _origin, step) => { await page.locator(step.selector).click(); },
  fill: async (page, _origin, step) => { await page.locator(step.selector).fill(step.value); },
  check: async (page, _origin, step) => { await page.locator(step.selector).setChecked(step.checked); },
  assert_visible: async (page, _origin, step) => { await page.locator(step.selector).waitFor({ state: "visible" }); },
  assert_hidden: async (page, _origin, step) => { await page.locator(step.selector).waitFor({ state: "hidden" }); },
  assert_text: assertContent, assert_value: assertContent, assert_count: assertContent,
});

async function browserStep(page: Page, origin: string, step: ProductBrowserStep, timeout: number): Promise<void> {
  // The discriminant selects the corresponding typed handler; the table above is exhaustive.
  const handler = browserStepHandlers[step.action] as StepHandler<BrowserAction>;
  await handler(page, origin, step, timeout);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export interface PreparedStaticWebCapabilities {
  options: NormalizedWebAcceptanceOptions;
  config_digest: string;
  contract_digest: string;
  contract: StaticWebCapabilities;
}

/** Local protected configuration only. This does not claim that any product has been exercised. */
export function prepareStaticWebCapabilities(input: unknown): PreparedStaticWebCapabilities {
  const options = normalizeWebAcceptanceOptions(input);
  if (isV3WebAcceptanceOptions(options)) {
    const contract = StaticWebCapabilitiesSchema.parse({ version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3,
      legacy_browser_steps: "rejected", actions: [...BROWSER_V3_ACTIONS], viewports: options.browser_program.viewports, device_scale_factor: 1,
      stage_policy: { research: "no-browser", design: options.design_capture_cases ? "declared-cases" : "prototype-only",
        implementation: "declared-cases", validation: "declared-cases" },
      screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
        same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
      limits: { max_cases: STATIC_WEB_MAX_CASES, max_steps_per_case: STATIC_WEB_MAX_STEPS, action_timeout_ms: options.action_timeout_ms },
      checks: ["horizontal-overflow", "dom-control-name-heuristic"],
      keyboard: { allowed_keys: AllowedBrowserKeySchema.options, typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
      unavailable: [...(options.storage_fault ? [] : ["storage-exception-injection"]), "native-screen-reader", "browser-zoom"],
      ...(options.storage_fault ? { storage_fault: storageFaultCapabilitiesV1(STORAGE_FAULT_INITIALIZER_DIGEST) } : {}),
      ...(options.storage_precondition ? { storage_precondition: storagePreconditionCapabilitiesV1(STORAGE_FAULT_INITIALIZER_DIGEST) } : {}),
    });
    return freeze({ options, config_digest: sha(canonical(options)), contract_digest: sha(canonical(contract)), contract });
  }
  if (isV2WebAcceptanceOptions(options)) {
    const contract = StaticWebCapabilitiesSchema.parse({ version: 2, kind: "static-web", claim: "configured", browser_steps_version: 2,
      legacy_browser_steps: "rejected", actions: [...BROWSER_V2_ACTIONS], viewports: options.browser_program.viewports, device_scale_factor: 1,
      stage_policy: { research: "no-browser", design: options.design_capture_cases ? "declared-cases" : "prototype-only",
        implementation: "declared-cases", validation: "declared-cases" },
      screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true },
      limits: { max_cases: STATIC_WEB_MAX_CASES, max_steps_per_case: STATIC_WEB_MAX_STEPS, action_timeout_ms: options.action_timeout_ms },
      checks: ["horizontal-overflow", "dom-control-name-heuristic"],
      keyboard: { allowed_keys: AllowedBrowserKeySchema.options, typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
      unavailable: ["multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"],
    });
    return freeze({ options, config_digest: sha(canonical(options)), contract_digest: sha(canonical(contract)), contract });
  }
  const contract = StaticWebCapabilitiesSchema.parse({ version: 1, kind: "static-web", claim: "configured", browser_steps_version: 1,
    actions: Object.keys(browserStepHandlers),
    viewports: options.viewports.map((width) => ({ id: `width-${width}`, width, height: STATIC_WEB_VIEWPORT_HEIGHT })),
    stage_policy: { research: "no-browser", design: options.design_capture_cases ? "declared-cases" : "prototype-only",
      implementation: "declared-cases", validation: "declared-cases" },
    screenshots: STATIC_WEB_FULL_PAGE_SCREENSHOT ? "full-page" : "final-visible-viewport",
    pages: { max_pages: 1, same_browser_context: true },
    limits: { max_cases: STATIC_WEB_MAX_CASES, max_steps_per_case: STATIC_WEB_MAX_STEPS, action_timeout_ms: options.action_timeout_ms },
    checks: ["horizontal-overflow", "dom-control-name-heuristic"],
    unavailable: ["keyboard-navigation", "multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"],
  });
  return freeze({ options, config_digest: sha(canonical(options)), contract_digest: sha(canonical(contract)), contract });
}

/** The child recomputes both identities from the snapshot it will actually execute. */
export function validateStaticWebCapabilitySnapshot(input: unknown): StaticWebCapabilitySnapshot {
  const snapshot = StaticWebCapabilitySnapshotSchema.parse(input), prepared = prepareStaticWebCapabilities(snapshot.options);
  if (snapshot.binding.config_digest !== prepared.config_digest || snapshot.binding.contract_digest !== prepared.contract_digest) {
    throw new Error("Static web capability snapshot differs from its configured binding");
  }
  return freeze({ ...snapshot, options: prepared.options });
}

/** Independently derive case identities from fixed product files and the protected configuration. */
export function deriveExpectedWebAcceptanceV2(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptions,
  binding: StaticWebCapabilityBinding, scope: VerificationObservation["scope"] = "final"): ExpectedWebAcceptanceV2 {
  const snapshot = validateStaticWebCapabilitySnapshot({ version: 1, binding, options });
  if (!isV2WebAcceptanceOptions(snapshot.options)) throw new Error("Expected a protected browser_program v2 configuration");
  return deriveWebAcceptanceV2Plan(workspace, context, snapshot.options, snapshot.binding, scope);
}

export function deriveExpectedWebAcceptanceV3(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptions,
  binding: StaticWebCapabilityBinding, scope: VerificationObservation["scope"] = "final"): ExpectedWebAcceptanceV3 {
  const snapshot = validateStaticWebCapabilitySnapshot({ version: 1, binding, options });
  if (!isV3WebAcceptanceOptions(snapshot.options)) throw new Error("Expected a protected browser_program v3 configuration");
  return deriveWebAcceptanceV3Plan(workspace, context, snapshot.options, snapshot.binding, scope);
}

export async function inspectPage(page: Page): Promise<void> {
  if (!(await page.title()).trim() || !(await page.locator("body").innerText()).trim()) throw new Error("A usable product needs a title and visible content");
  const facts = await page.evaluate(() => {
    const unnamed: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("button,input:not([type=hidden]),textarea,select,a[href]"))) {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
      const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const label = element.getAttribute("aria-label") || labelledBy.trim() || Array.from(labels ?? []).map((item) => item.textContent).join(" ").trim()
        || element.textContent?.trim() || element.getAttribute("title") || ((element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) ? element.value : "")
        || element.querySelector("img[alt]")?.getAttribute("alt");
      if (!label?.trim()) unnamed.push(element.outerHTML.slice(0, 180));
    }
    return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, unnamed };
  });
  if (facts.overflow) throw new Error("Product overflows the viewport horizontally");
  if (facts.unnamed.length) throw new Error(`Interactive controls need accessible names: ${facts.unnamed.slice(0, 3).join(" ")}`);
}

/** In-process authority only; never part of the serializable measurement options. */
export interface WebAcceptanceRuntime {
  readonly windowsProcessBackend?: PreparedWindowsProcessBackend;
  readonly verificationScope?: VerificationObservation["scope"];
}
export async function runWebAcceptance(workspace: string, context: ContextPack, options: WebAcceptanceOptions = {}, requestId = "local",
  capabilityBinding?: StaticWebCapabilityBinding, runtime?: WebAcceptanceRuntime) {
  let binding: StaticWebCapabilityBinding | undefined;
  if (capabilityBinding !== undefined) {
    const snapshot = validateStaticWebCapabilitySnapshot({ version: 1, binding: StaticWebCapabilityBindingSchema.parse(capabilityBinding),
      options: normalizeWebAcceptanceOptions(options) });
    options = snapshot.options; binding = snapshot.binding;
  }
  const windowsProcessBackend = runtime?.windowsProcessBackend, scope = runtime?.verificationScope ?? "final";
  if (scope !== "preview" && scope !== "final") throw new Error("Invalid node verification scope");
  if (options.windows_browser_process !== undefined) {
    // Strictly parse this option even on the legacy unbound direct-call path.
    normalizeWebAcceptanceOptions(options);
    if (process.platform !== "win32" || !windowsProcessBackend) throw new Error("Windows browser Job requires a genuine local Windows backend");
    assertWindowsProcessBackend(windowsProcessBackend);
  } else if (windowsProcessBackend !== undefined) throw new Error("Windows browser backend requires explicit protected opt-in");
  if (isV3WebAcceptanceOptions(options)) {
    if (!binding) throw new Error("Browser program v3 requires a protected capability binding");
    const normalized = normalizeWebAcceptanceOptions(options);
    if (!isV3WebAcceptanceOptions(normalized)) throw new Error("Expected browser program v3 options");
    return runWebAcceptanceV3(workspace, context, normalized, requestId, binding, scope, windowsProcessBackend);
  }
  if (isV2WebAcceptanceOptions(options)) {
    if (!binding) throw new Error("Browser program v2 requires a protected capability binding");
    const normalized = normalizeWebAcceptanceOptions(options);
    if (!isV2WebAcceptanceOptions(normalized)) throw new Error("Expected browser program v2 options");
    return runWebAcceptanceV2(workspace, context, normalized, requestId, binding, scope, windowsProcessBackend);
  }
  const root = realpathSync.native(workspace);
  const timeout = options.action_timeout_ms ?? STATIC_WEB_DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 10000) throw new Error("Invalid browser action timeout");
  const viewports = options.viewports ?? [...STATIC_WEB_DEFAULT_VIEWPORTS];
  if (!Array.isArray(viewports) || !viewports.length || viewports.length > 8 || new Set(viewports).size !== viewports.length
    || viewports.some((width) => !Number.isInteger(width) || width < 240 || width > 8192)) throw new Error("Invalid protected browser viewports");
  if (options.design_capture_cases !== undefined && typeof options.design_capture_cases !== "boolean") throw new Error("Invalid design capture policy");
  if (options.browser_executable && (!isAbsolute(options.browser_executable) || inside(realpathSync.native(options.browser_executable), root))) throw new Error("Browser executable must be outside the product workspace");
  let evidence: string | undefined;
  if (options.evidence_root) {
    const storage = realpathSync.native(options.evidence_root);
    if (!isAbsolute(options.evidence_root) || inside(storage, root) || inside(root, storage) || !lstatSync(storage).isDirectory()) throw new Error("Browser evidence must be outside the coding workspace");
    evidence = join(storage, sha(requestId).slice(7)); mkdirSync(evidence, { mode: 0o700 });
    if (lstatSync(evidence).isSymbolicLink() || realpathSync.native(evidence) !== evidence) throw new Error("Invalid browser evidence directory");
  }
  const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
  if (!stage) throw new Error("Static web acceptance requires a product stage or an explicitly bound review subject");
  const json = (path: string) => JSON.parse(readProductFile(root, path).toString("utf8")) as unknown;
  const research = ProductResearchReportSchema.parse(json(".artoo/product/research.json"));
  const finish = (cases: StaticWebAcceptanceReportV1["cases"]): StaticWebAcceptanceReportV1 => {
    const report: StaticWebAcceptanceReportV1 = { version: 1, format: "static-web-acceptance.v1", stage, passed: true, requirements: research.requirements.length, cases,
      ...(binding ? { capability_binding: binding } : {}) };
    if (evidence) writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2), { mode: 0o400, flag: "wx" });
    return report;
  };
  if (stage === "research") return finish([]);
  const design = ProductDesignSchema.parse(json(".artoo/product/design.json"));
  if (design.version !== 1) throw new Error("Version 2 product design requires a protected browser program v3 check");
  const validation = stage === "validation" ? ProductValidationReportSchema.parse(json(".artoo/product/validation.json")) : undefined;
  const missing = validateWebAcceptanceHandoff(context, research, design, validation, scope);
  if (missing.length) throw new Error(missing.join(" "));
  validateBrowserCases(design);
  if (!design.prototype.entrypoint.startsWith("product/")) throw new Error("Web prototype must be inside product/");
  readProductFile(root, design.prototype.entrypoint);
  const site = await serveAcceptanceProduct(root);
  const results: { case_id: string; viewport: number; assertions: number; screenshot_digest: string }[] = [];
  await withAcceptanceCleanup("site", async () => {
    const owned = await launchOwnedBrowser({ workspace: root, ...(options.browser_executable ? { executablePath: options.browser_executable } : {}),
      ...(windowsProcessBackend ? { windowsProcessBackend } : {}) });
    const browser = owned.browser;
    await withAcceptanceCleanup("browser", async () => {
      for (const width of viewports) {
        const cases = stage === "design" && !options.design_capture_cases ? [{ id: "prototype", browser_steps: [{ action: "navigate", path: `/${design.prototype.entrypoint.slice("product/".length)}` } as ProductBrowserStep] }] : design.validation_cases;
        for (const test of cases) {
          const isolated = await browser.newContext({ viewport: { width, height: STATIC_WEB_VIEWPORT_HEIGHT }, serviceWorkers: "block", acceptDownloads: false });
          const blocked: string[] = [], errors: string[] = [];
          await withAcceptanceCleanup("context", async () => { try {
            await isolated.route("**/*", (route) => {
              if (new URL(route.request().url()).origin === site.origin) return route.continue();
              blocked.push(route.request().url().slice(0, 300)); return route.abort("blockedbyclient");
            });
            await isolated.routeWebSocket("**/*", (socket) => { blocked.push(socket.url()); socket.close(); });
            const page = await isolated.newPage(); page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
            page.on("pageerror", (error) => errors.push(error.message.slice(0, 500)));
            for (const step of test.browser_steps!) { await browserStep(page, site.origin, step, timeout); }
            await inspectPage(page);
            if (blocked.length) throw new Error(`Product attempted external network access: ${blocked.slice(0, 3).join(", ")}`);
            if (errors.length) throw new Error(`Product JavaScript errors: ${errors.slice(0, 3).join("; ")}`);
            // Preserve the tested viewport, including its native scrollbar. Full-page
            // capture can shrink the PNG to the scrollable content width in Chromium.
            const screenshot = await page.screenshot({ fullPage: STATIC_WEB_FULL_PAGE_SCREENSHOT, animations: "disabled", timeout });
            if (evidence) writeFileSync(join(evidence, `${test.id}-${width}.png`), screenshot, { mode: 0o400, flag: "wx" });
            results.push({ case_id: test.id, viewport: width, assertions: test.browser_steps!.filter((step) => step.action.startsWith("assert_")).length, screenshot_digest: sha(screenshot) });
          } catch (error) { throw new Error(`Browser case ${test.id} at ${width}px: ${error instanceof Error ? error.message : "failed"}`, { cause: error }); }
          }, () => isolated.close());
        }
      }
    }, () => owned.close());
  }, () => site.close());
  return finish(results);
}

async function runWebAcceptanceV2(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptionsV2,
  requestId: string, binding: StaticWebCapabilityBinding, scope: VerificationObservation["scope"], windowsProcessBackend?: PreparedWindowsProcessBackend): Promise<StaticWebAcceptanceReportV2> {
  const root = realpathSync.native(workspace), timeout = options.action_timeout_ms;
  const plan = deriveExpectedWebAcceptanceV2(root, context, options, binding, scope);
  if (options.browser_executable && (!isAbsolute(options.browser_executable) || inside(realpathSync.native(options.browser_executable), root))) throw new Error("Browser executable must be outside the product workspace");
  let evidence: string | undefined;
  if (options.evidence_root) {
    const storage = realpathSync.native(options.evidence_root);
    if (!isAbsolute(options.evidence_root) || inside(storage, root) || inside(root, storage) || !lstatSync(storage).isDirectory()) throw new Error("Browser evidence must be outside the coding workspace");
    evidence = join(storage, sha(requestId).slice(7)); mkdirSync(evidence, { mode: 0o700 });
    if (lstatSync(evidence).isSymbolicLink() || realpathSync.native(evidence) !== evidence) throw new Error("Invalid browser evidence directory");
  }
  const finish = (cases: StaticWebAcceptanceReportV2["cases"]): StaticWebAcceptanceReportV2 => {
    const report = StaticWebAcceptanceReportV2Schema.parse({ version: 2, format: "static-web-acceptance.v2", stage: plan.stage,
      passed: true, requirements: plan.requirements, device_scale_factor: 1, capability_binding: binding, cases });
    if (evidence) writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2), { mode: 0o400, flag: "wx" });
    return report;
  };
  if (plan.stage === "research") return finish([]);
  const site = await serveAcceptanceProduct(root), results: StaticWebAcceptanceReportV2["cases"] = [];
  await withAcceptanceCleanup("site", async () => {
    const owned = await launchOwnedBrowser({ workspace: root, ...(options.browser_executable ? { executablePath: options.browser_executable } : {}),
      ...(windowsProcessBackend ? { windowsProcessBackend } : {}) });
    await withAcceptanceCleanup("browser", async () => {
      for (const expected of plan.programs) {
        const test = plan.casePrograms.find((item) => item.case_id === expected.case_id)!;
        const isolated = await owned.browser.newContext({ viewport: { width: expected.viewport.width, height: expected.viewport.height },
          deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
        const violations: string[] = [];
        await withAcceptanceCleanup("context", async () => { try {
          await isolated.route("**/*", (route) => {
            if (new URL(route.request().url()).origin === site.origin) return route.continue();
            violations.push("external network request"); return route.abort("blockedbyclient");
          });
          await isolated.routeWebSocket("**/*", (socket) => { violations.push("WebSocket request"); socket.close(); });
          let main: Page | undefined;
          isolated.on("page", (page) => {
            if (!main) { main = page; return; }
            violations.push("additional page or popup");
          });
          const page = await isolated.newPage(); main = page;
          page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
          page.on("pageerror", () => violations.push("product JavaScript error"));
          page.on("download", () => violations.push("download"));
          page.on("frameattached", () => violations.push("iframe"));
          const operations = await executeBrowserProgramV2(page, site.origin, test.program, timeout);
          await inspectPage(page);
          const screenshot = await page.screenshot({ fullPage: false, animations: "disabled", timeout });
          // Recheck after capture: events raised while inspecting or taking the screenshot also fail closed.
          if (violations.length) throw new Error(`Unsupported product behavior: ${[...new Set(violations)].join(", ")}`);
          const trace = BrowserOperationTraceV2Schema.parse({ version: 2, format: "static-web-trace.v2", case_id: expected.case_id,
            page_id: "main", viewport: expected.viewport, device_scale_factor: 1, program_digest: expected.program_digest, operations });
          const traceBytes = Buffer.from(JSON.stringify(trace));
          if (traceBytes.length > MAX_BROWSER_OPERATION_TRACE_BYTES) throw new Error("Browser operation trace exceeds its size limit");
          if (evidence) {
            writeFileSync(join(evidence, browserTraceV2Filename(expected.case_id, expected.viewport.id)), traceBytes, { mode: 0o400, flag: "wx" });
            writeFileSync(join(evidence, browserCaptureV2Filename(expected.case_id, expected.viewport.id)), screenshot, { mode: 0o400, flag: "wx" });
          }
          results.push({ case_id: expected.case_id, viewport: expected.viewport, program_digest: expected.program_digest,
            assertions: operations.filter((operation) => operation.action.startsWith("assert_")).length, operation_count: operations.length,
            trace_digest: sha(traceBytes), trace_size: traceBytes.length, captures: [{ page_id: "main", screenshot_digest: sha(screenshot) }] });
        } catch (error) {
          throw new Error(`Browser case ${expected.case_id} at ${expected.viewport.id} (${expected.viewport.width}x${expected.viewport.height}): ${error instanceof Error ? error.message : "failed"}`, { cause: error });
        } }, () => isolated.close());
        if (violations.length) throw new Error(`Browser case ${expected.case_id}: unsupported behavior during context closure: ${[...new Set(violations)].join(", ")}`);
      }
    }, () => owned.close());
  }, () => site.close());
  return finish(results);
}

async function runWebAcceptanceV3(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptionsV3,
  requestId: string, binding: StaticWebCapabilityBinding, scope: VerificationObservation["scope"], windowsProcessBackend?: PreparedWindowsProcessBackend): Promise<StaticWebAcceptanceReportV3> {
  const root = realpathSync.native(workspace), timeout = options.action_timeout_ms;
  const plan = deriveExpectedWebAcceptanceV3(root, context, options, binding, scope);
  if (options.browser_executable && (!isAbsolute(options.browser_executable) || inside(realpathSync.native(options.browser_executable), root))) throw new Error("Browser executable must be outside the product workspace");
  let evidence: string | undefined;
  if (options.evidence_root) {
    const storage = realpathSync.native(options.evidence_root);
    if (!isAbsolute(options.evidence_root) || inside(storage, root) || inside(root, storage) || !lstatSync(storage).isDirectory()) throw new Error("Browser evidence must be outside the coding workspace");
    evidence = join(storage, sha(requestId).slice(7)); mkdirSync(evidence, { mode: 0o700 });
    if (lstatSync(evidence).isSymbolicLink() || realpathSync.native(evidence) !== evidence) throw new Error("Invalid browser evidence directory");
  }
  const finish = (cases: StaticWebAcceptanceReportV3["cases"]): StaticWebAcceptanceReportV3 => {
    const report = StaticWebAcceptanceReportV3Schema.parse({ version: 3, format: "static-web-acceptance.v3", stage: plan.stage,
      passed: true, requirements: plan.requirements, device_scale_factor: 1, capability_binding: binding, cases });
    if (evidence) writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2), { mode: 0o400, flag: "wx" });
    return report;
  };
  if (plan.stage === "research") return finish([]);
  const site = await serveAcceptanceProduct(root), results: StaticWebAcceptanceReportV3["cases"] = [];
  await withAcceptanceCleanup("site", async () => {
    const owned = await launchOwnedBrowser({ workspace: root, ...(options.browser_executable ? { executablePath: options.browser_executable } : {}),
      ...(windowsProcessBackend ? { windowsProcessBackend } : {}) });
    await withAcceptanceCleanup("browser", async () => {
      for (const expected of plan.programs) {
        const test = plan.casePrograms.find((item) => item.case_id === expected.case_id)!;
        const isolated = await owned.browser.newContext({ viewport: { width: expected.viewport.width, height: expected.viewport.height },
          deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
        try {
          const actual = await executeBrowserProgramV3(isolated, site.origin, test.program, timeout, inspectPage, test.storage_checks, test.storage_precondition);
          const trace = BrowserOperationTraceV3Schema.parse({ version: 3, format: "static-web-trace.v3", case_id: expected.case_id,
            viewport: expected.viewport, device_scale_factor: 1, program_digest: expected.program_digest,
            operations: actual.operations, captures: actual.captures, ...(actual.storage_fault ? { storage_fault: actual.storage_fault } : {}),
            ...(actual.storage_precondition ? { storage_precondition: actual.storage_precondition } : {}) });
          const traceBytes = Buffer.from(JSON.stringify(trace));
          if (traceBytes.length > MAX_BROWSER_OPERATION_TRACE_BYTES) throw new Error("Browser operation trace exceeds its size limit");
          if (evidence) {
            writeFileSync(join(evidence, browserTraceV3Filename(expected.case_id, expected.viewport.id)), traceBytes, { mode: 0o400, flag: "wx" });
            for (const capture of trace.captures) {
              const screenshot = actual.screenshots.get(capture.page_id);
              if (!screenshot) throw new Error("Browser page capture is missing its actual screenshot");
              writeFileSync(join(evidence, browserCaptureV3Filename(expected.case_id, expected.viewport.id, capture.page_id)), screenshot, { mode: 0o400, flag: "wx" });
            }
          }
          results.push({ case_id: expected.case_id, viewport: expected.viewport, program_digest: expected.program_digest,
            assertions: trace.operations.filter((operation) => operation.action.startsWith("assert_")).length, operation_count: trace.operations.length,
            trace_digest: sha(traceBytes), trace_size: traceBytes.length, captures: trace.captures,
            ...(trace.storage_fault ? { storage_fault: storageFaultReportFromTraceV1(trace.storage_fault) } : {}),
            ...(trace.storage_precondition ? { storage_precondition: storagePreconditionReportFromTraceV1(trace.storage_precondition) } : {}) });
        } catch (error) {
          if (error instanceof AcceptanceCleanupError) throw error;
          throw new Error(`Browser case ${expected.case_id} at ${expected.viewport.id} (${expected.viewport.width}x${expected.viewport.height}): ${error instanceof Error ? error.message : "failed"}`, { cause: error });
        }
      }
    }, () => owned.close());
  }, () => site.close());
  return finish(results);
}
