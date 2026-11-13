import { RunActivityPayloadSchema, RunOperationSchema, type RunActivityPayload, type RunOperation } from "@artoo/domain";
import type { ProcessOutputFormat } from "./structured-output.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
/** Normalize only documented tool records; never collect internal reasoning items. */
export function createStructuredActivity(format: ProcessOutputFormat, sanitize: (text: string) => string = text => text) {
  function detail(value: unknown, limit: number): { text: string; truncated: boolean } | undefined {
    if (value === undefined) return undefined;
    const text = sanitize(typeof value === "string" ? value : JSON.stringify(value));
    return { text: text.slice(0, limit), truncated: text.length > limit };
  }
  function operation(id: unknown, name: unknown, phase: RunOperation["phase"], request?: unknown, response?: unknown, exitCode?: unknown): RunOperation | undefined {
    const input = detail(request, 16_000), output = detail(response, 32_000);
    const parsed = RunOperationSchema.safeParse({ call_id: typeof id === "string" ? sanitize(id) : id,
      name: typeof name === "string" ? sanitize(name) : name, phase,
      ...(input ? { request: input.text, ...(input.truncated ? { request_truncated: true } : {}) } : {}),
      ...(output ? { response: output.text, ...(output.truncated ? { response_truncated: true } : {}) } : {}),
      ...((typeof exitCode === "number" && Number.isSafeInteger(exitCode)) || exitCode === null ? { exit_code: exitCode } : {}),
    });
    return parsed.success ? parsed.data : undefined;
  }

  const names = new Map<string, string>();
  return (event: RecordValue): RunActivityPayload | undefined => {
    const operations: RunOperation[] = [];
    const add = (value: RunOperation | undefined) => { if (value) operations.push(value); };
    if (format === "codex-json" && ["item.started", "item.updated", "item.completed"].includes(String(event.type))) {
      const item = record(event.item);
      if (!item) return;
      const failed = item.status === "failed" || item.error != null || typeof item.exit_code === "number" && item.exit_code !== 0;
      const phase = failed ? "failed" : event.type === "item.completed" ? "completed" : event.type === "item.updated" ? "updated" : "started";
      if (item.type === "command_execution") add(operation(item.id, item.type, phase, item.command, item.aggregated_output, item.exit_code));
      else if (item.type === "mcp_tool_call") add(operation(item.id, item.type, phase,
        { server: item.server, tool: item.tool, arguments: item.arguments }, item.error ?? item.result));
      else if (item.type === "file_change") add(operation(item.id, item.type, phase, undefined, item.changes));
      else if (item.type === "web_search") add(operation(item.id, item.type, phase, item.query, item.action));
    } else if (format === "claude-json" && ["assistant", "user"].includes(String(event.type))) {
      const content = record(event.message)?.content;
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        const block = record(raw);
        if (block?.type === "tool_use" && event.type === "assistant") {
          const value = operation(block.id, block.name, "started", block.input);
          if (value) {
            // Correlation metadata is bounded; unmatched results remain explicit tool_result records.
            if (names.size >= 1024) names.delete(names.keys().next().value!);
            names.set(block.id as string, value.name);
          }
          add(value);
        } else if (block?.type === "tool_result" && event.type === "user") {
          const id = block.tool_use_id;
          add(operation(id, typeof id === "string" ? names.get(id) ?? "tool_result" : "tool_result",
            block.is_error === true ? "failed" : "completed", undefined, block.content));
          if (typeof id === "string") names.delete(id);
        }
      }
    } else if (format === "plain" && event.type === "run.activity") {
      const parsed = RunActivityPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const safeOperations = parsed.data.operations.flatMap(value => {
        const safe = operation(value.call_id, value.name, value.phase, value.request, value.response, value.exit_code);
        return safe ? [{ ...value, ...safe }] : [];
      });
      return safeOperations.length ? { ...parsed.data, operations: safeOperations } : undefined;
    }
    return operations.length ? { version: 1, operations: operations.slice(0, 64),
      ...(operations.length > 64 ? { omitted_operations: operations.length - 64 } : {}) } : undefined;
  };
}
