// Built POSIX integration fixtures. Products are controlled fixtures; no model or publication is invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, existsSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareVerificationProfiles, runVerification, runVerificationPreview, subjectManifest, verificationSupported } from "../dist/verification.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { createNodeClient } from "../dist/node-client.js";
import { takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader } from "../dist/workspace-tools.js";

const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const browser = process.env.ARTOO_TEST_CHROMIUM;
const real = { skip: !verificationSupported() || !browser, timeout: 120000 };
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const viewports = [{ id: "compact", width: 512, height: 650 }, { id: "tall", width: 512, height: 1000 }];
const step = (action, page = "main", properties = {}) => ({ action, page, ...properties });
const navigate = step("navigate", "main", { path: "/" });
const open = (page, path = "/") => step("open_page", page, { path });
const close = page => step("close_page", page);
const text = (page, selector, value) => step("assert_text", page, { selector, text: value });
const click = (selector, page = "main") => step("click", page, { selector });
const fill = value => step("fill", "main", { selector: "#entry", value });
const programs = {
  synchronization: [navigate, text("main", "#value", "Empty"), open("peer"), fill("First entry"), click("#save"),
    text("peer", "#value", "First entry"), text("peer", "#events", "1"), fill("Second entry"), click("#save"),
    text("peer", "#value", "Second entry"), text("peer", "#events", "2"), click("#clear"), text("peer", "#value", "Empty"),
    text("peer", "#events", "3"), close("peer"), text("main", "#value", "Empty")],
  three_pages: [navigate, open("first"), open("second"), fill("Three pages"), click("#save"),
    text("first", "#value", "Three pages"), text("second", "#value", "Three pages"), close("first"),
    text("main", "#value", "Three pages"), close("second"), text("main", "#value", "Three pages")],
  isolation: [navigate, text("main", "#value", "Empty"), text("main", "#events", "0")],
};
const invalidPrograms = {
  fourth: [navigate, open("first"), open("second"), open("third"), text("main", "#value", "Empty")],
  reused: [navigate, open("peer"), close("peer"), open("peer"), text("main", "#value", "Empty")],
  closed: [navigate, open("peer"), close("peer"), text("peer", "#value", "Empty")],
  unknown: [navigate, text("unknown", "#value", "Empty")],
  main_close: [navigate, text("main", "#value", "Empty"), close("main")],
};

