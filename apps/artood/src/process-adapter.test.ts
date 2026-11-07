import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { WorkspaceScopeError } from "@artoo/protocol";
import { describe, expect, it, vi } from "vitest";

import { assertRealWorkspaceScope, createProcessAdapter } from "./process-adapter.js";
import { buildRegistry, loadConfigFromEnv } from "./main.js";
import { productDevelopmentContext, CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, type ReleaseCapabilitiesV1 } from "@artoo/domain";
import { bindWorkspaceToolVerifier, bindWorkspaceToolEvidenceReader, bindWorkspaceToolCapabilities, bindWorkspaceToolReleaseCapabilities } from "./workspace-tools.js";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";

const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));
const structuredFixture = fileURLToPath(new URL("../test-fixtures/structured-agent.mjs", import.meta.url));

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "artoo-proc-"));
}

function makeConfig(workspace: string): AgentInstanceConfig {
  const contextPack = {
    task: {
      id: "task_1",
      title: "Process adapter task",
      description: "Make the runtime prove it received the task.",
      acceptance_criteria: ["write changes.patch"]
    },
    project: { id: "proj_1", name: "Artoo", default_workspace: workspace },
    workspace: { root: workspace, file_scope: ["src/**"] },
    policy: { filesystem_write_scope: [workspace], requires_approval: ["git.push"] },
    memory: { task_summary: null, project_notes: ["prefer small patches"] },
    artifacts: { expected: ["changes.patch"] }
  };
  return {
    runId: "run_1",
    taskId: "task_1",
    agentInstanceId: "ai_1",
    runtime: "codex",
    workspaceRoot: workspace,
    runStart: {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "codex",
      workspace: { root: workspace },
      context_pack: { id: "ctx_1", payload: contextPack },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: ["*.patch"] }
    }
  };
}

async function drain(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) {
    out.push(event);
  }
  return out;
}

function isOutput(e: RunEvent): e is Extract<RunEvent, { type: "run.output" }> {
  return e.type === "run.output";
}

