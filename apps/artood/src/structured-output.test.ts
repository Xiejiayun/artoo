import { describe, expect, it } from "vitest";
import { createStructuredOutput } from "./structured-output.js";

describe("provider final answer and measured usage", () => {
  it("takes the final Codex agent message and usage, excluding tool output and commentary", () => {
    const parser = createStructuredOutput("codex-json");
    for (const event of [
      { type: "thread.started", thread_id: "thread_example" },
      { type: "item.completed", item: { type: "agent_message", text: "I will inspect it." } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "not an answer" } },
      { type: "item.completed", item: { type: "agent_message", text: "已修复，并通过测试。" } },
      { type: "turn.completed", usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } },
    ]) parser.consume(JSON.stringify(event));
    expect(parser.finish(true)).toEqual([
      { type: "run.usage", payload: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25, provider_session_id: "thread_example" } },
      { type: "run.answer", payload: { text: "已修复，并通过测试。" } },
    ]);
  });

  it("uses Claude's successful result and reported cost only", () => {
    const parser = createStructuredOutput("claude-json");
    parser.consume(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
    parser.consume(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Final answer",
      session_id: "session_example", total_cost_usd: 0.01234,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 } }));
    expect(parser.finish(true)).toEqual([
      { type: "run.usage", payload: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60,
        cost_usd: 0.01234, currency: "USD", provider_session_id: "session_example" } },
      { type: "run.answer", payload: { text: "Final answer" } },
    ]);
  });

  it("never turns plain stdout or incidental provider JSON into chat", () => {
    const parser = createStructuredOutput("plain");
    parser.consume("BUILD SUCCESSFUL");
    parser.consume(JSON.stringify({ type: "result", result: "tool output" }));
    expect(parser.finish(true)).toEqual([]);
    parser.consume(JSON.stringify({ type: "run.answer", payload: { text: "explicit fixture answer" } }));
    expect(parser.finish(true)).toEqual([{ type: "run.answer", payload: { text: "explicit fixture answer" } }]);
  });

  it("does not publish a failed provider result or incomplete answer", () => {
    const parser = createStructuredOutput("claude-json");
    parser.consume(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "Exceeded limit", total_cost_usd: 0.01 }));
    expect(parser.failureReason()).toBe("Exceeded limit");
    expect(parser.finish(true)).toEqual([{ type: "run.usage", payload: { cost_usd: 0.01, currency: "USD" } }]);
    const interrupted = createStructuredOutput("codex-json");
    interrupted.consume(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "unfinished" } }));
    expect(interrupted.finish(true)).toEqual([]);
  });

  it("omits invalid measurements and fails oversized final answers without truncating them silently", () => {
    const parser = createStructuredOutput("claude-json");
    parser.consume(JSON.stringify({ type: "result", subtype: "success", result: "x".repeat(200_001), total_cost_usd: -2,
      usage: { input_tokens: -1, output_tokens: 10.5, cache_read_input_tokens: 5 } }));
    expect(parser.failureReason()).toContain("exceeds");
    expect(parser.finish(true)).toEqual([{ type: "run.usage", payload: { cached_input_tokens: 5 } }]);
  });
});
