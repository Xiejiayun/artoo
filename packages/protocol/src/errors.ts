import { z } from "zod";

/**
 * Closed set of node command error codes (design.md §4.6). The server maps each
 * code to a recovery rule, so this set is a frozen contract — extend only via a
 * protocol version bump.
 */
export const NODE_ERROR_CODES = [
  "runtime_missing",
  "workspace_missing",
  "permission_denied",
  "process_start_failed",
  "process_exited",
  "artifact_not_found",
  "timeout",
  "internal_error"
] as const;

export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number];

export const nodeErrorCodeSchema = z.enum(NODE_ERROR_CODES);

export function isNodeErrorCode(value: unknown): value is NodeErrorCode {
  return typeof value === "string" && (NODE_ERROR_CODES as readonly string[]).includes(value);
}
