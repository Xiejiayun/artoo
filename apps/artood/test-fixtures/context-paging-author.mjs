// Deterministic transport author. This is not a model or live research fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mcpScript, brokerConfig] = process.argv.slice(2);
const child = spawn(process.execPath, [mcpScript, brokerConfig], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map(); let nextId = 0, closed = false, stderr = "";
child.stderr.setEncoding("utf8"); child.stderr.on("data", text => { stderr += text; });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", line => {
  const message = JSON.parse(line), operation = pending.get(message.id);
  if (operation) { pending.delete(message.id); operation.resolve(message); }
});
const exit = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    closed = true;
    for (const operation of pending.values()) operation.reject(new Error(`MCP closed ${code}/${signal}: ${stderr}`));
    pending.clear(); resolve({ code, signal });
  });
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
}
async function call(name, args = {}) {
  const message = await request("tools/call", { name, arguments: args });
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.notEqual(message.result.isError, true, JSON.stringify(message.result));
  return JSON.parse(message.result.content[0].text);
}
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let facts;
try {
  await request("initialize", {});
  const pages = []; let offset = 0, checksum, size;
  for (;;) {
    const page = await call("context", { offset, limit: 4096, ...(checksum ? { expected_checksum: checksum } : {}) });
    assert.equal(page.version, 1); assert.equal(page.format, "artoo-context-text-page.v1");
    if (checksum) { assert.equal(page.checksum, checksum); assert.equal(page.size, size); }
    else { checksum = page.checksum; size = page.size; }
    assert.equal(page.offset, offset); assert.equal(page.verification_capabilities, undefined);
    assert.ok(Buffer.byteLength(page.content) <= 4096);
    pages.push(page.content);
    if (page.eof) { assert.equal(page.next_offset, null); break; }
    assert.equal(page.next_offset, offset + Buffer.byteLength(page.content));
    offset = page.next_offset; assert.ok(pages.length < 100);
  }
  const text = pages.join(""); assert.equal(sha(text), checksum); assert.equal(Buffer.byteLength(text), size);
  const context = JSON.parse(text.split("\n## Raw Payload\n")[1]);
  assert.equal(context.task.id, "task"); assert.equal(context.goal_context.goal_id, "goal");
  assert.equal(context.product_development.stage, "research");
  assert.deepEqual(context.product_development.accepted_inputs, { version: 1, files: [] });
  assert.ok(context.product_development.instructions.some(value => value.includes("objective") && value.includes("findings")));
  assert.ok(context.product_development.instructions.some(value => value.includes("measurement_plan")));
  assert.equal(context.memory.project_notes.at(-1), "上下文末尾🌱");
  const capabilities = context.verification_capabilities, check = capabilities.checks[0];
  assert.deepEqual(capabilities.measurement_plan_policy, { version: 1, coverage: "every-must-criterion" });
  const source = { id: "source_11111111111111111111111111111111", url: "https://example.com/controlled-context",
    title: "Controlled receipt fixture; no network request", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled source bytes") };
  const research = { version: 1, objective: context.task.description, assumptions: [],
    requirements: [{ id: "save", description: "Visible saved content", priority: "must", acceptance_criteria: ["Show saved content"] }],
    sources: [source], findings: [{ summary: "Controlled handoff transport", source_ids: [source.id] }], decisions: [],
    measurement_plan: { version: 1, profile_digest: capabilities.profile_digest, entries: [{
      requirement_id: "save", criterion_index: 0, command_id: check.command_id, config_digest: check.config_digest,
      contract_digest: check.contract_digest, actions: ["navigate", "assert_text"], keys: [], viewports: check.contract.viewports, needs: [] }] } };
  await call("mkdir", { path: ".artoo/product" });
  await call("mkdir", { path: "product" });
  await call("write", { path: ".artoo/product/research.json", content: JSON.stringify(research), expected_checksum: null });
  const preview = await call("verify"); assert.equal(preview.diagnostic_only, true);
  assert.equal(preview.verification.outcome, "passed", preview.verification.reason);
  assert.equal(preview.verification.measurement_plan.scope, "preview");
  facts = { checksum, size, pages: pages.length, context_text: text, task_id: context.task.id, run_present: text.includes("run: author"),
    profile_digest: capabilities.profile_digest, preview: preview.verification, mcp_pid: child.pid, author_pid: process.pid };
} finally {
  child.stdin.end();
  const timeout = setTimeout(() => { if (!closed) child.kill(); }, 5000);
  try { const result = await exit; assert.deepEqual(result, { code: 0, signal: null }); }
  finally { clearTimeout(timeout); lines.close(); }
}
console.log(JSON.stringify({ context_paging_fixture: facts }));
