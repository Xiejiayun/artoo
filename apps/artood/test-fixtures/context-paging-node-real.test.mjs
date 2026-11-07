// Production node + process adapter + rendered context + real MCP subprocess.
// The author and research receipt are explicit deterministic fixtures, not a provider acceptance run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ContextPackSchema, productDevelopmentContext } from "@artoo/domain";
import { createNodeClient } from "../dist/node-client.js";
import { createProcessAdapter } from "../dist/process-adapter.js";
import { prepareVerificationProfiles, readVerificationCapabilities, subjectManifest, verificationSupported } from "../dist/verification.js";

const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
test("the node's complete compact context reaches an author over paged MCP before preview and final verification", {
  skip: !verificationSupported(), timeout: 60000,
}, async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-context-node-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), receipts = join(root, "receipts");
  for (const path of [workspace, evidence, receipts]) mkdirSync(path);
  const browserConfig = join(root, "browser.json"), marker = join(root, "invocations.jsonl"), probe = join(root, "probe.mjs");
  writeFileSync(browserConfig, JSON.stringify({ evidence_root: evidence, viewports: [390], design_capture_cases: true }));
  writeFileSync(probe, `import{appendFileSync,readFileSync}from'node:fs';
const path=process.env.ARTOO_VERIFICATION_CONTEXT_FILE,c=JSON.parse(readFileSync(path,'utf8'));
appendFileSync(${JSON.stringify(marker)},JSON.stringify({request_id:c.request_id,profile_digest:c.profile_digest,context_file:path,pid:process.pid})+'\\n');`);
  const [profile] = prepareVerificationProfiles([{ id: "acceptance", project_id: "project", workspace_root: workspace,
    measurement_plan_policy: { version: 1, coverage: "every-must-criterion" }, required_files: [], subject_paths: ["product", ".artoo/product"],
    commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), browserConfig], timeout_ms: 10000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } },
    { id: "probe", argv: [process.execPath, probe], timeout_ms: 10000 }] }]);
  const capabilities = readVerificationCapabilities(profile);
  const source = { version: 1, id: "source_11111111111111111111111111111111", url: "https://example.com/controlled-context",
    title: "Controlled receipt fixture; no network request", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled source bytes"),
    media_type: "text/plain", bytes: Buffer.byteLength("controlled source bytes"), text: "controlled source bytes",
    content_base64: Buffer.from("controlled source bytes").toString("base64"),
    binding: { runId: "author", taskId: "task", projectId: "project", goalId: "goal", workspaceRoot: workspace } };
  writeFileSync(join(receipts, source.id + ".json"), JSON.stringify(source));
  const context = { task: { id: "task", title: "Controlled paged research", description: "Read the exact full node context", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] },
    memory: { task_summary: null, project_notes: ["有界上下文🌱".repeat(1800), "上下文末尾🌱"] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal", objective: "Controlled transport fixture", acceptance_criteria: [], plan: null },
    product_development: { ...productDevelopmentContext("research", capabilities), accepted_inputs: { version: 1, files: [] } },
    verification_capabilities: capabilities };
  const events = []; let send, stopped = false;
  const adapter = createProcessAdapter({ runtimeId: "fixture", allowedRoots: [workspace], artifacts: [], outputFormat: "plain",
    research: { receiptDirectory: receipts }, command: [process.execPath, "-e", "process.exit(51)"],
    productCommand: [process.execPath, fileURLToPath(new URL("./context-paging-author.mjs", import.meta.url)),
      fileURLToPath(new URL("../dist/workspace-tools-mcp.js", import.meta.url)), "{{workspace_tools_config_path}}"] });
  const client = createNodeClient({ nodeId: "node", adapter, verificationProfiles: [profile],
    transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } } });
  try {
    client.start(); send({ kind: "command", id: "start", idempotency_key: "author:start", type: "run.start", payload: {
      run_id: "author", task_id: "task", agent_instance_id: "instance", runtime: "fixture", workspace: { root: workspace },
      context_pack: { id: "context", payload: context }, policy_snapshot: context.policy, artifact_rules: { paths: [] },
      verification: { version: 1, profile_id: profile.id, request_id: "context-final", capability_binding: { version: 1, profile_digest: profile.digest,
        checks: capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) } } } });
    const deadline = Date.now() + 45000;
    let terminal;
    while (!(terminal = events.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
      && ["completed", "cancelled", "failed"].includes(message.event.payload.phase)))) {
      assert.equal(events.some(message => message.kind === "command.ack" && message.status === "rejected"), false, JSON.stringify(events));
      assert.ok(Date.now() < deadline, "Context node fixture did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(terminal.event.payload.phase, "completed", JSON.stringify(events));
    const output = events.filter(message => message.kind === "run.event" && message.event.type === "run.output" && message.event.payload.stream === "stdout")
      .map(message => message.event.payload.text).join("");
    const facts = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(item => item.context_paging_fixture)?.context_paging_fixture;
    assert.ok(facts); assert.ok(facts.pages > 10); assert.equal(facts.task_id, "task"); assert.equal(facts.run_present, true);
    assert.equal(facts.profile_digest, profile.digest);
    const rendered = readFileSync(join(workspace, "context_pack.md"));
    // The verified node snapshots through the existing schema, which orders JSON keys.
    const admittedContext = ContextPackSchema.parse(context); assert.deepEqual(admittedContext, context);
    const compact = `# Context Pack context\ntask: task\nrun: author\n\n## Raw Payload\n${JSON.stringify(admittedContext)}\n`;
    assert.equal(facts.context_text, compact);
    assert.equal(facts.checksum, sha(compact)); assert.equal(facts.size, Buffer.byteLength(compact));
    assert.deepEqual(JSON.parse(facts.context_text.split("\n## Raw Payload\n")[1]), context);
    const legacy = ["# Context Pack context", "task: task", "run: author", "", "## Task", "id: task", "title: Controlled paged research",
      "description: Read the exact full node context", "acceptance_criteria:", "", "## Project", "id: project", "name: Fixture",
      `default_workspace: ${workspace}`, "", "## Workspace", `root: ${workspace}`, "file_scope:", "", "## Policy", "filesystem_write_scope:",
      `- ${workspace}`, "requires_approval:", "", "## Memory", "task_summary: ", "project_notes:",
      ...context.memory.project_notes.map(note => `- ${note}`), "", "## Expected Artifacts", "", "## Raw Payload", JSON.stringify(admittedContext, null, 2), ""].join("\n");
    assert.deepEqual(rendered, Buffer.from(legacy));
    assert.deepEqual(JSON.parse(rendered.toString("utf8").split("\n## Raw Payload\n")[1]), context);
    assert.ok(rendered.length > facts.size);
    const final = events.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
    assert.equal(final?.outcome, "passed", final?.reason); assert.equal(final.request_id, "context-final");
    assert.equal(final.profile_digest, profile.digest); assert.equal(final.subject_digest, subjectManifest(profile).digest);
    assert.equal(final.measurement_plan.scope, "final"); assert.equal(facts.preview.measurement_plan.scope, "preview");
    assert.notEqual(final.request_id, facts.preview.request_id); assert.equal(final.subject_digest, facts.preview.subject_digest);
    assert.deepEqual(final.checks.map(check => check.exit_code), [0, 0]);
    await client.stop(true); stopped = true;
    for (const pid of [facts.author_pid, facts.mcp_pid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const invocations = readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(invocations.map(record => record.request_id), [facts.preview.request_id, "context-final"]);
    for (const record of invocations) {
      assert.equal(record.profile_digest, profile.digest);
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(-record.pid, 0), { code: "ESRCH" });
      assert.equal(existsSync(record.context_file), false);
    }
    assert.equal(realpathSync.native(root), root); rmSync(root, { recursive: true });
  } finally {
    if (!stopped) await client.stop(true);
    if (existsSync(root)) console.error(`Failed context fixture retained for diagnosis: ${root}`);
  }
});
