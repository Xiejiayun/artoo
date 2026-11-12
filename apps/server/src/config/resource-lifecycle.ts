import { DEFAULT_RESOURCE_EXPIRY_MS } from "@artoo/domain";

export function resourceExpiryMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.ARTOO_RESOURCE_EXPIRY_DAYS === undefined) return DEFAULT_RESOURCE_EXPIRY_MS;
  const days = Number(env.ARTOO_RESOURCE_EXPIRY_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("ARTOO_RESOURCE_EXPIRY_DAYS must be an integer between 1 and 3650");
  return days * 86400000;
}
