// Controlled regression observer only. Real native Windows, real CDP and real UI;
// no model, authored evidence, response substitution, process mock or publication.
// Invoked as an ordinary protected verifier in a native Job. The installed CLI
// integration is exercised separately by storage-precondition-real.test.mjs.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { ContextPackSchema, ProductDesignV2Schema } from "@artoo/domain";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native Windows x64 is required");
const sha = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : value && typeof value === "object" ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const envelope = JSON.parse(readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE, "utf8"));
const contextPack = ContextPackSchema.parse(envelope.context);
const workspace = realpathSync.native(process.cwd());
assert.equal(workspace, config.workspace); assert.equal(contextPack.workspace.root, workspace);
assert.equal(envelope.version, 1);
const auditPath = join(dirname(process.argv[2]), "native-events.jsonl");
const resultPath = join(dirname(process.argv[2]), "native-result.json");
writeFileSync(auditPath, "", { flag: "wx" });
let ordinal = 0, bytes = 0, observerFailure;
const observations = [];
function observe(body) { try { body(); } catch (error) { observerFailure ??= error; } }
function record(kind, details = {}) {
  if (observerFailure) return;
  try {
  const value = { ordinal: ++ordinal, monotonic_ms: performance.now(), kind, ...details };
  const line = JSON.stringify(value) + "\n"; bytes += Buffer.byteLength(line);
  if (ordinal > 8192 || bytes > 8 * 1024 * 1024) throw new Error("Controlled native observer exceeded its fixed audit bound");
  appendFileSync(auditPath, line); observations.push(value); return value;
  } catch (error) { observerFailure ??= error; }
}
const errorText = error => error instanceof Error ? error.message : String(error);
const errors = [], children = [], pages = [], sessions = [];
const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn");
const originalSpawn = childProcess.spawn;
function observedSpawn(...args) {
  const child = Reflect.apply(originalSpawn, this, args);
  const item = { executable: args[0], pid: null, spawned: false, exit: null, close: null,
    stdout_eof: child.stdout ? false : null, stderr_eof: child.stderr ? false : null };
  const argv = Array.isArray(args[1]) ? args[1] : [];
  if (args[0] === config.browser_executable) item.browser_profile = argv.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  children.push(item); record("process-created", { index: children.length - 1, executable: args[0], windows_hide: args[2]?.windowsHide });
  child.once("spawn", () => { item.pid = child.pid; item.spawned = true; record("process-spawn", { pid: child.pid, executable: item.executable }); });
  child.once("error", error => { item.error = errorText(error); record("process-error", { pid: child.pid, error: item.error }); });
  for (const event of ["exit", "close"]) child.once(event, (code, signal) => {
    item[event] = { code, signal }; record("process-" + event, { pid: child.pid, code, signal });
  });
  for (const [stream, field] of [[child.stdout, "stdout_eof"], [child.stderr, "stderr_eof"]]) {
    stream?.once("end", () => { item[field] = true; record("process-output-eof", { pid: child.pid, stream: field }); });
  }
  return child;
}
Object.defineProperty(childProcess, "spawn", { ...originalSpawnDescriptor, value: observedSpawn });
syncBuiltinESMExports();

// This isolated world observes native trusted events. Product default-world
// console messages cannot satisfy it. It never reads/writes application storage,
// changes UI, calls product handlers, or inserts a synthetic event.
const observerWorld = "artoo-controlled-native-storage-observer-v1";
const observerLabel = "ARTOO_CONTROLLED_NATIVE_EVENT_V1";
const observerSource = "(" + function () {
  const output = console.debug.bind(console);
  const stringify = JSON.stringify;
  const listen = window.addEventListener.bind(window);
  listen("storage", event => {
    output("ARTOO_CONTROLLED_NATIVE_EVENT_V1", stringify({
      event: "storage", trusted: event.isTrusted, key: event.key,
      old_value: event.oldValue, new_value: event.newValue, url: event.url
    }));
  });
  listen("click", event => {
    output("ARTOO_CONTROLLED_NATIVE_EVENT_V1", stringify({
      event: "click", trusted: event.isTrusted, target_id: event.target instanceof Element ? event.target.id : null
    }));
  }, true);
}.toString() + ")();";
const result = { version: 1, claim: "controlled-native-browser-fixture", request_id: envelope.request_id,
  profile_digest: envelope.profile_digest, subject_digest: envelope.subject_digest, worker_pid: process.pid,
  observer_source_digest: sha(observerSource), program_outcome: "not-started", context_closed: false,
  browser_close_fulfilled: false, server_close_fulfilled: false, children };
