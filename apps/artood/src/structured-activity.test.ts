import { RunOutputPayloadSchema } from "@artoo/domain";
import { adapterRunEventBodySchema, runEventMessageSchema } from "@artoo/protocol";
import { expect, it } from "vitest";
import { createStructuredOutput } from "./structured-output.js";

it("captures Codex command requests, results, errors and other tool operations without reasoning", () => {
  const parser = createStructuredOutput("codex-json");
  const consume = (type: string, item: Record<string, unknown>) => parser.consume(JSON.stringify({ type, item }));
  expect(consume("item.started", { id: "cmd1", type: "command_execution", command: "npm test", status: "in_progress" })).toMatchObject({
    version: 1, operations: [{ call_id: "cmd1", name: "command_execution", phase: "started", request: "npm test" }],
  });
  expect(consume("item.completed", { id: "cmd1", type: "command_execution", command: "npm test", aggregated_output: "Failed assertion", exit_code: 1, status: "completed" })).toMatchObject({
    operations: [{ call_id: "cmd1", phase: "failed", request: "npm test", response: "Failed assertion", exit_code: 1 }],
  });
  expect(consume("item.completed", { id: "mcp1", type: "mcp_tool_call", server: "local", tool: "lookup", arguments: { path: "test.ts" }, result: { found: true } })).toMatchObject({
    operations: [{ name: "mcp_tool_call", request: '{"server":"local","tool":"lookup","arguments":{"path":"test.ts"}}', response: '{"found":true}' }],
  });
  expect(consume("item.completed", { id: "file1", type: "file_change", changes: [{ path: "test.ts", kind: "update" }] })?.operations[0]?.name).toBe("file_change");
  expect(consume("item.completed", { id: "web1", type: "web_search", query: "docs" })?.operations[0]?.request).toBe("docs");
  expect(consume("item.completed", { id: "private", type: "reasoning", text: "Private reasoning" })).toBeUndefined();
  expect(consume("item.completed", { type: "command_execution" })).toBeUndefined();
});

it("correlates concurrent Claude tool calls and preserves failures and unmatched results", () => {
  const parser = createStructuredOutput("claude-json");
  const start = parser.consume(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "a", name: "Read", input: { file_path: "a.ts" } },
    { type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } },
    { type: "thinking", thinking: "Private reasoning" },
  ] } }));
  expect(start?.operations.map(value => [value.call_id, value.name, value.phase])).toEqual([["a", "Read", "started"], ["b", "Bash", "started"]]);
  const result = parser.consume(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "b", content: "Test failed", is_error: true },
    { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "file content" }] },
    { type: "tool_result", tool_use_id: "unknown", content: "result" },
  ] } }));
  expect(result?.operations.map(value => [value.call_id, value.name, value.phase])).toEqual([["b", "Bash", "failed"], ["a", "Read", "completed"], ["unknown", "tool_result", "completed"]]);
  expect(parser.finish(true)).toEqual([]);
});

it("redacts before bounding details and reports omitted operations explicitly", () => {
  const secret = "private-boundary-key";
  const parser = createStructuredOutput("codex-json", text => text.replaceAll(secret, "[redacted]"));
  const result = parser.consume(JSON.stringify({ type: "item.completed", item: {
    id: "a", type: "command_execution", command: "x".repeat(15_998) + secret, aggregated_output: "y".repeat(31_998) + secret,
  } }));
  expect(result?.operations[0]?.request).toHaveLength(16_000);
  expect(result?.operations[0]?.response).toHaveLength(32_000);
  expect(result?.operations[0]).toMatchObject({ request_truncated: true, response_truncated: true });
  expect(JSON.stringify(result)).not.toContain("private");
  const claude = createStructuredOutput("claude-json");
  const many = claude.consume(JSON.stringify({ type: "assistant", message: { content: Array.from({ length: 70 }, (_, i) => ({ type: "tool_use", id: `c${i}`, name: "Read", input: {} })) } }));
  expect(many?.operations).toHaveLength(64);
  expect(many?.omitted_operations).toBe(6);
});

it("preserves old output and validates optional versioned activity through the actual wire schemas", () => {
  const old = { stream: "stdout", text: "plain log" };
  expect(RunOutputPayloadSchema.parse(old)).toEqual(old);
  const activity = { version: 1, operations: [{ call_id: "c1", name: "Read", phase: "completed", response: "内容" }] };
  const body = { type: "run.output", payload: { ...old, activity } };
  const frame = { kind: "run.event", node_id: "node1", run_id: "run1", sequence: 1, event: body };
  expect(runEventMessageSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  expect(adapterRunEventBodySchema.parse(body)).toEqual(body);
  for (const bad of [{ ...activity, version: 2 }, { version: 1, operations: [] }, { version: 1, operations: [{ ...activity.operations[0], response: "x".repeat(32_001) }] }]) {
    expect(RunOutputPayloadSchema.safeParse({ ...old, activity: bad }).success).toBe(false);
  }
  const plain = createStructuredOutput("plain");
  expect(plain.consume(JSON.stringify({ type: "run.activity", payload: activity }))).toEqual(activity);
  expect(plain.consume(JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "unrecognized provider record" } }))).toBeUndefined();
});
