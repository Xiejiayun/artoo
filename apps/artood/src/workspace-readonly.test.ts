import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPack } from "@artoo/domain";
import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { bindWorkspaceReadOnlyTools, takeWorkspaceReadOnlyTools, type WorkspaceReadOnlyGrant } from "./workspace-readonly.js";
import { createWorkspaceToolSession, type WorkspaceToolSession, type WorkspaceToolSessionOptions } from "./workspace-tools.js";
import { prepareVerificationProfiles, subjectManifest } from "./verification.js";
import * as processAdapter from "./process-adapter.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";

const roots: string[] = [], sessions: WorkspaceToolSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-readonly-test-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const context: ContextPack = { task: { id: "task", title: "Plan", description: "Read the complete request", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } };
  const config: AgentInstanceConfig = { runId: "run", taskId: "task", agentInstanceId: "agent", runtime: "codex", workspaceRoot: workspace,
    runStart: { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "codex", workspace: { root: workspace },
      context_pack: { id: "context", payload: context }, policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] } } };
  const binding = { projectId: "project", workspaceRoot: workspace, assertCurrent: () => {} };
  function source(subjects = ["product", ".artoo/product"]) {
    mkdirSync(join(workspace, "product", "nested"), { recursive: true }); mkdirSync(join(workspace, ".artoo", "product"), { recursive: true });
    writeFileSync(join(workspace, "product", "nested", "index.html"), "完整需求🌱".repeat(16));
    writeFileSync(join(workspace, "product", "ungranted.txt"), "Sibling outside an individual-file profile");
    writeFileSync(join(workspace, ".artoo", "product", "design.json"), "{\"design\":true}");
    writeFileSync(join(workspace, "private.txt"), "Outside product roots");
    // Controlled trust-file fixture: profile preparation measures it; no command is executed.
    const verifier = join(root, "controlled-verifier.fixture"); writeFileSync(verifier, "not an executable product verifier");
    const profile = prepareVerificationProfiles([{ id: "profile", project_id: "project", workspace_root: workspace,
      commands: [{ id: "fixture", argv: [verifier], timeout_ms: 1000 }], required_files: [], subject_paths: subjects }])[0]!;
    const subjectDigest = subjectManifest(profile).digest;
    config.runStart.verification = { version: 1, request_id: "review-request", profile_id: profile.id, expected_subject_digest: subjectDigest };
    context.review_subject = { version: 1, task_id: "author", run_id: "author-run", evidence_id: "evidence", subject_digest: subjectDigest };
    return { profile, subjectDigest };
  }
  function grant(pinnedSource?: ReturnType<typeof source>) {
    bindWorkspaceReadOnlyTools(config, { ...binding, ...(pinnedSource ? { source: pinnedSource } : {}) }); return takeWorkspaceReadOnlyTools(config)!;
  }
  async function start(readOnlyGrant: WorkspaceReadOnlyGrant, extra: Partial<WorkspaceToolSessionOptions> = {}) {
    const session = await createWorkspaceToolSession({ workspaceRoot: workspace, context, contextText: "完整上下文🌱 End", readOnlyGrant, ...extra }); sessions.push(session);
    const broker = JSON.parse(readFileSync(session.configPath, "utf8"));
    const send = async (input: unknown) => {
      const response = await fetch(broker.url, { method: "POST", headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() as any };
    };
    return { session, broker, send };
  }
  return { root, workspace, context, config, binding, source, grant, start };
}