function html(mode, remoteNavigationUrl) {
  if (mode === "remote-navigation") assert.equal(typeof remoteNavigationUrl, "string");
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared journal fixture</title>
    <style>body{margin:12px}textarea{display:block;width:100%;box-sizing:border-box}</style></head><body><h1>Shared journal</h1>
    <label for="entry">Entry</label><textarea id="entry"></textarea><button id="save">Save</button><button id="clear">Clear</button>
    <p id="value">Empty</p><p id="events">0</p><button id="debug-sync">Debug event</button>
    ${mode === "iframe" ? '<iframe title="Unexpected frame" srcdoc="<p>Unexpected frame</p>"></iframe>' : ""}
    <script>
    const entry=document.getElementById('entry'), value=document.getElementById('value'), count=document.getElementById('events');
    let events=0;
    const render=()=>{value.textContent=localStorage.getItem('entry')||'Empty';};render();
    document.getElementById('save').addEventListener('click',()=>{localStorage.setItem('entry',entry.value);render();
      ${mode === "popup" ? "window.open('/','unexpected');" : ""}
      ${mode === "blank-popup" ? "const link=document.createElement('a');link.href='/';link.target='_blank';link.textContent='Unexpected';document.body.append(link);link.click();" : ""}
      ${mode === "noopener-popup" ? "window.open('/','_blank','noopener');" : ""}
      ${mode === "blank-navigation" ? "location.href='about:blank';" : ""}
      ${mode === "remote-navigation" ? `location.href=${JSON.stringify(remoteNavigationUrl)};` : ""}
      ${mode === "download" ? "const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['fixture']));a.download='fixture.txt';a.click();" : ""}
    });
    document.getElementById('clear').addEventListener('click',()=>{localStorage.removeItem('entry');render();});
    window.addEventListener('storage',event=>{
      if(event.key!=='entry'||event.storageArea!==localStorage)return;
      ${mode === "no-sync" ? "return;" : mode === "debug-only" ? "if(event.isTrusted)return;" : "if(!event.isTrusted)return;"}
      events++;count.textContent=String(events);render();
    });
    // This deliberately exposed product debug affordance is never used by the verifier.
    document.getElementById('debug-sync').addEventListener('click',()=>window.dispatchEvent(new StorageEvent('storage',{key:'entry',storageArea:localStorage})));
    if(new URL(location.href).searchParams.has('popup'))window.open('/','unexpected-from-peer');
    ${mode === "websocket" ? "new WebSocket('ws://'+location.host+'/channel');" : ""}
    </script></body></html>`;
}
function fixture(mode = "correct", cases = programs, designCapture = true, protectedOverrides = {}, remoteNavigationUrl) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-pages-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "web.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  writeFileSync(config, JSON.stringify({ evidence_root: evidence, browser_executable: realpathSync.native(browser),
    browser_program: { version: 3, viewports }, action_timeout_ms: protectedOverrides.action_timeout_ms ?? 1000, design_capture_cases: designCapture }));
  const [profile] = prepareVerificationProfiles([{ id: "web", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: protectedOverrides.command_timeout_ms ?? 60000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] }]);
  const contractDigest = profile.capabilities.checks[0].contract_digest;
  const research = { version: 1, objective: "Controlled actual cross-page journal updates", assumptions: [],
    requirements: [{ id: "shared", description: "Normal UI edits update existing peer pages", priority: "must", acceptance_criteria: ["Two writes and removal update peer UI through actual shared storage"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Schema fixture, not live research", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("fixture") }],
    findings: [{ summary: "Exercise normal UI and real storage notifications across pages", source_ids: ["fixture"] }], decisions: [] };
  const design = { version: 1, requirement_ids: ["shared"], information_architecture: ["Journal"],
    user_flows: [{ id: "edit", name: "Edit", requirement_ids: ["shared"], steps: ["Open peers", "Write", "Update", "Remove"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Share edits", states: ["Empty", "Saved"], accessibility: ["Named controls"], responsive: ["Fit configured dimensions"] }],
    prototype: { entrypoint: "product/index.html", description: "Controlled shared storage fixture" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Use normal UI writes and native storage events", rationale: "Synthetic events and debug controls cannot establish peer behavior" }],
    validation_cases: Object.entries(cases).map(([id, steps]) => ({ id, requirement_ids: ["shared"], procedure: ["Exercise real browser controls"], expected_result: "Program assertions pass",
      browser_program: { version: 3, contract_digest: contractDigest, steps } })) };
  writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify(research));
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify(design));
  writeFileSync(join(workspace, "product/index.html"), html(mode, remoteNavigationUrl));
  const context = { task: { id: "task", title: "Cross-page fixture", description: "Measure normal UI changes across pages", acceptance_criteria: ["Peers actually update"] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: { ...profile.capabilities, profile_id: profile.id },
    product_development: { version: 1, stage: "design", instructions: ["Use the configured contract"],
      deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Controlled handoff" }] } };
  return { root, workspace, evidence, config, profile, context, close: () => rmSync(root, { recursive: true, force: true }) };
}
function grant(f, receipt, scope = "final") {
  return { evidenceRoot: f.evidence, requestId: receipt.request_id, profileId: f.profile.id, profileDigest: f.profile.digest,
    subjectDigest: receipt.subject_digest, checkId: "browser", scope, ...receipt.checks[0].observation.evidence_bundle };
}

test("v3 normal UI writes/removal update real peer pages; exact captures include closed pages and isolated cases", real, async () => {
  const f = fixture();
  try {
    const before = subjectManifest(f.profile).digest;
    const receipt = await runVerification(f.profile, "shared-pages", new AbortController().signal, f.context);
    assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.checks[0].exit_code, 0);
    assert.equal(subjectManifest(f.profile).digest, before);
    const observation = receipt.checks[0].observation, binding = grant(f, receipt);
    assert.equal(observation.version, 3); assert.equal(observation.cases.length, viewports.length * Object.keys(programs).length);
    for (const item of observation.cases) {
      const planned = programs[item.case_id], pages = ["main", ...planned.filter(step => step.action === "open_page").map(step => step.page)];
      assert.deepEqual(item.captures.map(capture => capture.page_id), pages);
      const content = readBrowserEvidence(binding, item.trace_ref), trace = JSON.parse(content.text);
      assert.equal(sha(content.text), item.trace_digest); assert.equal(item.operation_count, planned.length);
      assert.deepEqual(trace.operations.map(operation => [operation.action, operation.page_id]), planned.map(step => [step.action, step.page]));
      assert.deepEqual(trace.captures, item.captures.map(({ screenshot_ref, ...capture }) => capture));
      for (const capture of item.captures) {
        const closeIndex = planned.findIndex(step => step.action === "close_page" && step.page === capture.page_id);
        const timing = closeIndex < 0 ? { kind: "case-end" } : { kind: "before-close", step_index: closeIndex };
        assert.deepEqual(capture.timing, timing);
        const image = readBrowserEvidence(binding, capture.screenshot_ref), png = Buffer.from(image.data, "base64");
        assert.equal(image.page_id, capture.page_id); assert.deepEqual(image.timing, timing);
        assert.equal(png.readUInt32BE(16), item.viewport.width); assert.equal(png.readUInt32BE(20), item.viewport.height);
        assert.equal(sha(png), capture.screenshot_digest);
      }
    }
  } finally { f.close(); }
});

for (const mode of ["no-sync", "debug-only"]) {
  test(`v3 rejects ${mode} peer UI with the same native-update program`, real, async () => {
    const f = fixture(mode, { synchronization: programs.synchronization });
    try {
      const receipt = await runVerification(f.profile, `broken-${mode}`, new AbortController().signal, f.context);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.match(receipt.reason, /assert_text/); assert.equal(receipt.checks[0].observation, undefined);
    } finally { f.close(); }
  });
}

for (const [name, program] of Object.entries(invalidPrograms)) {
  test(`v3 rejects the ${name} page lifecycle`, real, async () => {
    const f = fixture("correct", { [name]: program });
    try {
      const receipt = await runVerification(f.profile, `invalid-${name}`, new AbortController().signal, f.context);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.match(receipt.reason, /page|main|closed|reuse/i); assert.equal(receipt.checks[0].observation, undefined);
    } finally { f.close(); }
  });
}

async function controlledExternalSite() {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body>Controlled external page</body></html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/external`;
  const close = () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
  try {
    // Prove the controlled destination responds before counting product requests.
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200); await response.text(); assert.equal(requests, 1); requests = 0;
    return { url, get requests() { return requests; }, close };
  } catch (error) { await close(); throw error; }
}

