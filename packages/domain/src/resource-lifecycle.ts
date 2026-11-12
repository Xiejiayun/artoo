import { z } from "zod";

export const DEFAULT_RESOURCE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Read-time lifecycle; expiration never revokes authorization or erases history. */
export const ResourceLifecycleSchema = z.object({
  version: z.literal(1),
  state: z.enum(["active", "expired"]),
  last_seen_at: z.string().nullable(),
  expires_at: z.string(),
  inactivity_timeout_ms: z.number().int().positive(),
});
export type ResourceLifecycle = z.infer<typeof ResourceLifecycleSchema>;

export function deriveResourceLifecycle(lastSeenAt: string | null, createdAt: string, now: string,
  connected: boolean, timeoutMs = DEFAULT_RESOURCE_EXPIRY_MS): ResourceLifecycle {
  const last = lastSeenAt === null ? null : new Date(lastSeenAt).toISOString();
  // A newly registered workspace gets its own full inactivity window.
  const expires = Math.max(Date.parse(createdAt), last === null ? 0 : Date.parse(last)) + timeoutMs;
  return { version: 1, state: !connected && Date.parse(now) >= expires ? "expired" : "active",
    last_seen_at: last, expires_at: new Date(expires).toISOString(), inactivity_timeout_ms: timeoutMs };
}
