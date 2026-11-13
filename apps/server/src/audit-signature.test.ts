import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { AuditBundleExportSchema, TaskAuditBundleSchema, type AuditPublicKeyringV1 } from "@artoo/domain";
import { describe, expect, it } from "vitest";

import {
  auditDigestV1,
  auditKeyIdV1,
  canonicalAuditJson,
  createAuditSignerV1,
  verifyAuditExportV1,
} from "./audit-signature.js";

const pair = generateKeyPairSync("ed25519");
const keyId = auditKeyIdV1(pair.publicKey);
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ring: AuditPublicKeyringV1 = {
  version: 1,
  issuer: "artoo:test-instance",
  keys: [
    {
      key_id: keyId,
      status: "active",
      public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ],
};
const bundle = TaskAuditBundleSchema.parse({
  task: {
    id: "task_1",
    organization_id: "org_1",
    project_id: "project_1",
    title: "Evidence 中文",
    status: "backlog",
    created_by_type: "user",
    created_by_id: "user_1",
    created_at: "2026-11-14",
    updated_at: "2026-11-14",
  },
  room: null,
  messages: [],
  runs: [],
  artifacts: [],
  approvals: [],
  scheduler_decisions: [],
  events: [],
});
const signer = createAuditSignerV1(privatePem, ring, ring.issuer, keyId);
const exported = () =>
  signer.sign({ kind: "task", bundle: structuredClone(bundle), exported_at: "2026-11-14T00:00:00.000Z" });

describe("versioned audit signatures", () => {
  it("signs deterministic semantic JSON and verifies with an independently supplied SPKI key", () => {
    const envelope = exported();
    expect(exported()).toEqual(envelope);
    expect(verifyAuditExportV1(JSON.parse(JSON.stringify(envelope, null, 2)), ring)).toEqual(envelope);
    expect(AuditBundleExportSchema.safeParse(envelope).success).toBe(false);
    const { signature, ...unsigned } = envelope;
    expect(
      verify(
        null,
        Buffer.from("Artoo audit export signature v1\n" + canonicalAuditJson(unsigned)),
        createPublicKey(ring.keys[0]!.public_key_spki_pem),
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("PRIVATE KEY");
    expect(verifyAuditExportV1(Object.fromEntries(Object.entries(envelope).reverse()), ring)).toEqual(envelope);
  });

  it.each([
    [["schema_version"], "v1alpha1"],
    [["kind"], "goal"],
    [["exported_at"], "2026-11-15T00:00:00.000Z"],
    [["bundle_sha256"], `sha256:${"0".repeat(64)}`],
    [["bundle", "task", "title"], "Changed evidence"],
    [["signing", "status"], "deferred"],
    [["signing", "algorithm"], "RSA"],
    [["signing", "canonicalization"], "unknown"],
    [["signing", "issuer"], "artoo:other"],
    [["signing", "key_id"], `ed25519-spki-sha256:${"0".repeat(64)}`],
    [["signature"], "A".repeat(86) + "=="],
    [["unexpected"], "not covered by old parsers"],
    [["bundle", "task", "future_field"], "must also be covered"],
  ] as const)("rejects modified field %j", (path, value) => {
    const envelope = structuredClone(exported());
    let target: Record<string, unknown> = envelope as unknown as Record<string, unknown>;
    for (const segment of path.slice(0, -1)) target = target[segment] as Record<string, unknown>;
    target[path.at(-1)!] = value;
    expect(() => verifyAuditExportV1(envelope, ring)).toThrow();
  });

  it("covers unknown nested fields and raw missing defaults instead of schema-stripped output", () => {
    const raw = structuredClone(bundle);
    const fields = raw.task as unknown as Record<string, unknown>;
    fields.future = JSON.parse('{"__proto__":{"evidence":"must survive"},"z":2,"a":1}');
    delete (raw as unknown as Record<string, unknown>).decisions;
    const envelope = signer.sign({ kind: "task", bundle: raw, exported_at: "2026-11-14T00:00:00.000Z" });
    expect(verifyAuditExportV1(JSON.parse(JSON.stringify(envelope)), ring)).toEqual(envelope);
    (fields.future as Record<string, unknown>).__proto__ = { evidence: "changed" };
    expect(() => verifyAuditExportV1(envelope, ring)).toThrow();
  });

  it("accepts retired verification keys but rejects unknown, revoked or other-issuer trust", () => {
    const envelope = exported();
    const retired = structuredClone(ring);
    retired.keys[0]!.status = "retired";
    expect(verifyAuditExportV1(envelope, retired)).toEqual(envelope);
    expect(() => createAuditSignerV1(privatePem, retired, ring.issuer, keyId)).toThrow();
    const revoked = structuredClone(ring);
    revoked.keys[0]!.status = "revoked";
    expect(() => verifyAuditExportV1(envelope, revoked)).toThrow();
    expect(() => verifyAuditExportV1(envelope, { ...ring, issuer: "artoo:other" })).toThrow();
    const other = generateKeyPairSync("ed25519");
    expect(() =>
      verifyAuditExportV1(envelope, {
        ...ring,
        keys: [
          {
            key_id: auditKeyIdV1(other.publicKey),
            status: "active",
            public_key_spki_pem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createAuditSignerV1(
        other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        ring,
        ring.issuer,
        keyId,
      ),
    ).toThrow();
    expect(() => verifyAuditExportV1(envelope, { ...ring, keys: [...ring.keys, ...ring.keys] })).toThrow();
    expect(() =>
      verifyAuditExportV1(envelope, { ...ring, keys: [{ ...ring.keys[0], public_key_spki_pem: privatePem }] }),
    ).toThrow();
  });

  it("rotates to a new active key while retaining historical verification and rejecting revocation", () => {
    const previous = exported();
    const next = generateKeyPairSync("ed25519");
    const rotating = structuredClone(ring);
    rotating.keys[0]!.status = "retired";
    const nextId = auditKeyIdV1(next.publicKey);
    rotating.keys.push({
      key_id: nextId,
      status: "active",
      public_key_spki_pem: next.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const current = createAuditSignerV1(
      next.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      rotating,
      ring.issuer,
      nextId,
    ).sign({ kind: "task", bundle, exported_at: "2026-11-15T00:00:00.000Z" });
    expect(verifyAuditExportV1(previous, rotating)).toEqual(previous);
    expect(verifyAuditExportV1(current, rotating)).toEqual(current);
    rotating.keys[0]!.status = "revoked";
    expect(() => verifyAuditExportV1(previous, rotating)).toThrow();
    expect(verifyAuditExportV1(current, rotating)).toEqual(current);
  });

  it("rejects unsupported algorithms and noncanonical signature encodings", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() => auditKeyIdV1(ec.publicKey)).toThrow();
    expect(() =>
      createAuditSignerV1(ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ring, ring.issuer, keyId),
    ).toThrow();
    const envelope = exported();
    expect(() =>
      verifyAuditExportV1({ ...envelope, signature: envelope.signature.replace(/=+$/, "") }, ring),
    ).toThrow();
    expect(() => verifyAuditExportV1({ ...envelope, signature: "A".repeat(85) + "B==" }, ring)).toThrow();
    expect(() => verifyAuditExportV1({ schema_version: "v1alpha1", signature: null }, ring)).toThrow();
  });
});

describe("artoo-json-v1 canonicalization", () => {
  it("preserves JSON keys, array order and exact scalar distinctions", () => {
    const raw = JSON.parse('{"z":null,"__proto__":{"x":1},"2":"two","10":"ten","a":[true,"中文",-0,1e30]}');
    expect(canonicalAuditJson(raw)).toBe(
      '{"10":"ten","2":"two","__proto__":{"x":1},"a":[true,"中文",0,1e+30],"z":null}',
    );
    expect(auditDigestV1({ a: 1, b: 2 })).toBe(auditDigestV1({ b: 2, a: 1 }));
    expect(auditDigestV1([1, 2])).not.toBe(auditDigestV1([2, 1]));
    expect({}.hasOwnProperty.call({}, "x")).toBe(false);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    new Array(1),
    { value: undefined },
    {
      get value() {
        throw new Error("must not run");
      },
    },
  ])("rejects non-JSON input %#", (value) => {
    expect(() => canonicalAuditJson(value)).toThrow();
  });
  it("rejects cycles and symbol-keyed input without rejecting shared acyclic values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalAuditJson(value)).toThrow();
    expect(() => canonicalAuditJson({ [Symbol("hidden")]: 1 })).toThrow();
    expect(canonicalAuditJson([bundle, bundle])).toBe(`[${canonicalAuditJson(bundle)},${canonicalAuditJson(bundle)}]`);
  });
});
