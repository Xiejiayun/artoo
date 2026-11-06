import { describe, expect, it } from "vitest";
import { RunVerificationPayloadSchema, VerificationProfileAdvertisementSchema, VerificationRequirementSchema } from "./autonomy.js";
import { StaticWebCapabilitiesSchema, VerificationCapabilitiesSchema, VerificationCapabilityBindingSchema } from "./verification-capabilities.js";
import { ReviewVerificationContextSchema, StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";

const digest = `sha256:${"a".repeat(64)}`;
const contract = { version: 1, kind: "static-web", claim: "configured", browser_steps_version: 1,
  actions: ["navigate", "assert_text"], viewports: [{ id: "width-390", width: 390, height: 900 }],
  stage_policy: { research: "no-browser", design: "prototype-only", implementation: "declared-cases", validation: "declared-cases" },
  screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true },
  limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 },
  checks: ["horizontal-overflow", "dom-control-name-heuristic"],
  unavailable: ["keyboard-navigation", "multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"] };
const check = { command_id: "browser", config_digest: digest, contract_digest: digest };
const capabilities = { version: 1, profile_digest: digest, checks: [{ ...check, contract }] };
const binding = { version: 1, profile_digest: digest, checks: [check] };

describe("configured verification capability contracts", () => {
  it("keeps existing ads, requirements and observations unchanged when the extension is absent", () => {
    const ad = { profile_id: "profile", project_id: "project", workspace_root: "/workspace" };
    const requirement = { version: 1, request_id: "request", profile_id: "profile" };
    const observation = { version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "research", cases: [] };
    expect(VerificationProfileAdvertisementSchema.parse(ad)).toEqual(ad);
    expect(VerificationRequirementSchema.parse(requirement)).toEqual(requirement);
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    expect(VerificationProfileAdvertisementSchema.parse({ ...ad, capabilities })).toEqual({ ...ad, capabilities });
    expect(VerificationRequirementSchema.parse({ ...requirement, capability_binding: binding })).toEqual({ ...requirement, capability_binding: binding });
  });

  it("rejects measurement claims, executable configuration and unsupported actions in public metadata", () => {
    expect(StaticWebCapabilitiesSchema.parse(contract)).toEqual(contract);
    for (const change of [{ claim: "passed" }, { argv: ["node", "script.js"] }, { evidence_root: "/private" },
      { actions: ["evaluate"] }, { actions: ["navigate", "navigate"] }, { viewports: [{ id: "wide", width: 1440, height: 800 }] },
      { pages: { max_pages: 2, same_browser_context: true } }, { unavailable: ["guess"] }]) {
      expect(StaticWebCapabilitiesSchema.safeParse({ ...contract, ...change }).success).toBe(false);
    }
    expect(VerificationCapabilitiesSchema.safeParse({ ...capabilities, checks: [capabilities.checks[0], capabilities.checks[0]] }).success).toBe(false);
    expect(VerificationCapabilityBindingSchema.safeParse({ ...binding, checks: [{ ...check, contract }] }).success).toBe(false);
  });

  it("preserves a versioned per-command binding in reports and observations without making it a pass", () => {
    const capability_binding = { version: 1, profile_digest: digest, ...check };
    const observation = { version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "research", cases: [], capability_binding };
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    const report = { version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true, requirements: 1, cases: [], capability_binding };
    expect(StaticWebAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, passed: false }).success).toBe(false);
    expect(VerificationObservationSchema.safeParse({ ...observation, capability_binding: { ...capability_binding, contract_digest: "trust-me" } }).success).toBe(false);
    const measured = { version: 1, request_id: "request", profile_id: "profile", profile_digest: digest, subject_digest: digest,
      outcome: "passed", required_files: [], checks: [{ id: "browser", exit_code: 0, duration_ms: 1, output_digest: digest, observation }] };
    expect(RunVerificationPayloadSchema.safeParse(measured).success).toBe(true);
    const review = { version: 1, request_id: "request", profile_id: "profile", profile_digest: digest,
      checks: [{ id: "browser", output_digest: digest, observation }] };
    expect(ReviewVerificationContextSchema.safeParse(review).success).toBe(true);
    for (const change of [{ command_id: "other" }, { profile_digest: `sha256:${"b".repeat(64)}` }]) {
      const changed = { ...observation, capability_binding: { ...capability_binding, ...change } };
      expect(RunVerificationPayloadSchema.safeParse({ ...measured, checks: [{ ...measured.checks[0], observation: changed }] }).success).toBe(false);
      expect(ReviewVerificationContextSchema.safeParse({ ...review, checks: [{ ...review.checks[0], observation: changed }] }).success).toBe(false);
    }
  });
});
