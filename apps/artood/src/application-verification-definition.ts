import { createHash } from "node:crypto";
import { z } from "zod";
import { ProductBrowserProgramV3Schema, ProductDesignSchema, type ProductBrowserProgramV3 } from "@artoo/domain";
import { parseApplicationDataSchema, canonicalApplicationDataJson, type ApplicationDataSchema } from "./application-data-contract.js";

const apiPath = z.string().min(4).max(1024).refine(value => {
  if (!/^\/api(?:\/|\?|$)/u.test(value) || /[\\#\u0000-\u0020\u007f]/u.test(value)) return false;
  const parsed = new URL(value, "http://127.0.0.1:1234");
  return parsed.origin === "http://127.0.0.1:1234" && parsed.pathname + parsed.search === value;
}, "Expected a bounded same-origin API path");
const schema = z.object({ version: z.literal(1), format: z.literal("artoo.application-definition.v1"), schema: z.unknown(),
  persistence: z.object({
    write: z.object({ path: apiPath, body: z.unknown(), expected_status: z.union([z.literal(200), z.literal(201)]), expected_json: z.unknown() }).strict(),
    read: z.object({ path: apiPath, expected_status: z.literal(200), expected_json: z.unknown() }).strict(),
    after_restart_browser_program: ProductBrowserProgramV3Schema,
  }).strict(),
}).strict();
export interface ApplicationVerificationDefinition {
  readonly schema: ApplicationDataSchema; readonly schemaJson: string; readonly schemaDigest: string;
  readonly persistence: z.infer<typeof schema>["persistence"];
  readonly cases: readonly { readonly id: string; readonly program: ProductBrowserProgramV3 }[];
}
const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Declarative product data only. Native paths, argv, grants and profile values are absent. */
export function readApplicationVerificationDefinition(definitionText: string, designText: string,
  contractDigest: string): ApplicationVerificationDefinition {
  if (Buffer.byteLength(definitionText) > 262_144) throw Error("Application definition exceeds bound");
  const decoded: unknown = JSON.parse(definitionText, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw Error("Nonfinite application value"); return item;
  });
  let members = 0;
  const bound = (value: unknown, depth: number): void => {
    if (++members > 16_384 || depth > 32) throw Error("Application definition shape exceeds bound");
    if (value !== null && typeof value === "object") for (const item of Object.values(value)) bound(item, depth + 1);
  };
  bound(decoded, 0);
  const value = schema.parse(decoded);
  const data = parseApplicationDataSchema(JSON.stringify(value.schema));
  const schemaJson = canonicalApplicationDataJson(data);
  for (const json of [value.persistence.write.body, value.persistence.write.expected_json, value.persistence.read.expected_json]) {
    const text = JSON.stringify(json);
    if (text === undefined || Buffer.byteLength(text) > 65_536) throw Error("Application persistence JSON exceeds bound");
  }
  const after = value.persistence.after_restart_browser_program;
  const reads = new Set(["navigate", "assert_visible", "assert_hidden", "assert_text", "assert_value", "assert_count"]);
  if (after.contract_digest !== contractDigest || after.steps.some(step => step.page !== "main" || !reads.has(step.action))
    || after.steps[0]?.action !== "navigate" || !after.steps.some(step => ["assert_text", "assert_value", "assert_count"].includes(step.action))) {
    throw Error("Application reopen requires a bound read-only substantive browser program");
  }
  const design = ProductDesignSchema.parse(JSON.parse(designText));
  const cases = design.validation_cases.map(item => {
    if ("method" in item && item.method !== "workspace-check") throw Error("Application development cannot claim static publication");
    if (!item.browser_program || item.browser_program.version !== 3 || item.storage_checks
      || "storage_precondition" in item && item.storage_precondition) throw Error("Application cases require unchanged v3 programs without storage injection");
    return Object.freeze({ id: item.id, program: ProductBrowserProgramV3Schema.parse(item.browser_program) });
  });
  if (!cases.length || cases.length > 50) throw Error("Application case bound exceeded");
  return freeze({ schema: data, schemaJson, schemaDigest: sha(schemaJson), persistence: value.persistence, cases });
}
