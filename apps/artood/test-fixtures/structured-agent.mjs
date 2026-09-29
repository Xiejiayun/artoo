import { setTimeout } from "node:timers/promises";

const format = process.argv[2];
const answer = "已完成你的请求，测试通过。";
const events = format === "codex" ? [
  { type: "thread.started", thread_id: "fixture_codex" },
  { type: "item.completed", item: { type: "agent_message", text: "Inspecting files" } },
  { type: "item.completed", item: { type: "command_execution", aggregated_output: "tool log only" } },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage: { input_tokens: 101, output_tokens: 22, cached_input_tokens: 30 } },
] : format === "claude" ? [
  { type: "assistant", message: { content: [{ type: "text", text: "Inspecting files" }] } },
  { type: "result", subtype: "success", result: answer, session_id: "fixture_claude", total_cost_usd: 0.005,
    usage: { input_tokens: 91, output_tokens: 18, cache_read_input_tokens: 20 } },
] : [
  { type: "result", subtype: "error_max_turns", is_error: true, result: "Turn limit reached", total_cost_usd: 0.002 },
];
for (const event of events) {
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  const split = bytes.indexOf(Buffer.from("已"));
  if (split >= 0) {
    process.stdout.write(bytes.subarray(0, split + 1));
    await setTimeout(20);
    process.stdout.write(bytes.subarray(split + 1));
  } else process.stdout.write(bytes);
}
