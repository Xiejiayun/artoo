import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchOwnedBrowser } from "../dist/owned-browser.js";
import { prepareVerificationProfiles, runVerification } from "../dist/verification.js";
import { runWebAcceptance } from "../dist/web-acceptance.js";
import { readBrowserEvidence, sealBrowserEvidence } from "../dist/browser-evidence.js";

const executablePath = process.env.ARTOO_TEST_CHROMIUM;
const options = { skip: process.platform !== "linux" || !executablePath, timeout: 120000 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) { const until = Date.now() + 30000; while (!predicate()) { if (Date.now() > until) throw Error("Browser fixture timed out"); await pause(20); } }
function processes(profile, rootPid) {
  const observed = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try { const stat = readFileSync(`/proc/${name}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      let command = ""; try { command = readFileSync(`/proc/${name}/cmdline`, "utf8"); } catch { /* Sandboxed children can hide cmdline; parent/group remain observed. */ }
      return [{ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), command }];
    } catch { return []; }
  });
  const ids = new Set([rootPid]); let previous;
  do { previous = ids.size; for (const child of observed) if (ids.has(child.parent) || child.command.includes(profile)) ids.add(child.pid); } while (ids.size !== previous);
  return observed.filter((child) => ids.has(child.pid));
}
test("sandboxed Chromium is owned and its direct process actually exits on close", options, async () => {
  const root = mkdtempSync(join(tmpdir(), "artoo-browser-owned-"));
  let owned;
  try {
    owned = await launchOwnedBrowser({ workspace: root, executablePath });
    const page = await owned.browser.newPage(); await page.setContent("<title>Owned</title><h1>Actual renderer</h1>");
    assert.equal(await page.title(), "Owned");
    const command = readFileSync(`/proc/${owned.processId}/cmdline`, "utf8"); assert.equal(command.includes("--no-sandbox"), false);
    const profile = command.split("\0").find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    const known = processes(profile, owned.processId); assert.ok(known.length >= 2);
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8"); const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    for (const child of known) assert.equal(child.group, group, `Chromium helper escaped verifier group: ${child.command}`);
    await owned.close(); assert.throws(() => process.kill(owned.processId, 0), { code: "ESRCH" });
    await waitFor(() => processes(profile, owned.processId).length === 0); assert.equal(existsSync(profile), false);
  } finally { await owned?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real verifier timeout and cancellation reap Chromium's inherited group", options, async () => {
  for (const cancel of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "artoo-browser-timeout-")), workspace = join(root, "workspace"), ready = join(root, "ready.json"); mkdirSync(workspace);
    writeFileSync(join(workspace, "source.txt"), "source");
    const script = join(root, "verifier.mjs");
    writeFileSync(script, `import{writeFileSync,readFileSync}from'node:fs';import{launchOwnedBrowser}from ${JSON.stringify(new URL("../dist/owned-browser.js", import.meta.url).href)};
      const owned=await launchOwnedBrowser({workspace:process.cwd(),executablePath:${JSON.stringify(executablePath)}});
      const page=await owned.browser.newPage();await page.setContent('<title>Timeout</title><h1>Running</h1>');
      const args=readFileSync('/proc/'+owned.processId+'/cmdline','utf8').split('\\0');
      const profile=args.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      writeFileSync(${JSON.stringify(ready)},JSON.stringify({browser:owned.processId,verifier:process.pid,profile}));setInterval(()=>{},1000);`);
    const [profile] = prepareVerificationProfiles([{ id: "browser", project_id: "project", workspace_root: workspace, commands: [{ id: "browser", argv: [process.execPath, script], timeout_ms: 40000 }], required_files: ["source.txt"], subject_paths: ["source.txt"] }]);
    const controller = new AbortController(); let pending;
    try {
      let earlyResult, earlyError;
      pending = runVerification(profile, cancel ? "cancel" : "timeout", controller.signal);
      void pending.then((result) => { earlyResult = result; }, (error) => { earlyError = error; });
      await waitFor(() => existsSync(ready) || earlyResult || earlyError);
      if (!existsSync(ready)) throw new Error(`Browser verifier ended before readiness: ${earlyError?.message ?? JSON.stringify(earlyResult)}`);
      const ids = JSON.parse(readFileSync(ready, "utf8"));
      const known = processes(ids.profile, ids.browser); assert.ok(known.length >= 2);
      for (const child of known) assert.equal(child.group, ids.verifier, "Chromium helper escaped the owned process group");
      if (cancel) controller.abort(); const result = await pending;
      assert.equal(result.outcome, cancel ? "cancelled" : "timed_out");
      for (const child of known) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      assert.equal(processes(ids.profile, ids.browser).length, 0);
      assert.equal(existsSync(ids.profile), false, "Confirmed verifier closure must remove its browser profile");
    } finally { controller.abort(); await pending?.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
  }
});

test("real static acceptance seals exact viewport PNGs for a long scrolling product without changing source", options, async () => {
  const root = mkdtempSync(join(tmpdir(), "artoo-browser-viewport-")), workspace = join(root, "workspace"), evidence = join(root, "evidence");
  const sha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
  try {
    mkdirSync(join(workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
    const research = { version: 1, objective: "Journal persistence in a long page", assumptions: [],
      requirements: [{ id: "save", description: "Persist an entry", priority: "must", acceptance_criteria: ["Save and reload"] }],
      sources: [{ id: "fixture", url: "https://example.com/spec", title: "Controlled fixture; not a live research claim", retrieved_at: "2026-11-04T00:00:00Z", content_digest: sha("fixture") }],
      findings: [{ summary: "Deterministic browser regression", source_ids: ["fixture"] }], decisions: [] };
    const design = { version: 1, requirement_ids: ["save"], information_architecture: ["Journal editor"],
      user_flows: [{ id: "write", name: "Write", requirement_ids: ["save"], steps: ["Write, save and reload"] }],
      screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty", "Saved"], accessibility: ["Named input"], responsive: ["Fit the viewport"] }],
      prototype: { entrypoint: "product/index.html", description: "Long interactive fixture" }, data_model: [], api_contracts: [],
      decisions: [{ decision: "Use local storage", rationale: "Exercise actual reload persistence" }],
      validation_cases: [{ id: "persist", requirement_ids: ["save"], procedure: ["Save an entry", "Reload"], expected_result: "Entry remains", browser_steps: [
        { action: "navigate", path: "/" }, { action: "fill", selector: "#entry", value: "A durable entry" }, { action: "click", selector: "#save" },
        { action: "reload" }, { action: "assert_value", selector: "#entry", value: "A durable entry" }, { action: "assert_text", selector: "h1", text: "Long journal" },
      ] }] };
    // Natural overflow exposes native Linux scrollbars; no scrollbar styles, hiding flags or viewport resize are used.
    const html = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Long journal</title>'
      + '<style>body{margin:16px;font:18px sans-serif}main{min-height:2400px}textarea{display:block;width:100%;box-sizing:border-box}button{padding:12px}</style></head>'
      + '<body><main><h1>Long journal</h1><label for="entry">Entry</label><textarea id="entry"></textarea><button id="save">Save entry</button></main>'
      + '<script>const entry=document.getElementById("entry");entry.value=localStorage.getItem("entry")||"";document.getElementById("save").addEventListener("click",()=>localStorage.setItem("entry",entry.value));</script></body></html>';
    const sources = { "product/index.html": html, ".artoo/product/research.json": JSON.stringify(research),
      ".artoo/product/design.json": JSON.stringify(design), ".artoo/product/implementation.md": "Controlled static browser fixture.\n" };
    for (const [path, content] of Object.entries(sources)) writeFileSync(join(workspace, path), content);
    const sourceManifest = () => Object.fromEntries(Object.keys(sources).sort().map(path => [path, sha(readFileSync(join(workspace, path)))]));
    const before = sourceManifest(), sourceInventory = readdirSync(workspace, { recursive: true }).sort();
    const context = { task: { id: "task_viewport", title: "Long journal", description: "Controlled fixture", acceptance_criteria: ["Persistence"] },
      project: { id: "project_viewport", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: { version: 1, stage: "implementation", instructions: ["Run the fixed browser fixture"],
        deliverables: [{ path: ".artoo/product/implementation.md", format: "markdown", purpose: "Fixture handoff" }] } };
    const widths = [320, 390, 768, 1280], requestId = "long-product-viewport";
    const report = await runWebAcceptance(workspace, context, { browser_executable: executablePath, evidence_root: evidence, viewports: widths }, requestId);
    assert.equal(report.passed, true);
    assert.deepEqual(report.cases.map(({ case_id, viewport, assertions }) => ({ case_id, viewport, assertions })),
      widths.map(viewport => ({ case_id: "persist", viewport, assertions: 2 })));
    const directory = join(evidence, sha(requestId).slice(7));
    for (const item of report.cases) {
      const image = readFileSync(join(directory, "persist-" + item.viewport + ".png"));
      assert.equal(image.toString("ascii", 12, 16), "IHDR");
      assert.equal(image.readUInt32BE(16), item.viewport); assert.equal(image.readUInt32BE(20), 900);
      assert.equal(sha(image), item.screenshot_digest);
    }
    // These are controlled binding values for the component test, not a node verification or live publication receipt.
    const binding = { requestId, profileId: "fixture", profileDigest: sha(JSON.stringify({ widths, height: 900 })),
      subjectDigest: sha(JSON.stringify(before)), checkId: "browser", scope: "preview" };
    const bundle = sealBrowserEvidence({ ...binding, evidenceRoot: evidence, report }); assert.equal(bundle.case_refs.length, widths.length);
    for (const reference of bundle.case_refs) {
      const captured = readBrowserEvidence({ ...binding, evidenceRoot: evidence, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest }, reference.screenshot_ref);
      assert.equal(captured.mime_type, "image/png"); assert.equal(captured.viewport, reference.viewport);
      assert.deepEqual(Buffer.from(captured.data, "base64"), readFileSync(join(directory, "persist-" + reference.viewport + ".png")));
    }
    assert.deepEqual(sourceManifest(), before); assert.deepEqual(readdirSync(workspace, { recursive: true }).sort(), sourceInventory);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
