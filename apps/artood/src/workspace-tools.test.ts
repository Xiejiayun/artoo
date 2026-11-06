import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext, CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, type ReleaseCapabilitiesV1, type ContextPack, type RunVerificationPayload } from "@artoo/domain";
import type { AgentInstanceConfig } from "@artoo/protocol";
import { bindWorkspaceToolVerifier, bindWorkspaceToolEvidenceReader, createWorkspaceToolSession, takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader,
  bindWorkspaceToolCapabilities, takeWorkspaceToolCapabilities, bindWorkspaceToolReleaseCapabilities, takeWorkspaceToolReleaseCapabilities,
  type WorkspaceToolSession, type WorkspaceToolVerifier } from "./workspace-tools.js";
import { VerificationCleanupError } from "./verification.js";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";
import { workspaceToolDefinitions } from "./workspace-tools-mcp.js";

const roots: string[] = [], sessions: WorkspaceToolSession[] = [], uncertainSessions = new Set<WorkspaceToolSession>();
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    if (uncertainSessions.has(session)) { await expect(session.close()).rejects.toBeInstanceOf(VerificationCleanupError); roots.push(dirname(session.configPath)); }
    else await session.close();
  }
  uncertainSessions.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const evidence = (): RunVerificationPayload => ({ version: 1, request_id: "preview_fixture_1", profile_id: "protected", profile_digest: sha("profile"), subject_digest: sha("subject"),
  outcome: "passed", checks: [{ id: "local-test", exit_code: 0, duration_ms: 2, output_digest: sha("output") }], required_files: [] });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-workspace-tools-test-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const context: ContextPack = { task: { id: "task_1", title: "Build journal", description: "Implement storage", acceptance_criteria: ["Save an entry"] },
    project: { id: "project_1", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal_1", objective: "Journal", acceptance_criteria: [], plan: null }, product_development: productDevelopmentContext("research") };
  async function start(verify: WorkspaceToolVerifier = async () => evidence(), researchMcpPath?: string, contextText = "Fixed task context") {
    const session = await createWorkspaceToolSession({ workspaceRoot: workspace, context, contextText, verify, researchMcpPath }); sessions.push(session);
    const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
    const sendRaw = async (body: string) => {
      const response = await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
    };
    const send = (input: unknown) => sendRaw(JSON.stringify(input));
    return { session, config, send, sendRaw };
  }
  return { root, workspace, context, start };
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}

describe("protected workspace tool sessions", () => {
  it.each([false, true])("revalidates publication authority for every author/peer context page (peer=%s)", async (peer) => {
    const f = fixture(); f.context.goal_context!.plan = { id: "plan", version: 1, rationale: "Controlled", spec_ref: null };
    const release: ReleaseCapabilitiesV1 = { version: 1, binding: { version: 1, release_profile_id: "release", release_profile_digest: sha("release"),
      contract_digest: sha("contract"), project_id: "project_1", workspace_root: f.workspace, verification_profile_id: "verify", verification_profile_digest: sha("verify") },
      contract: { version: 1, kind: "configured-static-release", claim: "configured", execution_phase: "after-stage-acceptance",
        endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time", lifecycle: "while-configured-node-service-running",
        health_checks: [{ path: "/", expected_status: 200, body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" }],
        criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } } };
    f.context.release_capabilities = structuredClone(release);
    let active = true;
    const readReleaseCapabilities = () => { if (!active) throw new Error("Release capability closed"); return release; };
    const local = { runId: "run" } as AgentInstanceConfig;
    bindWorkspaceToolReleaseCapabilities(local, readReleaseCapabilities);
    expect(takeWorkspaceToolReleaseCapabilities(structuredClone(local))).toBeUndefined();
    expect(takeWorkspaceToolReleaseCapabilities(local)).toBe(readReleaseCapabilities);
    expect(takeWorkspaceToolReleaseCapabilities(local)).toBeUndefined();
    if (peer) {
      delete f.context.product_development;
      f.context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
      f.context.review_subject = { version: 1, task_id: "author", run_id: "author", evidence_id: "evidence", subject_digest: sha("subject") };
    }
    const options = { workspaceRoot: f.workspace, context: f.context, contextText: "Bound release context",
      ...(peer ? { evidenceOnly: true, readEvidence: async () => { throw new Error("No controlled evidence grant"); } } : { verify: async () => evidence() }) };
    await expect(createWorkspaceToolSession(options)).rejects.toThrow(/local binding/);
    const changed = structuredClone(f.context); changed.release_capabilities!.binding.release_profile_digest = sha("other");
    await expect(createWorkspaceToolSession({ ...options, context: changed, readReleaseCapabilities })).rejects.toThrow(/differ/);
    const session = await createWorkspaceToolSession({ ...options, readReleaseCapabilities }); sessions.push(session);
    const config = JSON.parse(readFileSync(session.configPath, "utf8")); expect(config.tools).not.toContain("deploy");
    const send = async (args = {}) => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "context", ...args }) });
    expect(await (await send()).json()).toMatchObject({ release_capabilities: release });
    const page = await (await send({ offset: 0, limit: 4 })).json(); expect(page.content).toBe("Boun");
    active = false;
    expect((await send({ offset: page.next_offset, expected_checksum: page.checksum })).status).toBe(400);
    expect((await send()).status).toBe(400);
  });
  it("exposes configured capabilities only through the exact local config object and rechecks them on context reads", async () => {
    const f = fixture(), prepared = prepareStaticWebCapabilities({ viewports: [768, 320] });
    const capabilities = { version: 1 as const, profile_id: "profile", profile_digest: sha("profile"), checks: [{ command_id: "browser",
      config_digest: prepared.config_digest, contract_digest: prepared.contract_digest, contract: prepared.contract }] };
    f.context.verification_capabilities = structuredClone(capabilities);
    let active = true;
    const readCapabilities = vi.fn(() => { if (!active) throw new Error("Run capability binding closed"); return capabilities; });
    const localConfig = { runId: "run" } as AgentInstanceConfig;
    bindWorkspaceToolCapabilities(localConfig, readCapabilities);
    expect(() => bindWorkspaceToolCapabilities(localConfig, readCapabilities)).toThrow(/binding/);
    expect(takeWorkspaceToolCapabilities(structuredClone(localConfig))).toBeUndefined();
    expect(takeWorkspaceToolCapabilities(localConfig)).toBe(readCapabilities);
    expect(takeWorkspaceToolCapabilities(localConfig)).toBeUndefined();
    const options = { workspaceRoot: f.workspace, context: f.context, contextText: "Bound research context", verify: async () => evidence() };
    await expect(createWorkspaceToolSession(options)).rejects.toThrow(/local binding/);
    const changed = structuredClone(f.context); changed.verification_capabilities!.checks[0]!.contract.viewports[0]!.width = 390;
    await expect(createWorkspaceToolSession({ ...options, context: changed, readCapabilities })).rejects.toThrow(/differ/);
    const localOptions = { ...options, readCapabilities };
    const session = await createWorkspaceToolSession(localOptions); sessions.push(session);
    const config = JSON.parse(readFileSync(session.configPath, "utf8"));
    const send = async (args = {}) => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify({ tool: "context", ...args }) });
    expect(await (await send()).json()).toEqual({ context: "Bound research context", verification_capabilities: capabilities,
      read_guidance: expect.stringContaining("expected_checksum until eof:true") });
    localOptions.contextText = "Changed after session creation";
    const page = await (await send({ offset: 0, limit: 4 })).json();
    expect(page).toEqual({ version: 1, format: "artoo-context-text-page.v1", content: "Boun", checksum: sha("Bound research context"),
      size: Buffer.byteLength("Bound research context"), offset: 0, next_offset: 4, eof: false });
    active = false;
    expect((await send({ offset: page.next_offset, expected_checksum: page.checksum })).status).toBe(400);
    expect((await send()).status).toBe(400);
  });
  it("grants a peer only bound evidence and rejects verifier, file and host-path requests", async () => {
    const f = fixture(), context = structuredClone(f.context); delete context.product_development;
    context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "subject", run_id: "author", evidence_id: "measured", subject_digest: sha("subject") };
    const readEvidence = vi.fn(async (reference: string) => {
      if (reference !== "browser_granted") throw new Error("Evidence reference is not granted to this session");
      return { reference, provenance: { requestId: "final_request", profileId: "protected", profileDigest: sha("profile"), subjectDigest: sha("subject"),
        checkId: "browser", scope: "final" as const, bundle_id: "browser_granted", manifest_digest: sha("manifest") }, mime_type: "application/json" as const, text: "{\"stage\":\"design\"}" };
    });
    const configObject = { runId: "peer" } as AgentInstanceConfig;
    bindWorkspaceToolEvidenceReader(configObject, readEvidence);
    expect(takeWorkspaceToolEvidenceReader(structuredClone(configObject))).toBeUndefined();
    expect(takeWorkspaceToolEvidenceReader(configObject)).toBe(readEvidence);
    const session = await createWorkspaceToolSession({ workspaceRoot: f.workspace, context, contextText: "Exact review context", evidenceOnly: true, readEvidence }); sessions.push(session);
    const config = JSON.parse(readFileSync(session.configPath, "utf8")); expect(config.tools).toEqual(["context", "read_evidence"]);
    const send = async (input: unknown) => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(await (await send({ tool: "context" })).json()).toEqual({ context: "Exact review context",
      evidence_read_guidance: expect.stringContaining("expected_checksum until eof:true") });
    expect(await (await send({ tool: "context", limit: 4 })).json()).toEqual({ version: 1, format: "artoo-context-text-page.v1",
      content: "Exac", checksum: sha("Exact review context"), size: Buffer.byteLength("Exact review context"), offset: 0, next_offset: 4, eof: false });
    expect(await (await send({ tool: "read_evidence", reference: "browser_granted" })).json()).toMatchObject({ evidence: { mime_type: "application/json" } });
    for (const input of [{ tool: "verify" }, { tool: "write", path: "product/evil", content: "no", expected_checksum: null },
      { tool: "read", path: "product/index.html" }, { tool: "read_evidence", reference: "browser_other_session" }, { tool: "read_evidence", reference: "../private" }]) expect((await send(input)).status).toBe(400);
  });
  it("keeps verifier authority in one local object, outside serialized run payloads", () => {
    const config = { runId: "run_1" } as AgentInstanceConfig, verify = vi.fn(async () => evidence());
    bindWorkspaceToolVerifier(config, verify);
    expect(() => bindWorkspaceToolVerifier(config, verify)).toThrow(/binding/);
    expect(takeWorkspaceToolVerifier(structuredClone(config))).toBeUndefined();
    expect(takeWorkspaceToolVerifier(config)).toBe(verify);
    expect(takeWorkspaceToolVerifier(config)).toBeUndefined();
    expect(Object.keys(config)).toEqual(["runId"]);
  });
  it("forwards only bounded JSON evidence pagination to the local reader and keeps legacy calls unchanged", async () => {
    const f = fixture(), context = structuredClone(f.context); delete context.product_development;
    context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "author", run_id: "run", evidence_id: "evidence", subject_digest: sha("source") };
    const readEvidence = vi.fn(async (_reference: string, _options?: import("./browser-evidence.js").BrowserEvidenceReadOptions) => ({
      reference: "trace_granted", provenance: { requestId: "request", profileId: "profile", profileDigest: sha("profile"), subjectDigest: sha("source"),
        checkId: "browser", scope: "final" as const, bundle_id: "bundle", manifest_digest: sha("manifest") }, mime_type: "application/json" as const,
      text: "{}", checksum: sha("{}"), size: 2, offset: 0, next_offset: null, eof: true,
    }));
    const session = await createWorkspaceToolSession({ workspaceRoot: f.workspace, context, contextText: "Review", evidenceOnly: true, readEvidence }); sessions.push(session);
    const config = JSON.parse(readFileSync(session.configPath, "utf8"));
    const send = async (input: unknown) => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect((await send({ tool: "read_evidence", reference: "trace_granted" })).status).toBe(200);
    expect(readEvidence).toHaveBeenLastCalledWith("trace_granted");
    const options = { offset: 0, limit: 4096, expected_checksum: sha("{}") };
    expect((await send({ tool: "read_evidence", reference: "trace_granted", ...options })).status).toBe(200);
    expect(readEvidence).toHaveBeenLastCalledWith("trace_granted", options);
    const calls = readEvidence.mock.calls.length;
    for (const pagination of [{ offset: -1 }, { limit: 3 }, { limit: 16385 }, { expected_checksum: "invented" }, { path: "/etc/private" }]) {
      expect((await send({ tool: "read_evidence", reference: "trace_granted", ...pagination })).status).toBe(400);
    }
    expect(readEvidence).toHaveBeenCalledTimes(calls);
    const toolContext = await (await send({ tool: "context" })).json() as { evidence_read_guidance: string };
    expect(toolContext.evidence_read_guidance).toContain("expected_checksum until eof:true");
    const definition = workspaceToolDefinitions.find(item => item.name === "read_evidence")!;
    expect(definition.inputSchema.required).toEqual(["reference"]);
    expect(definition.inputSchema.properties).toHaveProperty("limit", expect.objectContaining({ maximum: 16384 }));
  });

  it("reconstructs fixed context larger than a file through bounded pages without losing the raw stage, schema or capabilities", async () => {
    const f = fixture(), prepared = prepareStaticWebCapabilities({ viewports: [768, 320] });
    const raw = { before: "a".repeat(540_000), product_development: structuredClone(f.context.product_development), middle: "MIDDLE_REQUIRED_中😀",
      after: "z".repeat(540_000), verification_capabilities: prepared.contract, last: "TAIL_REQUIRED_😀中" };
    const original = `\uFEFF# Fixed context\r\n## Raw Payload\r\n${JSON.stringify(raw)}\r\n`, checksum = sha(original), size = Buffer.byteLength(original);
    expect(size).toBeGreaterThan(1024 * 1024);
    const { send } = await f.start(undefined, undefined, original);
    // Neither a mutable context file nor the caller's context object supplies later pages.
    writeFileSync(join(f.workspace, "context_pack.md"), "replacement context file");
    f.context.product_development!.instructions = ["replacement instructions"];
    let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 400; index++) {
      const response = await send({ tool: "context", offset, limit: 4096, ...(offset ? { expected_checksum: checksum } : {}) });
      expect(response.status).toBe(200); const page = response.body;
      expect(Object.keys(page).sort()).toEqual(["checksum", "content", "eof", "format", "next_offset", "offset", "size", "version"]);
      expect(page).toMatchObject({ version: 1, format: "artoo-context-text-page.v1", checksum, size, offset });
      const length = Buffer.byteLength(page.content); expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(4096);
      expect(page.content).not.toContain("\uFFFD"); combined += page.content;
      if (page.eof) { expect(page.next_offset).toBeNull(); finished = true; break; }
      expect(page.next_offset).toBe(offset + length); offset = page.next_offset;
    }
    expect(finished).toBe(true); expect(Buffer.from(combined).equals(Buffer.from(original))).toBe(true); expect(sha(combined)).toBe(checksum);
    expect(JSON.parse(combined.slice(combined.indexOf("{")))).toEqual(raw);
    const defaultPage = (await send({ tool: "context", offset: 0 })).body;
    expect(Buffer.byteLength(defaultPage.content)).toBe(16 * 1024); expect(defaultPage.next_offset).toBe(16 * 1024);
    expect((await send({ tool: "context", expected_checksum: checksum })).body).toEqual(defaultPage);
    expect((await send({ tool: "context" })).body).toEqual({ context: original, read_guidance: expect.stringContaining("expected_checksum until eof:true") });
  }, 30_000);

  it("preserves context UTF-8 boundaries and empty EOF, and rejects invalid or unbound ranges", async () => {
    const f = fixture(), original = "\uFEFFA😀中éB\r\n", checksum = sha(original), size = Buffer.byteLength(original);
    const { send } = await f.start(undefined, undefined, original); let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 16; index++) {
      const { status, body: page } = await send({ tool: "context", offset, limit: 4, expected_checksum: checksum });
      expect(status).toBe(200); expect(page.offset).toBe(offset); expect(page.checksum).toBe(checksum);
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(4); expect(page.content).not.toContain("\uFFFD"); combined += page.content;
      if (page.eof) { expect(page.next_offset).toBeNull(); finished = true; break; }
      expect(page.next_offset).toBeGreaterThan(offset); offset = page.next_offset;
    }
    expect(finished).toBe(true); expect(combined).toBe(original); expect(sha(combined)).toBe(checksum);
    expect((await send({ tool: "context", offset: 5, limit: 4, expected_checksum: checksum })).body.error).toMatch(/UTF-8 character boundary/);
    expect((await send({ tool: "context", offset: 4, limit: 4 })).body.error).toMatch(/requires the full-text expected_checksum/);
    expect((await send({ tool: "context", offset: size + 1, expected_checksum: checksum })).body.error).toMatch(/beyond the end/);
    expect((await send({ tool: "context", expected_checksum: sha("other context") })).body.error).toMatch(/checksum differs/);
    for (const range of [{ offset: -1 }, { offset: 1.5 }, { offset: 8 * 1024 * 1024 + 1 }, { offset: null }, { limit: 3 }, { limit: 4.5 },
      { limit: 16 * 1024 + 1 }, { limit: null }, { expected_checksum: "bad" }, { offset: 0, path: "context_pack.md" }]) {
      expect((await send({ tool: "context", ...range })).status).toBe(400);
    }
    expect((await send({ tool: "context", offset: size, expected_checksum: checksum })).body).toEqual({ version: 1, format: "artoo-context-text-page.v1",
      content: "", checksum, size, offset: size, next_offset: null, eof: true });
    const empty = await fixture().start(undefined, undefined, "");
    expect((await empty.send({ tool: "context", limit: 4 })).body).toEqual({ version: 1, format: "artoo-context-text-page.v1",
      content: "", checksum: sha(""), size: 0, offset: 0, next_offset: null, eof: true });
    const definition = workspaceToolDefinitions.find(item => item.name === "context")!;
    expect(definition.inputSchema.required).toEqual([]);
    expect(definition.inputSchema.properties).toMatchObject({ offset: { type: "integer", minimum: 0, maximum: 8 * 1024 * 1024 },
      limit: { minimum: 4, maximum: 16 * 1024 }, expected_checksum: { type: "string" } });
  });

  it("counts every explicit page attempt against 4096 while preserving ordinary tools after more than 1024 pages", async () => {
    const f = fixture(), verify = vi.fn(async () => evidence()), { send, config } = await f.start(verify);
    expect((await fetch(config.url, { method: "POST", body: JSON.stringify({ tool: "context", offset: 0 }) })).status).toBe(403);
    const valid = [{ offset: 0 }, { limit: 4 }, { expected_checksum: sha("Fixed task context") }];
    for (let batch = 0; batch < 1025; batch += 4) {
      const results = await Promise.all(Array.from({ length: Math.min(4, 1025 - batch) }, (_, index) => send({ tool: "context", ...valid[(batch + index) % valid.length] })));
      expect(results.map(result => result.status)).toEqual(results.map(() => 200));
    }
    expect((await send({ tool: "verify" })).status).toBe(200); expect(verify).toHaveBeenCalledTimes(1);
    const invalid = [{ offset: null }, { limit: null }, { expected_checksum: "" }, { offset: 0, unexpected: true }];
    for (let batch = 1025; batch < 4096; batch += 4) {
      const results = await Promise.all(Array.from({ length: Math.min(4, 4096 - batch) }, (_, index) => send({ tool: "context", ...invalid[(batch + index) % invalid.length] })));
      expect(results.map(result => result.status)).toEqual(results.map(() => 400));
    }
    expect((await send({ tool: "context", offset: 0 })).status).toBe(429);
    expect((await send({ tool: "context", expected_checksum: "" })).status).toBe(429);
    expect((await send({ tool: "context" })).status).toBe(200);
    expect((await send({ tool: "mkdir", path: "product" })).status).toBe(200);
    expect((await send({ tool: "write", path: "product/after-pages.txt", content: "still writable", expected_checksum: null })).status).toBe(200);
    expect((await send({ tool: "verify" })).status).toBe(200); expect(verify).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("keeps the ordinary 1024-request quota for malformed, invalid and legacy requests without revoking pages", async () => {
    const f = fixture(), { send, sendRaw } = await f.start();
    // The oversized request may close its HTTP stream. The boundary count below
    // still proves that this pre-classification failure consumes exactly one slot.
    await sendRaw("x".repeat(8 * 1024 * 1024 + 1)).catch(() => undefined);
    const ordinary = ["{", "null", "[]", JSON.stringify({ tool: "unknown", offset: 0 }),
      JSON.stringify({ tool: "context", path: "not-granted" }), JSON.stringify({ tool: "context" })];
    for (let batch = 1; batch < 1024; batch += 4) {
      const results = await Promise.all(Array.from({ length: Math.min(4, 1024 - batch) }, (_, index) => sendRaw(ordinary[(batch + index) % ordinary.length]!)));
      expect(results.map(result => result.status)).toEqual(results.map((_, index) => (batch + index) % ordinary.length === 5 ? 200 : 400));
    }
    expect((await send({ tool: "context" })).status).toBe(429);
    expect((await sendRaw("{")).status).toBe(429);
    expect((await send({ tool: "verify" })).status).toBe(429);
    expect((await send({ tool: "context", expected_checksum: sha("Fixed task context") })).status).toBe(200);
    expect((await send({ tool: "context", offset: 0 })).status).toBe(200);
  }, 60_000);

  it("writes, reads, edits and removes actual files with compare-and-swap checksums", async () => {
    const f = fixture(), { send, config } = await f.start();
    expect((await fetch(config.url, { method: "POST", body: "{}" })).status).toBe(403);
    const toolContext = (await send({ tool: "context" })).body;
    expect(toolContext.context).toBe("Fixed task context");
    expect(toolContext.read_guidance).toContain("expected_checksum until eof:true");
    expect((await send({ tool: "mkdir", path: "product/assets" })).status).toBe(200);
    expect((await send({ tool: "write", path: "product/index.html", content: "<h1>Journal</h1>", expected_checksum: null })).body.checksum).toBe(sha("<h1>Journal</h1>"));
    expect(readFileSync(join(f.workspace, "product/index.html"), "utf8")).toBe("<h1>Journal</h1>");
    expect((await send({ tool: "write", path: "product/index.html", content: "overwrite", expected_checksum: null })).status).toBe(400);
    expect((await send({ tool: "write", path: "product/index.html", content: "overwrite", expected_checksum: sha("stale") })).status).toBe(400);
    const read = await send({ tool: "read", path: "product/index.html" });
    expect(read.body).toEqual({ path: "product/index.html", content: "<h1>Journal</h1>", checksum: sha("<h1>Journal</h1>"), size: 16 });
    const edit = await send({ tool: "edit", path: "product/index.html", old_text: "Journal", new_text: "Notes", expected_checksum: read.body.checksum });
    expect(edit.status).toBe(200); expect(readFileSync(join(f.workspace, "product/index.html"), "utf8")).toBe("<h1>Notes</h1>");
    expect((await send({ tool: "list", path: "product" })).body.entries).toEqual([{ name: "assets", kind: "directory" }, { name: "index.html", kind: "file", size: 14 }]);
    expect((await send({ tool: "remove", path: "product/index.html", expected_checksum: read.body.checksum })).status).toBe(400);
    expect((await send({ tool: "remove", path: "product/index.html", expected_checksum: edit.body.checksum })).status).toBe(200);
    expect(existsSync(join(f.workspace, "product/index.html"))).toBe(false);
    expect((await send({ tool: "remove", path: "product/assets", expected_checksum: sha("") })).status).toBe(400);
  });


  it("reconstructs a long pinned JSON handoff through bounded pages with one full-file checksum", async () => {
    const f = fixture(); mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true });
    const handoff = JSON.stringify({ first: "START_REQUIREMENT", before: "a".repeat(24_000), middle: "MIDDLE_REQUIREMENT",
      after: "z".repeat(24_000), last: "END_REQUIREMENT" });
    const path = ".artoo/product/research.json", checksum = sha(handoff), size = Buffer.byteLength(handoff);
    writeFileSync(join(f.workspace, path), handoff);
    f.context.product_development = { ...productDevelopmentContext("design"), accepted_inputs: { version: 1, files: [
      { path, checksum, size, source_task_id: "research_task", source_run_id: "research_run", evidence_id: "evidence_1" },
    ] } };
    const { send } = await f.start(); let offset = 0, combined = "", finished = false;
    for (let pageNumber = 0; pageNumber < 16; pageNumber += 1) {
      const response = await send({ tool: "read", path, offset, limit: 16 * 1024, ...(offset ? { expected_checksum: checksum } : {}) });
      expect(response.status).toBe(200);
      const page = response.body; expect(page).toMatchObject({ path, checksum, size, offset });
      const bytes = Buffer.byteLength(page.content); expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThanOrEqual(16 * 1024);
      combined += page.content;
      if (page.eof) { expect(page.next_offset).toBeNull(); finished = true; break; }
      expect(page.next_offset).toBe(offset + bytes); offset = page.next_offset;
    }
    expect(finished).toBe(true); expect(combined).toBe(handoff); expect(sha(combined)).toBe(checksum);
    expect(JSON.parse(combined)).toMatchObject({ middle: "MIDDLE_REQUIREMENT", last: "END_REQUIREMENT" });
    // Paging never changes the legacy response shape or makes accepted inputs writable.
    expect((await send({ tool: "read", path })).body).toEqual({ path, content: handoff, checksum, size });
    expect((await send({ tool: "write", path, content: "weaker", expected_checksum: checksum })).body.error).toMatch(/read-only/);
    writeFileSync(join(f.workspace, path), handoff.replace("MIDDLE_REQUIREMENT", "CHANGED_REQUIREMENT"));
    expect((await send({ tool: "read", path, offset: 16 * 1024, limit: 4096, expected_checksum: checksum })).status).toBe(400);
  });

  it("keeps UTF-8 page boundaries, BOM and line endings, and explicitly rejects invalid ranges", async () => {
    const f = fixture(), { send } = await f.start(); mkdirSync(join(f.workspace, "product"));
    const path = "product/unicode.txt", original = "\uFEFFA😀中éB\r\n", checksum = sha(original), size = Buffer.byteLength(original);
    writeFileSync(join(f.workspace, path), original);
    let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 16; index += 1) {
      const response = await send({ tool: "read", path, offset, limit: 4, expected_checksum: checksum }); expect(response.status).toBe(200);
      const page = response.body; expect(page.offset).toBe(offset); expect(page.checksum).toBe(checksum);
      expect(page.content).not.toContain("\uFFFD"); expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(4);
      combined += page.content;
      if (page.eof) { expect(page.next_offset).toBeNull(); finished = true; break; }
      expect(page.next_offset).toBeGreaterThan(offset); offset = page.next_offset;
    }
    expect(finished).toBe(true); expect(combined).toBe(original); expect(sha(combined)).toBe(checksum);
    expect((await send({ tool: "read", path, offset: 5, limit: 4, expected_checksum: checksum })).body.error).toMatch(/UTF-8 character boundary/);
    expect((await send({ tool: "read", path, offset: 4, limit: 4 })).body.error).toMatch(/requires the full-file expected_checksum/);
    expect((await send({ tool: "read", path, offset: size + 1, expected_checksum: checksum })).body.error).toMatch(/beyond the end/);
    for (const range of [{ offset: -1 }, { offset: 1.5 }, { limit: 3 }, { limit: 16 * 1024 + 1 }, { expected_checksum: "bad" }]) {
      expect((await send({ tool: "read", path, ...range })).status).toBe(400);
    }
    expect((await send({ tool: "read", path, offset: size, expected_checksum: checksum })).body).toEqual({
      path, content: "", checksum, size, offset: size, next_offset: null, eof: true,
    });
    writeFileSync(join(f.workspace, "product/empty.txt"), "");
    expect((await send({ tool: "read", path: "product/empty.txt", limit: 4 })).body).toMatchObject({ content: "", size: 0, offset: 0, next_offset: null, eof: true });
    writeFileSync(join(f.workspace, "product/invalid.txt"), Buffer.from([0x61, 0x62, 0x63, 0x64, 0xff]));
    expect((await send({ tool: "read", path: "product/invalid.txt", limit: 4 })).status).toBe(400);
  });

  it("rejects a changed file between pages even when its byte length stays unchanged", async () => {
    const f = fixture(), { send } = await f.start(); mkdirSync(join(f.workspace, "product"));
    const path = "product/changing.txt", original = "first-version", updated = "other-version";
    writeFileSync(join(f.workspace, path), original);
    const first = (await send({ tool: "read", path, limit: 4 })).body;
    expect(first).toMatchObject({ content: "firs", offset: 0, next_offset: 4, eof: false, checksum: sha(original) });
    const changed = await send({ tool: "write", path, content: updated, expected_checksum: first.checksum }); expect(changed.status).toBe(200);
    expect((await send({ tool: "read", path, offset: first.next_offset, limit: 4, expected_checksum: first.checksum })).body.error).toMatch(/File changed since/);
    expect((await send({ tool: "read", path, expected_checksum: first.checksum })).status).toBe(400);
    expect((await send({ tool: "read", path, offset: 0, expected_checksum: changed.body.checksum })).body).toMatchObject({ content: updated, eof: true });
    expect((await send({ tool: "read", path, expected_checksum: changed.body.checksum })).body).toEqual({ path, content: updated, checksum: sha(updated), size: Buffer.byteLength(updated) });
    const definition = workspaceToolDefinitions.find((tool) => tool.name === "read")!;
    expect(definition.inputSchema.properties).toMatchObject({ offset: { type: "integer", minimum: 0 }, limit: { minimum: 4, maximum: 16 * 1024 }, expected_checksum: { type: "string" } });
    expect(definition.inputSchema.required).toEqual(["path"]);
  });

  it("requires exact schemas, explicit parents, and an unambiguous text edit", async () => {
    const f = fixture(), { send } = await f.start();
    expect((await send({ tool: "mkdir", path: "product", command: "anything" })).status).toBe(400);
    expect((await send({ tool: "write", path: "product/a.txt", content: "missing checksum" })).status).toBe(400);
    expect((await send({ tool: "write", path: "product/a.txt", content: "hello", expected_checksum: null })).status).toBe(400);
    await send({ tool: "mkdir", path: "product" });
    await send({ tool: "write", path: "product/a.txt", content: "one one", expected_checksum: null });
    expect((await send({ tool: "edit", path: "product/a.txt", old_text: "one", new_text: "two", expected_checksum: sha("one one") })).body.error).toMatch(/exactly once/);
    expect((await send({ tool: "edit", path: "product/a.txt", old_text: "absent", new_text: "two", expected_checksum: sha("one one") })).status).toBe(400);
    expect((await send({ tool: "verify", argv: ["anything"] })).status).toBe(400);
    expect((await send({ tool: "context", path: "anything" })).status).toBe(400);
    expect(readFileSync(join(f.workspace, "product/a.txt"), "utf8")).toBe("one one");
    expect(workspaceToolDefinitions.map((tool) => tool.name)).toEqual(["context", "list", "read", "mkdir", "write", "edit", "remove", "verify", "read_evidence"]);
    expect(workspaceToolDefinitions.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("preserves UTF-8 BOM, line endings and an existing executable file mode during an edit", async () => {
    const f = fixture(), { send } = await f.start(); mkdirSync(join(f.workspace, "product"));
    const path = join(f.workspace, "product", "entry.js"), original = "\uFEFFconst title = 'Journal';\r\n";
    writeFileSync(path, original); chmodSync(path, 0o770);
    const read = await send({ tool: "read", path: "product/entry.js" }); expect(read.body.content).toBe(original);
    const edit = await send({ tool: "edit", path: "product/entry.js", old_text: "Journal", new_text: "Notes", expected_checksum: read.body.checksum });
    expect(edit.status).toBe(200); expect(readFileSync(path, "utf8")).toBe("\uFEFFconst title = 'Notes';\r\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o770);
  });

  it("rejects traversal, Windows aliases, reserved names and tool configuration paths", async () => {
    const f = fixture(), { send } = await f.start();
    writeFileSync(join(f.root, "secret.txt"), "outside");
    const paths = ["../secret.txt", "/tmp/outside", "C:/outside", "product/../secret.txt", "product//file", "product\\file", ".artoo/other/file",
      "product/a.", "product/a ", "product/CON.txt", "product/com1", "product/LPT¹.txt", "product/a:stream", "product/.git/config", "product/.ClAuDe/settings.json",
      "product/.codex/config.toml", "product/.mcp.json", "product/.claude.json", "product/a\u0000.txt", "PRODUCT/file", ".ARTOO/product/file"];
    for (const path of paths) expect((await send({ tool: "write", path, content: "forbidden", expected_checksum: null })).status, path).toBe(400);
    expect((await send({ tool: "read", path: "context_pack.md" })).status).toBe(400);
    expect(readFileSync(join(f.root, "secret.txt"), "utf8")).toBe("outside");
  });

  it("rejects junction/symlink parents and hard-linked files without touching their targets", async () => {
    const f = fixture(), { send } = await f.start();
    mkdirSync(join(f.workspace, "product")); const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(f.workspace, "product", "linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await send({ tool: "read", path: "product/linked/secret.txt" })).status).toBe(400);
    expect((await send({ tool: "mkdir", path: "product/linked/subdirectory" })).status).toBe(400);
    expect((await send({ tool: "write", path: "product/linked/new.txt", content: "forbidden", expected_checksum: null })).status).toBe(400);
    expect(existsSync(join(outside, "new.txt"))).toBe(false); expect(existsSync(join(outside, "subdirectory"))).toBe(false);
    linkSync(join(outside, "secret.txt"), join(f.workspace, "product", "hard.txt"));
    for (const tool of ["read", "remove", "write"]) {
      const input = tool === "read" ? { tool, path: "product/hard.txt" } : { tool, path: "product/hard.txt", expected_checksum: sha("outside"), ...(tool === "write" ? { content: "overwrite" } : {}) };
      expect((await send(input)).status).toBe(400);
    }
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
    expect((await send({ tool: "list", path: "product" })).status).toBe(400);
  });

  it("pins accepted stage inputs, snapshots caller context and detects out-of-band changes", async () => {
    const f = fixture(); mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(f.workspace, "product"));
    const research = "accepted requirements"; writeFileSync(join(f.workspace, ".artoo/product/research.json"), research);
    f.context.product_development = { ...productDevelopmentContext("design"), accepted_inputs: { version: 1, files: [
      { path: ".artoo/product/research.json", checksum: sha(research), size: Buffer.byteLength(research), source_task_id: "research_task", source_run_id: "research_run", evidence_id: "evidence_1" },
    ] } };
    const verify = vi.fn(async () => evidence()), { send } = await f.start(verify);
    f.context.product_development.accepted_inputs!.files = [];
    const contextPage = (await send({ tool: "context", limit: 4 })).body;
    expect((await send({ tool: "read", path: ".artoo/product/research.json" })).body.content).toBe(research);
    for (const path of [".artoo/product/research.json", ".artoo/product/research.JSON"]) {
      expect((await send({ tool: "write", path, content: "weaker", expected_checksum: sha(research) })).body.error).toMatch(/read-only/);
      expect((await send({ tool: "remove", path, expected_checksum: sha(research) })).status).toBe(400);
    }
    writeFileSync(join(f.workspace, ".artoo/product/research.json"), "changed outside broker");
    expect((await send({ tool: "context", offset: contextPage.next_offset, expected_checksum: contextPage.checksum })).status).toBe(400);
    expect((await send({ tool: "mkdir", path: "product/new" })).status).toBe(400);
    expect((await send({ tool: "verify" })).status).toBe(400); expect(verify).not.toHaveBeenCalled();
    expect(existsSync(join(f.workspace, "product/new"))).toBe(false);
  });

  it("detects a replaced workspace directory", async () => {
    const f = fixture(), { send } = await f.start();
    const contextPage = (await send({ tool: "context", limit: 4 })).body;
    renameSync(f.workspace, join(f.root, "original")); mkdirSync(f.workspace);
    expect((await send({ tool: "context", offset: contextPage.next_offset, expected_checksum: contextPage.checksum })).body.error).toMatch(/identity changed/);
    expect((await send({ tool: "mkdir", path: "product" })).body.error).toMatch(/identity changed/);
    expect(existsSync(join(f.workspace, "product"))).toBe(false);
  });

  it("keeps in-progress verification diagnostic-only and locks every mutation", async () => {
    const f = fixture(), entered = deferred<void>(), finish = deferred<RunVerificationPayload>();
    const verify = vi.fn(async () => { entered.resolve(); return finish.promise; }), { send } = await f.start(verify);
    await send({ tool: "mkdir", path: "product" }); await send({ tool: "write", path: "product/a.txt", content: "one", expected_checksum: null });
    const request = send({ tool: "verify" }); await entered.promise;
    expect((await send({ tool: "verify" })).status).toBe(400);
    for (const input of [{ tool: "mkdir", path: "product/nested" }, { tool: "write", path: "product/a.txt", content: "two", expected_checksum: sha("one") },
      { tool: "edit", path: "product/a.txt", old_text: "one", new_text: "two", expected_checksum: sha("one") }, { tool: "remove", path: "product/a.txt", expected_checksum: sha("one") }]) {
      expect((await send(input)).body.error).toMatch(/disabled while verification/);
    }
    expect((await send({ tool: "read", path: "product/a.txt" })).body.content).toBe("one");
    finish.resolve(evidence()); const response = await request;
    expect(response.body).toEqual({ diagnostic_only: true, verification: evidence() }); expect(verify).toHaveBeenCalledTimes(1);
    expect((await send({ tool: "write", path: "product/a.txt", content: "two", expected_checksum: sha("one") })).status).toBe(200);
  });

  it("aborts an active verifier on close and waits for its actual cleanup before deleting configuration", async () => {
    const f = fixture(), entered = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<RunVerificationPayload>();
    const { send, session } = await f.start(async (signal) => { signal.addEventListener("abort", () => aborted.resolve(), { once: true }); entered.resolve(); return cleanup.promise; });
    const request = send({ tool: "verify" }).catch(() => undefined); await entered.promise;
    const closing = session.close(); await aborted.promise;
    expect(existsSync(session.configPath)).toBe(true);
    cleanup.resolve({ ...evidence(), outcome: "cancelled" }); await closing; await request;
    expect(existsSync(dirname(session.configPath))).toBe(false);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("remembers verifier cleanup uncertainty after the HTTP request ends", async () => {
    const f = fixture(), failure = new VerificationCleanupError("actual process closure is unconfirmed");
    const { send, session } = await f.start(async () => { throw failure; }); uncertainSessions.add(session);
    expect((await send({ tool: "verify" })).body.error).toMatch(/unconfirmed/);
    // The session no longer offers even a context read after losing subprocess ownership.
    const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
    expect((await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: '{"tool":"context"}' })).status).toBe(429);
    expect((await send({ tool: "context", offset: 0, limit: 4 })).status).toBe(429);
    await expect(session.close()).rejects.toBe(failure); await expect(session.close()).rejects.toBe(failure);
    expect(existsSync(session.configPath)).toBe(true);
  });

  it("bounds UTF-8 bytes per file and total writes without modifying the last valid file", async () => {
    const f = fixture(), { send } = await f.start(); await send({ tool: "mkdir", path: "product" });
    expect((await send({ tool: "write", path: "product/large.txt", content: "文".repeat(400_000), expected_checksum: null })).status).toBe(400);
    expect(existsSync(join(f.workspace, "product/large.txt"))).toBe(false);
    const content = "x".repeat(1024 * 1024), checksum = sha(content);
    for (let index = 0; index < 32; index += 1) expect((await send({ tool: "write", path: "product/large.txt", content, expected_checksum: index === 0 ? null : checksum })).status).toBe(200);
    expect((await send({ tool: "write", path: "product/large.txt", content: "new", expected_checksum: checksum })).body.error).toMatch(/budget/);
    expect(sha(readFileSync(join(f.workspace, "product/large.txt")))).toBe(checksum);
  }, 30_000);

  it("rejects invalid UTF-8 reads and refuses read-only, mismatched and unbound contexts", async () => {
    const f = fixture(), { send } = await f.start(); mkdirSync(join(f.workspace, "product")); writeFileSync(join(f.workspace, "product/binary.dat"), Buffer.from([255]));
    expect((await send({ tool: "read", path: "product/binary.dat" })).status).toBe(400);
    const options = { workspaceRoot: f.workspace, context: f.context, contextText: "context", verify: async () => evidence() };
    await expect(createWorkspaceToolSession({ ...options, context: { ...f.context, policy: { ...f.context.policy, execution_mode: "discussion" } } })).rejects.toThrow(/author context/);
    await expect(createWorkspaceToolSession({ ...options, context: { ...f.context, workspace: { ...f.context.workspace, root: f.root } } })).rejects.toThrow(/author context/);
    await expect(createWorkspaceToolSession({ ...options, context: { ...f.context, policy: { ...f.context.policy, filesystem_write_scope: [] } } })).rejects.toThrow(/write scope/);
  });

  it("merges only the already-created protected research MCP configuration", async () => {
    const f = fixture(), broker = join(f.root, "research-broker.json"), mcp = join(f.root, "research-mcp.json");
    writeFileSync(broker, JSON.stringify({ version: 1, url: "http://127.0.0.1:1234/", token: "a".repeat(64) }));
    const research = { command: process.execPath, args: [fileURLToPath(new URL("./research-mcp.js", import.meta.url)), broker], env: { ELECTRON_RUN_AS_NODE: "1" } };
    writeFileSync(mcp, JSON.stringify({ mcpServers: { artoo_research: research } }));
    const { session } = await f.start(async () => evidence(), mcp);
    const config = JSON.parse(readFileSync(session.mcpPath, "utf8"));
    expect(Object.keys(config.mcpServers).sort()).toEqual(["artoo_research", "artoo_workspace"]); expect(config.mcpServers.artoo_research).toEqual(research);
    writeFileSync(mcp, JSON.stringify({ mcpServers: { artoo_research: research, unexpected: { command: "anything" } } }));
    await expect(f.start(async () => evidence(), mcp)).rejects.toThrow(/node research/);
    writeFileSync(mcp, JSON.stringify({ mcpServers: { artoo_research: { ...research, command: "anything" } } }));
    await expect(f.start(async () => evidence(), mcp)).rejects.toThrow(/node research/);
  });
});
