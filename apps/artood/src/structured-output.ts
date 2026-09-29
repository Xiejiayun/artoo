import { RunAnswerPayloadSchema, RunUsagePayloadSchema, type RunUsagePayload } from "@artoo/domain";
import type { RunEvent } from "@artoo/protocol";

export type ProcessOutputFormat = "plain" | "codex-json" | "claude-json";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/**
 * JSONL contracts: https://developers.openai.com/codex/noninteractive/ and
 * https://code.claude.com/docs/en/headless. Intermediate assistant/tool messages
 * remain audit output; only the terminal provider answer becomes room chat.
 */
export function createStructuredOutput(format: ProcessOutputFormat) {
  let candidate: string | undefined;
  let answer: string | undefined;
  let usage: RunUsagePayload | undefined;
  let sessionId: string | undefined;
  let failure: string | undefined;

  function saveUsage(value: RecordValue | undefined, cost?: unknown) {
    const fields: RunUsagePayload = {};
    const count = (key: string) => {
      const number = value?.[key];
      return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
    };
    const input = count("input_tokens"), output = count("output_tokens");
    const cached = count(format === "claude-json" ? "cache_read_input_tokens" : "cached_input_tokens");
    if (input !== undefined) fields.input_tokens = input;
    if (output !== undefined) fields.output_tokens = output;
    if (cached !== undefined) fields.cached_input_tokens = cached;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) { fields.cost_usd = cost; fields.currency = "USD"; }
    if (sessionId !== undefined) fields.provider_session_id = sessionId;
    if (Object.keys(fields).length > 0) usage = fields;
  }

  return {
    consume(line: string): void {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      const event = record(parsed);
      if (!event) return;
      if (format === "codex-json") {
        if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.length <= 500) sessionId = event.thread_id;
        const item = record(event.item);
        if (event.type === "item.completed" && item?.type === "agent_message") {
          const valid = RunAnswerPayloadSchema.safeParse({ text: item.text });
          if (valid.success) candidate = valid.data.text;
          else if (typeof item.text === "string" && item.text.length > 200_000) failure = "assistant answer exceeds 200000 characters";
        }
        if (event.type === "turn.completed") { answer = candidate; saveUsage(record(event.usage)); }
        if (event.type === "turn.failed" || event.type === "error") {
          const error = record(event.error);
          failure = typeof error?.message === "string" ? error.message : typeof event.message === "string" ? event.message : "provider reported a failed turn";
          answer = undefined;
        }
      } else if (format === "claude-json") {
        if (typeof event.session_id === "string" && event.session_id.length <= 500) sessionId = event.session_id;
        if (event.type !== "result") return;
        saveUsage(record(event.usage), event.total_cost_usd);
        if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
          failure = typeof event.result === "string" && event.result !== "" ? event.result : "provider reported a failed turn";
          answer = undefined;
          return;
        }
        const valid = RunAnswerPayloadSchema.safeParse({ text: event.result });
        if (valid.success) answer = valid.data.text;
        else if (typeof event.result === "string" && event.result.length > 200_000) failure = "assistant answer exceeds 200000 characters";
      } else {
        // Deterministic/custom adapters may deliberately emit protocol frames.
        // Plain logs or provider-shaped JSON are never guessed to be answers.
        if (event.type === "run.answer") {
          const valid = RunAnswerPayloadSchema.safeParse(event.payload);
          if (valid.success) answer = valid.data.text;
        } else if (event.type === "run.usage") {
          const valid = RunUsagePayloadSchema.safeParse(event.payload);
          if (valid.success) usage = valid.data;
        }
      }
    },
    finish(success: boolean): RunEvent[] {
      const events: RunEvent[] = [];
      if (usage !== undefined) events.push({ type: "run.usage", payload: usage });
      if (success && failure === undefined && answer !== undefined) events.push({ type: "run.answer", payload: { text: answer } });
      return events;
    },
    failureReason(): string | undefined { return failure; },
  };
}
