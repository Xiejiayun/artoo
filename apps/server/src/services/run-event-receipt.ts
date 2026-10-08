import { createHash } from "node:crypto";
import { MANAGED_RECEIPT_CONTRACT, runEventMessageSchema, type RunEventMessage } from "@artoo/protocol";
import { runEventIngest, runs } from "@artoo/db";
import type { ServerContext } from "../context.js";

export const QUALIFIED_RECEIPT_PROFILE = MANAGED_RECEIPT_CONTRACT;
/** Read-only structural check; no identity backfill or transaction-commit claim. */
export async function requireQualifiedReceiptSchema(ctx: ServerContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all([
      ctx.db.db.select({ identity: runEventIngest.bodyIdentity }).from(runEventIngest).limit(0),
      ctx.db.db.select({ allocation: runs.workspaceAllocation }).from(runs).limit(0),
    ]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Receipt schema readiness expired")), 10000); })]);
  } finally { clearTimeout(timer); }
}

/** Deterministic JSON for the complete parsed event, not its domain projection. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("run event contains a non-JSON value");
}

/**
 * Model serialized-wire semantics before applying the unchanged protocol schema.
 * JSON may omit undefined object fields or honor toJSON; only unserializable
 * frames necessarily fail this step. Defaults/stripping belong to the schema.
 * The returned detached parsed frame feeds both the identity and domain mapper.
 */
export function qualifyRunEventMessage(raw: unknown): { message: RunEventMessage; bodyIdentity: string } {
  const wire = JSON.stringify(raw);
  if (wire === undefined) throw new Error("run event is not a JSON frame");
  const message = runEventMessageSchema.parse(JSON.parse(wire));
  const digest = createHash("sha256").update("artoo.run-event.body/v1\0", "utf8")
    .update(canonicalJson(message.event), "utf8").digest("hex");
  return { message, bodyIdentity: `${QUALIFIED_RECEIPT_PROFILE}:sha256:${digest}` };
}
