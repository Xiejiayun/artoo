import { z } from "zod";
import { BrowserViewportV2Schema } from "./browser-program.js";
import { BrowserOperationV2Schema, MAX_BROWSER_OPERATION_TRACE_BYTES } from "./browser-operation-trace.js";
import { BrowserCaptureTimingV3Schema, BrowserPageIdV3Schema, deriveBrowserPageLifecycleV3 } from "./browser-program-v3.js";
import { StorageFaultTraceV1Schema, validateProductStorageChecksV1 } from "./storage-fault.js";
import { StoragePreconditionTraceV1Schema, validateStoragePreconditionReferencesV1 } from "./storage-precondition.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const page = { page_id: BrowserPageIdV3Schema };
const operation = { index: z.number().int().min(0).max(99), ...page, planned_step_digest: digest };
export const BrowserCaptureV3Schema = z.object({ ...page, timing: BrowserCaptureTimingV3Schema, screenshot_digest: digest }).strict();
export type BrowserCaptureV3 = z.infer<typeof BrowserCaptureV3Schema>;

export const BrowserOperationV3Schema = z.discriminatedUnion("action", [
  BrowserOperationV2Schema.options[0].extend(page), BrowserOperationV2Schema.options[1].extend(page),
  BrowserOperationV2Schema.options[2].extend(page), BrowserOperationV2Schema.options[3].extend(page),
  BrowserOperationV2Schema.options[4].extend(page), BrowserOperationV2Schema.options[5].extend(page),
  BrowserOperationV2Schema.options[6].extend(page), BrowserOperationV2Schema.options[7].extend(page),
  BrowserOperationV2Schema.options[8].extend(page), BrowserOperationV2Schema.options[9].extend(page),
  BrowserOperationV2Schema.options[10].extend(page), BrowserOperationV2Schema.options[11].extend(page),
  BrowserOperationV2Schema.options[12].extend(page), BrowserOperationV2Schema.options[13].extend(page),
  BrowserOperationV2Schema.options[14].extend(page),
  z.object({ ...operation, action: z.literal("open_page"), observation: z.object({ kind: z.literal("page-opened"),
    status_code: z.number().int().min(200).max(299) }).strict() }).strict(),
  z.object({ ...operation, action: z.literal("close_page"), observation: z.object({ kind: z.literal("page-closed"),
    closed: z.literal(true) }).strict() }).strict(),
]);
export type BrowserOperationV3 = z.infer<typeof BrowserOperationV3Schema>;

export const BrowserOperationTraceV3Schema = z.object({
  version: z.literal(3), format: z.literal("static-web-trace.v3"), case_id: BrowserPageIdV3Schema,
  viewport: BrowserViewportV2Schema, device_scale_factor: z.literal(1), program_digest: digest,
  operations: z.array(BrowserOperationV3Schema).min(1).max(100), captures: z.array(BrowserCaptureV3Schema).min(1).max(3),
  storage_fault: StorageFaultTraceV1Schema.optional(),
  storage_precondition: StoragePreconditionTraceV1Schema.optional(),
}).strict().superRefine((trace, ctx) => {
  trace.operations.forEach((item, index) => {
    if (item.index !== index) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "index"],
      message: "Executed operation indexes must be complete and ordered from zero" });
  });
  try {
    const expected = deriveBrowserPageLifecycleV3(trace.operations.map(({ action, page_id }) => ({ action, page: page_id })));
    const actual = trace.captures.map(({ page_id, timing }) => ({ page_id, timing }));
    if (JSON.stringify(expected.captures) !== JSON.stringify(actual)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ["captures"], message: "Captures must match actual page lifetimes and creation order" });
  } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operations"], message: (error as Error).message }); }
  if (trace.storage_fault) {
    try {
      validateProductStorageChecksV1(trace.operations.map(({ action, page_id }) => ({ action, page: page_id })), {
        version: 1, windows: trace.storage_fault.windows.map((window) => ({ id: window.id, page: "main", mode: window.mode,
          arm_before_step: window.arm_before_step, settle_after_step: window.settle_after_step,
          requirement_criteria: window.requirement_criteria, ui_assertion_steps: window.ui_assertion_steps,
          min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } })),
      });
      trace.storage_fault.windows.forEach((window, index) => {
        const start = trace.operations[window.arm_before_step]!, end = trace.operations[window.settle_after_step]!;
        const epoch = trace.operations.slice(0, window.arm_before_step + 1)
          .filter((item) => item.action === "navigate" || item.action === "reload").length;
        if (window.start_step_digest !== start.planned_step_digest || window.end_step_digest !== end.planned_step_digest
          || window.document_epoch !== epoch) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storage_fault", "windows", index],
          message: "Storage windows must bind their actual boundary steps and explicit document epoch" });
      });
    } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storage_fault"], message: (error as Error).message }); }
  }
  if (trace.storage_precondition) {
    try {
      const precondition = trace.storage_precondition;
      validateStoragePreconditionReferencesV1(trace.operations.map(({ action, page_id }) => ({ action, page: page_id })), precondition);
      if (precondition.source.case_id !== trace.case_id || precondition.program_digest !== trace.program_digest
        || precondition.initial_step_digest !== trace.operations[0]!.planned_step_digest) throw new Error("Storage precondition must bind its exact case, program and initial step");
      precondition.preservation_checks.forEach(check => {
        const actualEpoch = trace.operations.slice(0, check.after_step + 1)
          .filter(item => item.page_id === "main" && (item.action === "navigate" || item.action === "reload")).length;
        if (check.step_digest !== trace.operations[check.after_step]!.planned_step_digest || check.document_epoch !== actualEpoch) {
          throw new Error("Storage preservation must bind its actual assertion and document epoch");
        }
      });
      const firstFault = trace.storage_fault?.windows.find(window => window.arm_before_step === 0);
      if (firstFault && (firstFault.installation.script_digest !== precondition.installation.script_digest
        || JSON.stringify(firstFault.native_storage.before) !== JSON.stringify(precondition.native_storage.seeded))) {
        throw new Error("First-document storage fault baseline must follow the actual native seed readback");
      }
    } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storage_precondition"], message: (error as Error).message }); }
  }
  // Every permitted string is ASCII; the encoded length here is also its UTF-8 byte length.
  if (JSON.stringify(trace).length > MAX_BROWSER_OPERATION_TRACE_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom,
    message: "Browser operation trace exceeds its evidence byte limit" });
});
export type BrowserOperationTraceV3 = z.infer<typeof BrowserOperationTraceV3Schema>;
