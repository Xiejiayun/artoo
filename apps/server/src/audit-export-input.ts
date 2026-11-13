import { AppError } from "./errors.js";

/** Old consumers retain v1alpha1; unsupported negotiation never silently downgrades. */
export function wantsSignedAuditExport(query: unknown): boolean {
  const signing = (query as { signing?: unknown } | undefined)?.signing;
  if (signing === undefined) return false;
  if (signing !== "ed25519-v1") throw AppError.validation("Unsupported audit signing format");
  return true;
}
