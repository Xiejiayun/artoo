import { createHash } from "node:crypto";
import { z } from "zod";

const contextChecksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const contextOffset = z.number().int().min(0).max(8 * 1024 * 1024);
const contextPage = z.object({ version: z.literal(1), format: z.literal("artoo-context-text-page.v1"),
  content: z.string().max(16384), checksum: contextChecksum, size: contextOffset,
  offset: contextOffset, next_offset: contextOffset.nullable(), eof: z.boolean() });
const contextCall = z.object({ type: z.literal("item.completed"), item: z.object({ type: z.literal("mcp_tool_call"),
  server: z.literal("artoo_workspace"), tool: z.literal("context"), status: z.literal("completed"),
  arguments: z.object({ offset: contextOffset.optional(), limit: z.number().int().min(4).max(16384).optional(),
    expected_checksum: contextChecksum.optional() }),
  result: z.object({ isError: z.literal(false).optional(), content: z.tuple([z.object({ type: z.literal("text"), text: z.string().max(128 * 1024) })]) }) }) });

/** Local tool-delivery metadata only; no prompts, response text or model reasoning are retained. */
export function contextPageMetadataFromCodexOutput(text: string) {
  if (text.length > 256 * 1024) return undefined;
  try {
    const call = contextCall.safeParse(JSON.parse(text)); if (!call.success) return undefined;
    const page = contextPage.safeParse(JSON.parse(call.data.item.result.content[0].text)); if (!page.success) return undefined;
    const { content, ...metadata } = page.data, args = call.data.item.arguments;
    const bytes = Buffer.byteLength(content), end = metadata.offset + bytes;
    if (bytes > (args.limit ?? 16384) || metadata.offset !== (args.offset ?? 0) || end > metadata.size
      || (args.expected_checksum !== undefined && args.expected_checksum !== metadata.checksum)
      || (metadata.offset > 0 && args.expected_checksum === undefined)
      || (metadata.eof ? metadata.next_offset !== null || end !== metadata.size : metadata.next_offset !== end || end <= metadata.offset || end >= metadata.size)) return undefined;
    return { ...metadata, content_bytes: bytes, content_checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      requested_limit: args.limit ?? 16384 };
  } catch { return undefined; } // Unrelated or malformed provider output is not context-delivery evidence.
}

const MAX_TOOL_LINE_BYTES = 8 * 1024 * 1024;
const toolNames = ["context", "list", "read", "mkdir", "write", "edit", "remove", "verify", "read_evidence", "fetch", "search"] as const;
const toolFrame = z.object({ type: z.enum(["item.started", "item.completed"]), item: z.object({
  id: z.string().regex(/^item_[0-9]{1,16}$/), type: z.literal("mcp_tool_call"),
  server: z.enum(["artoo_workspace", "artoo_research"]), tool: z.enum(toolNames),
  status: z.enum(["in_progress", "completed", "failed"]), arguments: z.record(z.unknown()),
  result: z.unknown().optional(), error: z.unknown().optional(),
}) });
const receivedToolEvent = z.object({
  run_id: z.string().regex(/^run_[0-9]{1,20}$/), sequence: z.number().int().min(0).max(2147483647),
  received_at: z.string().max(30).datetime(), received_monotonic_ms: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type CodexToolEventReceipt = z.infer<typeof receivedToolEvent>;
const byteCount = z.number().int().min(0).max(MAX_TOOL_LINE_BYTES);
const pageArguments = z.object({ offset: byteCount.optional(), limit: z.number().int().min(4).max(16384).optional(),
  expected_checksum: contextChecksum.optional() });
const textResult = z.object({ content: z.string().max(MAX_TOOL_LINE_BYTES), checksum: contextChecksum, size: byteCount,
  offset: byteCount.optional(), next_offset: byteCount.nullable().optional(), eof: z.boolean().optional() });
const toolResult = z.object({ isError: z.boolean().optional(), content: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(MAX_TOOL_LINE_BYTES) }),
  z.object({ type: z.literal("image"), mimeType: z.literal("image/png"), data: z.string().max(MAX_TOOL_LINE_BYTES) }),
])).max(2) });