for (const [mode, pattern] of [["popup", /page|popup/i], ["blank-popup", /page|popup/i], ["noopener-popup", /page|popup/i],
  ["iframe", /frame/i], ["websocket", /WebSocket/i], ["download", /download/i], ["blank-navigation", /navigation|origin|unsupported/i],
  ["remote-navigation", /navigation|origin|unsupported|external|ERR_ABORTED/i]]) {
  test(`v3 rejects ${mode} while operating the product`, real, async () => {
    const program = [navigate, fill("A value"), click("#save"), step("assert_count", "main", { selector: "body", count: 1 })];
    const external = mode === "remote-navigation" ? await controlledExternalSite() : undefined;
    let f;
    try {
      f = fixture(mode, { boundary: program }, true, {}, external?.url);
      const receipt = await runVerification(f.profile, `boundary-${mode}`, new AbortController().signal, f.context);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.match(receipt.reason, pattern); assert.equal(receipt.checks[0].observation, undefined);
      if (external) assert.equal(external.requests, 0, "The product's external navigation must be blocked before reaching the controlled destination");
    } finally { try { f?.close(); } finally { await external?.close(); } }
  });
}

test("v3 rejects an unsolicited popup during protected peer navigation", real, async () => {
  const f = fixture("correct", { popup_race: [navigate, open("peer", "/?popup=1"), text("main", "#value", "Empty")] });
  try {
    const receipt = await runVerification(f.profile, "popup-during-open", new AbortController().signal, f.context);
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
    assert.match(receipt.reason, /page|popup/i); assert.equal(receipt.checks[0].observation, undefined);
  } finally { f.close(); }
});

