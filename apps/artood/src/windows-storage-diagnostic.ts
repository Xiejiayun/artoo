import { z } from "zod";

/** Local diagnostics only; neither these labels nor their schema grant storage authority. */
const codes = ["storage_binding_rejected", "storage_boundary_rejected", "storage_acl_rejected", "storage_inventory_changed",
  "acl_input_rejected", "acl_collector_failed", "acl_facts_rejected", "filesystem_observation_failed"] as const;
const fields = ["added", "removed", "identity", "ctime", "mtime", "size"] as const;
export type WindowsStorageFailureCode = typeof codes[number];
export type WindowsStorageChangeField = typeof fields[number];
export const WindowsStorageFailureSchema = z.object({ code: z.enum(codes),
  first_change_fields: z.array(z.enum(fields)).min(1).max(fields.length).readonly().optional(),
}).strict().superRefine((value, context) => {
  if (value.first_change_fields !== undefined && (value.code !== "storage_inventory_changed"
    || new Set(value.first_change_fields).size !== value.first_change_fields.length))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid storage change fields" });
}).readonly();
type WindowsStorageFailure = z.infer<typeof WindowsStorageFailureSchema>;
const failures = new WeakMap<object, WindowsStorageFailure>();

/** Preserve the original value and first local classification, including unknown filesystem failures. */
export function markWindowsStorageFailure<T>(error: T, code: WindowsStorageFailureCode,
  firstChangeFields?: readonly WindowsStorageChangeField[]): T {
  if (error !== null && (typeof error === "object" || typeof error === "function") && !failures.has(error)) {
    try {
      const parsed = WindowsStorageFailureSchema.safeParse({ code,
        ...(firstChangeFields === undefined ? {} : { first_change_fields: firstChangeFields }) });
      if (parsed.success) failures.set(error, parsed.data);
    } catch { /* Optional diagnostics must never replace the original rejection. */ }
  }
  return error;
}
/** Exact local identity only: do not inspect properties, prototypes, messages or cause chains. */
export function readWindowsStorageFailure(error: unknown): WindowsStorageFailure | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? failures.get(error) : undefined;
}
