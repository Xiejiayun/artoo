import { createHash } from "node:crypto";
import { z } from "zod";

/** Internal, unadvertised application-data contract. It does not grant execution authority. */
export const APPLICATION_DATA_LIMITS = Object.freeze({
  schemaBytes: 32_768, requestBytes: 65_536, replyBytes: 262_144,
  tables: 8, columns: 16, operations: 32, rowsPerQuery: 100,
  rowsPerTable: 10_000, ledgerEntries: 10_000, textBytes: 4_096,
  permitMilliseconds: 30_000, executionMilliseconds: 1_000,
});

export type ApplicationDataErrorCode = "invalid-schema" | "invalid-request" | "scope-mismatch"
  | "unauthorized" | "expired" | "revoked" | "aborted" | "idempotency-conflict"
  | "limit" | "storage-unavailable" | "closed";
export class ApplicationDataError extends Error {
  constructor(readonly code: ApplicationDataErrorCode) {
    super(`Application data request failed: ${code}`);
    this.name = "ApplicationDataError";
  }
}

const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const scalar = z.union([z.string().max(APPLICATION_DATA_LIMITS.textBytes), safeInteger, z.boolean(), z.null()]);
export type ApplicationDataScalar = z.infer<typeof scalar>;

const column = z.discriminatedUnion("type", [
  z.object({ name, type: z.literal("text"), nullable: z.boolean(),
    max_bytes: z.number().int().min(1).max(APPLICATION_DATA_LIMITS.textBytes) }).strict(),
  z.object({ name, type: z.literal("integer"), nullable: z.boolean(), min: safeInteger, max: safeInteger }).strict(),
  z.object({ name, type: z.literal("boolean"), nullable: z.boolean() }).strict(),
]);
const schema = z.object({ version: z.literal(1), tables: z.array(z.object({
  name, columns: z.array(column).min(1).max(APPLICATION_DATA_LIMITS.columns),
}).strict()).min(1).max(APPLICATION_DATA_LIMITS.tables) }).strict();
export type ApplicationDataSchema = z.infer<typeof schema>;
export type ApplicationDataColumn = ApplicationDataSchema["tables"][number]["columns"][number];

const query = z.object({ kind: z.literal("query"), table: name,
  columns: z.array(name).min(1).max(APPLICATION_DATA_LIMITS.columns + 2),
  id: identity.optional(), after: identity.optional(),
  limit: z.number().int().min(1).max(APPLICATION_DATA_LIMITS.rowsPerQuery),
}).strict();
const values = z.record(name, scalar);
const insert = z.object({ kind: z.literal("insert"), table: name, id: identity, values }).strict();
const update = z.object({ kind: z.literal("compare-and-set"), table: name, id: identity,
  expected_revision: revision, values }).strict();
const remove = z.object({ kind: z.literal("delete"), table: name, id: identity, expected_revision: revision }).strict();
const operation = z.discriminatedUnion("kind", [query, insert, update, remove]);
const request = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("read"), query }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("transaction"), idempotency_key: identity,
    operations: z.array(operation).min(1).max(APPLICATION_DATA_LIMITS.operations) }).strict(),
]);
export type ApplicationDataOperation = z.infer<typeof operation>;
export type ApplicationDataRequest = z.infer<typeof request>;

export const ApplicationDataScopeSchema = z.object({ product_id: identity, data_generation: identity,
  service_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  artifact_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
export type ApplicationDataScope = z.infer<typeof ApplicationDataScopeSchema>;

export function canonicalApplicationDataJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) return JSON.stringify(value);
  if (typeof value !== "object") throw new ApplicationDataError("invalid-request");
  if (Array.isArray(value)) return `[${value.map(canonicalApplicationDataJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalApplicationDataJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function applicationDataDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalApplicationDataJson(value)).digest("hex")}`;
}

