import { describe, expect, it } from "vitest";
import { ReviewVerificationContextSchema, StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";

const digest = `sha256:${"a".repeat(64)}`;
const report = { version: 1, format: "static-web-acceptance.v1", stage: "design", passed: true, requirements: 17,
  cases: [390, 1280].map((viewport) => ({ case_id: "prototype", viewport, assertions: 0, screenshot_digest: digest })) };
const observation = { version: 1, format: report.format, stage: report.stage, scope: "final", cases: report.cases };

describe("bounded node observation contracts", () => {
  it("describes only the actual browser cases without equating declared requirements with coverage", () => {
    expect(StaticWebAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    for (const change of [{ passed: true }, { requirements: 17 }, { format: "guess-from-command-name" },
      { cases: [report.cases[0], report.cases[0]] }, { cases: [{ ...report.cases[0], assertions: -1 }] },
      { cases: [{ ...report.cases[0], viewport: 8193 }] }]) {
      expect(VerificationObservationSchema.safeParse({ ...observation, ...change }).success).toBe(false);
    }
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, passed: false }).success).toBe(false);
  });

  it("requires a complete bundle of opaque references instead of external paths or URLs", () => {
    const evidence_bundle = { bundle_id: "bundle_123", manifest_digest: digest };
    const cases = report.cases.map((item, index) => ({ ...item, screenshot_ref: `image_${index}` }));
    expect(VerificationObservationSchema.parse({ ...observation, cases, evidence_bundle })).toMatchObject({ cases, evidence_bundle });
    for (const value of [{ ...observation, cases }, { ...observation, evidence_bundle },
      { ...observation, evidence_bundle, cases: cases.map((item) => ({ ...item, screenshot_ref: "same_ref" })) },
      { ...observation, evidence_bundle, cases: cases.map((item) => ({ ...item, screenshot_ref: "https://private/image.png" })) }]) {
      expect(VerificationObservationSchema.safeParse(value).success).toBe(false);
    }
  });

  it("allows legacy unknown scope in review context but excludes preview observations", () => {
    const context = { version: 1, request_id: "request", profile_id: "profile", profile_digest: digest,
      checks: [{ id: "browser", output_digest: digest }] };
    expect(ReviewVerificationContextSchema.parse(context)).toEqual(context);
    expect(ReviewVerificationContextSchema.safeParse({ ...context, checks: [{ ...context.checks[0], observation }] }).success).toBe(true);
    expect(ReviewVerificationContextSchema.safeParse({ ...context, checks: [{ ...context.checks[0],
      observation: { ...observation, scope: "preview" } }] }).success).toBe(false);
  });
});