export interface CodexToolCallMetadata {
  event: "started" | "completed";
  call_id: string;
  server: "artoo_workspace" | "artoo_research";
  tool: typeof toolNames[number];
  status: "in_progress" | "completed" | "failed";
  /** UTF-8 bytes of the received line, excluding any removed JSONL delimiter. */
  cli_line_bytes: number;
  /** JSON.stringify projection sizes, not original network/CLI byte counts. */
  argument_json_bytes: number;
  result_json_bytes?: number;
  result_is_error?: boolean;
  error_reported?: true;
  result_metadata_unavailable?: true;
  text_bytes?: number;
  image_base64_bytes?: number;
  image_decoded_bytes?: number;
  page?: { kind: "context" | "read" | "evidence"; checksum: string; total_bytes: number; returned_bytes: number;
    offset?: number; next_offset?: number | null; eof?: boolean; requested_limit?: number };
  evidence_mime_type?: "application/json" | "image/png";
  evidence_content_bytes?: number;
  verification?: { outcome: "passed" | "failed" | "timed_out" | "cancelled"; check_count: number;
    command_duration_ms: number; checks: { index: number; duration_ms: number; exit_code: number | null;
      observation_scope?: "preview" | "final"; case_count?: number }[] };
}
export interface ReceivedCodexToolMetadata extends CodexToolCallMetadata, CodexToolEventReceipt {
  pairing: "pending" | "paired" | "missing-start";
  /** Local CLI-event receipt interval, not node execution or provider latency. */
  cli_observed_interval_ms?: number;
}

function projectTextResult(value: unknown, args: Record<string, unknown>, kind: "context" | "read" | "evidence") {
  const parsed = textResult.safeParse(value), request = pageArguments.safeParse(args);
  if (!parsed.success || !request.success) return undefined;
  const page = parsed.data, input = request.data, bytes = Buffer.byteLength(page.content);
  const paged = page.offset !== undefined || page.next_offset !== undefined || page.eof !== undefined;
  if (page.size > (kind === "context" ? MAX_TOOL_LINE_BYTES : 1024 * 1024) || bytes > page.size) return undefined;
  if (!paged) {
    if (kind === "context" || input.offset !== undefined || input.limit !== undefined || bytes !== page.size) return undefined;
    if (input.expected_checksum !== undefined && input.expected_checksum !== page.checksum) return undefined;
    return { kind, checksum: page.checksum, total_bytes: page.size, returned_bytes: bytes };
  }
  if (page.offset === undefined || page.next_offset === undefined || page.eof === undefined) return undefined;
  const end = page.offset + bytes;
  if (bytes > (input.limit ?? 16384) || page.offset !== (input.offset ?? 0) || end > page.size
    || (input.expected_checksum !== undefined && input.expected_checksum !== page.checksum)
    || (page.offset > 0 && input.expected_checksum === undefined)
    || (page.eof ? page.next_offset !== null || end !== page.size : page.next_offset !== end || end <= page.offset || end >= page.size)) return undefined;
  return { kind, checksum: page.checksum, total_bytes: page.size, returned_bytes: bytes, offset: page.offset,
    next_offset: page.next_offset, eof: page.eof, requested_limit: input.limit ?? 16384 };
}

const verificationMetadata = z.object({ diagnostic_only: z.literal(true), verification: z.object({
  outcome: z.enum(["passed", "failed", "timed_out", "cancelled"]), checks: z.array(z.object({
    duration_ms: z.number().finite().min(0).max(24 * 60 * 60_000), exit_code: z.number().int().min(-2147483648).max(2147483647).nullable(),
    observation: z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      scope: z.enum(["preview", "final"]), cases: z.array(z.unknown()).max(1600) })
      .refine(value => value.version === 1 || value.cases.length <= 400).optional(),
  })).max(64),
}) });

