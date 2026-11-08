import { AllowedBrowserKeySchema, BrowserActionV3Schema, StaticWebCapabilitiesV3Schema, storageFaultCapabilitiesV1,
  type VerificationCapabilities } from "@artoo/domain";

/** Controlled authenticated-node advertisement, not evidence of a live browser run. */
export function verificationCapabilitiesFixture(): VerificationCapabilities {
  return { version: 1, profile_digest: `sha256:${"a".repeat(64)}`, checks: [{ command_id: "acceptance",
    config_digest: `sha256:${"b".repeat(64)}`, contract_digest: `sha256:${"c".repeat(64)}`,
    contract: { version: 1, kind: "static-web", claim: "configured", browser_steps_version: 1,
      actions: ["navigate", "reload", "click", "fill", "check", "assert_visible", "assert_hidden", "assert_text", "assert_value", "assert_count"],
      viewports: [{ id: "desktop", width: 1440, height: 900 }, { id: "phone", width: 390, height: 900 }],
      stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
      screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true },
      limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 1750 },
      checks: ["horizontal-overflow", "dom-control-name-heuristic"],
      unavailable: ["keyboard-navigation", "multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"] } }] };
}

/** Controlled v3 advertisement; the digests are fixture identities, not browser measurements. */
export function verificationCapabilitiesV3Fixture(storageFault = false): VerificationCapabilities {
  const capabilities = verificationCapabilitiesFixture(), check = capabilities.checks[0]!;
  capabilities.profile_digest = `sha256:${(storageFault ? "1" : "d").repeat(64)}`;
  check.config_digest = `sha256:${(storageFault ? "2" : "e").repeat(64)}`;
  check.contract_digest = `sha256:${(storageFault ? "3" : "f").repeat(64)}`;
  check.contract = StaticWebCapabilitiesV3Schema.parse({ ...check.contract,
    version: 3, browser_steps_version: 3, legacy_browser_steps: "rejected",
    actions: [...BrowserActionV3Schema.options],
    viewports: [{ id: "compact", width: 512, height: 650 }, { id: "tall", width: 512, height: 1000 }],
    device_scale_factor: 1,
    keyboard: { allowed_keys: [...AllowedBrowserKeySchema.options], typing_max_length: 1000,
      focus_setup: "programmatic", focus_scope: "main-frame-dom" },
    screenshots: "each-created-page-visible-viewport",
    pages: { max_pages: 3, counting: "cumulative-created", same_origin: true, same_browser_context: true,
      name_reuse: "rejected", main_close: "rejected" },
    unavailable: [...(storageFault ? [] : ["storage-exception-injection"]), "native-screen-reader", "browser-zoom"],
    ...(storageFault ? { storage_fault: storageFaultCapabilitiesV1(`sha256:${"4".repeat(64)}`) } : {}),
  });
  return capabilities;
}
