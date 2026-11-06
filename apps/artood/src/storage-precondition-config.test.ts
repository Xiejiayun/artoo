import { describe, expect, it } from "vitest";
import type { ProductBrowserProgramV3, ProductStoragePreconditionBindingV1 } from "@artoo/domain";
import { prepareStaticWebCapabilities, validateStaticWebCapabilitySnapshot } from "./web-acceptance.js";
import { deriveStoragePreconditionExpectation } from "./web-acceptance-precondition.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";

const viewport = { id: "phone", width: 390, height: 844 }, digest = "sha256:" + "a".repeat(64);
const browser_program = { version: 3, viewports: [viewport] };

describe("protected storage precondition opt-in", () => {
  it("leaves old opt-out/fault-only contracts unchanged and binds new support to a distinct profile check", () => {
    // Existing storage-fault-config golden tests continue to cover exact legacy config/contract digests.
    const old = prepareStaticWebCapabilities({ browser_program, storage_fault: { version: 1 } });
    const enabled = prepareStaticWebCapabilities({ browser_program, storage_fault: { version: 1 }, storage_precondition: { version: 1 } });
    expect(old.options).not.toHaveProperty("storage_precondition"); expect(old.contract).not.toHaveProperty("storage_precondition");
    expect(enabled.config_digest).not.toBe(old.config_digest); expect(enabled.contract_digest).not.toBe(old.contract_digest);
    if (old.contract.version !== 3 || enabled.contract.version !== 3) throw new Error("Expected v3");
    expect(enabled.contract.storage_fault).toEqual(old.contract.storage_fault);
    expect(enabled.contract.storage_precondition).toMatchObject({ version: 1,
      input: { max_keys: 1, max_key_utf8_bytes: 512, max_value_utf8_bytes: 65536 },
      installation: { baseline: "empty-native-storage", native_readback: "exact-single-entry", seed_count: 1, reload: "no-replay" } });
    expect(Object.isFrozen(enabled.contract.storage_precondition)).toBe(true);
    const binding = { version: 1, command_id: "browser", profile_digest: digest, config_digest: old.config_digest, contract_digest: old.contract_digest };
    expect(() => validateStaticWebCapabilitySnapshot({ version: 1, binding, options: enabled.options })).toThrow("configured binding");
  });
  it.each([{}, { version: 0 }, { version: 2 }, { version: 1, origin: "https://elsewhere.example" }, { version: 1, script: "arbitrary" }])(
    "rejects missing/unknown versions and executable or origin configuration %j", storage_precondition => {
      expect(() => prepareStaticWebCapabilities({ browser_program, storage_precondition })).toThrow();
    });
  it.each([{}, { browser_program: { version: 2, viewports: [viewport] } }])("rejects extending a legacy browser profile %j", legacy => {
    expect(() => prepareStaticWebCapabilities({ ...legacy, storage_precondition: { version: 1 } })).toThrow();
  });
});

describe("precondition expectation is source-bound planning only", () => {
  const refs = [{ requirement_id: "malformed", criterion_index: 0 }];
  const binding: ProductStoragePreconditionBindingV1 = { source: { path: ".artoo/product/design.json", checksum: digest, size: 100, case_id: "repair" },
    precondition: { version: 1, local_storage: { key: "journal", value: "{" }, requirement_criteria: refs, ui_assertion_steps: [1, 4],
      preservation_checks: [{ after_step: 4, requirement_criteria: refs, ui_assertion_steps: [4] }] } };
  const program: ProductBrowserProgramV3 = { version: 3, contract_digest: digest, steps: [
    { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#error", text: "Malformed" },
    { action: "open_page", page: "peer", path: "/" }, { action: "reload", page: "peer" },
    { action: "assert_text", page: "peer", selector: "#error", text: "Malformed" },
  ] };
  it("pins the entire descriptor/program/source and counts only main document epochs", () => {
    const expected = deriveStoragePreconditionExpectation(binding, program);
    expect(expected).toMatchObject({ source: binding.source, descriptor_digest: sha(canonical(binding.precondition)),
      program_digest: sha(canonical(program)), document_epoch: 1, preservation_checks: [{ document_epoch: 1, after_step: 4 }] });
    expect(expected).not.toHaveProperty("origin"); expect(expected).not.toHaveProperty("sequence");
    const changed = structuredClone(binding); changed.precondition.local_storage.value = "["; changed.source.checksum = sha("changed source");
    const other = deriveStoragePreconditionExpectation(changed, program);
    expect(other.descriptor_digest).not.toBe(expected.descriptor_digest); expect(other.source.checksum).not.toBe(expected.source.checksum);
    expect(other.native_storage.seeded.digest).not.toBe(expected.native_storage.seeded.digest);
    const editedProgram = structuredClone(program); editedProgram.steps[1] = { action: "assert_text", page: "main", selector: "#error", text: "Different" };
    expect(deriveStoragePreconditionExpectation(binding, editedProgram).program_digest).not.toBe(expected.program_digest);
  });
});
