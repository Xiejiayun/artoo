import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createResearchSession, prepareResearchOptions, readResearchReceipt } from "../dist/research.js";
import { initializeEmptyProductRepository } from "../dist/product-bootstrap.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artoo-research-real-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const options = prepareResearchOptions({ receiptDirectory: join(root, "receipts") }, [workspace]);
  const binding = { projectId: "fixture-project", goalId: "fixture-goal", taskId: "fixture-task", runId: "fixture-run", workspaceRoot: workspace };
  return { root, workspace, options, binding, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("real MCP subprocess connects to node broker and cannot fetch private addresses", { timeout: 15000 }, async () => {
  const f = fixture(), session = await createResearchSession(f.options, f.binding);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/research-mcp.js", import.meta.url)), session.configPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const records = [], pending = new Map(); let output = "", errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      for (;;) { const newline = output.indexOf("\n"); if (newline < 0) break;
        const record = JSON.parse(output.slice(0, newline)); output = output.slice(newline + 1); records.push(record);
        pending.get(record.id)?.(record); pending.delete(record.id);
      }
    });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}: ${errors}`))); });
    const call = (id, method, params) => new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const initialized = await call(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "artoo-fixture", version: "1" } });
    assert.equal(initialized.result.serverInfo.name, "artoo-research");
    const tools = await call(2, "tools/list", {}); assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["fetch", "search"]);
    const denied = await call(3, "tools/call", { name: "fetch", arguments: { url: "https://127.0.0.1/" } });
    assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /private or reserved/);
    assert.equal(session.receipts().length, 0); child.stdin.end(); await closed;
  } finally { child?.kill(); await session.close(); f.close(); }
});

test("real empty repository bootstrap and replay preserve product files", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = fixture();
  try {
    assert.equal(await initializeEmptyProductRepository(f.workspace, "/usr/bin/git"), "created");
    writeFileSync(join(f.workspace, "product", "index.html"), "<h1>Journal</h1>");
    assert.equal(await initializeEmptyProductRepository(f.workspace, "/usr/bin/git"), "existing");
    assert.equal(readFileSync(join(f.workspace, "product", "index.html"), "utf8"), "<h1>Journal</h1>");
  } finally { f.close(); }
});

test("live public source produces a restart-readable content-bound receipt", { skip: !process.env.ARTOO_LIVE_RESEARCH_URL, timeout: 25000 }, async () => {
  const f = fixture(), session = await createResearchSession(f.options, f.binding);
  try {
    const config = JSON.parse(readFileSync(session.configPath, "utf8"));
    const response = await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ tool: "fetch", url: process.env.ARTOO_LIVE_RESEARCH_URL }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.match(result.content_digest, /^sha256:[a-f0-9]{64}$/); assert.ok(result.bytes > 0);
    await session.close();
    const persisted = readResearchReceipt(f.options, result.id, f.binding); assert.equal(persisted.content_digest, result.content_digest);
    assert.ok(Buffer.from(persisted.content_base64, "base64").length > 0);
  } finally { await session.close(); f.close(); }
});
