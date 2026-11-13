import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

import {
  AuditPublicKeyringV1Schema,
  SignedAuditExportV1Schema,
  type AuditPublicKeyringV1,
  type SignedAuditExportV1,
} from "@artoo/domain";

const DOMAIN = "Artoo audit export signature v1\n";

/** JSON semantic canonicalization v1: sorted UTF-16 keys and ECMAScript JSON scalars.
 * No toJSON hooks, sparse arrays, symbols, accessors or non-JSON values. This is
 * a new signed format; the v1alpha1 digest algorithm remains unchanged. */
export function canonicalAuditJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("Expected acyclic JSON data");
    const prototype = Object.getPrototypeOf(item);
    if (
      (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(item).length
    )
      throw new Error("Expected plain JSON data");
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(item);
      if (keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!)))
        throw new Error("Expected JSON values");
      if (Array.isArray(item)) {
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index)))
          throw new Error("Expected dense JSON array");
        return `[${item.map(encode).join(",")}]`;
      }
      return `{${keys
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(descriptors[key]!.value)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

export function auditDigestV1(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalAuditJson(value), "utf8").digest("hex")}`;
}

export function auditKeyIdV1(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 public key");
  return `ed25519-spki-sha256:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

function publicKeys(value: unknown): { ring: AuditPublicKeyringV1; keys: Map<string, KeyObject> } {
  const ring = AuditPublicKeyringV1Schema.parse(value);
  const keys = new Map<string, KeyObject>();
  for (const entry of ring.keys) {
    if (
      !entry.public_key_spki_pem.startsWith("-----BEGIN PUBLIC KEY-----") ||
      entry.public_key_spki_pem.includes("PRIVATE KEY")
    )
      throw new Error("Expected public SPKI PEM");
    const key = createPublicKey({ key: entry.public_key_spki_pem, format: "pem", type: "spki" });
    if (auditKeyIdV1(key) !== entry.key_id) throw new Error("Public key fingerprint mismatch");
    keys.set(entry.key_id, key);
  }
  return { ring, keys };
}

function signingBytes(envelope: Omit<SignedAuditExportV1, "signature">): Buffer {
  return Buffer.from(DOMAIN + canonicalAuditJson(envelope), "utf8");
}

export interface AuditSignerV1 {
  sign(input: {
    kind: "task" | "goal";
    bundle: SignedAuditExportV1["bundle"];
    exported_at: string;
  }): SignedAuditExportV1;
}

/** Operator-only input. The returned capability never exports its private key. */
export function createAuditSignerV1(
  privatePem: string,
  keyring: unknown,
  issuer: string,
  activeKeyId: string,
): AuditSignerV1 {
  const { ring } = publicKeys(keyring);
  const entry = ring.keys.find((key) => key.key_id === activeKeyId);
  if (ring.issuer !== issuer || entry?.status !== "active") throw new Error("Expected active key for this issuer");
  if (!privatePem.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("Expected PKCS8 private key");
  const privateKey = createPrivateKey({ key: privatePem, type: "pkcs8", format: "pem" });
  if (privateKey.asymmetricKeyType !== "ed25519" || auditKeyIdV1(createPublicKey(privateKey)) !== activeKeyId)
    throw new Error("Signing key mismatch");
  const signing = Object.freeze({
    status: "signed" as const,
    algorithm: "Ed25519" as const,
    canonicalization: "artoo-json-v1" as const,
    issuer,
    key_id: activeKeyId,
  });
  return Object.freeze({
    sign(input: {
      kind: "task" | "goal";
      bundle: SignedAuditExportV1["bundle"];
      exported_at: string;
    }): SignedAuditExportV1 {
      const unsigned = {
        schema_version: "artoo.audit-signed.v1" as const,
        kind: input.kind,
        exported_at: input.exported_at,
        bundle_sha256: auditDigestV1(input.bundle),
        bundle: input.bundle,
        signing,
      };
      // Validate without using parsed output: nested contract defaults/stripping
      // must never change the raw bytes covered by the signature.
      SignedAuditExportV1Schema.parse({ ...unsigned, signature: "A".repeat(86) + "==" });
      const signature = sign(null, signingBytes(unsigned), privateKey).toString("base64");
      return { ...unsigned, signature } as SignedAuditExportV1;
    },
  });
}

/** Trust comes solely from the independently supplied ring, never the export. */
export function verifyAuditExportV1(value: unknown, trustedKeyring: unknown): SignedAuditExportV1 {
  SignedAuditExportV1Schema.parse(value);
  const envelope = value as SignedAuditExportV1;
  const { ring, keys } = publicKeys(trustedKeyring);
  const entry = ring.keys.find((key) => key.key_id === envelope.signing.key_id);
  if (ring.issuer !== envelope.signing.issuer || !entry || entry.status === "revoked")
    throw new Error("Untrusted audit issuer or key");
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signature)
    throw new Error("Invalid signature encoding");
  const { signature: _signature, ...unsigned } = envelope;
  if (
    auditDigestV1(envelope.bundle) !== envelope.bundle_sha256 ||
    !verify(null, signingBytes(unsigned), keys.get(entry.key_id)!, signature)
  )
    throw new Error("Audit signature verification failed");
  return envelope;
}
