import { VerificationCapabilityBindingSchema, type RunVerificationPayload, type VerificationCapabilities,
  type VerificationCapabilityBinding, type VerificationRequirement } from "@artoo/domain";
import { isDeepStrictEqual } from "node:util";

/** Project an authenticated node snapshot; the server never computes or invents its digests. */
export function verificationCapabilityBinding(capabilities: VerificationCapabilities): VerificationCapabilityBinding {
  return { version: 1, profile_digest: capabilities.profile_digest,
    checks: capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
}

/** Undefined is a legacy unknown scope; null is an internally inconsistent receipt. */
export function receiptCapabilityBinding(payload: RunVerificationPayload): VerificationCapabilityBinding | undefined | null {
  const checks: VerificationCapabilityBinding["checks"] = [];
  for (const check of payload.checks) {
    const binding = check.observation?.capability_binding;
    if (!binding) continue;
    if (binding.command_id !== check.id || binding.profile_digest !== payload.profile_digest) return null;
    const { command_id, config_digest, contract_digest } = binding;
    checks.push({ command_id, config_digest, contract_digest });
  }
  if (!checks.length) return undefined;
  const result = VerificationCapabilityBindingSchema.safeParse({ version: 1, profile_digest: payload.profile_digest, checks });
  return result.success ? result.data : null;
}

export function verificationReceiptMatchesCapabilities(payload: RunVerificationPayload, requirement: VerificationRequirement): boolean {
  // Failed execution may stop before producing observations. Preserve that diagnostic receipt.
  if (payload.outcome !== "passed") return true;
  const measured = receiptCapabilityBinding(payload);
  return measured !== null && isDeepStrictEqual(measured, requirement.capability_binding);
}