/** Projects only known MCP result shapes. All source objects remain local and are discarded. */
function projectToolResult(item: z.infer<typeof toolFrame>["item"], output: CodexToolCallMetadata): void {
  if (item.result === undefined || item.result === null) return;
  output.result_json_bytes = Buffer.byteLength(JSON.stringify(item.result));
  const parsed = toolResult.safeParse(item.result);
  if (!parsed.success) { output.result_metadata_unavailable = true; return; }
  const result = parsed.data;
  if (result.isError !== undefined) output.result_is_error = result.isError;
  // Error text can contain arguments, paths or credentials. Only its byte count leaves this function.
  output.text_bytes = result.content.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
  if (result.isError || item.status !== "completed") return;
  try {
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error();
    const body: unknown = JSON.parse(first.text);
    if (item.server !== "artoo_workspace") return;
    if (item.tool === "context" || item.tool === "read") {
      if (result.content.length !== 1) throw new Error();
      const shape = item.tool === "context" ? contextPage.safeParse(body) : textResult.safeParse(body);
      if (!shape.success) throw new Error();
      const page = projectTextResult(shape.data, item.arguments, item.tool);
      if (!page) throw new Error();
      output.page = page;
    } else if (item.tool === "read_evidence") {
      const info = z.object({ mime_type: z.enum(["application/json", "image/png"]), checksum: contextChecksum.optional(),
        size: byteCount.optional(), offset: byteCount.optional(), next_offset: byteCount.nullable().optional(), eof: z.boolean().optional() }).parse(body);
      const data = result.content[1];
      if (result.content.length !== 2 || !data) throw new Error();
      if (info.mime_type === "image/png") {
        if (data.type !== "image" || !info.checksum || info.size === undefined || info.size > 4 * 1024 * 1024
          || info.offset !== undefined || info.next_offset !== undefined || info.eof !== undefined
          || item.arguments.offset !== undefined || item.arguments.limit !== undefined || item.arguments.expected_checksum !== undefined) throw new Error();
        const decoded = Buffer.from(data.data, "base64");
        if (decoded.length !== info.size || decoded.toString("base64") !== data.data) throw new Error();
        output.image_base64_bytes = Buffer.byteLength(data.data);
        output.image_decoded_bytes = decoded.length;
      } else {
        if (data.type !== "text") throw new Error();
        const evidenceBytes = Buffer.byteLength(data.text);
        if (evidenceBytes > 1024 * 1024) throw new Error();
        const paged = info.offset !== undefined || info.next_offset !== undefined || info.eof !== undefined;
        if (paged) {
          const page = projectTextResult({ ...info, content: data.text }, item.arguments, "evidence");
          if (!page) throw new Error();
          output.page = page;
        } else if (item.arguments.offset !== undefined || item.arguments.limit !== undefined) throw new Error();
        output.evidence_content_bytes = evidenceBytes;
      }
      output.evidence_mime_type = info.mime_type;
    } else if (item.tool === "verify") {
      if (result.content.length !== 1) throw new Error();
      const value = verificationMetadata.parse(body).verification;
      const checks = value.checks.map((check, index) => ({ index, duration_ms: check.duration_ms, exit_code: check.exit_code,
        ...(check.observation ? { observation_scope: check.observation.scope, case_count: check.observation.cases.length } : {}) }));
      output.verification = { outcome: value.outcome, check_count: checks.length,
        command_duration_ms: checks.reduce((sum, check) => sum + check.duration_ms, 0), checks };
    }
  } catch { output.result_metadata_unavailable = true; }
}

