import { AppError } from "../errors.js";

/** v1 search is a literal substring, not SQL wildcards or a query language. */
export function parseSearchQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200 || !value.trim() || value.includes("\0")) {
    throw AppError.validation("q must contain 1 to 200 characters of search text");
  }
  return value.trim();
}

export function literalSearchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