function parseJson(text: string, maximum: number, code: "invalid-schema" | "invalid-request"): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximum) throw new ApplicationDataError(code);
  try { return JSON.parse(text); } catch { throw new ApplicationDataError(code); }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function reject(condition: boolean, code: "invalid-schema" | "invalid-request"): asserts condition {
  if (!condition) throw new ApplicationDataError(code);
}

/** JSON text keeps getters, prototypes and executable values outside the data boundary. */
export function parseApplicationDataSchema(json: string): ApplicationDataSchema {
  const parsed = schema.safeParse(parseJson(json, APPLICATION_DATA_LIMITS.schemaBytes, "invalid-schema"));
  if (!parsed.success) throw new ApplicationDataError("invalid-schema");
  const result = parsed.data;
  reject(new Set(result.tables.map(table => table.name)).size === result.tables.length, "invalid-schema");
  for (const table of result.tables) {
    reject(new Set(table.columns.map(field => field.name)).size === table.columns.length, "invalid-schema");
    for (const field of table.columns) {
      reject(field.name !== "id" && field.name !== "revision", "invalid-schema");
      if (field.type === "integer") reject(field.min <= field.max, "invalid-schema");
    }
  }
  // Definition order is immaterial, but every declared constraint is part of the schema pin.
  const order = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1;
  result.tables.sort(order);
  for (const table of result.tables) table.columns.sort(order);
  return freeze(result);
}

export function applicationDataTable(schemaValue: ApplicationDataSchema, tableName: string): ApplicationDataSchema["tables"][number] {
  const table = schemaValue.tables.find(item => item.name === tableName);
  if (!table) throw new ApplicationDataError("invalid-request");
  return table;
}
function checkValue(field: ApplicationDataColumn, value: ApplicationDataScalar): void {
  if (value === null) { reject(field.nullable, "invalid-request"); return; }
  if (field.type === "text") reject(typeof value === "string" && Buffer.byteLength(value, "utf8") <= field.max_bytes, "invalid-request");
  else if (field.type === "boolean") reject(typeof value === "boolean", "invalid-request");
  else reject(typeof value === "number" && Number.isSafeInteger(value) && value >= field.min && value <= field.max, "invalid-request");
}
function checkOperation(schemaValue: ApplicationDataSchema, item: ApplicationDataOperation): void {
  const table = applicationDataTable(schemaValue, item.table);
  if (item.kind === "query") {
    reject(!(item.id !== undefined && item.after !== undefined), "invalid-request");
    reject(new Set(item.columns).size === item.columns.length, "invalid-request");
    for (const field of item.columns) reject(field === "id" || field === "revision" || table.columns.some(value => value.name === field), "invalid-request");
  } else if (item.kind === "insert" || item.kind === "compare-and-set") {
    const names = Object.keys(item.values);
    reject(names.length > 0 && names.length <= table.columns.length, "invalid-request");
    if (item.kind === "insert") reject(names.length === table.columns.length, "invalid-request");
    for (const fieldName of names) {
      const field = table.columns.find(value => value.name === fieldName);
      reject(field !== undefined, "invalid-request");
      checkValue(field, item.values[fieldName]!);
    }
  }
}
export function parseApplicationDataRequest(json: string, schemaValue: ApplicationDataSchema): {
  request: ApplicationDataRequest; digest: string; requiresWrite: boolean;
} {
  const parsed = request.safeParse(parseJson(json, APPLICATION_DATA_LIMITS.requestBytes, "invalid-request"));
  if (!parsed.success) throw new ApplicationDataError("invalid-request");
  const result = parsed.data;
  const operations = result.kind === "read" ? [result.query] : result.operations;
  operations.forEach(item => checkOperation(schemaValue, item));
  const requiresWrite = operations.some(item => item.kind !== "query");
  reject(result.kind !== "transaction" || requiresWrite, "invalid-request");
  return { request: freeze(result), digest: applicationDataDigest(result), requiresWrite };
}
