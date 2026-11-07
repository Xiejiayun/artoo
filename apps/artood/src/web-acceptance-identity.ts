import { createHash } from "node:crypto";

export const webAcceptanceDigest = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Preserve the original capability canonicalization; programs and steps use the same identity rules. */
export function canonicalWebAcceptance(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWebAcceptance).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalWebAcceptance(child)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported static web capability value");
  return encoded;
}