/** Public CLI MCP reports only. This does not grant node authority or measure other CLI activity. */
export function codexToolCallMetadataFromOutput(text: string):
  { kind: "ignored" } | { kind: "dropped"; reason: "oversized" | "malformed" } | { kind: "event"; metadata: CodexToolCallMetadata } {
  if (text.length > MAX_TOOL_LINE_BYTES || Buffer.byteLength(text) > MAX_TOOL_LINE_BYTES) return { kind: "dropped", reason: "oversized" };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("type" in value) || !["item.started", "item.completed"].includes(String(value.type))
      || !("item" in value) || !value.item || typeof value.item !== "object" || !("type" in value.item) || value.item.type !== "mcp_tool_call") return { kind: "ignored" };
    const parsed = toolFrame.safeParse(value);
    if (!parsed.success) return { kind: "dropped", reason: "malformed" };
    const { type, item } = parsed.data;
    if ((item.server === "artoo_research") !== (item.tool === "fetch" || item.tool === "search")
      || (type === "item.started" ? item.status !== "in_progress" || item.result != null || item.error != null : item.status === "in_progress")) return { kind: "dropped", reason: "malformed" };
    const metadata: CodexToolCallMetadata = { event: type === "item.started" ? "started" : "completed", call_id: item.id,
      server: item.server, tool: item.tool, status: item.status, cli_line_bytes: Buffer.byteLength(text),
      argument_json_bytes: Buffer.byteLength(JSON.stringify(item.arguments)) };
    if (item.error != null) metadata.error_reported = true;
    if (type === "item.completed") projectToolResult(item, metadata);
    return { kind: "event", metadata };
  } catch { return { kind: "dropped", reason: "malformed" }; }
}

/** Bounded test diagnostics. Caller supplies one local receive clock; no clock or content is inferred. */
export function createCodexToolMetadataCollector(options: { max_events?: number; max_calls?: number; max_runs?: number } = {}) {
  const bound = (value: number | undefined, maximum: number) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) throw new Error("Invalid tool metadata bound");
    return value ?? maximum;
  };
  const maxEvents = bound(options.max_events, 4096), maxCalls = bound(options.max_calls, 4096), maxRuns = bound(options.max_runs, 128);
  const records: ReceivedCodexToolMetadata[] = [];
  const runs = new Map<string, { sequence: number; monotonic: number }>();
  const calls = new Map<string, { server: CodexToolCallMetadata["server"]; tool: CodexToolCallMetadata["tool"];
    start?: CodexToolEventReceipt; completed: boolean }>();
  const dropped = { malformed: 0, oversized: 0, invalid_receipt: 0, duplicate: 0, out_of_order: 0, conflict: 0, capacity: 0 };
  const counts = { accepted: 0, ignored: 0, started: 0, completed: 0, paired: 0, missing_start: 0, result_metadata_unavailable: 0 };
  let countersSaturated = false;
  const increment = (record: Record<string, number>, key: string) => {
    if (record[key]! < Number.MAX_SAFE_INTEGER) record[key]! += 1; else countersSaturated = true;
  };
  return {
    record(receipt: CodexToolEventReceipt, text: string): ReceivedCodexToolMetadata | undefined {
      const parsed = codexToolCallMetadataFromOutput(text);
      if (parsed.kind === "ignored") { increment(counts, "ignored"); return; }
      if (parsed.kind === "dropped") { increment(dropped, parsed.reason); return; }
      const received = receivedToolEvent.safeParse(receipt);
      if (!received.success) { increment(dropped, "invalid_receipt"); return; }
      const info = received.data, metadata = parsed.metadata, previous = runs.get(info.run_id);
      if (previous && (info.sequence <= previous.sequence || info.received_monotonic_ms < previous.monotonic)) {
        increment(dropped, info.sequence === previous.sequence ? "duplicate" : "out_of_order"); return;
      }
      const key = `${info.run_id}:${metadata.call_id}`, existing = calls.get(key);
      if (records.length >= maxEvents || (!previous && runs.size >= maxRuns) || (!existing && calls.size >= maxCalls)) {
        increment(dropped, "capacity"); return;
      }
      runs.set(info.run_id, { sequence: info.sequence, monotonic: info.received_monotonic_ms });
      if (existing && (existing.server !== metadata.server || existing.tool !== metadata.tool)) { increment(dropped, "conflict"); return; }
      if (existing && (existing.completed || metadata.event === "started")) { increment(dropped, "duplicate"); return; }
      const state: NonNullable<typeof existing> = existing ?? { server: metadata.server, tool: metadata.tool, completed: false };
      const record: ReceivedCodexToolMetadata = { ...metadata, ...info,
        pairing: metadata.event === "started" ? "pending" : state.start ? "paired" : "missing-start" };
      if (metadata.event === "started") { state.start = { ...info }; increment(counts, "started"); }
      else {
        state.completed = true; increment(counts, "completed");
        if (state.start) {
          record.cli_observed_interval_ms = info.received_monotonic_ms - state.start.received_monotonic_ms;
          increment(counts, "paired");
        } else increment(counts, "missing_start");
      }
      calls.set(key, state); records.push(record); increment(counts, "accepted");
      if (record.result_metadata_unavailable) increment(counts, "result_metadata_unavailable");
      return structuredClone(record);
    },
    snapshot() {
      const pendingCalls = [...calls.values()].filter(call => !call.completed).length;
      return { version: 1 as const, scope: "Public CLI MCP reports and local receive intervals only; not node tool execution, provider latency, model comprehension, or other CLI activity.",
        byte_count_scope: "cli_line_bytes excludes the JSONL delimiter; argument_json_bytes and result_json_bytes are reserialized JSON sizes, not network transfer measurements.",
        interval_aggregation: "Intervals may overlap; do not sum them as elapsed stage time.",
        limits: { max_events: maxEvents, max_calls: maxCalls, max_runs: maxRuns, max_line_bytes: MAX_TOOL_LINE_BYTES },
        counts: { ...counts }, dropped: { ...dropped }, incomplete: Object.values(dropped).some(value => value > 0) || countersSaturated
          || counts.missing_start > 0 || counts.result_metadata_unavailable > 0 || pendingCalls > 0,
        counters_saturated: countersSaturated, pending_calls: pendingCalls,
        records: structuredClone(records) };
    },
  };
}

