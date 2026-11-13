import { readFile } from "node:fs/promises";

// Build first; no server or network request is made by this verifier.
import { verifyAuditExportV1 } from "../apps/server/dist/audit-signature.js";

export async function verifyAuditFiles(exportFile, trustedKeyringFile) {
  const document = JSON.parse(await readFile(exportFile, "utf8"));
  const trusted = JSON.parse(await readFile(trustedKeyringFile, "utf8"));
  const envelope = verifyAuditExportV1(document, trusted);
  return {
    issuer: envelope.signing.issuer,
    key_id: envelope.signing.key_id,
    kind: envelope.kind,
    bundle_sha256: envelope.bundle_sha256,
  };
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Expected export and trusted keyring files");
    const result = await verifyAuditFiles(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ verified: true, ...result }));
  } catch {
    console.error("Audit verification failed. Supply a signed export and an independently trusted public keyring.");
    process.exitCode = 1;
  }
}