const cmd = [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"];

describe("createProcessAdapter", () => {
  it.each([false, true])("preserves every bound context field across compact UTF-8 MCP pages (peer=%s)", async (peer) => {
    const ws = realpathSync.native(makeWorkspace()), config = makeConfig(ws), payload = config.runStart.context_pack.payload!;
    const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
    const prepared = prepareStaticWebCapabilities({ viewports: [1280, 768, 390, 320] });
    const capabilities = { version: 1 as const, profile_id: "profile", profile_digest: sha("profile"),
      checks: [{ command_id: "browser", config_digest: prepared.config_digest, contract_digest: prepared.contract_digest, contract: prepared.contract }] };
    const release: ReleaseCapabilitiesV1 = { version: 1, binding: { version: 1, release_profile_id: "release", release_profile_digest: sha("release"),
      contract_digest: sha("release-contract"), project_id: "proj_1", workspace_root: ws,
      verification_profile_id: capabilities.profile_id, verification_profile_digest: capabilities.profile_digest },
      contract: { version: 1, kind: "configured-static-release", claim: "configured", execution_phase: "after-stage-acceptance",
        endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time", lifecycle: "while-configured-node-service-running",
        health_checks: [{ path: "/", expected_status: 200, body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" }],
        criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } } };
    payload.verification_capabilities = capabilities; payload.release_capabilities = release;
    payload.goal_context = { version: 1, goal_id: "goal_1", objective: "完整需求🌱", acceptance_criteria: ["保留所有条件"],
      plan: { id: "plan_1", version: 3, rationale: "Accepted plan", spec_ref: null } };
    payload.memory = { task_summary: "摘要\n含引号\"与路径\\", project_notes: ["多字节🌱é".repeat(2200), "末尾必读🌱"] };
    payload.dependency_context = { version: 1, truncated: false, entries: [{ task_id: "research_task", title: "Accepted research", dependency_type: "requires",
      status: "accepted", acceptance_criteria: ["原始要求"], run_id: "research_run", workspace_root: ws, artifacts_truncated: false,
      artifacts: [{ id: "research_artifact", type: "report", run_id: "research_run", checksum: sha("research"), content_path: "/artifacts/research/content" }] }] };
    const verify = vi.fn(async () => { throw new Error("This transport fixture does not verify a product"); });
    const readEvidence = vi.fn(async () => { throw new Error("This transport fixture does not read evidence"); });
    if (peer) {
      config.runStart.context_pack.uri = "artoo://context/ctx_1";
      payload.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
      payload.review_subject = { version: 1, task_id: "author_task", run_id: "author_run", evidence_id: "final_evidence", subject_digest: sha("source"),
        development_stage: "design", verification: { version: 1, request_id: "final_request", profile_id: capabilities.profile_id,
          profile_digest: capabilities.profile_digest, checks: [{ id: "browser", output_digest: sha("actual output") }] } };
      bindWorkspaceToolEvidenceReader(config, readEvidence);
    } else {
      const accepted = '{"fixture":"接受的研究🌱"}';
      mkdirSync(join(ws, ".artoo", "product"), { recursive: true }); writeFileSync(join(ws, ".artoo", "product", "research.json"), accepted);
      payload.product_development = { ...productDevelopmentContext("design", capabilities), accepted_inputs: { version: 1, files: [{
        path: ".artoo/product/research.json", checksum: sha(accepted), size: Buffer.byteLength(accepted),
        source_task_id: "research_task", source_run_id: "research_run", evidence_id: "research_evidence" }] } };
      bindWorkspaceToolVerifier(config, verify);
    }
    bindWorkspaceToolCapabilities(config, () => capabilities); bindWorkspaceToolReleaseCapabilities(config, () => release);
    const original = structuredClone(payload);
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
      const path=JSON.parse(process.argv[1]),c=JSON.parse(fs.readFileSync(path,'utf8'));
      (async()=>{const pages=[];let offset=0,checksum;
        for(let i=0;i<100;i++){
          const r=await fetch(c.url,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},
            body:JSON.stringify({tool:'context',offset,limit:4096,...(checksum?{expected_checksum:checksum}:{})})});
          assert.equal(r.status,200);const page=await r.json();pages.push(page);checksum??=page.checksum;
          if(page.eof)break;offset=page.next_offset;
        }
        assert.equal(pages.at(-1).eof,true);
        console.log(JSON.stringify({pages,fileText:fs.readFileSync(process.argv[2],'utf8'),filePath:process.argv[2],configPath:path,tools:c.tools}));
        process.exitCode=7;
      })().catch(error=>{console.error(error);process.exitCode=1;});`;
    const command = [process.execPath, "-e", script, "{{workspace_tools_config_json}}", "{{context_pack_path}}"];
    const adapter = createProcessAdapter({ command: [process.execPath, "-e", "process.exit(51)"],
      discussionCommand: [process.execPath, "-e", "process.exit(52)"], productCommand: command, reviewCommand: command, allowedRoots: [ws], artifacts: [] });
    try {
      const events = await drain(adapter.streamEvents(await adapter.start(config)));
      const output = JSON.parse(events.filter(isOutput).filter(event => event.payload.stream === "stdout").map(event => event.payload.text).join(""));
      const pages = output.pages as Array<{ version: number; format: string; content: string; checksum: string; size: number;
        offset: number; next_offset: number | null; eof: boolean }>;
      const text = pages.map(page => page.content).join(""), checksum = sha(text), size = Buffer.byteLength(text);
      expect(pages.length).toBeGreaterThan(3); let offset = 0;
      for (const [index, page] of pages.entries()) {
        expect(Object.keys(page).sort()).toEqual(["checksum", "content", "eof", "format", "next_offset", "offset", "size", "version"]);
        expect(page).toMatchObject({ version: 1, format: "artoo-context-text-page.v1", checksum, size, offset });
        const bytes = Buffer.byteLength(page.content); expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThanOrEqual(4096);
        expect(page.content).not.toContain("\uFFFD"); offset += bytes;
        expect(page.eof).toBe(index === pages.length - 1); expect(page.next_offset).toBe(page.eof ? null : offset);
      }
      expect(offset).toBe(size);
      expect(pages.some(page => !page.eof && Buffer.byteLength(page.content) < 4096)).toBe(true);
      const header = `# Context Pack ctx_1\ntask: task_1\nrun: run_1${peer ? "\nuri: artoo://context/ctx_1" : ""}\n`;
      expect(text).toBe(`${header}\n## Raw Payload\n${JSON.stringify(original)}\n`);
      expect(JSON.parse(text.split("\n## Raw Payload\n")[1]!)).toEqual(original);
      expect(output.fileText).toContain("\n## Task\n"); expect(output.fileText.startsWith(header)).toBe(true);
      expect(output.fileText.endsWith(`\n## Raw Payload\n${JSON.stringify(original, null, 2)}\n`)).toBe(true);
      expect(JSON.parse(output.fileText.split("\n## Raw Payload\n")[1])).toEqual(original);
      expect(Buffer.byteLength(output.fileText)).toBeGreaterThan(size);
      expect(existsSync(output.configPath)).toBe(false); expect(existsSync(output.filePath)).toBe(!peer);
      if (peer) expect(output.tools).toEqual(["context", "read_evidence"]);
      else expect(output.tools).toContain("verify");
      expect(verify).not.toHaveBeenCalled(); expect(readEvidence).not.toHaveBeenCalled();
      // Exit 7 ends this transport-only fixture without claiming product-stage acceptance.
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it.each(["manual", "discussion", "peer-without-grant"])("preserves the complete legacy context file bytes for %s", async (mode) => {
    const ws = makeWorkspace(), config = makeConfig(ws), payload = config.runStart.context_pack.payload!;
    config.runStart.context_pack.uri = "artoo://context/ctx_1";
    if (mode !== "manual") payload.policy.execution_mode = "discussion";
    if (mode === "peer-without-grant") payload.review_subject = { version: 1, task_id: "author_task", run_id: "author_run",
      evidence_id: "evidence", subject_digest: `sha256:${"a".repeat(64)}` };
    const expected = ["# Context Pack ctx_1", "task: task_1", "run: run_1", "uri: artoo://context/ctx_1", "", "## Task", "id: task_1",
      "title: Process adapter task", "description: Make the runtime prove it received the task.", "acceptance_criteria:", "- write changes.patch",
      "", "## Project", "id: proj_1", "name: Artoo", `default_workspace: ${ws}`, "", "## Workspace", `root: ${ws}`, "file_scope:", "- src/**",
      "", "## Policy", "filesystem_write_scope:", `- ${ws}`, "requires_approval:", "- git.push", "", "## Memory", "task_summary: ",
      "project_notes:", "- prefer small patches", "", "## Expected Artifacts", "- changes.patch", "", "## Raw Payload", JSON.stringify(payload, null, 2), ""].join("\n");
    const command = [process.execPath, "-e", "const fs=require('node:fs');console.log(JSON.stringify({path:process.argv[1],text:fs.readFileSync(process.argv[1],'utf8')}));", "{{context_pack_path}}"];
    const adapter = createProcessAdapter({ command, discussionCommand: command,
      reviewCommand: [process.execPath, "-e", "process.exit(53)"], allowedRoots: [ws], artifacts: [] });
    try {
      const events = await drain(adapter.streamEvents(await adapter.start(config)));
      const output = JSON.parse(events.filter(isOutput).filter(event => event.payload.stream === "stdout").map(event => event.payload.text).join(""));
      expect(Buffer.from(output.text).equals(Buffer.from(expected))).toBe(true);
      expect(JSON.parse(output.text.split("\n## Raw Payload\n")[1])).toEqual(payload);
      expect(existsSync(output.path)).toBe(mode === "manual");
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it.each([false, true])("rejects serialized capability authority before writing model context (discussion=%s)", async (discussion) => {
    const ws = realpathSync.native(makeWorkspace()), config = makeConfig(ws), prepared = prepareStaticWebCapabilities({});
    config.runStart.context_pack.payload!.verification_capabilities = { version: 1, profile_id: "profile", profile_digest: `sha256:${"a".repeat(64)}`,
      checks: [{ command_id: "browser", config_digest: prepared.config_digest, contract_digest: prepared.contract_digest, contract: prepared.contract }] };
    if (discussion) config.runStart.context_pack.payload!.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    const adapter = createProcessAdapter({ command: cmd, discussionCommand: cmd, allowedRoots: [ws], artifacts: [] });
    try { await expect(adapter.start(config)).rejects.toThrow(/local binding/); expect(existsSync(join(ws, "context_pack.md"))).toBe(false); }
    finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it("includes the locally bound contract in the first author prompt", async () => {
    const ws = realpathSync.native(makeWorkspace()), config = makeConfig(ws), prepared = prepareStaticWebCapabilities({ viewports: [768, 320] });
    const capabilities = { version: 1 as const, profile_id: "profile", profile_digest: `sha256:${"a".repeat(64)}`,
      checks: [{ command_id: "browser", config_digest: prepared.config_digest, contract_digest: prepared.contract_digest, contract: prepared.contract }] };
    config.runStart.context_pack.payload!.verification_capabilities = capabilities;
    config.runStart.context_pack.payload!.product_development = productDevelopmentContext("research");
    bindWorkspaceToolCapabilities(config, () => capabilities);
    bindWorkspaceToolVerifier(config, async () => { throw new Error("This prompt fixture never invokes verification"); });
    const adapter = createProcessAdapter({ command: cmd, productCommand: cmd, allowedRoots: [ws], artifacts: [] });
    try {
      await drain(adapter.streamEvents(await adapter.start(config)));
      const context = readFileSync(join(ws, "context_pack.md"), "utf8");
      expect(context).toContain('"verification_capabilities"'); expect(context).toContain(capabilities.checks[0]!.config_digest);
      expect(context).toContain('"claim": "configured"'); expect(context).toContain('"screenshots": "final-visible-viewport"');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it("routes only a locally bound peer to the evidence bridge without granting verification", async () => {
    const ws = realpathSync.native(makeWorkspace()), config = makeConfig(ws), digest = `sha256:${"a".repeat(64)}`;
    config.runStart.context_pack.payload!.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    config.runStart.context_pack.payload!.review_subject = { version: 1, task_id: "author_task", run_id: "author", evidence_id: "evidence", subject_digest: digest };
    const script = `const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(JSON.parse(process.argv[1]),'utf8'));(async()=>{const send=async(tool)=>{const r=await fetch(c.url,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify(tool)});return {status:r.status,body:await r.json()}};console.log(JSON.stringify({read:await send({tool:'read_evidence',reference:'browser_granted'}),verify:await send({tool:'verify'}),tools:c.tools}));})();`;
    const adapter = createProcessAdapter({ command: cmd, discussionCommand: [process.execPath, "-e", "console.log('ordinary discussion')"],
      reviewCommand: [process.execPath, "-e", script, "{{workspace_tools_config_json}}"], allowedRoots: [ws], artifacts: [] });
    try {
      bindWorkspaceToolEvidenceReader(config, async (reference) => ({ reference, provenance: { requestId: "final", profileId: "profile", profileDigest: digest,
        subjectDigest: digest, checkId: "browser", scope: "final", bundle_id: "browser_granted", manifest_digest: digest }, mime_type: "application/json", text: "actual fixture evidence" }));
      const events = await drain(adapter.streamEvents(await adapter.start(config)));
      const output = JSON.parse(events.filter(isOutput).find((event) => event.payload.stream === "stdout")!.payload.text);
      expect(output).toMatchObject({ read: { status: 200 }, verify: { status: 400 }, tools: ["context", "read_evidence"] });
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it("routes product author diagnostics through the bound broker and JSON-escaped configuration argument", async () => {
    const ws = realpathSync.native(makeWorkspace()), config = makeConfig(ws);
    config.runStart.context_pack.payload!.product_development = productDevelopmentContext("research");
    const digest = `sha256:${"a".repeat(64)}`;
    const verify = vi.fn(async () => ({ version: 1 as const, request_id: "preview_fixture", profile_id: "protected",
      profile_digest: digest, subject_digest: digest, outcome: "failed" as const, checks: [], required_files: [], reason: "Actual fixture diagnostic" }));
    const script = `const fs=require('node:fs');const path=JSON.parse(process.argv[1]);const c=JSON.parse(fs.readFileSync(path,'utf8'));
      fetch(c.url,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify({tool:'verify'})})
      .then(async r=>{console.log(JSON.stringify({path,status:r.status,result:await r.json()}));process.exitCode=7;});`;
    const adapter = createProcessAdapter({ command: [process.execPath, "-e", "process.exit(51)"],
      productCommand: [process.execPath, "-e", script, "{{workspace_tools_config_json}}"], allowedRoots: [ws], artifacts: [] });
    try {
      await expect(adapter.start(config)).rejects.toThrow(/local verified-run binding/);
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
      bindWorkspaceToolVerifier(config, verify);
      const events = await drain(adapter.streamEvents(await adapter.start(config)));
      const output = JSON.parse(events.filter(isOutput).find((event) => event.payload.stream === "stdout")!.payload.text);
      expect(output).toMatchObject({ status: 200, result: { diagnostic_only: true, verification: { outcome: "failed", reason: "Actual fixture diagnostic" } } });
      expect(verify).toHaveBeenCalledOnce();
      expect(existsSync(output.path)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it.each(["completed", "failed", "cancelled"])("keeps discussion context outside the workspace and cleans it after %s", async (outcome) => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "context_pack.md"), "do not overwrite");
    const config = makeConfig(ws); config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
    config.runStart.context_pack.payload!.policy.filesystem_write_scope = [];
    const script = `const fs=require('node:fs');const path=process.argv[1];console.log(JSON.stringify({path,text:fs.readFileSync(path,'utf8')}));${outcome === "cancelled" ? "setInterval(()=>{},1000)" : `process.exit(${outcome === "failed" ? 2 : 0})`}`;
    const adapter = createProcessAdapter({ command: cmd, discussionCommand: [process.execPath, "-e", script, "{{context_pack_path}}"], allowedRoots: [ws] });
    try {
      const handle = await adapter.start(config);
      let resolveOutput!: () => void;
      const gotOutput = new Promise<void>((resolve) => { resolveOutput = resolve; });
      const events: RunEvent[] = [];
      const complete = (async () => { for await (const event of adapter.streamEvents(handle)) { events.push(event); if (isOutput(event)) resolveOutput(); } })();
      await gotOutput;
      if (outcome === "cancelled") await adapter.stop(handle, "user_cancelled");
      await complete;
      const reported = JSON.parse(events.filter(isOutput).find((event) => event.payload.stream === "stdout")!.payload.text);
      expect(reported.text).toContain("Make the runtime prove it received the task.");
      expect(relative(ws, reported.path).startsWith("..")).toBe(true);
      expect(existsSync(reported.path)).toBe(false);
      expect(readFileSync(join(ws, "context_pack.md"), "utf8")).toBe("do not overwrite");
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: outcome } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
  it("redacts quoted keys in nested JSON error bodies before publishing diagnostics", async () => {
    const ws = makeWorkspace();
    vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", 'sentinel-"private"-\\key');
    try {
      const script = `const key=process.env.ARTOO_CODEX_PROVIDER_KEY; let body=JSON.stringify({api_key:key}); for(let i=0;i<3;i++) body=JSON.stringify({response:body}); process.stderr.write(body); console.log(JSON.stringify({type:'turn.failed',error:{message:'API error body: '+body}})); process.exitCode=1;`;
      const adapter = createProcessAdapter({ command: [process.execPath, "-e", script], outputFormat: "codex-json", allowedRoots: [ws] });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(JSON.stringify(events)).not.toContain("private");
      expect(events.filter(isOutput).every((event) => event.payload.text.includes("[redacted]"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed", reason: expect.stringContaining("[redacted]") } });
    } finally { vi.unstubAllEnvs(); rmSync(ws, { recursive: true, force: true }); }
  });
  it.each(["type", "text"])("keeps the CLI protocol intact when a local key equals %s", async (secret) => {
    const ws = makeWorkspace();
    vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", secret);
    try {
      for (const fail of [false, true]) {
        const script = `const key=process.env.ARTOO_CODEX_PROVIDER_KEY; console.log(JSON.stringify({type:'thread.started',thread_id:key})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Answer '+key}})); ${fail ? "console.log(JSON.stringify({type:'turn.failed',error:{message:'Rejected '+key}})); process.exitCode=1;" : "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));"}`;
        const adapter = createProcessAdapter({ command: [process.execPath, "-e", script], outputFormat: "codex-json", allowedRoots: [ws] });
        const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
        if (fail) expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed", reason: "Rejected [redacted]" } });
        else {
          expect(events).toContainEqual({ type: "run.answer", payload: { text: "Answer [redacted]" } });
          expect(events.find((event) => event.type === "run.usage")).toMatchObject({ payload: { provider_session_id: "[redacted]", input_tokens: 1, output_tokens: 1 } });
          expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
        }
      }
    } finally { vi.unstubAllEnvs(); rmSync(ws, { recursive: true, force: true }); }
  });
  it("runs local provider bootstrap through the ordinary preset with no PATH lookup or global CLI config", async () => {
    const ws = makeWorkspace();
    const entry = join(ws, "fixture-codex.mjs");
    const binary = process.platform === "win32" ? join(ws, "codex.cmd") : entry;
    writeFileSync(entry, `#!${process.execPath}\nconsole.log(JSON.stringify({fixture:true,argv:process.argv.slice(2),hasKey:!!process.env.ARTOO_CODEX_PROVIDER_KEY})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture response'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`);
    if (process.platform === "win32") writeFileSync(binary, '@ECHO off\r\n"%_prog%" "%dp0%\\fixture-codex.mjs" %*\r\n');
    else chmodSync(entry, 0o755);
    vi.stubEnv("PATH", "");
    try {
      for (const authenticated of [false, true]) {
        vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", authenticated ? "isolated-fixture-key" : undefined);
        const registry = buildRegistry(loadConfigFromEnv({ ...process.env, ARTOO_NODE_URL: "ws://127.0.0.1:1/api/v1/node", ARTOO_NODE_ID: "fixture", ARTOO_ALLOWED_ROOTS: ws,
          ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: binary, ARTOO_CODEX_MODEL: "fixture-model", ARTOO_CODEX_PROVIDER_URL: "http://127.0.0.1:18181/v1" }));
        const adapter = registry.resolve("codex")!;
        for (const discussion of [false, true]) {
          const config = makeConfig(ws);
          config.runId += `${authenticated}-${discussion}`;
          if (discussion) config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
          const events = await drain(adapter.streamEvents(await adapter.start(config)));
          expect(events).toContainEqual({ type: "run.answer", payload: { text: "Fixture response" } });
          const invocation = events.filter(isOutput).map((event) => event.payload.text).find((line) => line.startsWith('{"fixture":true'))!;
          const observed = JSON.parse(invocation);
          expect(observed.hasKey).toBe(authenticated);
          expect(observed.argv).toEqual(expect.arrayContaining(["exec", "--json", "--ephemeral", "-s", discussion ? "read-only" : "workspace-write", 'model="fixture-model"', 'model_provider="artoo_desktop"']));
          expect(observed.argv.some((arg: string) => arg.includes("env_key"))).toBe(authenticated);
          expect(JSON.stringify(events)).not.toContain("isolated-fixture-key");
        }
      }
    } finally { vi.unstubAllEnvs(); rmSync(ws, { recursive: true, force: true }); }
  });
  it("redacts the local provider key from split stderr, JSON output, answers and terminal failures", async () => {
    const ws = makeWorkspace();
    const secret = 'sentinel-"private"-key';
    vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", secret);
    try {
      for (const fail of [false, true]) {
        const script = `const key=process.env.ARTOO_CODEX_PROVIDER_KEY; const print=(obj)=>console.log(JSON.stringify(obj).replaceAll('private',String.fromCharCode(92)+'u0070rivate')); process.stderr.write(key.slice(0,9)); setTimeout(()=>{process.stderr.write(key.slice(9)); print({type:'item.completed',item:{type:'agent_message',text:'Answer '+key}}); ${fail ? "print({type:'turn.failed',error:{message:'Rejected '+key}}); process.exitCode=1;" : "print({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});"}},10);`;
        const adapter = createProcessAdapter({ command: [process.execPath, "-e", script], outputFormat: "codex-json", allowedRoots: [ws] });
        const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
        expect(JSON.stringify(events)).not.toContain("private");
        expect(events).toContainEqual({ type: "run.output", payload: { stream: "stderr", text: "[redacted]" } });
        if (fail) expect(events.at(-1)).toMatchObject({ payload: { phase: "failed", reason: "Rejected [redacted]" } });
        else expect(events).toContainEqual({ type: "run.answer", payload: { text: "Answer [redacted]" } });
      }
    } finally { vi.unstubAllEnvs(); rmSync(ws, { recursive: true, force: true }); }
  });
  it("refuses discussion before writing context when the custom runtime has no restricted command", async () => {
    const ws = makeWorkspace();
    try {
      const config = makeConfig(ws);
      config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [ws] });
      await expect(adapter.start(config)).rejects.toThrow("read-only discussion command");
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("selects the restricted discussion command and never publishes stale workspace artifacts", async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "changes.patch"), "stale patch from earlier work");
      const config = makeConfig(ws);
      config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
      const adapter = createProcessAdapter({ command: ["unrestricted-command-must-not-run"],
        discussionCommand: [process.execPath, structuredFixture, "codex"], outputFormat: "codex-json",
        allowedRoots: [ws], artifacts: [{ type: "patch", path: "changes.patch" }] });
      const handle = await adapter.start(config);
      const events = await drain(adapter.streamEvents(handle));
      expect(events.some((event) => event.type === "run.answer")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
      expect(events.some((event) => event.type === "artifact.created")).toBe(false);
      expect(await adapter.collectArtifacts(handle)).toEqual([]);
      expect(readFileSync(join(ws, "changes.patch"), "utf8")).toBe("stale patch from earlier work");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it.each(["codex", "claude"] as const)("extracts the %s final answer and usage from a real JSONL subprocess", async (provider) => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: [process.execPath, structuredFixture, provider],
        outputFormat: provider === "codex" ? "codex-json" : "claude-json", allowedRoots: [ws] });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.filter((event) => event.type === "run.answer")).toEqual([{ type: "run.answer", payload: { text: "已完成你的请求，测试通过。" } }]);
      const usage = events.find((event) => event.type === "run.usage");
      expect(usage).toMatchObject({ payload: { input_tokens: provider === "codex" ? 101 : 91, provider_session_id: `fixture_${provider}` } });
      if (provider === "codex") expect(usage!.payload).not.toHaveProperty("cost_usd");
      else expect(usage!.payload).toHaveProperty("cost_usd", 0.005);
      expect(events.filter(isOutput).some((event) => event.payload.text.includes("Inspecting files"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
      expect(events.findIndex((event) => event.type === "run.answer")).toBeLessThan(events.length - 1);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("fails a provider error result even when the CLI exits zero and preserves reported spend", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: [process.execPath, structuredFixture, "error"], outputFormat: "claude-json", allowedRoots: [ws] });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.some((event) => event.type === "run.answer")).toBe(false);
      expect(events.find((event) => event.type === "run.usage")).toMatchObject({ payload: { cost_usd: 0.002 } });
      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: "Turn limit reached" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it.each(["codex", "claude"] as const)("preserves the %s provider error when its unterminated final record exits nonzero", async (provider) => {
    const ws = makeWorkspace();
    const reason = "API Error: 400 The requested model is not supported.";
    const record = provider === "claude"
      ? { type: "result", subtype: "success", is_error: true, result: reason, total_cost_usd: 0.002 }
      : { type: "turn.failed", error: { message: reason } };
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(record))}); process.exitCode = 1;`],
        outputFormat: provider === "claude" ? "claude-json" : "codex-json", allowedRoots: [ws],
      });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.some((event) => event.type === "run.answer")).toBe(false);
      expect(events.filter((event) => event.type === "run.lifecycle" && event.payload.phase === "failed")).toEqual([
        { type: "run.lifecycle", payload: { phase: "failed", reason } },
      ]);
      if (provider === "claude") expect(events.find((event) => event.type === "run.usage")).toMatchObject({ payload: { cost_usd: 0.002 } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("spawns, streams stdout/stderr, collects the artifact, and completes", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      const events = await drain(adapter.streamEvents(handle));

      expect(events[0]).toEqual({ type: "run.lifecycle", payload: { phase: "started" } });

      const stdout = events.filter(isOutput).filter((e) => e.payload.stream === "stdout").map((e) => e.payload.text);
      expect(stdout).toContain("mock-agent: reading context");
      expect(stdout).toContain("mock-agent: done");
      expect(events.filter(isOutput).some((e) => e.payload.stream === "stderr" && e.payload.text.includes("warning"))).toBe(true);

      const artifact = events.find((e) => e.type === "artifact.created");
      expect(artifact?.payload).toMatchObject({ type: "patch" });

      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });

      // context pack was written into the workspace for the agent
      expect(existsSync(join(ws, "context_pack.md"))).toBe(true);
      const context = readFileSync(join(ws, "context_pack.md"), "utf8");
      expect(context).toContain("Context Pack ctx_1");
      expect(context).toContain("## Task");
      expect(context).toContain("title: Process adapter task");
      expect(context).toContain("- write changes.patch");
      expect(context).toContain("## Raw Payload");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maps a non-zero exit to run.lifecycle failed", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--fail"],
        allowedRoots: [ws]
      });
      const handle = await adapter.start(makeConfig(ws));
      const events = await drain(adapter.streamEvents(handle));
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-scope workspace before spawning", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [join(ws, "allowed")] });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      // nothing was written outside scope
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects a context pack path that escapes the workspace", async () => {
    const ws = makeWorkspace();
    const escapedName = `${basename(ws)}-context_pack.md`;
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        contextPackFilename: `../${escapedName}`
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(ws, "..", escapedName))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(join(ws, "..", escapedName), { force: true });
    }
  });

  it("rejects a junction/symlink that escapes the local workspace root", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    try {
      symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [workspace], contextPackFilename: "escape/context_pack.md" });
      await expect(adapter.start(makeConfig(workspace))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(outside, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects artifact specs that escape the workspace before writing context", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "../escaped.patch" }]
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects spawn failures from start", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: ["artoo-missing-command-for-test"],
        allowedRoots: [ws]
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toThrow();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maps stop to run.lifecycle cancelled without collecting completion artifacts", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [
          process.execPath,
          fixture,
          "--workspace",
          "{{workspace_root}}",
          "--context",
          "{{context_pack_path}}",
          "--sleep-ms",
          "5000"
        ],
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      const eventsPromise = drain(adapter.streamEvents(handle));
      await adapter.stop(handle, "user_cancelled");
      const events = await eventsPromise;

      expect(events.at(-1)).toEqual({
        type: "run.lifecycle",
        payload: { phase: "cancelled", reason: "user_cancelled" }
      });
      expect(events.some((e) => e.type === "artifact.created")).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("collectArtifacts returns the workspace artifact with a checksum", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      await drain(adapter.streamEvents(handle));
      const artifacts = await adapter.collectArtifacts(handle);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.payload.type).toBe("patch");
      expect(artifacts[0]?.payload.checksum).toMatch(/^sha256:/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("closes child stdin so a stdin-reading process does not hang", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--read-stdin"],
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      // The fixture blocks until stdin EOF; if the adapter left stdin open this
      // would never reach a terminal lifecycle (the run would hang).
      const events = await drain(adapter.streamEvents(handle));
      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("physical workspace scope with POSIX symlink resolution", () => {
  function scopeFixture() {
    const owned = realpathSync.native(makeWorkspace());
    const allowed = join(owned, "allowed"), outside = join(owned, "outside");
    mkdirSync(allowed); mkdirSync(join(outside, "nested"), { recursive: true });
    return { owned, allowed, outside };
  }
  const markerCommand = [process.execPath, "-e", "require('node:fs').writeFileSync('spawned.marker', 'spawned\\n')"];

  it.each(["symlink-target-dotdot", "direct-symlink-dotdot", "dangling-context", "dangling-artifact"])(
    "rejects %s before context write or actual child spawn", async (kind) => {
      const { owned, allowed, outside } = scopeFixture();
      try {
        let workspace = allowed;
        if (kind === "symlink-target-dotdot" || kind === "direct-symlink-dotdot") {
          const inner = join(allowed, "inner"); symlinkSync(join(outside, "nested"), inner, "dir");
          if (kind === "symlink-target-dotdot") {
            const outer = join(allowed, "outer"); symlinkSync(inner + "/..", outer, "dir"); workspace = outer;
          } else workspace = inner + "/.."; // Preserve the path the OS receives.
          expect(realpathSync.native(workspace)).toBe(outside);
        } else {
          symlinkSync(join(outside, "new-file.txt"), join(allowed, kind === "dangling-context" ? "context_pack.md" : "changes.patch"));
        }
        const adapter = createProcessAdapter({ command: markerCommand, allowedRoots: [allowed],
          ...(kind === "dangling-artifact" ? { artifacts: [{ type: "patch" as const, path: "changes.patch" }] } : {}) });
        // Assert rejection before invoking the adapter. An unsafe guard must
        // fail this regression without ever starting the fixture command.
        const guardedPath = kind.startsWith("dangling-")
          ? join(allowed, kind === "dangling-context" ? "context_pack.md" : "changes.patch") : workspace;
        expect(() => assertRealWorkspaceScope(guardedPath, [allowed])).toThrow();
        await expect(adapter.start(makeConfig(workspace))).rejects.toBeInstanceOf(Error);
        expect({
          context_inside: existsSync(join(allowed, "context_pack.md")) && kind !== "dangling-context",
          context_outside: existsSync(join(outside, "context_pack.md")),
          dangling_target_written: existsSync(join(outside, "new-file.txt")),
          spawned_inside: existsSync(join(allowed, "spawned.marker")), spawned_outside: existsSync(join(outside, "spawned.marker")),
        }).toEqual({ context_inside: false, context_outside: false, dangling_target_written: false,
          spawned_inside: false, spawned_outside: false });
      } finally { rmSync(owned, { recursive: true, force: true }); }
    });

  it.each(["inside-alias", "existing-dotdot", "allowed-root-alias", "allowed-root-dotdot-alias"])(
    "preserves actual adapter execution for %s", async (kind) => {
      const { owned, allowed, outside } = scopeFixture();
      try {
        const actual = join(allowed, "actual"); mkdirSync(join(actual, "nested"), { recursive: true });
        let workspace = actual, roots = [allowed];
        if (kind === "inside-alias") {
          workspace = join(allowed, "alias"); symlinkSync(actual, workspace, "dir");
        } else if (kind === "existing-dotdot") {
          const inner = join(allowed, "inner"); symlinkSync(join(actual, "nested"), inner, "dir");
          workspace = inner + "/..";
        } else if (kind === "allowed-root-alias") {
          const alias = join(owned, "allowed-alias"); symlinkSync(allowed, alias, "dir");
          workspace = join(alias, "actual"); roots = [alias];
        } else {
          const inner = join(allowed, "inner"); symlinkSync(join(outside, "nested"), inner, "dir");
          workspace = join(allowed, "explicitly-allowed-alias"); symlinkSync(inner + "/..", workspace, "dir");
          roots = [workspace]; // The operator explicitly allows this physical destination.
        }
        const physical = realpathSync.native(workspace);
        const adapter = createProcessAdapter({ command: markerCommand, allowedRoots: roots });
        const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(workspace))));
        expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
        expect(readFileSync(join(physical, "spawned.marker"), "utf8")).toBe("spawned\n");
        expect(readFileSync(join(physical, "context_pack.md"), "utf8")).toContain(`root: ${workspace}`);
      } finally { rmSync(owned, { recursive: true, force: true }); }
    });

  it("allows ordinary missing descendants and relative paths under the actual allowed root", () => {
    const { owned, allowed } = scopeFixture();
    try {
      const alias = join(owned, "allowed-alias"); symlinkSync(allowed, alias, "dir");
      const missing = join(alias, "new", "nested", "worktree");
      expect(() => assertRealWorkspaceScope(missing, [alias])).not.toThrow();
      expect(() => assertRealWorkspaceScope(relative(process.cwd(), missing), [relative(process.cwd(), alias)])).not.toThrow();
      expect(existsSync(join(allowed, "new"))).toBe(false);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it("resolves existing symlink and dotdot ancestors before checking missing worktree descendants", () => {
    const { owned, allowed, outside } = scopeFixture();
    try {
      const inner = join(allowed, "inner"); symlinkSync(join(outside, "nested"), inner, "dir");
      const outer = join(allowed, "outer"); symlinkSync(inner + "/..", outer, "dir");
      for (const target of [outer + "/new/worktree", inner + "/../new/worktree"])
        expect(() => assertRealWorkspaceScope(target, [allowed])).toThrow();
      mkdirSync(join(allowed, "existing"));
      expect(() => assertRealWorkspaceScope(allowed + "/existing/../new/worktree", [allowed])).not.toThrow();
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it("does not normalize a nonexistent traversal, a non-directory or a symlink loop into an allowed path", () => {
    const { owned, allowed } = scopeFixture();
    try {
      writeFileSync(join(allowed, "file"), "not a directory");
      symlinkSync("loop", join(allowed, "loop"));
      for (const target of [allowed + "/missing/../new", join(allowed, "file", "child"), join(allowed, "loop", "child")])
        expect(() => assertRealWorkspaceScope(target, [allowed])).toThrow();
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });
});
