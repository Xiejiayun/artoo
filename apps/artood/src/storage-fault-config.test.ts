import { describe, expect, it } from "vitest";
import { prepareStaticWebCapabilities, validateStaticWebCapabilitySnapshot } from "./web-acceptance.js";

const viewport = { id: "phone", width: 390, height: 844 };
const digest = `sha256:${"a".repeat(64)}`;

describe("protected storage opt-in compatibility", () => {
  it("preserves canonical identities from the validated pre-extension I3 build", () => {
    // Recorded from the I3 build before I4 source integration; changed identities require an explicit compatibility decision.
    const golden = [
      { input: {}, config_digest: "sha256:80f79d462f5b886731fb7a307bc469b3ce71f452462d2d7e3315d49c1043998a",
        contract_digest: "sha256:d84a8088b2c716aeb96d3945372aa987220be871e79e64ecbaf89de7524b52ca" },
      { input: { browser_program: { version: 2, viewports: [viewport] } },
        config_digest: "sha256:a99744e60ee3d071d0a28d403e8e72e9f8b717aba09350fec5b4a1d53a76e716",
        contract_digest: "sha256:32a2baf48b88199c8f75579879a8d5e0f23dcbee8617ad6ca104f2d66e76d691" },
      { input: { browser_program: { version: 3, viewports: [viewport] } },
        config_digest: "sha256:a490f4061933ce68608dd2a02557f958dfd239b34677b3f82edea77cfd702570",
        contract_digest: "sha256:69128eff8c9002c59453c5d12d1e4e5bb820a9e2703de4d56a09f1c225f326dd" },
    ];
    for (const { input, config_digest, contract_digest } of golden) {
      const prepared = prepareStaticWebCapabilities(input);
      expect(prepared).toMatchObject({ config_digest, contract_digest });
      expect(prepared.options).not.toHaveProperty("storage_fault");
      expect(prepared.contract).not.toHaveProperty("storage_fault");
      expect(prepared.contract.unavailable).toContain("storage-exception-injection");
    }
  });

  it("binds the explicit opt-in and initializer to a distinct configured contract without claiming complete mutation coverage", () => {
    const browser_program = { version: 3, viewports: [viewport] };
    const ordinary = prepareStaticWebCapabilities({ browser_program });
    const enabled = prepareStaticWebCapabilities({ browser_program, storage_fault: { version: 1 } });
    expect(enabled.options).toHaveProperty("storage_fault", { version: 1 });
    expect(enabled.config_digest).not.toBe(ordinary.config_digest);
    expect(enabled.contract_digest).not.toBe(ordinary.contract_digest);
    expect(enabled.contract).toMatchObject({ version: 3, claim: "configured", storage_fault: {
      version: 1, initializer_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      native_storage: { scope: "all", comparison: "sampled-equal", max_keys: 512, max_utf8_bytes: 1048576 },
      events: { coverage: "observed-only", observed_mutation: "fails", max_observed_events_per_case: 512 },
      unavailable: ["cached-object-read-denial", "all-write-path-denial", "no-mutation-in-window", "multiple-page-faults"],
    } });
    expect(enabled.contract.unavailable).not.toContain("storage-exception-injection");
    expect(enabled.contract.unavailable).toEqual(["native-screen-reader", "browser-zoom"]);
    if (enabled.contract.version !== 3) throw new Error("Expected v3 contract");
    expect(Object.isFrozen(enabled.contract.storage_fault!.modes)).toBe(true);
  });

  it("rejects adding or removing fault support from the exact selected protected snapshot", () => {
    const browser_program = { version: 3, viewports: [viewport] };
    const enabled = prepareStaticWebCapabilities({ browser_program, storage_fault: { version: 1 } });
    const binding = { version: 1, command_id: "browser", profile_digest: digest,
      config_digest: enabled.config_digest, contract_digest: enabled.contract_digest };
    expect(validateStaticWebCapabilitySnapshot({ version: 1, binding, options: enabled.options }).options).toEqual(enabled.options);
    const ordinary = prepareStaticWebCapabilities({ browser_program });
    expect(() => validateStaticWebCapabilitySnapshot({ version: 1, binding, options: ordinary.options })).toThrow("configured binding");
    expect(() => validateStaticWebCapabilitySnapshot({ version: 1, binding: { ...binding,
      config_digest: ordinary.config_digest, contract_digest: ordinary.contract_digest }, options: enabled.options })).toThrow("configured binding");
  });
});