describe("node-bound read-only context and source tools", () => {
  it("pages the fixed planning context and grants no filesystem, execution or research tool", async () => {
    const f = fixture(), { broker, send } = await f.start(f.grant());
    expect(broker.tools).toEqual(["context"]);
    let text = "", offset = 0, checksum: string | undefined;
    for (let count = 0; count < 20; count++) {
      const response = await send({ tool: "context", offset, limit: 4, ...(checksum ? { expected_checksum: checksum } : {}) });
      expect(response.status).toBe(200); checksum ??= response.body.checksum; expect(response.body.checksum).toBe(checksum);
      text += response.body.content; if (response.body.eof) break; offset = response.body.next_offset;
    }
    expect(text).toBe("完整上下文🌱 End");
    for (const request of [{ tool: "list", path: "product" }, { tool: "read", path: "private.txt" }, { tool: "verify" },
      { tool: "write", path: "product/no.txt", content: "no", expected_checksum: null }, { tool: "read_evidence", reference: "ungranted" }]) {
      expect((await send(request)).status).toBe(400);
    }
  });

  it("requires exact local config identity and a one-use uncloneable grant", async () => {
    const f = fixture(); bindWorkspaceReadOnlyTools(f.config, f.binding);
    expect(takeWorkspaceReadOnlyTools(structuredClone(f.config))).toBeUndefined();
    const grant = takeWorkspaceReadOnlyTools(f.config)!;
    expect(takeWorkspaceReadOnlyTools(f.config)).toBeUndefined();
    expect(() => bindWorkspaceReadOnlyTools(f.config, f.binding)).toThrow(/binding/);
    await expect(f.start(structuredClone(grant))).rejects.toThrow(/fresh local/);
    await f.start(grant);
    await expect(f.start(grant)).rejects.toThrow(/fresh local/);
  });

  it.each(["run", "task", "agent", "runtime", "project", "request"])("rejects changed %s binding before returning context", async (field) => {
    const f = fixture(), { send } = await f.start(f.grant());
    if (field === "run") f.config.runId = "other";
    if (field === "task") f.config.taskId = "other";
    if (field === "agent") f.config.agentInstanceId = "other";
    if (field === "runtime") f.config.runtime = "other";
    if (field === "project") f.context.project.id = "other";
    if (field === "request") f.context.task.description = "different requirement";
    expect((await send({ tool: "context" })).status).toBe(400);
  });

  it("requires synchronous local lifetime checks and rejects revoked runs", async () => {
    const f = fixture();
    expect(() => bindWorkspaceReadOnlyTools(f.config, { ...f.binding, assertCurrent: async () => {} })).toThrow(/synchronously/);
    let active = true;
    bindWorkspaceReadOnlyTools(f.config, { ...f.binding, assertCurrent: () => { if (!active) throw new Error("Run closed"); } });
    const { send } = await f.start(takeWorkspaceReadOnlyTools(f.config)!); active = false;
    expect((await send({ tool: "context" })).body.error).toContain("Run closed");
  });

  it("lists only pinned files and their ancestors and reads their exact bytes", async () => {
    const f = fixture(), source = f.source(["product/nested/index.html", ".artoo/product/design.json", "private.txt"]);
    const { send, broker } = await f.start(f.grant(source));
    expect(broker.tools).toEqual(["context", "list", "read"]);
    expect((await send({ tool: "list", path: "product" })).body.entries).toEqual([{ name: "nested", kind: "directory" }]);
    expect((await send({ tool: "list", path: "product/nested" })).body.entries).toEqual([{ name: "index.html", kind: "file", size: Buffer.byteLength("完整需求🌱".repeat(16)) }]);
    const read = await send({ tool: "read", path: "product/nested/index.html", offset: 0, limit: 4 });
    expect(read.status).toBe(200); expect(read.body.checksum).toBe(sha("完整需求🌱".repeat(16)));
    for (const path of ["product/ungranted.txt", "private.txt", "../private.txt", ".artoo/product/../../private.txt"]) {
      expect((await send({ tool: "read", path })).status).toBe(400);
    }
    expect((await send({ tool: "list", path: ".artoo" })).status).toBe(400);
    expect((await send({ tool: "verify" })).status).toBe(400);
  });

  it("rejects all later source/context reads after a source mutation, including a paged continuation", async () => {
    const f = fixture(), { send } = await f.start(f.grant(f.source()));
    const first = await send({ tool: "read", path: "product/nested/index.html", offset: 0, limit: 4 });
    writeFileSync(join(f.workspace, "product", "nested", "index.html"), "changed");
    for (const request of [{ tool: "context" }, { tool: "list", path: "product" },
      { tool: "read", path: "product/nested/index.html", offset: first.body.next_offset, expected_checksum: first.body.checksum }]) {
      expect((await send(request)).status).toBe(400);
    }
  });

  it("rechecks pinned source after asynchronous evidence retrieval before emitting a response", async () => {
    const f = fixture(), source = f.source();
    const readEvidence = vi.fn(async () => {
      writeFileSync(join(f.workspace, "product", "nested", "index.html"), "changed during evidence read");
      return { reference: "fixture", mime_type: "application/json" as const, text: "{}",
        provenance: { requestId: "fixture", profileId: "profile", profileDigest: sha("profile"), subjectDigest: source.subjectDigest,
          checkId: "fixture", scope: "final" as const, bundle_id: "fixture", manifest_digest: sha("manifest") } };
    });
    const { send } = await f.start(f.grant(source), { readEvidence });
    expect((await send({ tool: "read_evidence", reference: "fixture" })).status).toBe(400); expect(readEvidence).toHaveBeenCalledOnce();
  });

  it("rejects a replaced physical workspace and a changed session context", async () => {
    const f = fixture(), grant = f.grant();
    await expect(f.start(grant, { context: { ...f.context, task: { ...f.context.task, description: "other" } } })).rejects.toThrow(/fresh local/);
    const { send } = await f.start(grant);
    renameSync(f.workspace, join(f.root, "previous-workspace")); mkdirSync(f.workspace);
    expect((await send({ tool: "context" })).status).toBe(400);
  });

  it("does not derive source authority from serialized profiles or review metadata", async () => {
    const f = fixture(), source = f.source();
    expect(() => f.grant({ ...source, profile: structuredClone(source.profile) })).toThrow(/locally prepared/);
    expect(() => f.grant()).toThrow(/requires a local source binding/);
    f.config.runStart.verification!.expected_subject_digest = sha("other");
    expect(() => f.grant(source)).toThrow(/admitted review/);
    f.config.runStart.verification!.expected_subject_digest = source.subjectDigest;
    f.context.review_subject!.subject_digest = sha("other");
    expect(() => f.grant(source)).toThrow(/admitted review/);
    await expect(createWorkspaceToolSession({ workspaceRoot: f.workspace, context: f.context, contextText: "JSON-only" })).rejects.toThrow(/authority/);
  });

  it.each(["verify", "research", "evidenceOnly"])("cannot combine a local read-only grant with %s authority", async (kind) => {
    const f = fixture(), extra = kind === "verify" ? { verify: async () => { throw new Error("Not granted"); } }
      : kind === "research" ? { researchMcpPath: "not-granted" } : { evidenceOnly: true };
    await expect(f.start(f.grant(), extra)).rejects.toThrow(/authority/);
  });
});

