import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextPackSchema, ProductDesignSchema, productDevelopmentContext } from "@artoo/domain";
import { prepareStaticWebCapabilities, runWebAcceptance } from "./web-acceptance.js";
import { AcceptanceCleanupError } from "./web-acceptance-cleanup.js";

const mocks = vi.hoisted(() => ({ server: vi.fn(), launch: vi.fn() }));
vi.mock("node:http", async importOriginal => ({ ...await importOriginal<typeof import("node:http")>(), createServer: mocks.server }));
vi.mock("./owned-browser.js", () => ({ launchOwnedBrowser: mocks.launch }));
const roots: string[] = [], digest = `sha256:${"a".repeat(64)}`;
beforeEach(() => { mocks.server.mockReset(); mocks.launch.mockReset(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Flatten only verifier wrappers, so assertions retain the actual injected error identities and order.
function originalErrors(error: unknown): unknown[] {
  if (error instanceof AcceptanceCleanupError) return error.errors.flatMap(originalErrors);
  if (error instanceof Error && Object.hasOwn(error, "cause")) return originalErrors(error.cause);
  return [error];
}

/** Real plans, case executors and cleanup call sites; controlled Playwright and HTTP boundaries only. */
function fixture(version: 1 | 2 | 3) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-cleanup-integration-"))); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), log: string[] = [];
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const failures = new Map<string, unknown>();
  const fail = (phase: string) => { if (failures.has(phase)) throw failures.get(phase); };
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); },
    address: () => ({ port: 23456 }),
    close(done: (error?: Error) => void) { log.push("site-close"); done(failures.get("site") as Error | undefined); },
    closeAllConnections() { log.push("site-connections-close"); },
  });
  mocks.server.mockReturnValue(server);
  const isolated = new EventEmitter(), page = new EventEmitter();
  let closed = false, address = "about:blank", onContextClose: (() => void) | undefined;
  const frame = { url: () => address };
  Object.assign(page, {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    url: () => address, mainFrame: () => frame, frames: () => [frame], isClosed: () => closed,
    async goto(url: string) { log.push("case"); fail("case"); address = url; page.emit("framenavigated", frame); return { ok: () => true, status: () => 200 }; },
    title: async () => "Saved entry", evaluate: async () => ({ overflow: false, unnamed: [] }),
    locator: () => ({ textContent: async () => "Saved", innerText: async () => "Saved" }),
    screenshot: async () => Buffer.from("controlled screenshot"),
  });
  Object.assign(isolated, {
    pages: () => [], async route() {}, async routeWebSocket() {},
    async newPage() { isolated.emit("page", page); return page; },
    async close() { log.push("context-close"); onContextClose?.(); fail("context"); closed = true; page.emit("close"); },
  });
  mocks.launch.mockImplementation(async () => {
    log.push("launch"); fail("launch");
    return { browser: { async newContext() { log.push("context-open"); fail("context-open"); return isolated; } },
      async close() { log.push("browser-close"); fail("browser"); } };
  });
  const prepared = prepareStaticWebCapabilities(version === 1 ? { viewports: [390], evidence_root: evidence }
    : { browser_program: { version, viewports: [{ id: "phone", width: 390, height: 600 }] }, evidence_root: evidence });
  const binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Save", description: "Fixture", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("implementation") });
  const steps = [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "#entry", text: "Saved" }];
  const design = ProductDesignSchema.parse({ version: 1, requirement_ids: ["save"], information_architecture: ["Journal"],
    user_flows: [{ id: "write", name: "Write", requirement_ids: ["save"], steps: ["Save an entry"] }],
    screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Saved"], accessibility: ["Labels"], responsive: ["Phone"] }],
    prototype: { entrypoint: "product/index.html", description: "Interactive editor" }, data_model: [], api_contracts: [], decisions: [{ decision: "Offline", rationale: "Local" }],
    validation_cases: [{ id: "saved", requirement_ids: ["save"], procedure: ["Save"], expected_result: "Entry appears",
      ...(version === 1 ? { browser_steps: steps } : { browser_program: { version, contract_digest: prepared.contract_digest, steps: steps.map(item => ({ ...item, page: "main" })) } }) }] });
  writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify({ version: 1, objective: "Journal", assumptions: [],
    requirements: [{ id: "save", description: "Save an entry", priority: "must", acceptance_criteria: ["Entry appears"] }],
    sources: [{ id: "fixture", url: "https://example.com", title: "Controlled fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: digest }],
    findings: [{ summary: "Controlled fixture only", source_ids: ["fixture"] }], decisions: [] }));
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify(design));
  writeFileSync(join(workspace, "product/index.html"), "<title>Journal</title><p id=entry>Saved</p>");
  return { log, failures, page, onContextClose: (callback: () => void) => { onContextClose = callback; },
    hasReport: () => readdirSync(evidence).some(directory => existsSync(join(evidence, directory, "result.json"))),
    run: () => runWebAcceptance(workspace, context, prepared.options, "cleanup-fixture", binding) };
}

