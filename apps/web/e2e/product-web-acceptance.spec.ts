import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPackSchema, ProductDesignSchema, productDevelopmentContext } from "@artoo/domain";
import { runWebAcceptance } from "../../artood/src/web-acceptance.js";
import { launchOwnedBrowser } from "../../artood/src/owned-browser.js";
import { readBrowserEvidence, sealBrowserEvidence } from "../../artood/src/browser-evidence.js";

function fixture(variant: "working" | "broken" | "unlabeled" | "external" = "working") {
  const directory = mkdtempSync(join(tmpdir(), "artoo-browser-acceptance-")), workspace = join(directory, "workspace"), evidence = join(directory, "evidence");
  mkdirSync(join(workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const research = { version: 1, objective: "Journal entries survive reload", assumptions: [],
    requirements: [{ id: "save", description: "Persist entries", priority: "must", acceptance_criteria: ["Save an entry and reload"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Explicit fixture source", retrieved_at: "2026-11-04T00:00:00Z", content_digest: `sha256:${"a".repeat(64)}` }],
    findings: [{ summary: "Deterministic browser fixture; no real research claim", source_ids: ["fixture"] }], decisions: [] };
  const design = ProductDesignSchema.parse({ version: 1, requirement_ids: ["save"], information_architecture: ["Journal editor"],
    user_flows: [{ id: "write", name: "Write", requirement_ids: ["save"], steps: ["Write, save and reload"] }],
    screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty", "Saved"], accessibility: ["Labeled fields"], responsive: ["Fit phone"] }],
    prototype: { entrypoint: "product/index.html", description: "Actual interactive editor" }, data_model: [], api_contracts: [], decisions: [{ decision: "Local storage", rationale: "Offline" }],
    validation_cases: [{ id: "persist", requirement_ids: ["save"], procedure: ["Save a note", "Reload"], expected_result: "Note is restored", browser_steps: [
      { action: "navigate", path: "/" }, { action: "fill", selector: "#note", value: "A durable entry" }, { action: "click", selector: "#save" },
      { action: "reload" }, { action: "assert_value", selector: "#note", value: "A durable entry" },
    ] }] });
  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Journal</title><style>body{margin:16px;font:18px system-ui}textarea{display:block;width:100%;box-sizing:border-box}button{margin-top:12px;padding:12px}</style></head><body><main><h1>Journal</h1>${variant === "unlabeled" ? "" : '<label for="note">Entry</label>'}<textarea id="note"></textarea><button id="save">Save entry</button>${variant === "external" ? '<img alt="Remote" src="https://example.com/image.png">' : ""}</main><script>const note=document.getElementById('note');note.value=localStorage.getItem('entry')||'';document.getElementById('save').addEventListener('click',()=>{${variant === "broken" ? "" : "localStorage.setItem('entry',note.value)"}});</script></body></html>`;
  writeFileSync(join(workspace, "product", "index.html"), html);
  writeFileSync(join(workspace, ".artoo", "product", "research.json"), JSON.stringify(research));
  writeFileSync(join(workspace, ".artoo", "product", "design.json"), JSON.stringify(design));
  const context = ContextPackSchema.parse({ task: { id: "task_web", title: "Implement journal", description: "Fixture", acceptance_criteria: ["Persistence"] }, project: { id: "project_web", name: "Web", default_workspace: workspace },
    workspace: { root: workspace, file_scope: [] }, policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] }, product_development: productDevelopmentContext("implementation") });
  return { directory, workspace, evidence, context, html };
}

test("protected browser verifier actually saves, reloads and checks both desktop and phone layouts", async () => {
  const item = fixture();
  try {
    const result = await runWebAcceptance(item.workspace, item.context, { evidence_root: item.evidence });
    expect(result.passed).toBe(true);
    expect(result.cases.map((entry) => entry.viewport)).toEqual([1280, 390]);
    const evidence = join(item.evidence, readdirSync(item.evidence)[0]!);
    expect(readdirSync(evidence).sort()).toEqual(["persist-1280.png", "persist-390.png", "result.json"]);
    expect(readFileSync(join(item.workspace, "product", "index.html"), "utf8")).toBe(item.html);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("a scrolling product preserves the measured viewport and its actual PNG passes unchanged evidence sealing", async () => {
  const item = fixture(), widths = [320, 390, 768, 1280], requestId = "scrollbar-width-regression";
  const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  // A controlled long page creates natural vertical overflow without hiding or styling its scrollbar.
  const scrollingHtml = item.html.replace("</main>", '<div style="height:2400px" aria-hidden="true"></div></main>');
  writeFileSync(join(item.workspace, "product", "index.html"), scrollingHtml);
  try {
    const result = await runWebAcceptance(item.workspace, item.context, { evidence_root: item.evidence, viewports: widths }, requestId);
    expect(result.cases.map(({ viewport, assertions }) => ({ viewport, assertions }))).toEqual(widths.map(viewport => ({ viewport, assertions: 1 })));
    const directory = join(item.evidence, sha(requestId).slice(7));
    for (const entry of result.cases) {
      const png = readFileSync(join(directory, `persist-${entry.viewport}.png`));
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(entry.viewport); expect(png.readUInt32BE(20)).toBe(900);
      expect(sha(png)).toBe(entry.screenshot_digest);
    }
    // Controlled component fixture: the real sealer validates the captured bytes; this is not a live run receipt.
    const binding = { requestId, profileId: "fixture", profileDigest: sha("fixed viewport fixture"), subjectDigest: sha(scrollingHtml), checkId: "browser", scope: "preview" as const };
    const bundle = sealBrowserEvidence({ ...binding, evidenceRoot: item.evidence, report: result });
    for (const reference of bundle.case_refs) {
      const evidence = readBrowserEvidence({ ...binding, evidenceRoot: item.evidence, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest }, reference.screenshot_ref);
      expect(evidence.mime_type).toBe("image/png");
      if (evidence.mime_type !== "image/png") throw new Error("Expected the actual screenshot bytes");
      expect(evidence.data).toBe(readFileSync(join(directory, `persist-${reference.viewport}.png`)).toString("base64"));
    }
    expect(readFileSync(join(item.workspace, "product", "index.html"), "utf8")).toBe(scrollingHtml);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("protected design capture executes real cases at configured widths while the default only opens the prototype", async () => {
  const item = fixture("broken"); item.context.product_development = productDevelopmentContext("design");
  try {
    const opening = await runWebAcceptance(item.workspace, item.context, { evidence_root: item.evidence }, "design-open");
    expect(opening.cases).toEqual(expect.arrayContaining([expect.objectContaining({ case_id: "prototype", assertions: 0, viewport: 390 })]));
    await expect(runWebAcceptance(item.workspace, item.context, { viewports: [320, 768, 1280], design_capture_cases: true }, "design-failing-cases")).rejects.toThrow("assert_value failed");
    writeFileSync(join(item.workspace, "product", "index.html"), item.html.replace("()=>{}", "()=>{localStorage.setItem('entry',note.value)}"));
    const measured = await runWebAcceptance(item.workspace, item.context, { evidence_root: item.evidence, viewports: [320, 768, 1280], design_capture_cases: true }, "design-cases");
    expect(measured.cases.map(({ case_id, viewport, assertions }) => ({ case_id, viewport, assertions }))).toEqual([320, 768, 1280].map((viewport) => ({ case_id: "persist", viewport, assertions: 1 })));
    const resultDirectories = readdirSync(item.evidence);
    expect(resultDirectories.some((path) => readdirSync(join(item.evidence, path)).includes("persist-320.png"))).toBe(true);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("Windows browser close stops its owned parent and observed helpers before returning", async () => {
  test.skip(process.platform !== "win32", "Windows process-tree shutdown regression");
  const item = fixture();
  let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
  try {
    owned = await launchOwnedBrowser({ workspace: item.workspace });
    const page = await owned.browser.newPage();
    await page.setContent("<title>Owned process fixture</title><h1>Actual renderer</h1>");
    // CDP reports processes for this browser only. Never enumerate or terminate
    // a user's unrelated browser, and never rely on a process-name match.
    const session = await owned.browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const pids = [...new Set(processInfo.map(({ id }) => id))];
    expect(pids).toContain(owned.processId);
    expect(pids.some((pid) => pid !== owned!.processId)).toBe(true);
    await owned.close();
    for (const pid of pids) {
      expect(() => process.kill(pid, 0), `Owned browser process ${pid} must have actually exited`).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  } finally { await owned?.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

for (const [variant, message] of [["broken", "assert_value failed"], ["unlabeled", "accessible names"], ["external", "external network access"]] as const) {
  test(`protected browser verifier rejects ${variant} behavior instead of trusting the design's success claim`, async () => {
    const item = fixture(variant);
    try { await expect(runWebAcceptance(item.workspace, item.context)).rejects.toThrow(message); }
    finally { rmSync(item.directory, { recursive: true, force: true }); }
  });
}
