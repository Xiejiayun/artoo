import { isIP } from "node:net";

/** Trust only explicitly named proxy peers; direct deployments ignore forwarded headers. */
export function loadTrustedProxies(env: { ARTOO_TRUSTED_PROXIES?: string | undefined }): string[] {
  const value = env.ARTOO_TRUSTED_PROXIES?.trim();
  if (!value) return [];
  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.some((address) => isIP(address) === 0)) {
    throw new Error("ARTOO_TRUSTED_PROXIES must contain comma-separated proxy IP addresses; ranges, hostnames and blanket trust are not supported");
  }
  return [...new Set(addresses)];
}
