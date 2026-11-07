import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { storageFaultReportFromTraceV1 } from "@artoo/domain";
import { createWorkspaceToolSession } from "../dist/workspace-tools.js";
import { browserCaptureV2Filename, browserTraceV2Filename, browserCaptureV3Filename, browserTraceV3Filename, readBrowserEvidence, sealBrowserEvidence } from "../dist/browser-evidence.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "../dist/web-acceptance-storage-source.js";

const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Deterministic valid PNG bytes test transport and sealing, not actual browser rendering. */
function fixturePng(width, height, color = 0) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4); header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, color);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

async function fixture(t, evidenceOnly = false, evidenceVersion = 1, storageFault = false, contextText = "The fixed node task context") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-workspace-mcp-real-"))), workspace = join(root, "workspace");
  mkdirSync(workspace);
  const context = {
    task: { id: "task_mcp", title: "Create a page", description: "Create product/index.html", acceptance_criteria: ["A title"] },
    project: { id: "project_mcp", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: { version: 1, stage: "research", instructions: [], deliverables: [] },
  };
  let previews = 0;
  let evidence, evidenceOptions;
  if (evidenceOnly) {
    delete context.product_development;
    context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "author", run_id: "author_run", evidence_id: "evidence", subject_digest: sha("source"), development_stage: "design" };
    const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
    const binding = { requestId: "final_fixture", profileId: "protected", profileDigest: sha("profile"), subjectDigest: sha("source"), checkId: "browser", scope: "final" };
    const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
    // Deterministic image bytes test MCP transport, not browser rendering or visual quality.
    let png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a54cAAAAASUVORK5CYII=", "base64");
    let report = { version: 1, format: "static-web-acceptance.v1", stage: "design", passed: true, requirements: 1,
      cases: [{ case_id: "fixture", viewport: 1, assertions: 0, screenshot_digest: sha(png) }] };
    let expectedPrograms, trace;
    if (evidenceVersion === 2) {
      const viewport = { id: "compact", width: 320, height: 240 }, caseId = "keyboard_transport", programDigest = sha("controlled-mcp-program");
      // This is a declared controlled trace fixture; actual browser execution is tested separately.
      const operations = [{ index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate"), observation: { kind: "navigation", status_code: 200 } },
        ...Array.from({ length: 85 }, (_, index) => ({ index: index + 1, page_id: "main", action: "assert_focused",
          planned_step_digest: sha(`assert-focus-${index}`), observation: { kind: "focus-assertion", passed: true } }))];
      trace = { version: 2, format: "static-web-trace.v2", case_id: caseId, page_id: "main", viewport, device_scale_factor: 1, program_digest: programDigest, operations };
      const bytes = Buffer.from(JSON.stringify(trace)); png = fixturePng(viewport.width, viewport.height);
      expectedPrograms = [{ case_id: caseId, viewport, program_digest: programDigest, captures: [{ page_id: "main" }],
        steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
          expected_observation: observation.kind === "navigation" ? { kind: "navigation" } : { ...observation } })) }];
      report = { version: 2, format: "static-web-acceptance.v2", stage: "design", passed: true, requirements: 1, device_scale_factor: 1,
        capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest, config_digest: sha("config"), contract_digest: sha("contract") },
        cases: [{ case_id: caseId, viewport, assertions: 85, operation_count: operations.length, program_digest: programDigest,
          trace_digest: sha(bytes), trace_size: bytes.length, captures: [{ page_id: "main", screenshot_digest: sha(png) }] }] };
      writeFileSync(join(directory, browserTraceV2Filename(caseId, viewport.id)), bytes);
      writeFileSync(join(directory, browserCaptureV2Filename(caseId, viewport.id)), png);
    } else if (evidenceVersion === 3 && storageFault) {
      // Controlled storage facts test sealing and MCP transport; no actual fault execution is claimed here.
      const viewport = { id: "compact", width: 320, height: 240 }, caseId = "storage_fault_transport", programDigest = sha("controlled-storage-program");
      const operations = [{ index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate"), observation: { kind: "navigation", status_code: 200 } },
        { index: 1, page_id: "main", action: "assert_text", planned_step_digest: sha("error-ui"), observation: { kind: "assertion", passed: true } }];
      const expectedWindow = { id: "read-denied", page_id: "main", mode: "read-security", arm_before_step: 0, settle_after_step: 1,
        start_step_digest: operations[0].planned_step_digest, end_step_digest: operations[1].planned_step_digest,
        requirement_criteria: [{ requirement_id: "R-load", criterion_index: 0 }], ui_assertion_steps: [1], min_hits: 1,
        native_storage: { scope: "all", comparison: "sampled-equal" }, baseline_phase: "first-document-paused", document_epoch: 1 };
      const { min_hits, ...actualWindow } = expectedWindow;
      const storage = { version: 1, checks_digest: sha("controlled-storage-checks"), windows: [{ ...actualWindow,
        installation: { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true }, sequence: ["baseline", "armed", "settled", "disarmed"],
        hits: { baseline: 0, final: 2, delta: 2 }, native_storage: { scope: "all", comparison: "sampled-equal",
          before: { digest: sha("[]"), key_count: 0, utf8_bytes: 0 }, after: { digest: sha("[]"), key_count: 0, utf8_bytes: 0 }, equal: true },
        events: { coverage: "observed-only", observed_mutations: 0 } }] };
      png = fixturePng(viewport.width, viewport.height);
      const captures = [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha(png) }];
      trace = { version: 3, format: "static-web-trace.v3", case_id: caseId, viewport, device_scale_factor: 1, program_digest: programDigest,
        operations, captures, storage_fault: storage };
      const bytes = Buffer.from(JSON.stringify(trace));
      expectedPrograms = [{ case_id: caseId, viewport, program_digest: programDigest, captures: [{ page_id: "main", timing: { kind: "case-end" } }],
        steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
          expected_observation: observation.kind === "navigation" ? { kind: "navigation" } : { ...observation } })),
        storage_fault: { version: 1, checks_digest: storage.checks_digest, installation_script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, windows: [expectedWindow] } }];
      report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 1, device_scale_factor: 1,
        capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest, config_digest: sha("storage-config"), contract_digest: sha("storage-contract") },
        cases: [{ case_id: caseId, viewport, assertions: 1, operation_count: operations.length, program_digest: programDigest,
          trace_digest: sha(bytes), trace_size: bytes.length, captures: structuredClone(captures), storage_fault: storageFaultReportFromTraceV1(storage) }] };
      writeFileSync(join(directory, browserTraceV3Filename(caseId, viewport.id)), bytes);
      writeFileSync(join(directory, browserCaptureV3Filename(caseId, viewport.id, "main")), png);
    } else if (evidenceVersion === 3) {
      const viewport = { id: "compact", width: 320, height: 240 }, caseId = "multiple_pages_transport", programDigest = sha("controlled-mcp-v3-program");
      // Controlled transport evidence only; no browser action is claimed by this fixture.
      const operations = [
        { index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate-main"), observation: { kind: "navigation", status_code: 200 } },
        { index: 1, page_id: "peer", action: "open_page", planned_step_digest: sha("open-peer"), observation: { kind: "page-opened", status_code: 200 } },
        ...Array.from({ length: 85 }, (_, index) => ({ index: index + 2, page_id: "peer", action: "assert_text",
          planned_step_digest: sha(`read-peer-${index}`), observation: { kind: "assertion", passed: true } })),
        { index: 87, page_id: "peer", action: "close_page", planned_step_digest: sha("close-peer"), observation: { kind: "page-closed", closed: true } },
        { index: 88, page_id: "main", action: "assert_text", planned_step_digest: sha("read-main"), observation: { kind: "assertion", passed: true } },
      ];
      png = fixturePng(viewport.width, viewport.height);
      const peerPng = fixturePng(viewport.width, viewport.height, 100), captures = [
        { page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha(png) },
        { page_id: "peer", timing: { kind: "before-close", step_index: 87 }, screenshot_digest: sha(peerPng) },
      ];
      trace = { version: 3, format: "static-web-trace.v3", case_id: caseId, viewport, device_scale_factor: 1, program_digest: programDigest, operations, captures };
      const bytes = Buffer.from(JSON.stringify(trace));
      expectedPrograms = [{ case_id: caseId, viewport, program_digest: programDigest,
        captures: captures.map(({ page_id, timing }) => ({ page_id, timing: { ...timing } })),
        steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
          expected_observation: observation.kind === "navigation" || observation.kind === "page-opened" ? { kind: observation.kind } : { ...observation } })) }];
      report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 1, device_scale_factor: 1,
        capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest, config_digest: sha("config-v3"), contract_digest: sha("contract-v3") },
        cases: [{ case_id: caseId, viewport, assertions: 86, operation_count: operations.length, program_digest: programDigest,
          trace_digest: sha(bytes), trace_size: bytes.length, captures: structuredClone(captures) }] };
      writeFileSync(join(directory, browserTraceV3Filename(caseId, viewport.id)), bytes);
      writeFileSync(join(directory, browserCaptureV3Filename(caseId, viewport.id, "main")), png);
      writeFileSync(join(directory, browserCaptureV3Filename(caseId, viewport.id, "peer")), peerPng);
    } else writeFileSync(join(directory, "fixture-1.png"), png);
    writeFileSync(join(directory, "result.json"), JSON.stringify(report));
    const bundle = sealBrowserEvidence({ ...binding, evidenceRoot, report, ...(expectedPrograms ? { expectedPrograms } : {}) });
    const grant = { ...binding, evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    evidence = { bundle, png, binding, directory, report, trace };
    evidenceOptions = { evidenceOnly: true, readEvidence: async (reference, options) => readBrowserEvidence(grant, reference, options) };
  }
  // This fixture checks the real MCP boundary. The separate node fixture runs the protected verifier subprocess.
  const session = await createWorkspaceToolSession({ workspaceRoot: workspace, context, contextText, ...(evidenceOptions ?? { verify: async () => {
    previews += 1;
    return { version: 1, request_id: `preview_fixture_${previews}`, profile_id: "fixture", profile_digest: sha("profile"), subject_digest: sha(readFileSync(join(workspace, "product/index.html"))),
      outcome: "passed", checks: [{ id: "transport-fixture", exit_code: 0, duration_ms: 0, output_digest: sha("fixture") }], required_files: [] };
  } }) });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/workspace-tools-mcp.js", import.meta.url)), session.configPath], {
    cwd: workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) },
  });
  let stderr = "", closed = false, next = 1;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (text) => { stderr += text; });
  const pending = new Map(), reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const message = JSON.parse(line), operation = pending.get(message.id);
    if (operation) { pending.delete(message.id); operation.resolve(message); }
  });
  const exit = new Promise((resolveExit) => child.once("close", (code, signal) => {
    closed = true;
    for (const operation of pending.values()) operation.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`));
    pending.clear(); resolveExit({ code, signal });
  }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => { if (!closed) child.kill(); }, 5000);
    try { await exit; await session.close(); }
    finally { clearTimeout(timer); reader.close(); rmSync(root, { recursive: true, force: true }); }
  });
  function raw(line, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(line + "\n", (error) => { if (error) { pending.delete(id); reject(error); } });
    });
  }
  function request(method, params) {
    const id = next++; return raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), id);
  }
  async function call(name, args = {}) {
    const response = await request("tools/call", { name, arguments: args });
    if (response.error) return response;
    return { ...response.result, value: JSON.parse(response.result.content[0].text) };
  }
  return { root, workspace, session, child, exit, request, raw, call, evidence, previews: () => previews };
}

test("real MCP subprocess performs checksum-bound product edits and protected-preview requests without shell tools", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "artoo-workspace");
  const tools = (await f.request("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["context", "list", "read", "mkdir", "write", "edit", "remove", "verify"]);
  assert(tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.equal((await f.call("context")).value.context, "The fixed node task context");
  assert.equal((await f.call("mkdir", { path: "product" })).isError, undefined);
  const html = "<!doctype html><title>Journal</title><h1>Journal</h1>";
  const write = await f.call("write", { path: "product/index.html", content: html, expected_checksum: null });
  assert.equal(write.value.checksum, sha(html)); assert.equal(readFileSync(join(f.workspace, "product/index.html"), "utf8"), html);
  const read = await f.call("read", { path: "product/index.html" }); assert.equal(read.value.content, html);
  const edit = await f.call("edit", { path: "product/index.html", old_text: "<h1>Journal</h1>", new_text: "<h1>Notes</h1>", expected_checksum: read.value.checksum });
  assert.equal(edit.isError, undefined); assert.equal((await f.call("read", { path: "product/index.html" })).value.checksum, edit.value.checksum);
  const preview = await f.call("verify"); assert.equal(preview.value.diagnostic_only, true); assert.equal(preview.value.verification.request_id, "preview_fixture_1");
  assert.equal(f.previews(), 1);
  assert.equal((await f.call("verify", { argv: ["untrusted"] })).isError, true); assert.equal(f.previews(), 1);
  assert.equal((await f.call("Bash", { command: "anything" })).error.code, -32602);
  assert.equal((await f.call("write", { path: "../outside", content: "forbidden", expected_checksum: null })).isError, true);
  assert.equal(existsSync(join(f.root, "outside")), false);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});


for (const evidenceOnly of [false, true]) test(`real ${evidenceOnly ? "peer" : "author"} MCP reconstructs a large fixed context through bounded UTF-8 pages`, { timeout: 30_000 }, async (t) => {
  // Controlled context transport fixture. Live provider interpretation is checked separately.
  const rawPayload = { before: "a".repeat(540_000), product_development: { version: 1, stage: "research", instructions: [
    "MIDDLE_REQUIRED_中😀", 'research.json shape: {"version":1,"objective":"...","assumptions":[],"findings":[],"requirements":[],"decisions":[],"measurement_plan":{"version":1,"cases":[]}}',
  ] }, after: "z".repeat(540_000), verification_capabilities: { tail_marker: "TAIL_REQUIRED_😀中" } };
  const contextText = `\uFEFF# Context 😀中\r\n## Raw Payload\r\n${JSON.stringify(rawPayload)}\r\n`, checksum = sha(contextText), size = Buffer.byteLength(contextText);
  assert(size > 1024 * 1024);
  const f = await fixture(t, evidenceOnly, 1, false, contextText), definitions = (await f.request("tools/list")).result.tools;
  const definition = definitions.find(tool => tool.name === "context");
  assert.deepEqual(definition.inputSchema.required, []); assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ["expected_checksum", "limit", "offset"]);
  assert.equal(definition.inputSchema.properties.offset.maximum, 8 * 1024 * 1024);
  assert.equal(definition.inputSchema.properties.limit.minimum, 4); assert.equal(definition.inputSchema.properties.limit.maximum, 16 * 1024);
  assert.equal(definition.inputSchema.properties.expected_checksum.type, "string");
  const legacy = (await f.call("context")).value;
  assert.deepEqual(Object.keys(legacy).sort(), ["context", evidenceOnly ? "evidence_read_guidance" : "read_guidance"].sort());
  assert.equal(legacy.context, contextText);
  writeFileSync(join(f.workspace, "context_pack.md"), "changed file cannot replace the fixed context");
  let offset = 0, combined = "", finished = false, firstChecksum;
  for (let index = 0; index < 400; index++) {
    const result = await f.call("context", { offset, limit: 4096, ...(offset ? { expected_checksum: firstChecksum } : {}) });
    assert.equal(result.isError, undefined); const page = result.value;
    assert.deepEqual(Object.keys(page).sort(), ["checksum", "content", "eof", "format", "next_offset", "offset", "size", "version"]);
    assert.equal(page.version, 1); assert.equal(page.format, "artoo-context-text-page.v1");
    firstChecksum ??= page.checksum; assert.equal(page.checksum, firstChecksum); assert.equal(page.checksum, checksum);
    assert.equal(page.size, size); assert.equal(page.offset, offset);
    const length = Buffer.byteLength(page.content); assert(length > 0 && length <= 4096); assert(!page.content.includes("\uFFFD")); combined += page.content;
    if (page.eof) { assert.equal(page.next_offset, null); finished = true; break; }
    assert.equal(page.next_offset, offset + length); offset = page.next_offset;
  }
  assert.equal(finished, true); assert.deepEqual(Buffer.from(combined), Buffer.from(contextText)); assert.equal(sha(combined), checksum);
  assert.deepEqual(JSON.parse(combined.slice(combined.indexOf("{"))), rawPayload);
  const defaultPage = (await f.call("context", { offset: 0 })).value;
  assert.equal(Buffer.byteLength(defaultPage.content), 16 * 1024);
  assert.deepEqual((await f.call("context", { expected_checksum: checksum })).value, defaultPage);
  assert.deepEqual((await f.call("context", { offset: size, expected_checksum: checksum })).value, { version: 1, format: "artoo-context-text-page.v1",
    content: "", checksum, size, offset: size, next_offset: null, eof: true });
  assert.equal((await f.call("context", { offset: 4096 })).isError, true);
  assert.equal((await f.call("context", { offset: 4096, expected_checksum: sha("other context") })).isError, true);
  assert.equal((await f.call("context", { offset: 1, expected_checksum: checksum })).isError, true);
  assert.equal((await f.call("context", { offset: 0, path: f.workspace })).isError, true);
  assert.equal((await f.call("context", { limit: 3 })).isError, true);
  assert.deepEqual((await f.call("context")).value, legacy);
  if (evidenceOnly) {
    assert.deepEqual(definitions.map(tool => tool.name), ["context", "read_evidence"]);
    for (const name of ["verify", "write", "read", "mkdir"]) assert.equal((await f.call(name)).error.code, -32602);
    assert.equal(f.previews(), 0);
  } else {
    assert.equal((await f.call("mkdir", { path: "product" })).isError, undefined);
    assert.equal((await f.call("write", { path: "product/index.html", content: "<h1>Transport fixture</h1>", expected_checksum: null })).isError, undefined);
    assert.equal((await f.call("verify")).value.diagnostic_only, true); assert.equal(f.previews(), 1);
  }
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real MCP advertises and transports checksum-bound UTF-8 pages without losing middle or tail requirements", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), definitions = (await f.request("tools/list")).result.tools;
  const definition = definitions.find(tool => tool.name === "read");
  assert.equal(definition.inputSchema.properties.limit.maximum, 16 * 1024);
  assert.equal(definition.inputSchema.properties.offset.minimum, 0);
  assert.equal(definition.inputSchema.properties.expected_checksum.type, "string");
  assert.deepEqual(definition.inputSchema.required, ["path"]);
  assert.match((await f.call("context")).value.read_guidance, /expected_checksum until eof:true/);
  await f.call("mkdir", { path: "product" });
  const path = "product/requirements.json", text = JSON.stringify({ first: "start", before: "x".repeat(24_000),
    middle: "MIDDLE_REQUIRED_😀", after: "y".repeat(24_000), last: "TAIL_REQUIRED_中" });
  await f.call("write", { path, content: text, expected_checksum: null });
  let offset = 0, combined = "", finished = false;
  for (let index = 0; index < 32; index += 1) {
    const result = await f.call("read", { path, offset, limit: 4096, ...(offset ? { expected_checksum: sha(text) } : {}) });
    assert.equal(result.isError, undefined); const page = result.value;
    assert.equal(page.checksum, sha(text)); assert.equal(page.size, Buffer.byteLength(text)); assert.equal(page.offset, offset);
    assert(Buffer.byteLength(page.content) <= 4096); combined += page.content;
    if (page.eof) { assert.equal(page.next_offset, null); finished = true; break; }
    assert.equal(page.next_offset, offset + Buffer.byteLength(page.content)); offset = page.next_offset;
  }
  assert.equal(finished, true); assert.equal(combined, text);
  assert.deepEqual({ middle: JSON.parse(combined).middle, last: JSON.parse(combined).last }, { middle: "MIDDLE_REQUIRED_😀", last: "TAIL_REQUIRED_中" });
  assert.deepEqual((await f.call("read", { path })).value, { path, content: text, checksum: sha(text), size: Buffer.byteLength(text) });
  await f.call("write", { path, content: text.replace("start", "other"), expected_checksum: sha(text) });
  assert.equal((await f.call("read", { path, offset: 4096, limit: 4096, expected_checksum: sha(text) })).isError, true);
  assert.equal((await f.call("read", { path, offset: 4096, limit: 4096 })).isError, true);
  const unicodePath = "product/unicode.txt", unicode = "A😀中éZ";
  await f.call("write", { path: unicodePath, content: unicode, expected_checksum: null });
  const first = (await f.call("read", { path: unicodePath, offset: 0, limit: 4 })).value;
  assert.equal(first.content, "A"); assert.equal(first.next_offset, 1);
  const second = (await f.call("read", { path: unicodePath, offset: 1, limit: 4, expected_checksum: sha(unicode) })).value;
  assert.equal(second.content, "😀"); assert.equal(second.next_offset, 5);
  assert.match((await f.call("read", { path: unicodePath, offset: 2, limit: 4, expected_checksum: sha(unicode) })).value.error, /UTF-8 character boundary/);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real MCP framing rejects oversized and substituted tool arguments, then remains usable", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const oversized = await f.raw("x".repeat(8 * 1024 * 1024 + 1), null);
  assert.equal(oversized.error.code, -32600);
  const ping = await f.request("ping"); assert.deepEqual(ping.result, {});
  const forged = await f.call("context", { tool: "write", path: "product/fake", content: "unsafe", expected_checksum: null });
  assert.equal(forged.error.code, -32602);
  assert.equal((await f.call("context")).value.context, "The fixed node task context");
  assert.equal(existsSync(join(f.workspace, "product/fake")), false);
});

