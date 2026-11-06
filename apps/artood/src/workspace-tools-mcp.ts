import { lstatSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const pathProperty = { type: "string", minLength: 1, maxLength: 1024 };
const checksumProperty = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const workspaceToolDefinitions = [
  tool("context", "Read the fixed task context and stage instructions. Start with offset:0 and limit:4096, then follow next_offset with the first full-text checksum as expected_checksum until eof:true. Join content from artoo-context-text-page.v1 pages in order; these are UTF-8 bytes of the fixed context text, including its entire Raw Payload, not pages of the legacy JSON response. Never infer omitted stage/schema instructions from a partial response. If a page is visibly truncated, repeat it with a smaller valid limit. Pages have a separate bounded 4096-request allowance; ordinary tools retain their 1024-request allowance. With no arguments this tool retains its complete legacy response. No model-selected host path is accepted.",
    { offset: { type: "integer", minimum: 0, maximum: 8 * 1024 * 1024, description: "UTF-8 byte offset at a complete character boundary; defaults to zero for paged calls." },
      limit: { type: "integer", minimum: 4, maximum: 16 * 1024, description: "Maximum context content bytes in this page; defaults to 16384. Start with 4096." },
      expected_checksum: { ...checksumProperty, description: "Checksum of the complete fixed context text, required for offset > 0. Supplying this alone requests the first page with the default limit. A mismatch fails instead of mixing contexts." } }),
  tool("list", "List direct children of product or .artoo/product directories. Paths are workspace-relative; links and configuration directories are forbidden.", { path: pathProperty }, ["path"]),
  tool("read", "Read one UTF-8 product file (at most 1 MiB) and its full-file sha256 checksum. With only path, returns the full file as before. For a large/truncated response, page with offset:0 and limit:4096; follow next_offset with the same expected_checksum until eof:true. offset/limit use UTF-8 bytes, pages never split a character, and a nonzero offset requires expected_checksum. The checksum also binds later updates/removals.",
    { path: pathProperty, offset: { type: "integer", minimum: 0, maximum: 1024 * 1024, description: "UTF-8 byte offset at a complete character boundary; defaults to zero when limit is supplied." },
      limit: { type: "integer", minimum: 4, maximum: 16 * 1024, description: "Maximum response content bytes; defaults to 16384 when offset is supplied. The actual chunk may be shorter to preserve UTF-8 boundaries." },
      expected_checksum: { ...checksumProperty, description: "Expected checksum of the entire file. Required for offset > 0; a changed file is rejected instead of mixing pages from different versions." } }, ["path"]),
  tool("mkdir", "Create a directory and missing parents below product or .artoo/product. No shell is executed.", { path: pathProperty }, ["path"]),
  tool("write", "Create or replace one UTF-8 product file, at most 1 MiB. expected_checksum null means the file must not exist; updates require the checksum returned by read. Create parent directories first. Accepted research/design inputs are read-only.",
    { path: pathProperty, content: { type: "string", maxLength: 1024 * 1024 }, expected_checksum: { anyOf: [checksumProperty, { type: "null" }] } }, ["path", "content", "expected_checksum"]),
  tool("edit", "Replace exactly one occurrence of old_text after confirming the read checksum. Accepted research/design inputs are read-only.",
    { path: pathProperty, old_text: { type: "string", minLength: 1, maxLength: 1024 * 1024 }, new_text: { type: "string", maxLength: 1024 * 1024 }, expected_checksum: checksumProperty }, ["path", "old_text", "new_text", "expected_checksum"]),
  tool("remove", "Remove one ordinary product file after confirming its read checksum. Directories and accepted research/design inputs cannot be removed.", { path: pathProperty, expected_checksum: checksumProperty }, ["path", "expected_checksum"]),
  tool("verify", "Run the node's protected verification profile for this task and return diagnostic feedback. No arguments, commands or profile overrides are accepted. Mutations are disabled until it finishes. Only checks[].observation states measured scope; missing observations mean unknown scope, and raw diagnostics are repair information. Final acceptance and independent review still run separately."),
  tool("read_evidence", "Read one granted immutable node browser evidence reference. With only reference, returns the full measured report, trace or PNG as before, with request/source provenance. For large JSON, page with offset:0 and limit:4096; follow next_offset with the same expected_checksum until eof:true. Pages never split UTF-8 characters. PNG references cannot be paged. No file path or URL is accepted; preview evidence is diagnostic only.",
    { reference: { type: "string", pattern: "^[A-Za-z0-9_-]{1,160}$" },
      offset: { type: "integer", minimum: 0, maximum: 1024 * 1024, description: "UTF-8 byte offset into JSON evidence; a nonzero offset requires expected_checksum." },
      limit: { type: "integer", minimum: 4, maximum: 16 * 1024, description: "Maximum JSON evidence content bytes; defaults to 16384 when offset is supplied." },
      expected_checksum: { ...checksumProperty, description: "Expected checksum of the complete JSON evidence. Changed evidence is rejected instead of mixing pages." } }, ["reference"]),
];

/** This process only translates MCP messages; all filesystem and verification authority stays in the node. */
export async function runWorkspaceToolsMcp(configPath: string): Promise<void> {
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Invalid node workspace tool session file");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { version: number; url: string; token: string; tools?: string[] };
  const url = new URL(config.url);
  if (config.version !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password
    || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid node workspace tool session");
  const names = config.tools ?? workspaceToolDefinitions.filter((entry) => entry.name !== "read_evidence").map((entry) => entry.name);
  if (!Array.isArray(names) || names.some((name) => !workspaceToolDefinitions.some((entry) => entry.name === name))) throw new Error("Invalid node tool grants");
  const definitions = workspaceToolDefinitions.filter((entry) => names.includes(entry.name));
  const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + "\n"); };
  async function handle(line: string): Promise<void> {
    let id: string | number | null = null;
    try {
      const message = JSON.parse(line) as { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
      if (message.id === undefined) return;
      if (message.jsonrpc !== "2.0" || (typeof message.id !== "string" && typeof message.id !== "number")) throw new Error("Invalid MCP request");
      id = message.id;
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "artoo-workspace", version: "1.0.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: definitions };
      else if (message.method === "tools/call" && definitions.some((entry) => entry.name === message.params?.name)) {
        const args = message.params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args) || Object.hasOwn(args, "tool")) throw new Error("Invalid tool arguments");
        const response = await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...args, tool: message.params!.name }), signal: AbortSignal.timeout(16 * 60_000) });
        const body = await response.text();
        if (response.ok && message.params?.name === "read_evidence") {
          const { evidence } = JSON.parse(body) as { evidence: { mime_type: string; data?: string; text?: string; [key: string]: unknown } };
          const { data, text, ...provenance } = evidence;
          result = { content: [{ type: "text", text: JSON.stringify(provenance) },
            ...(evidence.mime_type === "image/png" ? [{ type: "image", mimeType: "image/png", data }]
              : [{ type: "text", text }])] };
        } else result = { content: [{ type: "text", text: body }], ...(!response.ok ? { isError: true } : {}) };
      } else throw new Error("Unsupported MCP method or tool");
      send({ jsonrpc: "2.0", id, result });
    } catch (error) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: error instanceof Error ? error.message : "MCP request failed" } }); }
  }
  // Bound framing while reading, rather than waiting for an arbitrarily large newline-delimited string.
  const decoder = new StringDecoder("utf8"); let buffered = "", discarding = false;
  for await (const chunk of process.stdin) {
    const text = decoder.write(Buffer.from(chunk)); let offset = 0;
    for (;;) {
      const end = text.indexOf("\n", offset), part = text.slice(offset, end < 0 ? undefined : end);
      if (!discarding) {
        if (Buffer.byteLength(buffered) + Buffer.byteLength(part) > MAX_LINE_BYTES) {
          buffered = ""; discarding = true; send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds size limit" } });
        } else buffered += part;
      }
      if (end < 0) break;
      if (!discarding && buffered.trim()) await handle(buffered);
      buffered = ""; discarding = false; offset = end + 1;
    }
  }
  buffered += decoder.end(); if (!discarding && buffered.trim()) await handle(buffered);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) runWorkspaceToolsMcp(process.argv[2] ?? "").catch(() => {
  process.stderr.write("Workspace MCP failed to initialize\n"); process.exitCode = 1;
});
