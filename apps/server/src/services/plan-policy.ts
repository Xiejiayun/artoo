import { type TaskSpec } from "@artoo/domain";

import { AppError } from "../errors.js";

/** Preserve old plans for audit, but never execute an unenforced safety policy. */
export function assertSupportedPlanTaskControls(spec: TaskSpec, specIndex: number): void {
  if (spec.approval_gates.length > 0) {
    throw AppError.validation("Plan task approval_gates are not supported in this preview; request execution approval on the task before assignment", {
      field: `task_specs[${specIndex}].approval_gates`, spec_index: specIndex,
    });
  }
  if (spec.write_scopes.length > 0) {
    throw AppError.validation("Plan task write_scopes are not enforced in this preview; configure local workspace roots and runtime permissions instead", {
      field: `task_specs[${specIndex}].write_scopes`, spec_index: specIndex,
    });
  }
}
