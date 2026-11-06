import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalProductSourceTransferValueV1, ProductSourceTransferReceiptV1Schema, ProductSourceTransferRequestV1Schema,
  productSourceTransferRequestDigestV1 } from "./product-source-transfer.js";

const digest = `sha256:${"a".repeat(64)}`, sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture() {
  return { version: 1, kind: "product-source-transfer.v1", transfer_id: "transfer", organization_id: "org", project_id: "project", goal_id: "goal", plan_id: "plan",
    authorization: { actor_user_id: "user", consent_id: null, policy_version: "policy" },
    source: { node_id: "source", run_id: "run", task_id: "task", evidence_id: "evidence", verification_request_id: "request", profile_id: "profile",
      profile_digest: digest, workspace_root: "/source", subject_digest: digest, review_id: "review", reviewer_run_id: "peer", reviewer_evidence_id: "peer_evidence",
      capsule_digest: digest, manifest_digest: digest, capsule_bytes: 300 },
    destination: { node_id: "destination", profile_id: "profile", workspace_root: "C:/destination", capability_digest: digest,
      capabilities: { version: 1, profile_digest: digest, checks: [{ command_id: "check", config_digest: digest, contract_digest: digest,
        contract: { version: 1, kind: "static-web", claim: "configured", browser_steps_version: 1, actions: ["navigate"],
          viewports: [{ id: "desktop", width: 1440, height: 900 }], stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
          screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true },
          limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 1000 }, checks: [], unavailable: [] } }] } } };
}
it("keeps new transfer contracts strictly versioned and rejects credentials or remote commands", () => {
  expect(ProductSourceTransferRequestV1Schema.safeParse(fixture()).success).toBe(true);
  for (const extra of [{ version: 2 }, { control_token: "never-transmit" }, { argv: ["run"] }]) {
    expect(ProductSourceTransferRequestV1Schema.safeParse({ ...fixture(), ...extra }).success).toBe(false);
  }
  const same = fixture(); same.destination.node_id = same.source.node_id;
  expect(ProductSourceTransferRequestV1Schema.safeParse(same).success).toBe(false);
  const oversized = fixture(); oversized.source.capsule_bytes = 12 * 1024 * 1024 + 1;
  expect(ProductSourceTransferRequestV1Schema.safeParse(oversized).success).toBe(false);
});
it("binds every request value while accepting equivalent object-key ordering", () => {
  const request = ProductSourceTransferRequestV1Schema.parse(fixture());
  const expected = productSourceTransferRequestDigestV1(request, sha);
  expect(productSourceTransferRequestDigestV1(JSON.parse(canonicalProductSourceTransferValueV1(request)), sha)).toBe(expected);
  for (const key of ["plan_id", "goal_id", "project_id", "organization_id"] as const) {
    expect(productSourceTransferRequestDigestV1({ ...request, [key]: "replacement" }, sha)).not.toBe(expected);
  }
  expect(productSourceTransferRequestDigestV1({ ...request, destination: { ...request.destination, workspace_root: "/replacement" } }, sha)).not.toBe(expected);
});
it("never describes uploaded bytes as execution authorization", () => {
  const receipt = { version: 1, transfer_id: "transfer", request_digest: digest, capsule_digest: digest, status: "available", execution_authorized: false };
  expect(ProductSourceTransferReceiptV1Schema.safeParse(receipt).success).toBe(true);
  expect(ProductSourceTransferReceiptV1Schema.safeParse({ ...receipt, execution_authorized: true }).success).toBe(false);
});