for (const version of [1, 2, 3] as const) describe(`v${version} actual acceptance cleanup call sites (controlled boundaries)`, () => {
  const completeOrder = ["launch", "context-open", "case", "context-close", "browser-close", "site-close", "site-connections-close"];
  it("returns evidence only after every owned cleanup settles", async () => {
    const f = fixture(version), actual = await f.run();
    expect(actual.passed).toBe(true); expect(actual.cases).toHaveLength(1);
    expect(f.log).toEqual(completeOrder); expect(f.hasReport()).toBe(true);
  });
  it("preserves the case cause when all cleanup succeeds", async () => {
    const f = fixture(version), failure = new Error("accessible names"); f.failures.set("case", failure);
    const caught = await f.run().catch(error => error);
    expect(caught).not.toBeInstanceOf(AcceptanceCleanupError); expect(caught.cause).toBe(failure);
    expect(() => { throw caught; }).toThrow("accessible names");
    expect(f.log).toEqual(completeOrder); expect(f.hasReport()).toBe(false);
  });
  for (const phase of ["context", "browser", "site"] as const) it.each([false, true])(`${phase} cleanup failure remains fatal with case failure=%s`, async caseFails => {
    const f = fixture(version), caseFailure = new Error("accessible names"), cleanupFailure = new Error(`${phase} actual failure`);
    f.failures.set(phase, cleanupFailure); if (caseFails) f.failures.set("case", caseFailure);
    const caught = await f.run().catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.phase).toBe(phase); expect(caught.cause).toBe(cleanupFailure);
    expect(caught.message).toBe(phase === "browser" ? "Browser acceptance owned browser cleanup failed"
      : phase === "context" ? "Browser acceptance context cleanup failed" : "Browser acceptance local site cleanup failed");
    const originals = originalErrors(caught);
    expect(originals).toHaveLength(caseFails ? 2 : 1); expect(originals.at(-1)).toBe(cleanupFailure);
    if (caseFails) expect(originals[0]).toBe(caseFailure);
    expect(() => expect(() => { throw caught; }).toThrow("accessible names")).toThrow();
    expect(f.log).toEqual(completeOrder); expect(f.hasReport()).toBe(false);
  });
  it("retains every original failure in order while owned-browser failure stays primary", async () => {
    const f = fixture(version), errors = ["case", "context", "browser", "site"].map(phase => new Error(phase));
    for (const [index, phase] of ["case", "context", "browser", "site"].entries()) f.failures.set(phase, errors[index]);
    const caught = await f.run().catch(error => error), originals = originalErrors(caught);
    expect(caught.phase).toBe("browser"); expect(caught.cause).toBe(errors[2]);
    expect(originals).toHaveLength(4); originals.forEach((error, index) => expect(error).toBe(errors[index]));
    expect(f.log).toEqual(completeOrder); expect(f.hasReport()).toBe(false);
  });
  it.each(["launch", "context-open"])("does not invent ownership after %s fails", async acquisition => {
    const f = fixture(version), failure = new Error("acquisition failed"), siteFailure = new Error("site cleanup failed");
    f.failures.set(acquisition, failure); f.failures.set("site", siteFailure);
    const caught = await f.run().catch(error => error), originals = originalErrors(caught);
    expect(caught.phase).toBe("site"); expect(caught.cause).toBe(siteFailure);
    expect(originals[0]).toBe(failure); expect(originals[1]).toBe(siteFailure);
    expect(f.log).toEqual(acquisition === "launch" ? ["launch", "site-close", "site-connections-close"]
      : ["launch", "context-open", "browser-close", "site-close", "site-connections-close"]);
    expect(f.hasReport()).toBe(false);
  });
});

it("keeps the v2 violation check after actual context closure", async () => {
  const f = fixture(2); f.onContextClose(() => f.page.emit("download", {}));
  await expect(f.run()).rejects.toThrow("unsupported behavior during context closure: download");
  expect(f.log.slice(-4)).toEqual(["context-close", "browser-close", "site-close", "site-connections-close"]);
  expect(f.hasReport()).toBe(false);
});
