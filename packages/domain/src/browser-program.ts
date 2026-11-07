import { z } from "zod";

const text = z.string().trim().min(1).max(10000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

/** Declarative v1 actions retain their original validation and meaning. */
export const ProductBrowserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), path: z.string().min(1).max(2048).refine((value) => value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020]/u.test(value), "Expected a local URL path") }).strict(),
  z.object({ action: z.literal("reload") }).strict(),
  z.object({ action: z.literal("click"), selector: text }).strict(),
  z.object({ action: z.literal("fill"), selector: text, value: z.string().max(10000) }).strict(),
  z.object({ action: z.literal("check"), selector: text, checked: z.boolean() }).strict(),
  z.object({ action: z.literal("assert_visible"), selector: text }).strict(),
  z.object({ action: z.literal("assert_hidden"), selector: text }).strict(),
  z.object({ action: z.literal("assert_text"), selector: text, text }).strict(),
  z.object({ action: z.literal("assert_value"), selector: text, value: z.string().max(10000) }).strict(),
  z.object({ action: z.literal("assert_count"), selector: text, count: z.number().int().min(0).max(1000) }).strict(),
]);
export type ProductBrowserStep = z.infer<typeof ProductBrowserStepSchema>;

export const AllowedBrowserKeySchema = z.enum(["Tab", "Shift+Tab", "Enter", "Escape", "Space", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"]);
export type AllowedBrowserKey = z.infer<typeof AllowedBrowserKeySchema>;
export const BrowserActionV2Schema = z.enum(["navigate", "reload", "click", "fill", "check", "assert_visible", "assert_hidden",
  "assert_text", "assert_value", "assert_count", "press", "type_text", "focus", "assert_focused", "assert_focus_within"]);

const mainPage = { page: z.literal("main") };
/** V2 is explicit and main-page only; arbitrary keys, scripts and page names are unsupported. */
export const ProductBrowserStepV2Schema = z.discriminatedUnion("action", [
  ProductBrowserStepSchema.options[0].extend(mainPage), ProductBrowserStepSchema.options[1].extend(mainPage),
  ProductBrowserStepSchema.options[2].extend(mainPage), ProductBrowserStepSchema.options[3].extend(mainPage),
  ProductBrowserStepSchema.options[4].extend(mainPage), ProductBrowserStepSchema.options[5].extend(mainPage),
  ProductBrowserStepSchema.options[6].extend(mainPage), ProductBrowserStepSchema.options[7].extend(mainPage),
  ProductBrowserStepSchema.options[8].extend(mainPage), ProductBrowserStepSchema.options[9].extend(mainPage),
  z.object({ action: z.literal("press"), ...mainPage, key: AllowedBrowserKeySchema }).strict(),
  z.object({ action: z.literal("type_text"), ...mainPage, text: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("focus"), ...mainPage, selector: text }).strict(),
  z.object({ action: z.literal("assert_focused"), ...mainPage, selector: text }).strict(),
  z.object({ action: z.literal("assert_focus_within"), ...mainPage, selector: text }).strict(),
]);
export type ProductBrowserStepV2 = z.infer<typeof ProductBrowserStepV2Schema>;
export const ProductBrowserProgramV2Schema = z.object({ version: z.literal(2), contract_digest: digest,
  steps: z.array(ProductBrowserStepV2Schema).min(1).max(100) }).strict();
export type ProductBrowserProgramV2 = z.infer<typeof ProductBrowserProgramV2Schema>;

export const BrowserViewportV2Schema = z.object({ id: identifier, width: z.number().int().min(240).max(8192),
  height: z.number().int().min(240).max(8192) }).strict()
  .refine((viewport) => viewport.width * viewport.height <= 32_000_000, "Viewport exceeds the screenshot pixel limit");
export type BrowserViewportV2 = z.infer<typeof BrowserViewportV2Schema>;
