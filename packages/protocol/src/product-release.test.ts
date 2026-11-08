import { describe, expect, it } from "vitest";
import { ProductReleaseHealthReportSchema, ProductReleaseReceiptSchema, ProductReleaseRequestSchema } from "@artoo/domain";
import { adapterRunEventBodySchema, commandSchema, nodeHelloSchema, productReleaseReceiptMessageSchema, productReleaseHealthMessageSchema } from "./node-messages.js";

const digest = `sha256:${"a".repeat(64)}`;
const request = { version: 1 as const, release_id: "release", goal_id: "goal", project_id: "project", run_id: "run",
  release_profile_id: "site", verification_request_id: "verify", verification_profile_id: "default",
  verification_profile_digest: digest, subject_digest: digest };
const receipt = { request, release_profile_digest: digest, artifact_digest: digest, outcome: "published", endpoint: "https://product.example",
  previous_release_id: null, health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: "2026-11-04T00:00:00Z" }] };

describe("node-owned product release contract", () => {
  it("rejects remote deployment argv, secrets and filesystem scope", () => {
    expect(ProductReleaseRequestSchema.safeParse({ ...request, argv: ["sh", "untrusted.sh"] }).success).toBe(false);
    expect(ProductReleaseRequestSchema.safeParse({ ...request, workspace_root: "/other" }).success).toBe(false);
    for (const type of ["product.release", "product.release.cancel"]) {
      expect(commandSchema.safeParse({ kind: "command", id: "command", idempotency_key: "stable", type, payload: request }).success).toBe(true);
    }
  });
  it("requires exact immutable source, endpoint and actual health for successful publication", () => {
    expect(ProductReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const patch of [{ health_checks: [] }, { artifact_digest: null }, { endpoint: null },
      { artifact_digest: `sha256:${"b".repeat(64)}` }, { health_checks: [{ ...receipt.health_checks[0], passed: false }] }]) {
      expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
    }
    expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, outcome: "rolled_back", endpoint: null, previous_release_id: "previous" }).success).toBe(false);
    expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, outcome: "rolled_back", endpoint: null, previous_release_id: "previous", recovery_checks: receipt.health_checks }).success).toBe(true);
  });
  it("rejects asserted success without successful HTTP measurements in health and recovery", () => {
    for (const patch of [{ status_code: null, body_digest: null }, { status_code: 500 }, { body_digest: null }]) {
      const checks = [{ ...receipt.health_checks[0], ...patch }];
      expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, health_checks: checks }).success).toBe(false);
      expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, outcome: "rolled_back", endpoint: null,
        previous_release_id: "previous", recovery_checks: checks }).success).toBe(false);
      expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, outcome: "failed", endpoint: null,
        health_checks: checks }).success).toBe(false);
    }
    expect(ProductReleaseReceiptSchema.safeParse({ ...receipt, outcome: "failed", endpoint: null,
      health_checks: [{ ...receipt.health_checks[0], status_code: null, body_digest: null, passed: false }] }).success).toBe(true);
  });
  it("accepts receipts only as separate node messages and keeps coding adapters unable to publish evidence", () => {
    expect(productReleaseReceiptMessageSchema.safeParse({ kind: "product.release.receipt", node_id: "node", payload: receipt }).success).toBe(true);
    expect(adapterRunEventBodySchema.safeParse({ type: "product.release.receipt", payload: receipt }).success).toBe(false);
    const profile = { profile_id: "site", project_id: "project", workspace_root: "/workspace", verification_profile_id: "default", target_kind: "static_site" };
    const hello = { kind: "node.hello", node_id: "node", protocol_version: "1", artood_version: "1", machine: { hostname: "host", os: "linux", arch: "x64" }, release_profiles: [profile] };
    expect(nodeHelloSchema.safeParse(hello).success).toBe(true);
    expect(nodeHelloSchema.safeParse({ ...hello, release_profiles: [profile, profile] }).success).toBe(false);
  });
  it("keeps later health observations outside adapter output and requires measured state transitions", () => {
    const report = { version: 1, event_id: "health_1", sequence: 1, request, release_profile_digest: digest, artifact_digest: digest,
      state: "healthy", active_release_id: request.release_id, active_artifact_digest: digest, consecutive_failures: 0,
      health_checks: receipt.health_checks, recovery_checks: [], checked_at: "2026-11-04T00:01:00Z" };
    expect(productReleaseHealthMessageSchema.safeParse({ kind: "product.release.health", node_id: "node", payload: report }).success).toBe(true);
    expect(adapterRunEventBodySchema.safeParse({ type: "product.release.health", payload: report }).success).toBe(false);
    for (const patch of [{ sequence: 0 }, { sequence: 2147483648 }, { version: 2 }, { health_checks: [] },
      { health_checks: [...receipt.health_checks, ...receipt.health_checks] }, { active_release_id: "other" },
      { artifact_digest: `sha256:${"b".repeat(64)}` }, { state: "degraded", consecutive_failures: 1 },
      { checked_at: "2026-11-03T00:00:00Z" }, { consecutive_failures: 1 }, { recovery_checks: receipt.health_checks }]) {
      expect(ProductReleaseHealthReportSchema.safeParse({ ...report, ...patch }).success).toBe(false);
    }
    const failed = { ...report, state: "degraded", consecutive_failures: 1,
      health_checks: [{ ...receipt.health_checks[0], passed: false, status_code: 503 }] };
    expect(ProductReleaseHealthReportSchema.safeParse(failed).success).toBe(true);
    expect(ProductReleaseHealthReportSchema.safeParse({ ...failed, state: "rolled_back", active_release_id: "previous", recovery_checks: receipt.health_checks }).success).toBe(true);
    expect(ProductReleaseHealthReportSchema.safeParse({ ...failed, state: "rolled_back", active_release_id: "previous" }).success).toBe(false);
    expect(ProductReleaseHealthReportSchema.safeParse({ ...failed, state: "unavailable", active_release_id: null, active_artifact_digest: null }).success).toBe(true);
    expect(ProductReleaseHealthReportSchema.safeParse({ ...failed, state: "unavailable" }).success).toBe(false);
  });
  it("acknowledges a health observation by its immutable event, release and sequence", () => {
    const acknowledgement = { kind: "command", id: "receipt", idempotency_key: "receipt", type: "product.release.health.ack",
      payload: { event_id: "health_1", release_id: request.release_id, sequence: 1, status: "accepted" } };
    expect(commandSchema.safeParse(acknowledgement).success).toBe(true);
    expect(commandSchema.safeParse({ ...acknowledgement, payload: { ...acknowledgement.payload, status: "rejected", message: "Stale session" } }).success).toBe(true);
    for (const patch of [{ event_id: "" }, { release_id: "" }, { sequence: 0 }, { sequence: 2147483648 }, { status: "queued" }]) {
      expect(commandSchema.safeParse({ ...acknowledgement, payload: { ...acknowledgement.payload, ...patch } }).success).toBe(false);
    }
  });
});