test("read-only peer MCP returns sealed PNG image content and refuses author tools or host paths", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual((await f.request("tools/list")).result.tools.map(tool => tool.name), ["context", "read_evidence"]);
  const bundle = await f.call("read_evidence", { reference: f.evidence.bundle.bundle_id });
  assert.equal(bundle.isError, undefined);
  assert.equal(bundle.value.mime_type, "application/json");
  assert.equal(JSON.parse(bundle.content[1].text).binding.subjectDigest, f.evidence.binding.subjectDigest);
  const image = await f.call("read_evidence", { reference: f.evidence.bundle.case_refs[0].screenshot_ref });
  assert.equal(image.value.provenance.scope, "final");
  assert.equal(image.value.provenance.requestId, f.evidence.binding.requestId);
  assert.deepEqual(image.content[1], { type: "image", mimeType: "image/png", data: f.evidence.png.toString("base64") });
  assert.equal((await f.call("read_evidence", { reference: f.workspace })).isError, true);
  assert.equal((await f.call("read_evidence", { reference: "image_not_granted" })).isError, true);
  for (const name of ["verify", "read", "write", "edit", "remove"]) assert.equal((await f.call(name)).error.code, -32602);
  assert.equal(f.previews(), 0);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real peer MCP pages immutable JSON evidence and rejects changed or unbound continuations", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, true), reference = f.evidence.bundle.bundle_id;
  const definition = (await f.request("tools/list")).result.tools.find(tool => tool.name === "read_evidence");
  assert.deepEqual(definition.inputSchema.required, ["reference"]);
  assert.equal(definition.inputSchema.properties.limit.maximum, 16 * 1024);
  assert.match((await f.call("context")).value.evidence_read_guidance, /expected_checksum until eof:true/);
  const full = await f.call("read_evidence", { reference }), text = full.content[1].text, checksum = sha(text);
  assert.equal(full.value.offset, undefined);
  let offset = 0, combined = "", finished = false;
  for (let index = 0; index < 64; index++) {
    const page = await f.call("read_evidence", { reference, offset, limit: 64, ...(offset ? { expected_checksum: checksum } : {}) });
    assert.equal(page.isError, undefined); assert.equal(page.value.checksum, checksum); assert.equal(page.value.size, Buffer.byteLength(text));
    assert.equal(page.value.offset, offset); assert(Buffer.byteLength(page.content[1].text) <= 64);
    combined += page.content[1].text;
    if (page.value.eof) { assert.equal(page.value.next_offset, null); finished = true; break; }
    offset = page.value.next_offset;
  }
  assert.equal(finished, true); assert.equal(combined, text);
  assert.equal((await f.call("read_evidence", { reference, offset: 64, limit: 64 })).isError, true);
  assert.equal((await f.call("read_evidence", { reference, offset: 64, expected_checksum: sha("different") })).isError, true);
  assert.equal((await f.call("read_evidence", { reference: f.evidence.bundle.case_refs[0].screenshot_ref, offset: 0, limit: 64 })).isError, true);
  writeFileSync(join(f.evidence.directory, "result.json"), JSON.stringify({ ...f.evidence.report, requirements: 2 }));
  assert.equal((await f.call("read_evidence", { reference, offset: 64, expected_checksum: checksum })).isError, true);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real peer MCP transports a sealed v2 trace larger than 16 KiB through checksum-bound pages", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, true, 2), reference = f.evidence.bundle.case_refs[0].trace_ref;
  const full = await f.call("read_evidence", { reference }), text = full.content[1].text, checksum = sha(text);
  assert.equal(full.isError, undefined); assert.equal(full.value.mime_type, "application/json");
  assert.equal(full.value.provenance.scope, "final"); assert.equal(full.value.offset, undefined);
  assert(Buffer.byteLength(text) > 16 * 1024);
  let offset = 0, combined = "", finished = false, pages = 0;
  for (; pages < 32; pages++) {
    const page = await f.call("read_evidence", { reference, offset, limit: 4096, ...(offset ? { expected_checksum: checksum } : {}) });
    assert.equal(page.isError, undefined); assert.equal(page.value.checksum, checksum); assert.equal(page.value.size, Buffer.byteLength(text));
    assert.equal(page.value.reference, reference); assert.equal(page.value.offset, offset);
    assert(Buffer.byteLength(page.content[1].text) <= 4096); combined += page.content[1].text;
    if (page.value.eof) { assert.equal(page.value.next_offset, null); finished = true; break; }
    assert.equal(page.value.next_offset, offset + Buffer.byteLength(page.content[1].text)); offset = page.value.next_offset;
  }
  assert.equal(finished, true); assert(pages >= 4); assert.equal(combined, text);
  const reconstructed = JSON.parse(combined); assert.deepEqual(reconstructed, f.evidence.trace);
  assert.equal(reconstructed.operations.length, 86); assert.equal(reconstructed.operations.at(-1).index, 85);
  assert.equal((await f.call("read_evidence", { reference, offset: 4096, limit: 4096 })).isError, true);
  assert.equal((await f.call("read_evidence", { reference, offset: 4096, expected_checksum: sha("stale") })).isError, true);
  const image = await f.call("read_evidence", { reference: f.evidence.bundle.case_refs[0].captures[0].screenshot_ref });
  assert.deepEqual(image.content[1], { type: "image", mimeType: "image/png", data: f.evidence.png.toString("base64") });
  f.evidence.trace.operations.at(-1).planned_step_digest = sha("substituted-after-sealing");
  writeFileSync(join(f.evidence.directory, browserTraceV2Filename(f.evidence.trace.case_id, f.evidence.trace.viewport.id)), JSON.stringify(f.evidence.trace));
  assert.equal((await f.call("read_evidence", { reference, offset: 4096, expected_checksum: checksum })).isError, true);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real peer MCP pages v3 multi-page evidence and reads a closed page capture with its actual close position", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, true, 3), refs = f.evidence.bundle.case_refs[0], reference = refs.trace_ref;
  const full = await f.call("read_evidence", { reference }), text = full.content[1].text, checksum = sha(text);
  assert.equal(full.isError, undefined); assert.equal(full.value.mime_type, "application/json"); assert(Buffer.byteLength(text) > 16 * 1024);
  let offset = 0, combined = "", finished = false;
  for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
    const page = await f.call("read_evidence", { reference, offset, limit: 4096, ...(offset ? { expected_checksum: checksum } : {}) });
    assert.equal(page.isError, undefined); assert.equal(page.value.checksum, checksum); assert.equal(page.value.offset, offset);
    assert.equal(page.value.size, Buffer.byteLength(text)); assert(Buffer.byteLength(page.content[1].text) <= 4096); combined += page.content[1].text;
    if (page.value.eof) { assert.equal(page.value.next_offset, null); finished = true; break; }
    assert.equal(page.value.next_offset, offset + Buffer.byteLength(page.content[1].text)); offset = page.value.next_offset;
  }
  assert.equal(finished, true); assert.equal(combined, text); assert.deepEqual(JSON.parse(combined), f.evidence.trace);
  assert.equal((await f.call("read_evidence", { reference, offset: 4096 })).isError, true);
  assert.equal((await f.call("read_evidence", { reference, offset: 4096, expected_checksum: sha("stale") })).isError, true);
  assert.deepEqual(refs.captures.map(capture => capture.page_id), ["main", "peer"]);
  const peerReference = refs.captures[1].screenshot_ref, image = await f.call("read_evidence", { reference: peerReference });
  assert.equal(image.isError, undefined); assert.equal(image.value.page_id, "peer"); assert.equal(image.value.provenance.scope, "final");
  assert.deepEqual(image.value.timing, { kind: "before-close", step_index: 87 });
  assert.equal(sha(Buffer.from(image.content[1].data, "base64")), f.evidence.trace.captures[1].screenshot_digest);
  assert.equal((await f.call("read_evidence", { reference: peerReference, offset: 0, limit: 4096 })).isError, true);
  assert.equal((await f.call("read_evidence", { reference: "image_wrong_page" })).isError, true);
  f.evidence.trace.operations[87].observation.closed = false;
  writeFileSync(join(f.evidence.directory, browserTraceV3Filename(f.evidence.trace.case_id, f.evidence.trace.viewport.id)), JSON.stringify(f.evidence.trace));
  assert.equal((await f.call("read_evidence", { reference, offset: 4096, expected_checksum: checksum })).isError, true);
  assert.equal((await f.call("read_evidence", { reference: peerReference })).isError, true);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test("real peer MCP preserves optional v3 storage facts and rejects a tampered storage trace for both JSON and image reads", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, true, 3, true), refs = f.evidence.bundle.case_refs[0];
  const full = await f.call("read_evidence", { reference: refs.trace_ref });
  assert.equal(full.isError, undefined); assert.equal(full.value.mime_type, "application/json");
  const text = full.content[1].text, checksum = sha(text); let offset = 0, combined = "", finished = false;
  for (let pageIndex = 0; pageIndex < 64; pageIndex++) {
    const page = await f.call("read_evidence", { reference: refs.trace_ref, offset, limit: 128, ...(offset ? { expected_checksum: checksum } : {}) });
    assert.equal(page.isError, undefined); assert.equal(page.value.checksum, checksum); combined += page.content[1].text;
    if (page.value.eof) { finished = true; break; } offset = page.value.next_offset;
  }
  assert.equal(finished, true); assert.equal(combined, text); assert.deepEqual(JSON.parse(combined), f.evidence.trace);
  assert.equal(JSON.parse(combined).storage_fault.windows[0].events.coverage, "observed-only");
  const bundle = await f.call("read_evidence", { reference: f.evidence.bundle.bundle_id });
  assert.deepEqual(JSON.parse(bundle.content[1].text).report.cases[0].storage_fault, storageFaultReportFromTraceV1(f.evidence.trace.storage_fault));
  assert.equal((await f.call("read_evidence", { reference: refs.captures[0].screenshot_ref })).isError, undefined);
  f.evidence.trace.storage_fault.windows[0].installation.script_digest = sha("tampered-initializer");
  writeFileSync(join(f.evidence.directory, browserTraceV3Filename(f.evidence.trace.case_id, f.evidence.trace.viewport.id)), JSON.stringify(f.evidence.trace));
  assert.equal((await f.call("read_evidence", { reference: refs.trace_ref, offset: 128, expected_checksum: checksum })).isError, true);
  assert.equal((await f.call("read_evidence", { reference: refs.captures[0].screenshot_ref })).isError, true);
  f.child.stdin.end(); assert.deepEqual(await f.exit, { code: 0, signal: null });
});
