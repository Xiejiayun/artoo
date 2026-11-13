import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { AuditIssuerV1Schema, AuditSigningKeyIdV1Schema } from "@artoo/domain";
import { z } from "zod";

import { createAuditSignerV1, type AuditSignerV1 } from "../audit-signature.js";

const Config = z
  .object({
    version: z.literal(1),
    issuer: AuditIssuerV1Schema,
    active_key_id: AuditSigningKeyIdV1Schema,
    private_key_file: z.string().refine(isAbsolute),
    public_keyring_file: z.string().refine(isAbsolute),
  })
  .strict();

/** Read and validate before opening the database. Bad configuration cannot downgrade. */
export async function loadAuditSignerV1(env: NodeJS.ProcessEnv): Promise<AuditSignerV1 | undefined> {
  const path = env.ARTOO_AUDIT_SIGNING_CONFIG;
  if (path === undefined) return undefined;
  try {
    if (!isAbsolute(path)) throw new Error("Expected absolute config path");
    const text = await readFile(path, "utf8");
    if (text.length > 65536) throw new Error("Oversized config");
    const config = Config.parse(JSON.parse(text));
    const privatePem = await readFile(config.private_key_file, "utf8");
    const publicText = await readFile(config.public_keyring_file, "utf8");
    if (privatePem.length > 32768 || publicText.length > 524288) throw new Error("Oversized keys");
    return createAuditSignerV1(privatePem, JSON.parse(publicText), config.issuer, config.active_key_id);
  } catch {
    // Neither parser diagnostics nor filesystem errors may disclose pasted keys.
    throw new Error("ARTOO_AUDIT_SIGNING_CONFIG is invalid; refusing to start");
  }
}
