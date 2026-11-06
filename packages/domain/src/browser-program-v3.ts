import { z } from "zod";
import { ProductBrowserStepV2Schema } from "./browser-program.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BrowserPageIdV3Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const BrowserActionV3Schema = z.enum(["navigate", "reload", "click", "fill", "check", "assert_visible", "assert_hidden",
  "assert_text", "assert_value", "assert_count", "press", "type_text", "focus", "assert_focused", "assert_focus_within",
  "open_page", "close_page"]);
const page = { page: BrowserPageIdV3Schema };

/** Multiple pages are explicit v3 actions; v1/v2 programs retain their original meaning. */
export const ProductBrowserStepV3Schema = z.discriminatedUnion("action", [
  ProductBrowserStepV2Schema.options[0].extend(page), ProductBrowserStepV2Schema.options[1].extend(page),
  ProductBrowserStepV2Schema.options[2].extend(page), ProductBrowserStepV2Schema.options[3].extend(page),
  ProductBrowserStepV2Schema.options[4].extend(page), ProductBrowserStepV2Schema.options[5].extend(page),
  ProductBrowserStepV2Schema.options[6].extend(page), ProductBrowserStepV2Schema.options[7].extend(page),
  ProductBrowserStepV2Schema.options[8].extend(page), ProductBrowserStepV2Schema.options[9].extend(page),
  ProductBrowserStepV2Schema.options[10].extend(page), ProductBrowserStepV2Schema.options[11].extend(page),
  ProductBrowserStepV2Schema.options[12].extend(page), ProductBrowserStepV2Schema.options[13].extend(page),
  ProductBrowserStepV2Schema.options[14].extend(page),
  z.object({ action: z.literal("open_page"), ...page, path: ProductBrowserStepV2Schema.options[0].shape.path }).strict(),
  z.object({ action: z.literal("close_page"), ...page }).strict(),
]);
export type ProductBrowserStepV3 = z.infer<typeof ProductBrowserStepV3Schema>;

export const BrowserCaptureTimingV3Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("before-close"), step_index: z.number().int().min(0).max(99) }).strict(),
  z.object({ kind: z.literal("case-end") }).strict(),
]);
export type BrowserCaptureTimingV3 = z.infer<typeof BrowserCaptureTimingV3Schema>;

/** Pure lifecycle derivation for schema-validated steps. Captures contain no execution evidence. */
export function deriveBrowserPageLifecycleV3(steps: readonly Pick<ProductBrowserStepV3, "action" | "page">[]): {
  captures: { page_id: string; timing: BrowserCaptureTimingV3 }[];
} {
  if (steps.length < 1 || steps.length > 100 || steps[0]?.action !== "navigate" || steps[0]?.page !== "main") {
    throw new Error("A v3 program must start with navigate on main and contain 1 to 100 steps");
  }
  const pages = new Map<string, BrowserCaptureTimingV3>([["main", { kind: "case-end" }]]);
  steps.forEach((step, index) => {
    if (step.action === "open_page") {
      if (pages.has(step.page)) throw new Error(`Page name cannot be reused at step ${index}`);
      if (pages.size >= 3) throw new Error(`Cumulative created page limit is three, including main, at step ${index}`);
      pages.set(step.page, { kind: "case-end" });
      return;
    }
    const lifetime = pages.get(step.page);
    if (!lifetime || lifetime.kind === "before-close") throw new Error(`Unknown or closed page at step ${index}`);
    if (step.action === "close_page") {
      if (step.page === "main") throw new Error(`Main page cannot be closed at step ${index}`);
      pages.set(step.page, { kind: "before-close", step_index: index });
    }
  });
  return { captures: [...pages].map(([page_id, timing]) => ({ page_id, timing })) };
}

export const ProductBrowserProgramV3Schema = z.object({ version: z.literal(3), contract_digest: digest,
  steps: z.array(ProductBrowserStepV3Schema).min(1).max(100) }).strict().superRefine((program, ctx) => {
  try { deriveBrowserPageLifecycleV3(program.steps); }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: (error as Error).message }); }
});
export type ProductBrowserProgramV3 = z.infer<typeof ProductBrowserProgramV3Schema>;
