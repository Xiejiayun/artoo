import { z } from "zod";
import { AllowedBrowserKeySchema, BrowserViewportV2Schema } from "./browser-program.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const operation = { index: z.number().int().min(0).max(99), page_id: z.literal("main"), planned_step_digest: digest };
const navigation = z.object({ kind: z.literal("navigation"), status_code: z.number().int().min(200).max(299) }).strict();
const completed = z.object({ kind: z.literal("action-completed") }).strict();
const assertion = z.object({ kind: z.literal("assertion"), passed: z.literal(true) }).strict();
const focusAssertion = z.object({ kind: z.literal("focus-assertion"), passed: z.literal(true) }).strict();

/** Observations are supplied after awaited protected handlers; they contain no typed text or page values. */
export const BrowserOperationV2Schema = z.discriminatedUnion("action", [
  z.object({ ...operation, action: z.literal("navigate"), observation: navigation }).strict(),
  z.object({ ...operation, action: z.literal("reload"), observation: navigation }).strict(),
  z.object({ ...operation, action: z.literal("click"), observation: completed }).strict(),
  z.object({ ...operation, action: z.literal("fill"), observation: completed }).strict(),
  z.object({ ...operation, action: z.literal("check"), observation: completed }).strict(),
  z.object({ ...operation, action: z.literal("assert_visible"), observation: assertion }).strict(),
  z.object({ ...operation, action: z.literal("assert_hidden"), observation: assertion }).strict(),
  z.object({ ...operation, action: z.literal("assert_text"), observation: assertion }).strict(),
  z.object({ ...operation, action: z.literal("assert_value"), observation: assertion }).strict(),
  z.object({ ...operation, action: z.literal("assert_count"), observation: assertion }).strict(),
  z.object({ ...operation, action: z.literal("press"), observation: z.object({ kind: z.literal("key-press"), key: AllowedBrowserKeySchema }).strict() }).strict(),
  z.object({ ...operation, action: z.literal("type_text"), observation: z.object({ kind: z.literal("keyboard-input"), text_length: z.number().int().min(1).max(1000) }).strict() }).strict(),
  z.object({ ...operation, action: z.literal("focus"), observation: z.object({ kind: z.literal("programmatic-focus"), focused: z.boolean() }).strict() }).strict(),
  z.object({ ...operation, action: z.literal("assert_focused"), observation: focusAssertion }).strict(),
  z.object({ ...operation, action: z.literal("assert_focus_within"), observation: focusAssertion }).strict(),
]);
export type BrowserOperationV2 = z.infer<typeof BrowserOperationV2Schema>;
export const MAX_BROWSER_OPERATION_TRACE_BYTES = 256 * 1024;
export const BrowserOperationTraceV2Schema = z.object({
  version: z.literal(2), format: z.literal("static-web-trace.v2"), case_id: identifier, page_id: z.literal("main"),
  viewport: BrowserViewportV2Schema, device_scale_factor: z.literal(1), program_digest: digest,
  operations: z.array(BrowserOperationV2Schema).min(1).max(100),
}).strict().superRefine((trace, ctx) => {
  trace.operations.forEach((item, index) => {
    if (item.index !== index) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "index"],
      message: "Executed operation indexes must be complete and ordered from zero" });
  });
  // Every permitted string is ASCII; the encoded length here is also its UTF-8 byte length.
  if (JSON.stringify(trace).length > MAX_BROWSER_OPERATION_TRACE_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom,
    message: "Browser operation trace exceeds its evidence byte limit" });
});
export type BrowserOperationTraceV2 = z.infer<typeof BrowserOperationTraceV2Schema>;