test("v3 research has no pages and prototype-only preview creates only its actual main-page capture", real, async () => {
  const f = fixture("correct", { synchronization: programs.synchronization }, false);
  try {
    const context = structuredClone(f.context); context.product_development.stage = "research";
    const research = await runVerification(f.profile, "research-v3", new AbortController().signal, context);
    assert.equal(research.outcome, "passed", research.reason); assert.deepEqual(research.checks[0].observation.cases, []);
    assert.ok(readBrowserEvidence(grant(f, research), research.checks[0].observation.evidence_bundle.bundle_id));
    const { verification: preview } = await runVerificationPreview(f.profile, "prototype-v3", new AbortController().signal, f.context);
    assert.equal(preview.outcome, "passed", preview.reason);
    for (const item of preview.checks[0].observation.cases) {
      assert.equal(item.case_id, "prototype"); assert.equal(item.operation_count, 1); assert.equal(item.assertions, 0);
      assert.deepEqual(item.captures.map(({ page_id, timing }) => ({ page_id, timing })), [{ page_id: "main", timing: { kind: "case-end" } }]);
    }
  } finally { f.close(); }
});

function processSnapshot() {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      let command = "";
      try { command = readFileSync(`/proc/${name}/cmdline`, "utf8"); }
      catch { /* Sandboxed helpers can hide cmdline; the protected parent/group still identifies them. */ }
      return [{ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19], command }];
    } catch { return []; } // A process can exit while the read-only snapshot is enumerating.
  });
}
function ownedProcessSnapshot(browserProfile, group, observed = processSnapshot()) {
  const ids = new Set(observed.filter(item => item.group === group
    || item.command.split("\0").includes(`--user-data-dir=${browserProfile}`)).map(item => item.pid));
  let previous;
  do {
    previous = ids.size;
    for (const item of observed) if (ids.has(item.parent)) ids.add(item.pid);
  } while (previous !== ids.size);
  return observed.filter(item => ids.has(item.pid));
}
function assertOwnedProductListener(verifierPid, origin) {
  const url = new URL(origin); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  const address = `0100007F:${Number(url.port).toString(16).toUpperCase().padStart(4, "0")}`;
  const listeners = readFileSync(`/proc/${verifierPid}/net/tcp`, "utf8").trim().split("\n").slice(1)
    .map(line => line.trim().split(/\s+/)).filter(fields => fields[1] === address && fields[3] === "0A");
  assert.equal(listeners.length, 1, "The observed product origin must have one live loopback listener");
  const expectedSocket = `socket:[${listeners[0][9]}]`;
  const ownsSocket = readdirSync(`/proc/${verifierPid}/fd`).some(fd => {
    try { return readlinkSync(`/proc/${verifierPid}/fd/${fd}`) === expectedSocket; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  assert.equal(ownsSocket, true, "The bound verifier must own the observed product HTTP listener");
}
function assertConnectionRefused(url) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    const finish = error => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(new Error("The verifier's product HTTP listener is still accepting connections")));
    socket.once("timeout", () => finish(new Error("Product HTTP connection timed out instead of confirming ECONNREFUSED")));
    socket.once("error", error => finish(error.code === "ECONNREFUSED" ? undefined : error));
  });
}
async function assertVerifierClosed(observed) {
  for (const item of observed.processes) assert.throws(() => process.kill(item.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(-observed.group, 0), { code: "ESRCH" });
  assert.equal(ownedProcessSnapshot(observed.browserProfile, observed.group).length, 0);
  assert.equal(existsSync(observed.browserProfile), false); assert.equal(existsSync(observed.contextDirectory), false);
  await assert.rejects(fetch(observed.urls[0], { signal: AbortSignal.timeout(1000) }));
  await assertConnectionRefused(observed.urls[0]);
}
async function observeThreeActualPages(f, requestId, settled) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(settled(), undefined, "Verifier ended before three actual pages were observed");
    for (const directory of readdirSync(tmpdir(), { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith("artoo-verification-context-"))) {
      const contextDirectory = join(tmpdir(), directory.name), contextFile = join(contextDirectory, "context.json");
      let envelope;
      try { envelope = JSON.parse(readFileSync(contextFile, "utf8")); }
      catch { continue; } // Other invocations may be creating or removing their own private context.
      if (envelope.request_id !== requestId) continue;
      assert.equal(envelope.profile_id, f.profile.id); assert.equal(envelope.profile_digest, f.profile.digest);
      assert.equal(envelope.context?.workspace.root, f.workspace);
      for (const entry of readdirSync(contextDirectory, { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith("artoo-owned-browser-"))) {
        const browserProfile = join(contextDirectory, entry.name), endpointFile = join(browserProfile, "DevToolsActivePort");
        if (!existsSync(endpointFile)) continue;
        const port = Number(readFileSync(endpointFile, "utf8").split(/\r?\n/)[0]);
        assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
        let targets;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
          targets = await response.json();
        } catch { continue; } // The owned browser endpoint is still starting or has already closed.
        const pages = targets.filter(target => target.type === "page" && target.title === "Shared journal fixture"
          && target.url.startsWith("http://127.0.0.1:"));
        if (pages.length !== 3) continue;
        const snapshot = processSnapshot(), browserProcesses = snapshot.filter(item => item.command.split("\0").includes(`--user-data-dir=${browserProfile}`));
        assert.ok(browserProcesses.length > 0);
        const groups = [...new Set(browserProcesses.map(item => item.group))]; assert.equal(groups.length, 1);
        const group = groups[0], verifier = snapshot.find(item => item.pid === group && item.group === group);
        assert.ok(verifier, "The owned Chromium must inherit its verifier's process group");
        assert.deepEqual(verifier.command.split("\0").filter(Boolean), f.profile.commands[0].argv);
        assert.equal(f.profile.commands[0].argv[1], realpathSync.native(cli));
        assert.equal(f.profile.commands[0].argv[2], realpathSync.native(f.config));
        assert.equal(realpathSync.native(`/proc/${verifier.pid}/cwd`), f.workspace);
        const environment = readFileSync(`/proc/${verifier.pid}/environ`, "utf8").split("\0");
        const commandContextFile = join(contextDirectory, "command-0.json");
        assert.deepEqual(environment.filter(value => value.startsWith("ARTOO_VERIFICATION_CONTEXT_FILE=")), [`ARTOO_VERIFICATION_CONTEXT_FILE=${commandContextFile}`]);
        assert.ok(environment.includes(`TMPDIR=${contextDirectory}`));
        const commandContext = JSON.parse(readFileSync(commandContextFile, "utf8"));
        assert.equal(commandContext.request_id, requestId); assert.equal(commandContext.profile_id, f.profile.id);
        assert.equal(commandContext.profile_digest, f.profile.digest); assert.equal(commandContext.subject_digest, envelope.subject_digest);
        assert.equal(commandContext.context?.workspace.root, f.workspace);
        const origins = [...new Set(pages.map(page => new URL(page.url).origin))]; assert.equal(origins.length, 1);
        assertOwnedProductListener(verifier.pid, origins[0]);
        const processes = ownedProcessSnapshot(browserProfile, group, snapshot); assert.ok(processes.length >= 2);
        assert.ok(processes.some(item => item.pid === verifier.pid));
        return { contextDirectory, browserProfile, processes, group, urls: pages.map(page => page.url) };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Three real product page targets were not observed");
}

for (const cancel of [true, false]) {
  test(`v3 ${cancel ? "cancellation" : "timeout"} closes three actual pages and the verifier's owned processes`, {
    ...real, skip: process.platform !== "linux" || !browser,
  }, async () => {
    const f = fixture("correct", { wait: [navigate, open("first"), open("second"),
      text("main", "#never-present", "Never reached")] }, true,
    { action_timeout_ms: 10000, command_timeout_ms: cancel ? 30000 : 5000 });
    const controller = new AbortController(), requestId = cancel ? "cancel-three-pages" : "timeout-three-pages";
    let pending, settlement, observed, executionError;
    try {
      pending = runVerification(f.profile, requestId, controller.signal, f.context);
      void pending.then(result => { settlement = result; }, error => { settlement = { error: error.message }; });
      // This separate inspector only observes owned DevTools target metadata. It
      // does not mutate product storage, dispatch events or grant passing evidence.
      observed = await observeThreeActualPages(f, requestId, () => settlement);
      if (cancel) controller.abort();
      const receipt = await pending;
      assert.equal(receipt.outcome, cancel ? "cancelled" : "timed_out", receipt.reason);
      assert.equal(receipt.checks.some(check => check.observation), false);
    } catch (error) {
      executionError = error; throw error;
    } finally {
      controller.abort();
      try {
        if (pending) await pending;
        assert.ok(observed, "Three-page verifier ownership was not established; cleanup cannot be independently confirmed");
        await assertVerifierClosed(observed);
      } catch (error) {
        throw new Error(`Unconfirmed verifier cleanup; fixture retained at ${f.root}`,
          { cause: executionError ? new AggregateError([executionError, error], "Execution and cleanup evidence failed") : error });
      }
      f.close();
    }
  });
}

test("node grants v3 author preview and only final multi-page traces and closed-page captures to a read-only peer", real, async () => {
  // The repeated real assertions make a trace larger than a single evidence page.
  const traceSteps = [...programs.synchronization, ...Array.from({ length: 80 }, () => text("main", "#value", "Empty"))];
  const f = fixture("correct", { trace: traceSteps }), events = [], previewReferences = new Set();
  const closeIndex = traceSteps.findIndex(item => item.action === "close_page" && item.page === "peer");
  let send, verifier, reader, previewTrace, author, peer;
  const terminal = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
    && ["completed", "cancelled", "failed"].includes(message.event.payload.phase));
  const receipt = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
  const waitTerminal = async messages => {
    const deadline = Date.now() + 90000;
    while (!terminal(messages)) {
      const rejection = messages.find(message => message.status === "rejected");
      assert.equal(rejection, undefined, `Node rejected the fixture request: ${JSON.stringify(rejection)}`);
      assert.ok(Date.now() < deadline, "node multi-page evidence flow did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(terminal(messages).event.payload.phase, "completed", JSON.stringify(terminal(messages)));
  };
  const readTrace = async (read, measured, scope, subjectDigest) => {
    assert.ok(measured.trace_size > 16 * 1024, `long actual trace is only ${measured.trace_size} bytes`);
    let combined = "", offset = 0, checksum, first;
    for (let count = 0; count < 64; count++) {
      const page = await read(measured.trace_ref, { offset, limit: 4096, ...(checksum ? { expected_checksum: checksum } : {}) });
      first ??= page; checksum ??= page.checksum;
      assert.equal(page.mime_type, "application/json"); assert.equal(page.offset, offset);
      assert.equal(page.provenance.scope, scope); assert.equal(page.provenance.subjectDigest, subjectDigest);
      assert.equal(page.checksum, measured.trace_digest); assert.equal(page.checksum, checksum);
      combined += page.text;
      if (page.eof) { assert.equal(page.next_offset, null); break; }
      assert.ok(page.next_offset > offset); offset = page.next_offset;
    }
    assert.equal(Buffer.byteLength(combined), measured.trace_size); assert.equal(sha(combined), measured.trace_digest);
    const actual = JSON.parse(combined);
    assert.equal(actual.version, 3); assert.equal(actual.format, "static-web-trace.v3");
    assert.equal(actual.operations.length, traceSteps.length);
    assert.deepEqual(actual.operations.map(operation => [operation.action, operation.page_id]), traceSteps.map(item => [item.action, item.page]));
    assert.deepEqual(actual.captures, measured.captures.map(({ screenshot_ref, ...capture }) => capture));
    assert.deepEqual(actual.operations[closeIndex].observation, { kind: "page-closed", closed: true });
    await assert.rejects(read(measured.trace_ref, { offset: first.next_offset, limit: 4096 }), /checksum/);
    await assert.rejects(read(measured.trace_ref, { limit: 4096, expected_checksum: sha("wrong trace") }), /checksum/);
    return actual;
  };
  const readClosedPage = async (read, measured, scope, subjectDigest) => {
    const capture = measured.captures.find(item => item.page_id === "peer");
    assert.ok(capture, "the already-closed peer page must have a capture");
    assert.deepEqual(capture.timing, { kind: "before-close", step_index: closeIndex });
    const image = await read(capture.screenshot_ref), png = Buffer.from(image.data, "base64");
    assert.equal(image.mime_type, "image/png"); assert.equal(image.page_id, "peer");
    assert.equal(image.provenance.scope, scope); assert.equal(image.provenance.subjectDigest, subjectDigest);
    assert.deepEqual(image.timing, capture.timing); assert.equal(image.checksum, capture.screenshot_digest);
    assert.equal(sha(png), capture.screenshot_digest);
    assert.equal(png.readUInt32BE(16), measured.viewport.width); assert.equal(png.readUInt32BE(20), measured.viewport.height);
    await assert.rejects(read(capture.screenshot_ref, { offset: 0, limit: 4096 }), /only for JSON/);
  };
  const capabilityBinding = { version: 1, profile_digest: f.profile.digest,
    checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  const request = { kind: "command", id: "author_start", idempotency_key: "author:start", type: "run.start", payload: {
    run_id: "author", task_id: "task", agent_instance_id: "author_instance", runtime: "fixture", workspace: { root: f.workspace },
    context_pack: { id: "author_context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: f.profile.id, request_id: "node-final-v3", capability_binding: capabilityBinding } } };
  try {
    const before = subjectManifest(f.profile).digest;
    author = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        verifier = takeWorkspaceToolVerifier(config); reader = takeWorkspaceToolEvidenceReader(config);
        assert.equal(typeof verifier, "function"); assert.equal(typeof reader, "function"); return { runId: "author" };
      }, async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
        const preview = (await verifier(new AbortController().signal)).verification;
        assert.equal(preview.outcome, "passed", preview.reason);
        const observation = preview.checks[0].observation;
        assert.equal(observation.version, 3); assert.equal(observation.scope, "preview");
        previewReferences.add(observation.evidence_bundle.bundle_id);
        for (const measured of observation.cases) {
          previewReferences.add(measured.trace_ref);
          for (const capture of measured.captures) previewReferences.add(capture.screenshot_ref);
        }
        const measured = observation.cases[0]; previewTrace = measured.trace_ref;
        await readTrace(reader, measured, "preview", preview.subject_digest);
        await readClosedPage(reader, measured, "preview", preview.subject_digest);
        await assert.rejects(reader("trace_other_session"), /not granted/);
        yield { type: "run.lifecycle", payload: { phase: "completed" } };
      }, async stop() {}, async collectArtifacts() { return []; } } });
    author.start(); send(request); await waitTerminal(events);
    const final = receipt(events); assert.equal(final.outcome, "passed", final.reason);
    assert.equal(final.subject_digest, before); assert.equal(subjectManifest(f.profile).digest, before);
    const finalObservation = final.checks[0].observation;
    assert.equal(finalObservation.version, 3); assert.equal(finalObservation.scope, "final");
    const measured = finalObservation.cases[0]; assert.notEqual(measured.trace_ref, previewTrace);
    assert.equal(previewReferences.has(finalObservation.evidence_bundle.bundle_id), false);
    await author.stop(true);
    const peerEvents = [], context = structuredClone(f.context); delete context.product_development;
    context.task.id = "peer_task"; context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "task", run_id: "author", evidence_id: "author_evidence",
      subject_digest: final.subject_digest, development_stage: "design", verification: { version: 1,
        request_id: final.request_id, profile_id: final.profile_id, profile_digest: final.profile_digest,
        checks: final.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    peer = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { peerEvents.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        assert.equal(takeWorkspaceToolVerifier(config), undefined);
        assert.equal(config.runStart.context_pack.payload.policy.execution_mode, "discussion");
        assert.deepEqual(config.runStart.context_pack.payload.policy.filesystem_write_scope, []);
        assert.deepEqual(config.runStart.policy_snapshot.filesystem_write_scope, [f.workspace]);
        const read = takeWorkspaceToolEvidenceReader(config); assert.equal(typeof read, "function");
        await readTrace(read, measured, "final", final.subject_digest);
        await readClosedPage(read, measured, "final", final.subject_digest);
        for (const reference of previewReferences) await assert.rejects(read(reference), /not granted/);
        await assert.rejects(read("trace_other_session"), /not granted/);
        return { runId: "peer" };
      }, async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    peer.start(); send({ ...request, id: "peer_start", idempotency_key: "peer:start", payload: { ...request.payload,
      // The server's outer workspace admission remains authorized. The distinct
      // discussion context and absent verifier grant constrain peer tools to reads.
      run_id: "peer", task_id: "peer_task", agent_instance_id: "peer_instance", context_pack: { id: "peer_context", payload: context },
      verification: { ...request.payload.verification, request_id: "peer-final-v3", expected_subject_digest: final.subject_digest } } });
    await waitTerminal(peerEvents); assert.equal(receipt(peerEvents).outcome, "passed");
    assert.equal(subjectManifest(f.profile).digest, before);
  } finally { await peer?.stop(true); await author?.stop(true); f.close(); }
});
