import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { VerificationCapabilitiesContextSchema, type ContextPack, type RunVerificationPayload, type VerificationCapabilitiesContext } from "@artoo/domain";
import type { AgentInstanceConfig } from "@artoo/protocol";
import { assertAcceptedProductInputs } from "./product-stage.js";
import { VerificationCleanupError, type VerificationPreviewResult } from "./verification.js";
import { MAX_BROWSER_EVIDENCE_PAGE_BYTES, type BrowserEvidenceContent, type BrowserEvidenceReadOptions } from "./browser-evidence.js";
import { assertReleaseCapabilityContext, type ReleaseCapabilityReader } from "./release-capability-authority.js";
import { claimWorkspaceReadOnlyTools, type WorkspaceReadOnlyGrant } from "./workspace-readonly.js";

export type WorkspaceToolVerifier = (signal: AbortSignal) => Promise<RunVerificationPayload | VerificationPreviewResult>;
export type WorkspaceToolEvidenceReader = (reference: string, options?: BrowserEvidenceReadOptions) => Promise<BrowserEvidenceContent>;
export type WorkspaceToolCapabilities = () => VerificationCapabilitiesContext;
const localVerifiers = new WeakMap<AgentInstanceConfig, WorkspaceToolVerifier>();
const localEvidenceReaders = new WeakMap<AgentInstanceConfig, WorkspaceToolEvidenceReader>();
const localCapabilities = new WeakMap<AgentInstanceConfig, WorkspaceToolCapabilities>();
const localReleaseCapabilities = new WeakMap<AgentInstanceConfig, ReleaseCapabilityReader>();
export function bindWorkspaceToolReleaseCapabilities(config: AgentInstanceConfig, read: ReleaseCapabilityReader): void {
  if (localReleaseCapabilities.has(config) || typeof read !== "function") throw new Error("Invalid workspace release capability binding");
  localReleaseCapabilities.set(config, read);
}
export function takeWorkspaceToolReleaseCapabilities(config: AgentInstanceConfig): ReleaseCapabilityReader | undefined {
  const read = localReleaseCapabilities.get(config); localReleaseCapabilities.delete(config); return read;
}
export function bindWorkspaceToolCapabilities(config: AgentInstanceConfig, read: WorkspaceToolCapabilities): void {
  if (localCapabilities.has(config) || typeof read !== "function") throw new Error("Invalid workspace capability binding");
  localCapabilities.set(config, read);
}
export function takeWorkspaceToolCapabilities(config: AgentInstanceConfig): WorkspaceToolCapabilities | undefined {
  const read = localCapabilities.get(config); localCapabilities.delete(config); return read;
}
/** A serialized contract is descriptive data, never authority to grant a local tool. */
export function assertWorkspaceToolCapabilities(context: ContextPack | undefined, read: WorkspaceToolCapabilities | undefined): VerificationCapabilitiesContext | undefined {
  const supplied = context?.verification_capabilities;
  if (!read) {
    if (supplied !== undefined) throw new Error("Verification capabilities require the node's local binding");
    return undefined;
  }
  const expected = VerificationCapabilitiesContextSchema.parse(read()), parsed = VerificationCapabilitiesContextSchema.safeParse(supplied);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(expected)) throw new Error("Verification capabilities differ from the node's local binding");
  return expected;
}
export function bindWorkspaceToolEvidenceReader(config: AgentInstanceConfig, read: WorkspaceToolEvidenceReader): void {
  if (localEvidenceReaders.has(config) || typeof read !== "function") throw new Error("Invalid workspace evidence reader binding");
  localEvidenceReaders.set(config, read);
}
export function takeWorkspaceToolEvidenceReader(config: AgentInstanceConfig): WorkspaceToolEvidenceReader | undefined {
  const read = localEvidenceReaders.get(config); localEvidenceReaders.delete(config); return read;
}

/** Local object identity is the authority. No serialized run field can install a verifier. */
export function bindWorkspaceToolVerifier(config: AgentInstanceConfig, verify: WorkspaceToolVerifier): void {
  if (localVerifiers.has(config) || typeof verify !== "function") throw new Error("Invalid workspace tool verifier binding");
  localVerifiers.set(config, verify);
}
export function takeWorkspaceToolVerifier(config: AgentInstanceConfig): WorkspaceToolVerifier | undefined {
  const verify = localVerifiers.get(config); localVerifiers.delete(config); return verify;
}

