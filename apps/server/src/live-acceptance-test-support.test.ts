import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupLiveAcceptance, codexToolCallMetadataFromOutput, contextPageMetadataFromCodexOutput, createCodexToolMetadataCollector,
  createLiveAcceptanceReportWriter, type CodexToolEventReceipt, type LiveAcceptanceCleanup } from "./live-acceptance-test-support.js";

afterEach(() => vi.useRealTimers());

describe("bounded context delivery metadata", () => {
  const checksum = `sha256:${"a".repeat(64)}`;
  const page = { version: 1, format: "artoo-context-text-page.v1", content: "私有🌱", checksum, size: 10, offset: 0, next_offset: null, eof: true };
  const frame = (value: unknown = page, args: Record<string, unknown> = { offset: 0, limit: 4096 }) => JSON.stringify({ type: "item.completed",
    item: { type: "mcp_tool_call", server: "artoo_workspace", tool: "context", status: "completed", arguments: args,
      result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });
  it("retains byte-level page facts without storing private context or unrelated fields", () => {
    const result = contextPageMetadataFromCodexOutput(frame({ ...page, private_field: "/private/credentials" }));
    expect(result).toMatchObject({ version: 1, offset: 0, next_offset: null, eof: true, content_bytes: 10, checksum, requested_limit: 4096 });
    expect(result?.content_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/私有|private_field|credentials/);
  });
  it.each([
    { ...page, size: 11 }, { ...page, offset: 1 }, { ...page, next_offset: 10 },
    { ...page, content: "x".repeat(4097), size: 4097 }, { ...page, eof: false }, { context: "legacy full context" },
  ])("rejects malformed or legacy replies as paging metadata", value => {
    expect(contextPageMetadataFromCodexOutput(frame(value))).toBeUndefined();
  });
  it("requires matching request offsets and checksums for continuation pages", () => {
    const continuation = { ...page, offset: 10, size: 20 };
    expect(contextPageMetadataFromCodexOutput(frame(continuation, { offset: 10, expected_checksum: checksum }))).toMatchObject({ offset: 10 });
    expect(contextPageMetadataFromCodexOutput(frame(continuation, { offset: 10 }))).toBeUndefined();
    expect(contextPageMetadataFromCodexOutput(frame(continuation, { offset: 10, expected_checksum: `sha256:${"b".repeat(64)}` }))).toBeUndefined();
    expect(contextPageMetadataFromCodexOutput("not JSON")).toBeUndefined();
    expect(contextPageMetadataFromCodexOutput(JSON.stringify({ type: "agent_message", text: frame() }))).toBeUndefined();
  });
});

describe("public Codex MCP metadata projection", () => {
  // Synthetic public CLI envelopes, not a provider acceptance transcript.
  const checksum = `sha256:${"a".repeat(64)}`, secret = "PRIVATE_CONTENT_DO_NOT_RETAIN";
  function frame(tool = "read", options: Record<string, unknown> = {}, type = "item.completed") {
    return JSON.stringify({ type, private_reasoning: secret, item: { id: "item_1", type: "mcp_tool_call", server: "artoo_workspace",
      tool, status: type === "item.started" ? "in_progress" : "completed", arguments: { path: `/private/${secret}` }, ...options } });
  }
  const textResult = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  const metadata = (line: string) => {
    const result = codexToolCallMetadataFromOutput(line);
    expect(result.kind).toBe("event");
    if (result.kind !== "event") throw new Error("Expected projected MCP metadata");
    return result.metadata;
  };

  it("counts UTF-8 data and strips paths, arguments, extra fields and error text", () => {
    const content = `私有🌱${secret}`, line = frame("read", { duration_ms: 999, private: secret,
      error: { message: secret, stack: `/private/${secret}`, credential: secret }, result: textResult({
        path: `/private/${secret}`, content, checksum, size: Buffer.byteLength(content), private_field: secret }) });
    const result = metadata(line);
    expect(result).toMatchObject({ event: "completed", call_id: "item_1", status: "completed", error_reported: true,
      cli_line_bytes: Buffer.byteLength(line), page: { kind: "read", returned_bytes: 10 + secret.length, total_bytes: 10 + secret.length } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CONTENT|private_reasoning|credential|\/private|duration_ms/);
    expect(result).not.toHaveProperty("arguments"); expect(result).not.toHaveProperty("result");
  });

  it("records a public started event without inventing result or duration fields", () => {
    const result = metadata(frame("verify", { arguments: {}, result: null, error: null }, "item.started"));
    expect(result).toMatchObject({ event: "started", status: "in_progress", argument_json_bytes: 2 });
    expect(result).not.toHaveProperty("result_json_bytes"); expect(result).not.toHaveProperty("verification");
    expect(result).not.toHaveProperty("duration_ms");
  });

  it("preserves completed status separately from explicit MCP error and omits its contents", () => {
    const result = metadata(frame("verify", { result: { isError: true, content: [{ type: "text", text: secret }] } }));
    expect(result).toMatchObject({ status: "completed", result_is_error: true, text_bytes: secret.length });
    expect(result.verification).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(secret);
    expect(metadata(frame("read", { status: "failed", result: null, error: { message: secret } })))
      .toMatchObject({ status: "failed", error_reported: true });
  });

  it("projects only a consistent context page and retains the old no-id page helper", () => {
    const body = { version: 1, format: "artoo-context-text-page.v1", content: "私有🌱", checksum, size: 20,
      offset: 10, next_offset: null, eof: true };
    const line = frame("context", { arguments: { offset: 10, limit: 4096, expected_checksum: checksum }, result: textResult(body) });
    expect(metadata(line).page).toEqual({ kind: "context", checksum, total_bytes: 20, returned_bytes: 10,
      offset: 10, next_offset: null, eof: true, requested_limit: 4096 });
    const old = JSON.parse(line); delete old.item.id;
    expect(contextPageMetadataFromCodexOutput(JSON.stringify(old))).toMatchObject({ content_bytes: 10, offset: 10 });
    expect(codexToolCallMetadataFromOutput(JSON.stringify(old))).toEqual({ kind: "dropped", reason: "malformed" });
    for (const invalid of [{ ...body, size: 21 }, { ...body, next_offset: 20 }, { ...body, offset: 9 }]) {
      const result = metadata(frame("context", { arguments: { offset: 10, expected_checksum: checksum }, result: textResult(invalid) }));
      expect(result.result_metadata_unavailable).toBe(true); expect(result.page).toBeUndefined();
    }
  });

  it("projects paged JSON evidence without retaining provenance or trace text", () => {
    const result = metadata(frame("read_evidence", { arguments: { reference: secret, offset: 0, limit: 4096 }, result: {
      content: [{ type: "text", text: JSON.stringify({ mime_type: "application/json", checksum, size: 10,
        offset: 0, next_offset: null, eof: true, provenance: { private_path: secret } }) }, { type: "text", text: "私有🌱" }] } }));
    expect(result).toMatchObject({ evidence_mime_type: "application/json", evidence_content_bytes: 10,
      page: { kind: "evidence", returned_bytes: 10, total_bytes: 10 } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CONTENT|私有|provenance/);
  });

  it("keeps image base64 bytes distinct from decoded bytes and rejects noncanonical base64", () => {
    const image = Buffer.from([137, 80, 78, 71, 13]), data = image.toString("base64");
    const result = (value: string, size = image.length) => ({ content: [
      { type: "text", text: JSON.stringify({ mime_type: "image/png", size, checksum, reference: secret }) },
      { type: "image", mimeType: "image/png", data: value },
    ] });
    expect(metadata(frame("read_evidence", { arguments: { reference: secret }, result: result(data) })))
      .toMatchObject({ image_base64_bytes: 8, image_decoded_bytes: 5, evidence_mime_type: "image/png" });
    for (const invalid of [result(`${data}\n`), result(data, 6), result("not base64!")]) {
      const value = metadata(frame("read_evidence", { result: invalid }));
      expect(value.result_metadata_unavailable).toBe(true); expect(value.image_decoded_bytes).toBeUndefined();
      expect(value.evidence_mime_type).toBeUndefined();
    }
  });

  it("projects explicit verifier counts and command duration, never arbitrary CLI duration", () => {
    const verification = { outcome: "passed", request_id: secret, reason: secret, checks: [
      { id: secret, duration_ms: 12.5, exit_code: 0, output_digest: secret, observation: { version: 3, scope: "preview", cases: [{ secret }, { secret }] } },
      { id: secret, duration_ms: 3, exit_code: null },
    ] };
    const result = metadata(frame("verify", { duration_ms: 98765, result: textResult({ diagnostic_only: true, verification, command_output: secret }) }));
    expect(result.verification).toEqual({ outcome: "passed", check_count: 2, command_duration_ms: 15.5, checks: [
      { index: 0, duration_ms: 12.5, exit_code: 0, observation_scope: "preview", case_count: 2 },
      { index: 1, duration_ms: 3, exit_code: null },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CONTENT|98765|output_digest|request_id/);
    for (const value of [-1, null, "12", 24 * 60 * 60_000 + 1]) {
      const invalid = metadata(frame("verify", { result: textResult({ diagnostic_only: true,
        verification: { outcome: "passed", checks: [{ duration_ms: value, exit_code: 0 }] } }) }));
      expect(invalid.verification).toBeUndefined(); expect(invalid.result_metadata_unavailable).toBe(true);
    }
  });

  it("supports the domain's check/case bounds and marks unsupported result counts unavailable", () => {
    const check = { duration_ms: 1, exit_code: 0, observation: { version: 1, scope: "preview", cases: Array.from({ length: 1600 }, () => ({})) } };
    const result = (checks: unknown[]) => metadata(frame("verify", { result: textResult({ diagnostic_only: true, verification: { outcome: "passed", checks } }) }));
    expect(result(Array.from({ length: 64 }, () => check)).verification).toMatchObject({ check_count: 64, command_duration_ms: 64 });
    expect(result(Array.from({ length: 65 }, () => check)).result_metadata_unavailable).toBe(true);
    expect(result([{ ...check, observation: { ...check.observation, version: 3, cases: Array.from({ length: 401 }, () => ({})) } }]).verification).toBeUndefined();
  });

  it.each([
    { id: "item_PRIVATE_CONTENT" }, { id: "item_12345678901234567" }, { id: 1 }, { id: "../item_1" },
    { server: "other" }, { tool: "execute" }, { server: "artoo_workspace", tool: "fetch" },
    { server: "artoo_research", tool: "read" }, { arguments: [] }, { arguments: null }, { status: "in_progress" },
  ])("rejects malformed or ungranted tool envelope %#", item => {
    expect(codexToolCallMetadataFromOutput(frame("read", item))).toEqual({ kind: "dropped", reason: "malformed" });
  });

  it("counts research tools without retaining queries or URLs and ignores non-MCP activity", () => {
    expect(metadata(frame("fetch", { server: "artoo_research", arguments: { url: secret }, result: textResult({ text: secret }) })))
      .toMatchObject({ tool: "fetch", server: "artoo_research" });
    for (const type of ["reasoning", "agent_message", "command_execution"]) {
      expect(codexToolCallMetadataFromOutput(JSON.stringify({ type: "item.completed", item: { type, text: frame() } })))
        .toEqual({ kind: "ignored" });
    }
    expect(codexToolCallMetadataFromOutput("{" )).toEqual({ kind: "dropped", reason: "malformed" });
    expect(codexToolCallMetadataFromOutput("x".repeat(8 * 1024 * 1024 + 1))).toEqual({ kind: "dropped", reason: "oversized" });
    expect(codexToolCallMetadataFromOutput("私".repeat(3 * 1024 * 1024))).toEqual({ kind: "dropped", reason: "oversized" });
    expect(codexToolCallMetadataFromOutput(frame("read", { result: {} }, "item.started"))).toEqual({ kind: "dropped", reason: "malformed" });
  });
});

describe("bounded CLI tool receive interval collection", () => {
  const receipt = (sequence: number, time: number, run_id = "run_000001"): CodexToolEventReceipt => ({
    run_id, sequence, received_at: "2026-11-05T00:00:00.000Z", received_monotonic_ms: time });
  const line = (event: "started" | "completed", id = "item_1", tool = "verify") => JSON.stringify({ type: `item.${event}`,
    item: { id, type: "mcp_tool_call", server: "artoo_workspace", tool, status: event === "started" ? "in_progress" : "completed", arguments: {} } });

  it("pairs only matching run/call events and returns detached safe records", () => {
    const collector = createCodexToolMetadataCollector();
    const first = collector.record(receipt(0, 10), line("started"))!;
    expect(collector.snapshot()).toMatchObject({ incomplete: true, pending_calls: 1 });
    first.call_id = "changed";
    expect(collector.record(receipt(1, 25), line("completed")))
      .toMatchObject({ pairing: "paired", cli_observed_interval_ms: 15, call_id: "item_1" });
    expect(collector.snapshot()).toMatchObject({ incomplete: false, pending_calls: 0 });
    expect(collector.record(receipt(0, 30, "run_000002"), line("completed")))
      .toMatchObject({ pairing: "missing-start" });
    const snapshot = collector.snapshot();
    expect(snapshot.counts).toMatchObject({ accepted: 3, paired: 1, missing_start: 1 });
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.records[2]).not.toHaveProperty("cli_observed_interval_ms");
    snapshot.records[0]!.call_id = "changed";
    expect(collector.snapshot().records[0]!.call_id).toBe("item_1");
  });

  it("never backfills an orphan completion and never resets an existing start", () => {
    const collector = createCodexToolMetadataCollector();
    collector.record(receipt(0, 10), line("completed", "item_1"));
    expect(collector.record(receipt(1, 15), line("started", "item_1"))).toBeUndefined();
    collector.record(receipt(2, 20), line("started", "item_2"));
    expect(collector.record(receipt(3, 30), line("started", "item_2"))).toBeUndefined();
    expect(collector.record(receipt(4, 50), line("completed", "item_2")))
      .toMatchObject({ cli_observed_interval_ms: 30 });
    expect(collector.record(receipt(4, 50), line("completed", "item_2"))).toBeUndefined();
    expect(collector.snapshot()).toMatchObject({ dropped: { duplicate: 3 }, counts: { completed: 2, paired: 1 } });
  });

  it("rejects reverse sequence, clock rollback and mismatched tool without fabricating a span", () => {
    const collector = createCodexToolMetadataCollector();
    collector.record(receipt(2, 20), line("started"));
    expect(collector.record(receipt(1, 30), line("completed"))).toBeUndefined();
    expect(collector.record(receipt(3, 19), line("completed"))).toBeUndefined();
    expect(collector.record(receipt(4, 40), line("completed", "item_1", "context"))).toBeUndefined();
    expect(collector.record(receipt(5, 50), line("completed"))).toMatchObject({ cli_observed_interval_ms: 30 });
    expect(collector.snapshot()).toMatchObject({ dropped: { out_of_order: 2, conflict: 1 }, incomplete: true });
  });

  it("keeps overlapping intervals separate instead of claiming summed stage time", () => {
    const collector = createCodexToolMetadataCollector();
    collector.record(receipt(0, 0), line("started", "item_1"));
    collector.record(receipt(1, 5), line("started", "item_2"));
    collector.record(receipt(2, 10), line("completed", "item_1"));
    collector.record(receipt(3, 15), line("completed", "item_2"));
    expect(collector.snapshot().records.filter(record => record.pairing === "paired").map(record => record.cli_observed_interval_ms)).toEqual([10, 10]);
    expect(collector.snapshot()).not.toHaveProperty("total_tool_duration_ms");
    expect(collector.snapshot().interval_aggregation).toContain("overlap");
  });

  it.each([
    { run_id: "run_PRIVATE_CONTENT" }, { sequence: -1 }, { sequence: 2147483648 }, { sequence: 0.1 },
    { received_monotonic_ms: NaN }, { received_monotonic_ms: Infinity }, { received_monotonic_ms: -1 },
    { received_at: "/private/credentials" }, { received_at: "2026-11-05" }, { private_field: "PRIVATE_CONTENT" },
  ])("rejects invalid injected receipt metadata %#", invalid => {
    const collector = createCodexToolMetadataCollector();
    expect(collector.record({ ...receipt(0, 0), ...invalid }, line("started"))).toBeUndefined();
    expect(collector.snapshot()).toMatchObject({ counts: { accepted: 0 }, dropped: { invalid_receipt: 1 }, records: [], incomplete: true });
    expect(JSON.stringify(collector.snapshot())).not.toContain("PRIVATE_CONTENT");
  });

  it("caps events without eviction or a fabricated completion", () => {
    const collector = createCodexToolMetadataCollector({ max_events: 1 });
    collector.record(receipt(0, 0), line("started"));
    expect(collector.record(receipt(1, 1), line("completed"))).toBeUndefined();
    expect(collector.snapshot()).toMatchObject({ counts: { accepted: 1, completed: 0 }, pending_calls: 1,
      dropped: { capacity: 1 }, incomplete: true });
  });

  it("caps unique calls and runs while allowing admitted calls to finish", () => {
    const collector = createCodexToolMetadataCollector({ max_calls: 1, max_runs: 1 });
    collector.record(receipt(0, 0), line("started"));
    expect(collector.record(receipt(1, 1), line("started", "item_2"))).toBeUndefined();
    expect(collector.record(receipt(0, 1, "run_000002"), line("started"))).toBeUndefined();
    expect(collector.record(receipt(2, 2), line("completed"))).toMatchObject({ pairing: "paired" });
    expect(collector.record(receipt(3, 3), line("completed"))).toBeUndefined();
    expect(collector.snapshot()).toMatchObject({ counts: { accepted: 2, paired: 1 }, dropped: { capacity: 2, duplicate: 1 } });
  });

  it("separately counts ignored, malformed and oversized input without retaining it", () => {
    const collector = createCodexToolMetadataCollector();
    collector.record(receipt(0, 0), JSON.stringify({ type: "reasoning", text: "PRIVATE_CONTENT" }));
    collector.record(receipt(1, 1), "{PRIVATE_CONTENT");
    collector.record(receipt(2, 2), "PRIVATE_CONTENT".repeat(700000));
    expect(collector.snapshot()).toMatchObject({ counts: { ignored: 1, accepted: 0 }, dropped: { malformed: 1, oversized: 1 }, records: [] });
    expect(JSON.stringify(collector.snapshot())).not.toContain("PRIVATE_CONTENT");
    expect(() => createCodexToolMetadataCollector({ max_calls: 4097 })).toThrow("Invalid tool metadata bound");
    expect(() => createCodexToolMetadataCollector({ max_events: 0 })).toThrow("Invalid tool metadata bound");
  });

  it("retains no private result or error in either returned records or aggregate snapshots", () => {
    const collector = createCodexToolMetadataCollector(), secret = "PRIVATE_CONTENT_DO_NOT_RETAIN";
    const input = JSON.parse(line("completed", "item_1", "read"));
    input.item.arguments = { path: `/private/${secret}`, token: secret };
    input.item.error = { message: secret, stack: secret };
    input.item.result = { isError: true, content: [{ type: "text", text: secret }] };
    const recorded = collector.record(receipt(0, 0), JSON.stringify(input));
    expect(recorded).toMatchObject({ error_reported: true, result_is_error: true, pairing: "missing-start" });
    expect(JSON.stringify({ recorded, summary: collector.snapshot() })).not.toMatch(/PRIVATE_CONTENT|\/private|token|arguments|stack/);
  });
});

describe("live acceptance final report", () => {
  it("keeps a successful pipeline provisional until the test and cleanup pass", () => {
    const saved: Record<string, unknown>[] = [];
    const writer = createLiveAcceptanceReportWriter((report) => saved.push(report));
    const report = { pipeline_passed: true, cleanup_passed: true, passed: true };
    writer.progress(report);
    expect(saved.at(-1)?.passed).toBe(false);
    writer.finish(report, "pass", false);
    expect(saved.at(-1)?.passed).toBe(true);
    writer.progress({ ...report, pipeline_passed: false });
    writer.finish({}, "fail", true);
    expect(saved).toHaveLength(2);
  });

  it.each([
    ["body failed", false, true, "fail", false],
    ["cleanup failed", true, false, "fail", false],
    ["body report write failed", true, true, "fail", false],
    ["test timed out", true, true, "fail", true],
    ["cancellation raced completion", true, true, "pass", true],
    ["cleanup still pending", true, undefined, "fail", true],
  ])("does not report success when %s", (_reason, pipeline, cleanup, state, aborted) => {
    const persist = vi.fn();
    const writer = createLiveAcceptanceReportWriter(persist);
    writer.finish({ pipeline_passed: pipeline, cleanup_passed: cleanup }, state as string, aborted as boolean);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ passed: false }));
  });

  it("fences late progress even if final persistence fails", () => {
    const persist = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("disk full"); });
    const writer = createLiveAcceptanceReportWriter(persist);
    writer.progress({ pipeline_passed: true });
    expect(() => writer.finish({ pipeline_passed: true, cleanup_passed: true }, "pass", false)).toThrow("disk full");
    writer.progress({ passed: true });
    expect(writer.finalized).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[0]![0]).toMatchObject({ passed: false });
  });
});