let owned, site, browserContext, programResult;
try {
  const { launchOwnedBrowser } = await import("../dist/owned-browser.js");
  const { serveAcceptanceProduct } = await import("../dist/web-acceptance.js");
  const { executeBrowserProgramV3 } = await import("../dist/web-acceptance-pages.js");
  const { withBrowserActionTimeout: bounded } = await import("../dist/web-acceptance-executor.js");
  const designPath = join(workspace, ".artoo/product/design.json");
  const designBytes = readFileSync(designPath), design = ProductDesignV2Schema.parse(JSON.parse(designBytes.toString("utf8")));
  const selected = design.validation_cases.find(item => item.id === config.case_id);
  assert.equal(selected?.method, "workspace-check"); assert.ok(selected.storage_precondition);
  const binding = { source: { path: ".artoo/product/design.json", checksum: sha(designBytes), size: designBytes.length, case_id: selected.id },
    precondition: selected.storage_precondition };
  result.source = binding.source; result.program_digest = sha(canonical(selected.browser_program));
  site = await serveAcceptanceProduct(workspace); result.origin = site.origin;
  owned = await launchOwnedBrowser({ workspace, executablePath: config.browser_executable });
  result.browser_pid = owned.processId;
  browserContext = await owned.browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
  browserContext.once("close", () => { result.context_closed = true; record("context-close"); });
  const originalNewPage = browserContext.newPage.bind(browserContext);
  const originalNewSession = browserContext.newCDPSession.bind(browserContext);
  const originalContextClose = browserContext.close.bind(browserContext);
  let sessionId = 0;
  function observeSession(session, pageId, role) {
    const item = { id: ++sessionId, page_id: pageId, role, closed: false };
    sessions.push(item);
    session.once("close", () => { item.closed = true; record("cdp-close", { session: item.id, page_id: pageId, role }); });
    const nativeSend = session.send.bind(session);
    let request = 0;
    session.send = async (method, params) => {
      const id = ++request;
      const interesting = method.startsWith("DOMStorage.") || ["Debugger.resume", "Debugger.getScriptSource", "Page.addScriptToEvaluateOnNewDocument"].includes(method)
        || method === "Runtime.callFunctionOn" && params?.arguments?.[0]?.value === "arm";
      const metadata = { session: item.id, page_id: pageId, role, request: id, method };
      if (interesting) {
        const details = method === "Page.addScriptToEvaluateOnNewDocument"
          ? { source_digest: sha(params.source), world_name: params.worldName ?? null }
          : method === "Runtime.callFunctionOn" ? { operation: "arm", mode: params.arguments[1].value }
            : params;
        record("cdp-send", { ...metadata, params: details });
      }
      try {
        const value = await nativeSend(method, params);
        if (interesting) record("cdp-response", { ...metadata, result: method === "Debugger.getScriptSource" ? { source_digest: sha(value.scriptSource) } : value });
        return value;
      } catch (error) { record("cdp-error", { ...metadata, error: errorText(error) }); throw error; }
    };
    for (const name of ["Debugger.paused", "Debugger.resumed", "DOMStorage.domStorageItemAdded", "DOMStorage.domStorageItemUpdated",
      "DOMStorage.domStorageItemRemoved", "DOMStorage.domStorageItemsCleared"]) session.on(name, event => {
      record("cdp-event", { session: item.id, page_id: pageId, role, event: name,
        value: name === "Debugger.paused" ? { reason: event.reason, location: event.callFrames[0]?.location } : event });
    });
    return session;
  }
  // Every call delegates to the real Playwright/CDP operation. No controlled
  // response seam or added controller operation participates in acceptance.
  browserContext.newCDPSession = async page => {
    const pageId = pages.find(item => item.page === page)?.id;
    assert.ok(pageId, "Controller requested a session for an unobserved page");
    return observeSession(await originalNewSession(page), pageId, "controller");
  };
  browserContext.newPage = async () => {
    const page = await originalNewPage(), pageId = pages.length === 0 ? "main" : "peer";
    const item = { page, id: pageId, closed: false };
    pages.push(item); page.once("close", () => { item.closed = true; record("page-close", { page_id: pageId }); });
    const session = observeSession(await originalNewSession(page), pageId, "observer");
    item.observer = session;
    let mainFrame;
    const isolatedContexts = new Map();
    session.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.name === observerWorld && context.auxData?.isDefault === false && context.auxData?.frameId === mainFrame
        && typeof context.uniqueId === "string" && context.uniqueId) isolatedContexts.set(context.id,
          { unique_id: context.uniqueId, frame_id: context.auxData.frameId, world_name: context.name });
    });
    session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => isolatedContexts.delete(executionContextId));
    session.on("Runtime.executionContextsCleared", () => isolatedContexts.clear());
    session.on("Runtime.consoleAPICalled", event => {
      if (!isolatedContexts.has(event.executionContextId) || event.type !== "debug" || event.args[0]?.value !== observerLabel) return;
      observe(() => {
        const value = JSON.parse(event.args[1]?.value);
        record("native-dom-event", { page_id: pageId, isolated_context_id: event.executionContextId,
          ...isolatedContexts.get(event.executionContextId), browser_timestamp: event.timestamp, value });
      });
    });
    await bounded(session.send("Page.enable"), config.action_timeout_ms, "Controlled event observer setup");
    mainFrame = (await bounded(session.send("Page.getFrameTree"), config.action_timeout_ms, "Controlled frame observation")).frameTree.frame.id;
    assert.ok(mainFrame, "Native observer requires the actual main frame");
    record("observer-page", { page_id: pageId, frame_id: mainFrame, source_digest: sha(observerSource) });
    await bounded(session.send("Runtime.enable"), config.action_timeout_ms, "Controlled event observer setup");
    await bounded(session.send("DOMStorage.enable"), config.action_timeout_ms, "Controlled native observer setup");
    await bounded(session.send("Page.addScriptToEvaluateOnNewDocument", { source: observerSource, worldName: observerWorld }),
      config.action_timeout_ms, "Controlled event observer registration");
    return page;
  };
  browserContext.close = async () => {
    const sampleErrors = [];
    try {
      const main = pages.find(item => item.id === "main");
      if (main && !main.page.isClosed()) {
        try {
          const actual = await bounded(main.observer.send("DOMStorage.getDOMStorageItems",
            { storageId: { securityOrigin: site.origin, isLocalStorage: true } }), config.action_timeout_ms, "Controlled final native snapshot");
          result.final_native_entries = actual.entries;
          record("final-native-snapshot", { entries: actual.entries });
        } catch (error) { sampleErrors.push(error); }
        try {
          result.final_ui = {
            status: await main.page.locator("#status").textContent({ timeout: config.action_timeout_ms }),
            draft: await main.page.locator("#draft").inputValue({ timeout: config.action_timeout_ms }),
            external: await main.page.locator("#external").textContent({ timeout: config.action_timeout_ms }),
          };
          record("final-dom-read", result.final_ui);
        } catch (error) { sampleErrors.push(error); }
      }
    } finally {
      // Observation failure cannot prevent the production context-close path.
      try { await originalContextClose(); }
      catch (error) { sampleErrors.push(error); }
    }
    if (sampleErrors.length) throw new AggregateError(sampleErrors, "Controlled observation or actual context closure failed");
  };
  try {
    programResult = await executeBrowserProgramV3(browserContext, site.origin, selected.browser_program, config.action_timeout_ms,
      async page => { assert.equal(await page.title(), "Controlled storage recovery"); },
      selected.storage_checks, binding);
    result.program_outcome = "passed";
    result.operations = programResult.operations;
    result.storage_precondition = programResult.storage_precondition;
    if (programResult.storage_fault) result.storage_fault = programResult.storage_fault;
    for (const [pageId, screenshot] of programResult.screenshots) writeFileSync(join(dirname(process.argv[2]), "native-" + pageId + ".png"), screenshot);
  } catch (error) {
    result.program_outcome = "failed"; result.program_error = errorText(error); errors.push(error);
  }
} catch (error) {
  if (result.program_outcome === "not-started") result.setup_error = errorText(error);
  errors.push(error);
} finally {
  // Keep every cleanup result; never turn an intended negative into a pass when
  // its context, CDP session, browser, native observer or server remains uncertain.
  if (browserContext && !result.context_closed) {
    try { await browserContext.close(); }
    catch (error) { errors.push(error); result.context_close_error = errorText(error); }
  }
  if (owned) {
    try { await owned.close(); result.browser_close_fulfilled = true; record("owned-browser-close-fulfilled"); }
    catch (error) { errors.push(error); result.browser_close_error = errorText(error); }
  }
  if (site) {
    try { await site.close(); result.server_close_fulfilled = true; record("server-close-fulfilled"); }
    catch (error) { errors.push(error); result.server_close_error = errorText(error); }
  }
  result.pages = pages.map(({ id, page, closed }) => ({ id, close_event: closed, actually_closed: page.isClosed() }));
  result.sessions = sessions;
  try {
    assert.equal(result.context_closed, true, "Actual context close event is required");
    assert.equal(result.browser_close_fulfilled, true, "Owned browser native exit audit must fulfill");
    assert.equal(result.server_close_fulfilled, true, "Actual server closure is required");
    assert.ok(result.pages.length > 0 && result.pages.every(page => page.close_event && page.actually_closed));
    assert.ok(sessions.length > 0 && sessions.every(session => session.closed), "Every actual CDP session must close");
    const browserChild = children.find(child => child.pid === result.browser_pid);
    assert.ok(browserChild?.browser_profile && browserChild.spawned);
    assert.equal(existsSync(browserChild.browser_profile), false, "Owned browser profile must be removed only after confirmed native exit");
    assert.ok(children.length >= 2, "Observe the native browser and its Windows observer process");
    for (const child of children) {
      assert.ok(child.spawned && child.exit && child.close, "Each observed native child needs actual exit and close");
      assert.deepEqual(child.exit, child.close);
      assert.notEqual(child.stdout_eof, false); assert.notEqual(child.stderr_eof, false);
      assert.equal(child.error, undefined);
    }
    result.cleanup_confirmed = true;
  } catch (error) { result.cleanup_confirmed = false; errors.push(error); result.cleanup_error = errorText(error); }
  const restorationErrors = [];
  try { assert.equal(childProcess.spawn, observedSpawn, "Native spawn observer binding changed"); }
  catch (error) { restorationErrors.push(error); }
  finally {
    // Always restore, including when the identity assertion above failed.
    try { Object.defineProperty(childProcess, "spawn", originalSpawnDescriptor); }
    catch (error) { restorationErrors.push(error); }
    finally { try { syncBuiltinESMExports(); } catch (error) { restorationErrors.push(error); } }
  }
  if (restorationErrors.length) {
    const error = new AggregateError(restorationErrors, "Native spawn observer restoration failed");
    errors.push(error); result.observer_restoration_error = errorText(error);
    result.observer_restoration_details = restorationErrors.map(errorText);
  }
  if (observerFailure) { errors.push(observerFailure); result.observer_error = errorText(observerFailure); }
  result.audit_events = observations.length;
  try { result.audit_checksum = sha(readFileSync(auditPath)); }
  catch (error) { errors.push(error); result.audit_read_error = errorText(error); }
  result.errors = errors.map(errorText);
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
}
if (errors.length) {
  process.stderr.write(JSON.stringify({ controlled_native_fixture: "failed", program_error: result.program_error,
    setup_error: result.setup_error, cleanup_confirmed: result.cleanup_confirmed, retained: dirname(process.argv[2]) }) + "\n");
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ controlled_native_fixture: "passed", cleanup_confirmed: true }) + "\n");