export interface WorkspaceToolSession { configPath: string; mcpPath: string; close(options?: { retainFiles?: boolean }): Promise<void> }
export interface WorkspaceToolSessionOptions {
  workspaceRoot: string;
  context: ContextPack;
  contextText: string;
  verify?: WorkspaceToolVerifier;
  readEvidence?: WorkspaceToolEvidenceReader;
  readCapabilities?: WorkspaceToolCapabilities;
  readReleaseCapabilities?: ReleaseCapabilityReader;
  /** Installed locally for an independent reviewer; never enables file mutations or verification. */
  evidenceOnly?: boolean;
  /** One-use node-local discussion grant. Serialized context fields cannot enable it. */
  readOnlyGrant?: WorkspaceReadOnlyGrant;
  /** An already-created node research session, never a path from tool arguments. */
  researchMcpPath?: string;
}
const MAX_FILE_BYTES = 1024 * 1024, MAX_WRITE_BYTES = 32 * MAX_FILE_BYTES, MAX_REQUEST_BYTES = 8 * MAX_FILE_BYTES;
const MAX_READ_PAGE_BYTES = 16 * 1024;
const READ_PAGINATION_GUIDANCE = "If a file response is large or truncated, use read with offset:0 and limit:4096. Offsets and limits are UTF-8 bytes. Continue from next_offset with the returned full-file checksum as expected_checksum until eof:true. Every page must have the same checksum; never infer or reconstruct omitted requirements from a partial response. The default read with only path still returns the complete file.";
const EVIDENCE_PAGINATION_GUIDANCE = "For large or truncated JSON evidence, call read_evidence with the same reference, offset:0 and limit:4096. Follow next_offset with the returned checksum as expected_checksum until eof:true; offsets and limits are UTF-8 bytes. All pages must have the same checksum. PNG references are returned as complete images and cannot be paged. Evidence with preview scope remains diagnostic only.";
const MAX_REQUESTS = 1024, MAX_CONTEXT_PAGE_REQUESTS = 4096, MAX_DIRECTORY_ENTRIES = 1024, MAX_ACTIVE_REQUESTS = 8;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pathSchema = z.string().min(1).max(1024);
const requestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("context"), offset: z.number().int().min(0).max(MAX_REQUEST_BYTES).optional(),
    limit: z.number().int().min(4).max(MAX_READ_PAGE_BYTES).optional(), expected_checksum: checksum.optional() }).strict(),
  z.object({ tool: z.literal("list"), path: pathSchema }).strict(),
  z.object({ tool: z.literal("read"), path: pathSchema, offset: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
    limit: z.number().int().min(4).max(MAX_READ_PAGE_BYTES).optional(), expected_checksum: checksum.optional() }).strict(),
  z.object({ tool: z.literal("mkdir"), path: pathSchema }).strict(),
  z.object({ tool: z.literal("write"), path: pathSchema, content: z.string().max(MAX_FILE_BYTES), expected_checksum: checksum.nullable() }).strict(),
  z.object({ tool: z.literal("edit"), path: pathSchema, old_text: z.string().min(1).max(MAX_FILE_BYTES), new_text: z.string().max(MAX_FILE_BYTES), expected_checksum: checksum }).strict(),
  z.object({ tool: z.literal("remove"), path: pathSchema, expected_checksum: checksum }).strict(),
  z.object({ tool: z.literal("verify") }).strict(),
  z.object({ tool: z.literal("read_evidence"), reference: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    offset: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
    limit: z.number().int().min(4).max(MAX_BROWSER_EVIDENCE_PAGE_BYTES).optional(), expected_checksum: checksum.optional() }).strict(),
]);
const mutations = new Set(["mkdir", "write", "edit", "remove"]);
const inside = (path: string, root: string): boolean => {
  const suffix = relative(root, path); return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
function identity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("Expected a bounded regular file without links");
}
function scopedParts(path: string, file = false): string[] {
  const parts = path.split("/");
  if (!path || path.length > 1024 || parts.length > 32 || isAbsolute(path) || /[\\:\u0000-\u001f\u007f<>"|?*]/u.test(path)
    || parts.some((part) => !part || part === "." || part === ".." || part !== part.trim() || /[. ]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
      || [".git", ".claude", ".codex", ".mcp.json", ".claude.json"].includes(part.toLowerCase()))) {
    throw new Error("Path must be a canonical relative product path without configuration directories or platform aliases");
  }
  const base = parts[0] === "product" ? 1 : parts[0] === ".artoo" && parts[1] === "product" ? 2 : 0;
  if (!base || (file && parts.length <= base)) throw new Error("Workspace tools allow only product files and .artoo/product handoffs");
  return parts;
}

/** The broker is a narrow filesystem capability, not a shell or a host filesystem sandbox. */
export async function createWorkspaceToolSession(options: WorkspaceToolSessionOptions): Promise<WorkspaceToolSession> {
  const root = options.workspaceRoot, rootStat = lstatSync(root);
  if (!isAbsolute(root) || !rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync.native(root) !== root) throw new Error("Workspace tools require a physical absolute workspace");
  const context = structuredClone(options.context), contextText = options.contextText, verify = options.verify;
  assertWorkspaceToolCapabilities(context, options.readCapabilities);
  assertReleaseCapabilityContext(context, options.readReleaseCapabilities);
  const evidenceOnly = options.evidenceOnly === true;
  const readOnly = options.readOnlyGrant === undefined ? undefined : claimWorkspaceReadOnlyTools(options.readOnlyGrant, root, context);
  if (context.workspace.root !== root
    || typeof contextText !== "string" || Buffer.byteLength(contextText) > MAX_REQUEST_BYTES) throw new Error("Workspace tools require an author context and a node-owned verifier");
  // Pages describe this immutable session text, not a mutable workspace context file
  // or the larger legacy JSON response (which also repeats capability guidance).
  const contextBytes = Buffer.from(contextText, "utf8"), contextChecksum = sha(contextBytes);
  if (readOnly ? (evidenceOnly || options.verify || options.researchMcpPath)
    : evidenceOnly ? (!context.review_subject || context.policy.execution_mode !== "discussion" || !options.readEvidence || options.verify || options.researchMcpPath)
    : (!context.product_development || context.review_subject || context.policy.execution_mode === "discussion" || typeof verify !== "function")) {
    throw new Error("Invalid author context or read-only evidence tool authority");
  }
  if (!evidenceOnly && !readOnly && !context.policy.filesystem_write_scope.some((scope) => {
    try { return isAbsolute(scope) && inside(root, realpathSync.native(scope)); } catch { return false; }
  })) throw new Error("Workspace tools have no authorized write scope");
  const pinned = new Set((context.product_development?.accepted_inputs?.files ?? []).map((file) => file.path.toLowerCase()));
  const allowedTools = readOnly ? ["context", ...(readOnly.source ? ["list", "read"] : []), ...(options.readEvidence ? ["read_evidence"] : [])]
    : evidenceOnly ? ["context", "read_evidence"] : ["context", "list", "read", "mkdir", "write", "edit", "remove", "verify", ...(options.readEvidence ? ["read_evidence"] : [])];
  function assertRoot(): void {
    const now = lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || !identity(rootStat, now) || realpathSync.native(root) !== root) throw new Error("Workspace identity changed");
  }
  function assertInputs(): void {
    assertRoot(); assertAcceptedProductInputs(root, context);
    readOnly?.assertCurrent();
    assertReleaseCapabilityContext(context, options.readReleaseCapabilities);
  }
  assertInputs();
  function pathFor(path: string, missingFinal = false): string {
    const parts = scopedParts(path); assertRoot(); let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]!);
      if (!inside(current, root)) throw new Error("Path leaves workspace");
      let stat: Stats;
      try { stat = lstatSync(current); }
      catch (error) { if (missingFinal && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return current; throw error; }
      if (stat.isSymbolicLink() || realpathSync.native(current) !== current) throw new Error("Links and path aliases are not allowed");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Parent must be a directory");
    }
    return current;
  }
  function read(path: string): { bytes: Buffer; checksum: string; absolute: string; stat: Stats } {
    scopedParts(path, true);
    readOnly?.assertRead(path);
    const absolute = pathFor(path), before = lstatSync(absolute); regular(before);
    const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor); regular(opened);
      if (!identity(before, opened)) throw new Error("File changed before opening");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, length);
        if (count === 0) break; length += count;
      }
      if (length > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
      const after = fstatSync(descriptor), current = lstatSync(pathFor(path)); regular(after); regular(current);
      if (!identity(opened, after) || !identity(after, current) || length !== after.size || opened.size !== after.size
        || opened.mtimeMs !== after.mtimeMs || after.mtimeMs !== current.mtimeMs || current.size !== length) throw new Error("File changed while reading");
      const bytes = buffer.subarray(0, length), checksum = sha(bytes);
      readOnly?.assertRead(path, checksum, bytes.length);
      return { bytes, checksum, absolute, stat: current };
    } finally { closeSync(descriptor); }
  }
  function mutable(path: string): void {
    scopedParts(path, true);
    if (pinned.has(path.toLowerCase())) throw new Error("Accepted product inputs are read-only; a reviewed plan revision is required");
  }
  let written = 0;
  function compare(path: string, expected: string | null): string {
    const absolute = pathFor(path, expected === null);
    if (expected === null) {
      try { lstatSync(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute; throw error; }
      throw new Error("File already exists; read it and supply its checksum");
    }
    if (read(path).checksum !== expected) throw new Error("File checksum changed; read it again before modifying it");
    return absolute;
  }
  function write(path: string, bytes: Buffer, expected: string | null): { path: string; checksum: string; size: number } {
    mutable(path);
    if (bytes.length > MAX_FILE_BYTES || written + bytes.length > MAX_WRITE_BYTES) throw new Error("Workspace tool write budget exceeded");
    const absolute = compare(path, expected), parent = dirname(absolute), parentStat = lstatSync(parent);
    const temporary = join(parent, `.artoo-write-${randomBytes(16).toString("hex")}.tmp`);
    let descriptor: number | undefined, temporaryExists = false;
    try {
      const mode = expected === null ? 0o644 : lstatSync(absolute).mode & 0o777;
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode); temporaryExists = true;
      if (expected !== null) fchmodSync(descriptor, mode); // Do not let the daemon's umask remove existing rwx bits.
      writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      assertInputs(); compare(path, expected);
      if (!identity(parentStat, lstatSync(parent))) throw new Error("Parent directory changed while writing");
      renameSync(temporary, absolute); temporaryExists = false; written += bytes.length;
      const measured = read(path);
      if (!measured.bytes.equals(bytes)) throw new Error("File changed after writing");
      return { path, checksum: measured.checksum, size: bytes.length };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      // Only remove this invocation's own temporary file after rechecking its parent.
      if (temporaryExists) { assertRoot(); pathFor(path, expected === null); if (!identity(parentStat, lstatSync(parent))) throw new Error("Temporary file cleanup boundary changed"); unlinkSync(temporary); }
    }
  }
  function mkdir(path: string): { path: string } {
    const parts = scopedParts(path); let current = root;
    for (const part of parts) {
      assertRoot(); current = resolve(current, part);
      try { mkdirSync(current, { mode: 0o755 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(current) !== current) throw new Error("Directory path contains a link or alias");
    }
    return { path };
  }
  const token = randomBytes(32).toString("hex"), directory = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-workspace-tools-"));
  chmodSync(directory, 0o700);
  if (inside(directory, root)) { rmSync(directory, { recursive: true }); throw new Error("Workspace tool configuration must be outside the workspace"); }
  let closed = false, retainFiles = false, calls = 0, contextPageCalls = 0, activeRequests = 0, closePromise: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  let verification: { controller: AbortController; pending: ReturnType<WorkspaceToolVerifier> } | undefined;
  let unsafe: VerificationCleanupError | undefined;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== "POST" || req.url !== "/" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    if (closed || unsafe || activeRequests >= MAX_ACTIVE_REQUESTS) { res.writeHead(429).end(); return; }
    activeRequests += 1;
    let requestFinished!: () => void;
    const requestClosed = new Promise<void>(done => { requestFinished = done; }); requests.add(requestClosed);
    let charged = false;
    const charge = (contextPage: boolean): boolean => {
      charged = true;
      // Invalid explicit page attempts count here as well. Paging cannot exhaust
      // the separate ordinary budget needed for writes, verification and evidence.
      if (contextPage ? ++contextPageCalls > MAX_CONTEXT_PAGE_REQUESTS : ++calls > MAX_REQUESTS) {
        res.writeHead(429).end(); return false;
      }
      return true;
    };
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > MAX_REQUEST_BYTES) throw new Error("Workspace tool request exceeds size limit"); chunks.push(bytes);
      }
      if (closed || unsafe) throw new Error("Workspace tool session is closed");
      const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const contextPage = request !== null && typeof request === "object" && !Array.isArray(request)
        && "tool" in request && request.tool === "context"
        && ["offset", "limit", "expected_checksum"].some(key => Object.hasOwn(request, key));
      if (!charge(contextPage)) return;
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) throw new Error("Invalid workspace tool arguments");
      const input = parsed.data;
      if (!allowedTools.includes(input.tool)) throw new Error("Tool is not granted to this session");
      if (verification && mutations.has(input.tool)) throw new Error("Workspace mutations are disabled while verification is running");
      assertInputs();
      let result: unknown;
      if (input.tool === "context") {
        const capabilities = assertWorkspaceToolCapabilities(context, options.readCapabilities);
        const releaseCapabilities = assertReleaseCapabilityContext(context, options.readReleaseCapabilities);
        if (contextPage) {
          const offset = input.offset ?? 0;
          if (offset > 0 && input.expected_checksum === undefined) throw new Error("A nonzero context offset requires the full-text expected_checksum");
          if (input.expected_checksum !== undefined && input.expected_checksum !== contextChecksum) throw new Error("Context checksum differs from the fixed session text");
          if (offset > contextBytes.length) throw new Error("Context offset is beyond the end of the fixed text");
          if (offset < contextBytes.length && (contextBytes[offset]! & 0xc0) === 0x80) throw new Error("Context offset must be a UTF-8 character boundary");
          let end = Math.min(contextBytes.length, offset + (input.limit ?? MAX_READ_PAGE_BYTES));
          while (end < contextBytes.length && (contextBytes[end]! & 0xc0) === 0x80) end -= 1;
          const eof = end === contextBytes.length;
          result = { version: 1, format: "artoo-context-text-page.v1",
            content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contextBytes.subarray(offset, end)),
            checksum: contextChecksum, size: contextBytes.length, offset, next_offset: eof ? null : end, eof };
        } else {
          result = { context: contextText, ...(allowedTools.includes("read") ? { read_guidance: READ_PAGINATION_GUIDANCE } : {}),
            ...(options.readEvidence ? { evidence_read_guidance: EVIDENCE_PAGINATION_GUIDANCE } : {}),
            ...(capabilities ? { verification_capabilities: capabilities } : {}),
            ...(releaseCapabilities ? { release_capabilities: releaseCapabilities } : {}) };
        }
      }
      else if (input.tool === "read_evidence") {
        const { tool: _tool, reference, ...pagination } = input;
        result = { evidence: await (Object.keys(pagination).length ? options.readEvidence!(reference, pagination) : options.readEvidence!(reference)) };
      }
      else if (input.tool === "read") {
        const file = read(input.path), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        // Validate the entire text, even when only one page will be returned.
        const content = decoder.decode(file.bytes);
        if (input.expected_checksum !== undefined && input.expected_checksum !== file.checksum) throw new Error("File changed since the requested read checksum");
        if (input.offset === undefined && input.limit === undefined) {
          result = { path: input.path, content, checksum: file.checksum, size: file.bytes.length };
        } else {
          const offset = input.offset ?? 0;
          if (offset > 0 && input.expected_checksum === undefined) throw new Error("A nonzero read offset requires the full-file expected_checksum");
          if (offset > file.bytes.length) throw new Error("Read offset is beyond the end of the file");
          if (offset < file.bytes.length && (file.bytes[offset]! & 0xc0) === 0x80) throw new Error("Read offset must be a UTF-8 character boundary");
          let end = Math.min(file.bytes.length, offset + (input.limit ?? MAX_READ_PAGE_BYTES));
          // A minimum limit of four bytes guarantees progress for any UTF-8 character.
          while (end < file.bytes.length && (file.bytes[end]! & 0xc0) === 0x80) end -= 1;
          const eof = end === file.bytes.length;
          result = { path: input.path, content: decoder.decode(file.bytes.subarray(offset, end)), checksum: file.checksum,
            size: file.bytes.length, offset, next_offset: eof ? null : end, eof };
        }
      } else if (input.tool === "list") {
        const pinnedEntries = readOnly?.list(input.path);
        const absolute = pathFor(input.path);
        if (!lstatSync(absolute).isDirectory()) throw new Error("List requires a directory");
        const children = pinnedEntries ? pinnedEntries.map(entry => entry.name) : readdirSync(absolute).sort();
        if (children.length > MAX_DIRECTORY_ENTRIES) throw new Error("Directory exceeds entry limit");
        result = { path: input.path, entries: children.map((name) => {
          const stat = lstatSync(pathFor(`${input.path}/${name}`));
          if (!stat.isDirectory()) regular(stat);
          return { name, kind: stat.isDirectory() ? "directory" : "file", ...(stat.isFile() ? { size: stat.size } : {}) };
        }) };
      } else if (input.tool === "mkdir") result = mkdir(input.path);
      else if (input.tool === "write") result = write(input.path, Buffer.from(input.content, "utf8"), input.expected_checksum);
      else if (input.tool === "edit") {
        mutable(input.path); const file = read(input.path);
        if (file.checksum !== input.expected_checksum) throw new Error("File checksum changed; read it again before modifying it");
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes), index = content.indexOf(input.old_text);
        if (index < 0 || content.indexOf(input.old_text, index + 1) >= 0) throw new Error("old_text must match exactly once");
        result = write(input.path, Buffer.from(content.slice(0, index) + input.new_text + content.slice(index + input.old_text.length), "utf8"), input.expected_checksum);
      } else if (input.tool === "remove") {
        mutable(input.path); const absolute = compare(input.path, input.expected_checksum); unlinkSync(absolute); result = { path: input.path, removed: true };
      } else {
        if (verification) throw new Error("Verification is already running");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Workspace verification timed out")), 15 * 60_000);
        // Install the lock before invoking the local callback, including synchronous failures.
        const pending = Promise.resolve().then(() => verify!(controller.signal)); verification = { controller, pending };
        try { const measured = await pending; result = { diagnostic_only: true, ...("verification" in measured ? measured : { verification: measured }) }; assertInputs(); }
        catch (error) { if (error instanceof VerificationCleanupError) unsafe = error; throw error; }
        finally { clearTimeout(timer); verification = undefined; }
      }
      assertRoot(); readOnly?.assertCurrent(); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      // Malformed JSON, oversized bodies and interrupted reads cannot bypass the
      // ordinary quota merely because they never reached argument classification.
      if (!charged && !charge(false)) return;
      const message = (error instanceof Error ? error.message : "Workspace tool request failed").replaceAll(token, "[redacted]").slice(0, 1000);
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
    } finally { activeRequests -= 1; requests.delete(requestClosed); requestFinished(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 20;
  try {
    const mcpServers: Record<string, unknown> = {};
    if (options.researchMcpPath) {
      const path = options.researchMcpPath, stat = lstatSync(path);
      if (!isAbsolute(path) || inside(realpathSync.native(path), root) || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("Invalid node research MCP configuration");
      const parsed = z.object({ mcpServers: z.object({ artoo_research: z.object({ command: z.literal(process.execPath),
        args: z.tuple([z.literal(fileURLToPath(new URL("./research-mcp.js", import.meta.url))), z.string()]),
        env: z.object({ ELECTRON_RUN_AS_NODE: z.literal("1") }).strict(),
      }).strict() }).strict() }).strict().safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) throw new Error("Expected the node research MCP server only");
      const brokerPath = parsed.data.mcpServers.artoo_research.args[1], brokerStat = lstatSync(brokerPath);
      if (!isAbsolute(brokerPath) || inside(realpathSync.native(brokerPath), root) || brokerStat.isSymbolicLink() || !brokerStat.isFile() || brokerStat.nlink !== 1 || brokerStat.size > 16_384) throw new Error("Invalid node research broker configuration");
      mcpServers.artoo_research = parsed.data.mcpServers.artoo_research;
    }
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); ready(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Workspace tool broker failed to bind loopback");
    const configPath = join(directory, "broker.json"), mcpPath = join(directory, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, url: `http://127.0.0.1:${address.port}/`, token, tools: allowedTools }), { flag: "wx", mode: 0o400 });
    mcpServers.artoo_workspace = { command: process.execPath, args: [fileURLToPath(new URL("./workspace-tools-mcp.js", import.meta.url)), configPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
    writeFileSync(mcpPath, JSON.stringify({ mcpServers }), { flag: "wx", mode: 0o400 });
    return { configPath, mcpPath, close(options) {
      retainFiles ||= options?.retainFiles === true;
      return closePromise ??= (async () => {
        closed = true; const running = verification; running?.controller.abort(new Error("Workspace tool session closed"));
        server.closeAllConnections();
        const stopped = new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
        const verifierClosed = Promise.resolve(running?.pending).catch(error => { if (error instanceof VerificationCleanupError) unsafe = error; });
        // Socket closure does not settle asynchronous evidence/read handlers.
        // No handler invokes close; the session owner joins the admitted set.
        await Promise.all([stopped, verifierClosed, ...requests]);
        if (unsafe) throw unsafe;
        if (!retainFiles) rmSync(directory, { recursive: true, force: true });
      })();
    } };
  } catch (error) { closed = true; server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}
