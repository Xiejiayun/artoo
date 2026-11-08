// Coordinator boundaries only: real loopback HTTP, controlled compiler, store,
// process and browser owners. This is not Windows/native/provider acceptance.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStartPayload } from "@artoo/domain";
import type { PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
const state = vi.hoisted(() => ({ profile: vi.fn(), pin: vi.fn(), definition: vi.fn(), create: vi.fn(), candidate: vi.fn(),
  initialize: vi.fn(), store: vi.fn(), service: vi.fn(), browser: vi.fn(), program: vi.fn() }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: state.profile }));
vi.mock("./application-runtime-installation.js", () => ({ readApplicationRuntimePin: state.pin }));
vi.mock("./application-verification-definition.js", () => ({ readApplicationVerificationDefinition: state.definition }));
vi.mock("./application-verification-candidate.js", () => ({ createApplicationVerificationCandidate: state.create, readApplicationVerificationCandidate: state.candidate }));
vi.mock("./application-verification-bootstrap-process.js", () => ({ initializeApplicationVerificationStore: state.initialize,
  readApplicationVerificationStore: state.store, startApplicationVerificationService: state.service }));
vi.mock("./owned-browser.js", () => ({ launchOwnedBrowser: state.browser }));
vi.mock("./web-acceptance-pages.js", () => ({ executeBrowserProgramV3: state.program }));
vi.mock("./web-acceptance.js", () => ({ inspectPage: vi.fn() }));
import { executeApplicationVerification, readOriginalApplicationMeasurement } from "./application-verification.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
const digest = "sha256:" + "a".repeat(64), workspace = "C:\\work";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => { for (const mock of Object.values(state)) mock.mockReset(); });
async function fixture() {
  const profile = Object.freeze({}) as PreparedApplicationVerificationProfile, backend = Object.freeze({}) as PreparedWindowsProcessBackend;
  const events: string[] = [], rows = new Set<string>(), storeIds = new WeakMap<object, string>();
  let activeService = 0, requests = 0, corruptReopen = false, corruptReplay = false, writes = 0;
  const server = createServer((incoming, response) => {
    requests++; const parts: Buffer[] = [];
    incoming.on("data", chunk => parts.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      events.push(`api:${activeService}:${incoming.method}`);
      let value: unknown;
      if (incoming.method === "POST") {
        writes++; const body = JSON.parse(Buffer.concat(parts).toString()); rows.add(body.idempotency_key);
        response.statusCode = 201; value = { saved: !(corruptReplay && writes > 1) };
      } else value = { items: corruptReopen && activeService % 2 === 0 ? [] : [...rows] };
      response.setHeader("content-type", "application/json"); response.setHeader("connection", "close"); response.end(JSON.stringify(value));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listener absent");
  const origin = `http://127.0.0.1:${address.port}`;
  const configured = { config: { origin, timeout_ms: 10_000, operation_timeout_ms: 1000, action_timeout_ms: 500,
    browser: { path: "C:\\browser\\chrome.exe" } }, capabilities: { config_digest: digest, contract_digest: digest } };
  state.profile.mockImplementation(value => { expect(value).toBe(profile); return configured; });
  const files = new Map(["product/client/index.html", "product/server/handler.ts", ".artoo/product/application.json", ".artoo/product/design.json"]
    .map(path => [path, { checksum: sha(path), size: Buffer.byteLength(path) }] as const));
  state.pin.mockImplementation(pin => {
    const path = win32.relative(workspace, pin.path).split("\\").join("/");
    expect(pin).toEqual({ path: win32.join(workspace, ...path.split("/")), bytes: files.get(path)!.size, sha256: files.get(path)!.checksum });
    return Buffer.from(path);
  });
  const program = { version: 3, contract_digest: digest, steps: [{ action: "navigate", page: "main", path: "/" },
    { action: "assert_text", page: "main", selector: "#items", text: "Saved" }] };
  const definition = { schemaDigest: digest, schemaJson: "{}", schema: {}, cases: [{ id: "save", program }],
    persistence: { write: { path: "/api/items", body: { idempotency_key: "Saved" }, expected_status: 201, expected_json: { saved: true } },
      read: { path: "/api/items", expected_status: 200, expected_json: { items: ["Saved"] } }, after_restart_browser_program: program } };
  state.definition.mockReturnValue(definition);
  const candidate = Object.freeze({}), identity = { version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest,
    toolchain_digest: digest, package_digest: digest, schema_digest: digest, qualified_for_product: false };
  state.create.mockImplementation(async (_profile, input) => { events.push("compile");
    expect(input.source).toEqual([{ path: "product/client/index.html", text: "product/client/index.html" }, { path: "product/server/handler.ts", text: "product/server/handler.ts" }]); return candidate; });
  state.candidate.mockImplementation(value => { expect(value).toBe(candidate); return { identity, originRunId: "author", originRequestId: "author-request" }; });
  state.initialize.mockImplementation(async (_profile, original) => {
    expect(original).toBe(candidate); events.push("initialize"); rows.clear(); writes = 0;
    const store = Object.freeze({}); storeIds.set(store, randomUUID()); return store;
  });
  state.store.mockImplementation(value => { const id = storeIds.get(value); if (!id) throw Error("original store missing"); return { testStoreId: id }; });
  const services: { close: ReturnType<typeof vi.fn> }[] = [];
  state.service.mockImplementation(async store => {
    expect(storeIds.has(store)).toBe(true); activeService++; requests = 0; const id = activeService;
    events.push(`service:${id}`); let count = 0, closed = false, resolve!: () => void;
    const closing = new Promise<void>(done => { resolve = done; });
    const service = { closed: closing, close: vi.fn(async () => { if (!closed) { count = requests; closed = true; events.push(`close:${id}`); resolve(); } }),
      invocations: () => { if (!closed) throw Error("original not closed"); return count; } };
    services.push(service); return service;
  });
  const browserClose = vi.fn(async () => { events.push("browser-close"); });
  const newContext = vi.fn(async () => Object.freeze({}));
  state.browser.mockResolvedValue({ browser: { newContext }, close: browserClose });
  state.program.mockImplementation(async (_context, actualOrigin, actualProgram) => {
    expect(actualOrigin).toBe(origin); expect(actualProgram).toBe(program); events.push("browser-program");
    const screenshot = Buffer.from("controlled-image"), checksum = sha(screenshot);
    return { operations: [{ action: "assert_text", result: "controlled" }], captures: [{ page_id: "main", screenshot_digest: checksum }], screenshots: new Map([["main", screenshot]]) };
  });
  const makeRun = (id = "author", expected?: { candidate: unknown; origin_run_id: string; origin_request_id: string }) => ({
    run_id: id, task_id: `task-${id}`, workspace: { root: workspace }, verification: { request_id: `${id}-request`,
      application: { version: 1, config_digest: digest, contract_digest: digest, ...(expected ? { expected_candidate: expected } : {}) } },
    context_pack: { payload: { app_delivery: { version: 1, kind: "local-application-development" }, project: { id: "project" }, task: { id: `task-${id}` },
      workspace: { root: workspace }, ...(expected ? { review_subject: { run_id: "author" } } : {}) } },
  }) as unknown as RunStartPayload;
  const subject = { digest, files }, assertSubject = vi.fn();
  const run = (payload = makeRun()) => executeApplicationVerification(profile, { run: { nodeId: "node", runStart: payload }, requestId: payload.verification!.request_id,
    workspace, stage: "implementation", subject, assertSubject, backend, signal: new AbortController().signal });
  return { profile, run, makeRun, events, services, browserClose, newContext, candidate, identity, subject, assertSubject,
    corruptReopen: () => { corruptReopen = true; }, corruptReplay: () => { corruptReplay = true; } };
}
describe("actual application orchestration over controlled owner boundaries", () => {
  it("retains candidate lineage only for the original successful observation and unchanged original run", async () => {
    const f = await fixture(), payload = f.makeRun(), original = { nodeId: "node", runStart: payload };
    const observation = await f.run(payload);
    const measured = readOriginalApplicationMeasurement(f.profile, observation, original);
    expect(measured.candidate).toBe(f.candidate);
    expect(measured.runStart).toBe(payload);
    expect(measured.definition.persistence.read.path).toBe("/api/items");
    expect(() => readOriginalApplicationMeasurement(f.profile, structuredClone(observation), original)).toThrow("Original unchanged");
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, { ...original, runStart: structuredClone(payload) })).toThrow("Original unchanged");
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, { ...original, nodeId: "other" })).toThrow("Original unchanged");
    expect(() => readOriginalApplicationMeasurement(Object.freeze({}) as PreparedApplicationVerificationProfile, observation, original)).toThrow("Original unchanged");
    payload.task_id = "different-task";
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, original)).toThrow("Original unchanged");
  });
  it("rejects mutated original evidence and changed protected candidate on later composition", async () => {
    const f = await fixture(), payload = f.makeRun(), original = { nodeId: "node", runStart: payload };
    const observation = await f.run(payload), before = observation.acceptance.test_store_id;
    observation.acceptance.test_store_id = randomUUID();
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, original)).toThrow("Original unchanged");
    observation.acceptance.test_store_id = before;
    state.candidate.mockReturnValue({ identity: { ...f.identity, package_digest: "sha256:" + "b".repeat(64) },
      originRunId: "author", originRequestId: "author-request" });
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, original)).toThrow("candidate changed");
    state.candidate.mockImplementation(() => { throw Error("original protected package audit failed"); });
    expect(() => readOriginalApplicationMeasurement(f.profile, observation, original)).toThrow("package audit failed");
  });
  it("performs business requests across distinct original services and withholds success until all owners close", async () => {
    const f = await fixture(), result = await f.run();
    expect(f.events).toEqual(["compile", "initialize", "service:1", "browser-program", "api:1:POST", "api:1:GET", "close:1",
      "service:2", "api:2:GET", "api:2:POST", "api:2:GET", "browser-program", "close:2", "browser-close"]);
    expect(result.acceptance.closures).toEqual({ compiler: true, initialize: true, services: 2, browser: true });
    expect(result.qualified_for_product).toBe(false); expect(result.candidate).toEqual(f.identity);
    expect(f.newContext).toHaveBeenCalledTimes(2);
  });
  it("reuses the exact candidate for independent review and creates a different test store", async () => {
    const f = await fixture(), author = await f.run();
    const review = await f.run(f.makeRun("reviewer", { candidate: author.candidate, origin_run_id: "author", origin_request_id: "author-request" }));
    expect(state.create).toHaveBeenCalledTimes(1); expect(state.initialize).toHaveBeenCalledTimes(2);
    expect(review.candidate).toEqual(author.candidate); expect(review.acceptance.test_store_id).not.toBe(author.acceptance.test_store_id);
    expect(review.run_id).toBe("reviewer"); expect(review.origin_run_id).toBe("author");
  });
  it("rejects copied/rebound review candidates before store or browser startup", async () => {
    const f = await fixture();
    await expect(f.run(f.makeRun("reviewer", { candidate: f.identity, origin_run_id: "author", origin_request_id: "author-request" }))).rejects.toThrow("unavailable");
    expect(state.initialize).not.toHaveBeenCalled(); await f.run(); state.initialize.mockClear();
    await expect(f.run(f.makeRun("reviewer", { candidate: { ...f.identity, package_digest: "sha256:" + "b".repeat(64) },
      origin_run_id: "author", origin_request_id: "author-request" }))).rejects.toThrow("differs");
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it.each(["reopen", "replay"])("does not emit evidence after a %s business mismatch and still closes original owners", async phase => {
    const f = await fixture(); (phase === "reopen" ? f.corruptReopen : f.corruptReplay)();
    await expect(f.run()).rejects.toThrow("business assertion failed");
    expect(f.services).toHaveLength(2); expect(f.services.every(service => service.close.mock.calls.length > 0)).toBe(true);
    expect(f.browserClose).toHaveBeenCalledOnce();
    await expect(f.run(f.makeRun("reviewer", { candidate: f.identity, origin_run_id: "author", origin_request_id: "author-request" }))).rejects.toThrow("unavailable");
  });
  it("rejects changed source after measurements and declines to register the candidate", async () => {
    const f = await fixture(); f.browserClose.mockImplementation(async () => { f.assertSubject.mockImplementation(() => { throw Error("source changed"); }); });
    await expect(f.run()).rejects.toThrow("source changed"); expect(f.services).toHaveLength(2);
  });
  it("does not report successful closures after a browser close failure", async () => {
    const f = await fixture(); f.browserClose.mockRejectedValue(Error("browser remains owned"));
    await expect(f.run()).rejects.toBeInstanceOf(VerificationCleanupError);
  });
  it("joins the browser even when service cleanup throws synchronously, preserving the original case failure", async () => {
    const f = await fixture(), originalStart = state.service.getMockImplementation()!;
    state.service.mockImplementationOnce(async (...args) => { const service = await originalStart(...args);
      service.close.mockImplementation(() => { throw Error("synchronous service cleanup failure"); }); return service; });
    const primary = Error("original browser case failure"); state.program.mockRejectedValueOnce(primary);
    const failure = await f.run().catch(error => error);
    expect(failure).toBeInstanceOf(VerificationCleanupError);
    expect(failure.cause).toBeInstanceOf(AggregateError); expect(failure.cause.errors[0]).toBe(primary);
    expect(failure.cause.errors[1].message).toContain("synchronous service"); expect(f.browserClose).toHaveBeenCalledOnce();
  });
  it("rejects empty package members before compiler allocation", async () => {
    const f = await fixture(); f.subject.files.set("product/client/empty.css", { checksum: sha(""), size: 0 });
    await expect(f.run()).rejects.toThrow("nonempty"); expect(state.create).not.toHaveBeenCalled();
  });
  it("rechecks the original clock after a synchronous admission/source audit without waiting for timer dispatch", async () => {
    const f = await fixture(); let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    f.assertSubject.mockImplementation(() => { now = 10_000; });
    try { await expect(f.run()).rejects.toThrow("deadline elapsed"); expect(state.create).not.toHaveBeenCalled(); }
    finally { clock.mockRestore(); }
  });
  it("includes the first protected profile audit in the original application budget", async () => {
    const f = await fixture(), originalRead = state.profile.getMockImplementation()!; let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    state.profile.mockImplementationOnce(value => { const result = originalRead(value); now = 10_000; return result; });
    try { await expect(f.run()).rejects.toThrow("deadline elapsed"); expect(state.create).not.toHaveBeenCalled(); }
    finally { clock.mockRestore(); }
  });
  it("does not register or return success when the final store audit crosses the original deadline", async () => {
    const f = await fixture(), originalRead = state.store.getMockImplementation()!; let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    state.store.mockImplementation(value => { const result = originalRead(value); now = 10_000; return result; });
    try {
      await expect(f.run()).rejects.toThrow("deadline elapsed");
      expect(f.browserClose).toHaveBeenCalledOnce(); expect(f.services).toHaveLength(2);
      await expect(f.run(f.makeRun("reviewer", { candidate: f.identity, origin_run_id: "author", origin_request_id: "author-request" }))).rejects.toThrow("unavailable");
    } finally { clock.mockRestore(); }
  });
});
