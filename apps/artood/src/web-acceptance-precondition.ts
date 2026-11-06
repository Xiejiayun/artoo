import { ProductStoragePreconditionBindingV1Schema, validateProductStoragePreconditionV1,
  type ProductBrowserProgramV3, type ProductStoragePreconditionBindingV1, type StoragePreconditionTraceV1 } from "@artoo/domain";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { nativeStorageSnapshotV1, STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";

/** Expected data from measured source, not a receipt of a native write or product success. */
export type ExpectedStoragePreconditionV1 = Omit<StoragePreconditionTraceV1, "origin" | "installation" | "sequence"> & {
  installation_script_digest: string;
};

export function deriveStoragePreconditionExpectation(input: ProductStoragePreconditionBindingV1,
  program: ProductBrowserProgramV3): ExpectedStoragePreconditionV1 {
  const { source, precondition } = ProductStoragePreconditionBindingV1Schema.parse(input);
  validateProductStoragePreconditionV1(program.steps, precondition);
  const expected = nativeStorageSnapshotV1([[precondition.local_storage.key, precondition.local_storage.value]]).summary;
  return { version: 1, descriptor_digest: sha(canonical(precondition)), source, program_digest: sha(canonical(program)),
    page_id: "main", document_epoch: 1, initial_step_digest: sha(canonical(program.steps[0])), seed_apply_count: 1,
    installation_script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, requirement_criteria: precondition.requirement_criteria,
    ui_assertion_steps: precondition.ui_assertion_steps, native_storage: { scope: "all",
      before: nativeStorageSnapshotV1([]).summary, seeded: expected },
    preservation_checks: (precondition.preservation_checks ?? []).map(check => ({ ...check,
      step_digest: sha(canonical(program.steps[check.after_step])),
      document_epoch: program.steps.slice(0, check.after_step + 1).filter(step => step.page === "main" && (step.action === "navigate" || step.action === "reload")).length,
      native_storage: { scope: "all", comparison: "sampled-equal", snapshot: expected, equal: true } })),
  };
}