describe("live acceptance cleanup", () => {
  function fixture() {
    const order: string[] = [];
    const record = (name: string) => vi.fn(() => { order.push(name); });
    const actions: LiveAcceptanceCleanup = {
      stopDispatchers: [record("dispatcher.0"), record("dispatcher.1")], stopNode: record("node"),
      drainBinding: record("drain"), closeBinding: record("binding"), closeServer: record("server"), removeWorkspace: record("remove"),
      finalized: () => false, describeError: (error) => error instanceof Error ? error.message : String(error),
    };
    return { actions, order };
  }

  it("removes the workspace only after producers, node and server have closed", async () => {
    const { actions, order } = fixture();
    expect(await cleanupLiveAcceptance(actions)).toMatchObject({ passed: true, node_stopped: true, workspace_removed: true, errors: [] });
    expect(order).toEqual(["dispatcher.0", "dispatcher.1", "node", "drain", "binding", "server", "remove"]);
  });

  it.each(["stopNode", "drainBinding", "closeBinding", "closeServer", "removeWorkspace"] as const)("records %s failure and still tries later cleanup", async (step) => {
    const { actions } = fixture();
    actions[step] = vi.fn(() => { throw new Error(`${step} failed`); });
    const result = await cleanupLiveAcceptance(actions);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toBe(`${step} failed`);
    expect(actions.closeServer).toHaveBeenCalledOnce();
    expect(result.workspace_removed).toBe(false);
  });

  it("collects multiple failures without abandoning node or server cleanup", async () => {
    const { actions } = fixture();
    actions.stopDispatchers[0] = () => { throw new Error("dispatcher failed"); };
    actions.drainBinding = () => Promise.reject(new Error("drain failed"));
    const result = await cleanupLiveAcceptance(actions);
    expect(result.errors.map((failure) => failure.error)).toEqual(["dispatcher failed", "drain failed"]);
    expect(actions.stopNode).toHaveBeenCalledOnce();
    expect(actions.closeBinding).toHaveBeenCalledOnce();
    expect(actions.closeServer).toHaveBeenCalledOnce();
    expect(actions.removeWorkspace).not.toHaveBeenCalled();
  });

  it("retains ownership when a stop times out, even if it later resolves", async () => {
    vi.useFakeTimers();
    const { actions } = fixture();
    let resolveStop!: () => void;
    actions.stopNode = () => new Promise<void>((resolve) => { resolveStop = resolve; });
    const pending = cleanupLiveAcceptance(actions, 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ passed: false, node_stopped: false, workspace_removed: false });
    expect(result.errors[0]?.step).toBe("node.stop");
    resolveStop(); await Promise.resolve();
    expect(actions.closeServer).toHaveBeenCalledOnce();
    expect(actions.removeWorkspace).not.toHaveBeenCalled();
  });

  it("does not remove a retained workspace after the test has finalized", async () => {
    const { actions } = fixture();
    actions.finalized = () => true;
    expect(await cleanupLiveAcceptance(actions)).toMatchObject({ passed: false, node_stopped: true, workspace_removed: false });
    expect(actions.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps pending initialization owned until its late handle is closed", async () => {
    vi.useFakeTimers();
    const { actions } = fixture();
    const close = vi.fn(async () => undefined);
    let initialized!: (handle: { close(): Promise<void> }) => void;
    const initialization = new Promise<{ close(): Promise<void> }>((resolve) => { initialized = resolve; });
    actions.closeServer = async () => { const handle = await initialization; await handle.close(); };
    const pending = cleanupLiveAcceptance(actions, 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ passed: false, workspace_removed: false });
    expect(result.errors[0]?.step).toBe("server.close");
    initialized({ close }); await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(actions.removeWorkspace).not.toHaveBeenCalled();
  });
});
