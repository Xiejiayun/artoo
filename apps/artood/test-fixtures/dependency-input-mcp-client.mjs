// Controlled Provider stand-in. Reads artifact bytes only through the actual
// MCP process and broker, never through the private snapshot filesystem paths.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const child = spawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: ["pipe", "pipe", "pipe"] });
const closed = once(child, "close");
const pending = new Map();
let id = 0,
  errors = "";
child.stderr.on("data", (chunk) => {
  errors += chunk;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const response = JSON.parse(line),
    waiter = pending.get(response.id);
  if (waiter) {
    pending.delete(response.id);
    waiter(response);
  }
});
const call = (method, params) =>
  new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
  });
const tool = (name, args = {}) => call("tools/call", { name, arguments: args });
const body = (response) => {
  if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 60_000);
try {
  const tools = (await call("tools/list")).result.tools.map((entry) => entry.name);
  let context = "",
    offset = 0,
    contextChecksum;
  for (;;) {
    const page = body(
      await tool("context", { offset, limit: 4096, ...(offset ? { expected_checksum: contextChecksum } : {}) }),
    );
    contextChecksum ??= page.checksum;
    if (contextChecksum !== page.checksum) throw new Error("Context checksum changed");
    context += page.content;
    if (page.eof) break;
    offset = page.next_offset;
  }
  const [input] = JSON.parse(context.slice(context.lastIndexOf("\n[") + 1));
  const chunks = [],
    pages = [];
  offset = 0;
  for (;;) {
    const page = body(
      await tool("read_input", { reference: input.reference, offset, limit: 4096, expected_checksum: input.checksum }),
    );
    if (page.checksum !== input.checksum || page.artifact_id !== input.id || page.source_run_id !== input.run_id)
      throw new Error("Frozen provenance changed");
    const bytes = Buffer.from(page.content, page.encoding === "base64" ? "base64" : "utf8");
    if (bytes.length > 4096) throw new Error("Unbounded input page");
    chunks.push(bytes);
    pages.push({ offset: page.offset, eof: page.eof, checksum: page.checksum });
    if (page.eof) break;
    offset = page.next_offset;
  }
  const denied = [];
  for (const [name, args] of [
    ["read_input", { reference: "dependency_input_999" }],
    ["read_input", { reference: input.path }],
    ["read_input", { reference: input.reference, path: input.path }],
    ["read_input", { reference: input.reference, offset: 1 }],
    ["read_input", { reference: input.reference, expected_checksum: `sha256:${"0".repeat(64)}` }],
    ["read", { path: "product/secret.txt" }],
    ["verify", {}],
    ["read_evidence", { reference: input.reference }],
  ]) {
    const response = await tool(name, args);
    denied.push(!!response.error || response.result?.isError === true);
  }
  child.stdin.end();
  const [code, signal] = await closed;
  if (code !== 0 || signal !== null || errors) throw new Error(`MCP failed closure ${code}/${signal}: ${errors}`);
  console.log(
    JSON.stringify({
      tools,
      configuredTools: config.tools,
      bytes: Buffer.concat(chunks).toString("hex"),
      pages,
      denied,
      mcpClosed: true,
      snapshotPath: input.path,
    }),
  );
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await closed;
  }
  lines.close();
}