/** Test-only reporting: a successful pipeline is provisional until Vitest finishes cleanup. */
export function createLiveAcceptanceReportWriter(persist: (report: Record<string, unknown>) => void) {
  let finalized = false;
  return {
    get finalized() { return finalized; },
    progress(report: Record<string, unknown>): void {
      if (!finalized) persist({ ...report, passed: false });
    },
    finish(report: Record<string, unknown>, testState: string | undefined, aborted: boolean): void {
      if (finalized) return;
      // Fence late test bodies/hooks before persisting, including when persistence throws.
      finalized = true;
      persist({ ...report, test_state: testState ?? "unknown", aborted, finished_at: new Date().toISOString(),
        passed: testState === "pass" && !aborted && report.pipeline_passed === true && report.cleanup_passed === true });
    },
  };
}

type CleanupAction = () => void | Promise<void>;
export interface LiveAcceptanceCleanup {
  stopDispatchers: CleanupAction[];
  stopNode: CleanupAction;
  drainBinding: CleanupAction;
  closeBinding: CleanupAction;
  closeServer: CleanupAction;
  removeWorkspace: CleanupAction;
  finalized(): boolean;
  describeError(error: unknown): string;
}

/** Timeouts mean unconfirmed closure, never permission to remove an owned workspace. */
export async function cleanupLiveAcceptance(actions: LiveAcceptanceCleanup, stepTimeoutMs = 15_000) {
  const errors: { step: string; error: string }[] = [];
  async function attempt(step: string, action: CleanupAction): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${step} did not confirm completion before its cleanup deadline`)), stepTimeoutMs); }),
      ]);
      return true;
    } catch (error) {
      errors.push({ step, error: actions.describeError(error) });
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }
  // Each stop is attempted even when another rejects synchronously or hangs.
  const dispatchers = await Promise.all(actions.stopDispatchers.map((stop, index) => attempt(`dispatcher.${index}`, stop)));
  const producersStopped = dispatchers.every(Boolean);
  const nodeStopped = await attempt("node.stop", actions.stopNode);
  await attempt("binding.drain", actions.drainBinding);
  await attempt("binding.close", actions.closeBinding);
  await attempt("server.close", actions.closeServer);
  let workspaceRemoved = false;
  if (producersStopped && nodeStopped && errors.length === 0 && !actions.finalized()) {
    workspaceRemoved = await attempt("workspace.remove", actions.removeWorkspace);
  }
  return { passed: errors.length === 0 && workspaceRemoved && !actions.finalized(),
    producers_stopped: producersStopped, node_stopped: nodeStopped, workspace_removed: workspaceRemoved, errors };
}