describe("read-only preset selection", () => {
  it("uses only scoped MCP reads without changing manual commands or CLI approval/sandbox policy", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      for (const preset of [codexRuntime, claudeCodeRuntime]) {
        const runtime = preset({ allowedRoots: ["/workspace"] }), options = create.mock.calls.at(-1)![0], command = options.readOnlyCommand!;
        expect(processAdapter.supportsWorkspaceReadOnlyTools(runtime.adapter)).toBe(true);
        expect(processAdapter.supportsWorkspaceReadOnlyTools({ ...runtime.adapter })).toBe(false);
        expect(command.find(arg => arg.startsWith("First call mcp__artoo_workspace__context"))).toContain("Do not use shell, network, filesystem edits or verification commands");
        expect(options.discussionCommand!.join(" ")).toContain("Read the file {{context_pack_path}}");
        if (runtime.runtime === "codex") {
          expect(command[command.indexOf("-s") + 1]).toBe("read-only");
          expect(command).toContain('mcp_servers.artoo_workspace.enabled_tools=["context","list","read","read_evidence"]');
          expect(command).not.toContain('mcp_servers.artoo_workspace.tools.verify.approval_mode="approve"');
          expect(command.join(" ")).not.toContain("dangerously-bypass");
        } else {
          expect(command[command.indexOf("--tools") + 1]).toBe("");
          expect(command[command.indexOf("--permission-mode") + 1]).toBe("dontAsk");
          expect(command[command.indexOf("--allowedTools") + 1]).toBe("mcp__artoo_workspace__context,mcp__artoo_workspace__list,mcp__artoo_workspace__read,mcp__artoo_workspace__read_evidence");
        }
        preset({ allowedRoots: ["/workspace"], command: ["custom"], discussionCommand: ["custom-read"] });
        expect(create.mock.calls.at(-1)![0].readOnlyCommand).toBeUndefined();
      }
    } finally { create.mockRestore(); }
  });

  it("selects the broker only for a local grant and closes the actual native fixture process", async () => {
    const f = fixture();
    const script = "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(JSON.parse(process.argv[1]),'utf8'));" +
      "fetch(c.url,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify({tool:'context'})})" +
      ".then(async r=>{if(r.status!==200)throw Error('context rejected');console.log(JSON.stringify({tools:c.tools,body:await r.json()}))})" +
      ".catch(e=>{console.error(e);process.exitCode=1});";
    const adapter = processAdapter.createProcessAdapter({ runtimeId: "codex", allowedRoots: [f.workspace], artifacts: [],
      command: [process.execPath, "-e", "throw Error('ordinary command unexpected')"],
      discussionCommand: [process.execPath, "-e", "console.log('LEGACY_DISCUSSION')"],
      readOnlyCommand: [process.execPath, "-e", script, "{{workspace_tools_config_json}}"] });
    const collect = async (config: AgentInstanceConfig) => {
      const handle = await adapter.start(config), events: RunEvent[] = [];
      for await (const event of adapter.streamEvents(handle)) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
      return JSON.stringify(events);
    };
    expect(await collect(f.config)).toContain("LEGACY_DISCUSSION");
    const granted = structuredClone(f.config); granted.runId = granted.runStart.run_id = "granted";
    bindWorkspaceReadOnlyTools(granted, f.binding);
    const output = await collect(granted);
    expect(output).toContain("Read the complete request"); expect(output).toContain('\\"tools\\":[\\"context\\"]');
    expect(output).not.toContain("LEGACY_DISCUSSION");
  });
});
