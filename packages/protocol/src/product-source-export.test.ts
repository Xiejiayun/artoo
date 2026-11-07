import { describe, expect, it } from "vitest";
import { ProductSourceExportV1Schema, ProductSourceImportReadyV1Schema } from "@artoo/domain";
import { adapterRunEventBodySchema, runEventBodySchema } from "./node-messages.js";

const digest = `sha256:${"a".repeat(64)}`;
const proof = { version: 1, export_id: digest, node_id: "node", run_id: "run", task_id: "task", project_id: "project", goal_id: "goal", plan_id: "plan",
  verification_request_id: "request", profile_id: "profile", profile_digest: digest, subject_digest: digest, context_digest: digest,
  verification_digest: digest, capsule_digest: digest, manifest_digest: digest, capsule_bytes: 10,
  author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false };
describe("node-only product source export contract", () => {
  it("accepts a strict node frame and rejects the same adapter output", () => {
    const event = { type: "run.product-source.export.v1", payload: proof };
    expect(runEventBodySchema.parse(event)).toEqual(event);
    expect(adapterRunEventBodySchema.safeParse(event).success).toBe(false);
    for (const payload of [{ ...proof, execution_authorized: true }, { ...proof, capsule_bytes: 12 * 1024 * 1024 + 1 },
      { ...proof, author_closure: "cli-exit" }, { ...proof, trusted: true }]) expect(ProductSourceExportV1Schema.safeParse(payload).success).toBe(false);
  });
  it("never encodes import completion as semantic, execution or verification authority", () => {
    const ready = { version: 1, transfer_id: "transfer", request_digest: digest, capsule_digest: digest, manifest_digest: digest,
      destination: { node_id: "node", project_id: "project", profile_id: "profile", profile_digest: digest, workspace_root: "C:\\target", subject_digest: digest },
      git_metadata_digest: digest, git_processes_closed: true, verification_passed: false, execution_authorized: false, semantic_mapping_accepted: false };
    expect(ProductSourceImportReadyV1Schema.parse(ready)).toEqual(ready);
    for (const key of ["verification_passed", "execution_authorized", "semantic_mapping_accepted"])
      expect(ProductSourceImportReadyV1Schema.safeParse({ ...ready, [key]: true }).success).toBe(false);
    expect(ProductSourceImportReadyV1Schema.safeParse({ ...ready, issuer: "model" }).success).toBe(false);
  });
});
