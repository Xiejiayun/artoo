import { describe, expect, it } from "vitest";
import { AutonomousTeamSchema, CreateAutonomousGoalRequestSchema, IndependentReviewVerdictSchema, RunVerificationPayloadSchema } from "./autonomy.js";

const hash = `sha256:${"a".repeat(64)}`;
const passed = { version: 1, request_id: "verify_1", profile_id: "default", profile_digest: hash,
  subject_digest: hash, outcome: "passed", checks: [{ id: "integration", exit_code: 0, duration_ms: 25, output_digest: hash }],
  required_files: [{ path: "src/main.ts", checksum: hash, size: 12 }] };

describe("autonomous verification contracts", () => {
  it("requires distinct contributors and a verdict bound to a measured source without blocking findings", () => {
    const team = { version: 1, members: ["research", "design", "implementation", "validation"].map((stage, index) => ({ stage, agent_instance_id: index === 2 ? "writer" : "specialist" })), reviewer_instance_ids: ["writer", "specialist"] };
    expect(AutonomousTeamSchema.safeParse(team).success).toBe(true);
    expect(AutonomousTeamSchema.safeParse({ ...team, members: team.members.map((member) => ({ ...member, agent_instance_id: "writer" })) }).success).toBe(false);
    expect(AutonomousTeamSchema.safeParse({ ...team, members: team.members.map((member) => ({ ...member, stage: "research" })) }).success).toBe(false);
    const verdict = { version: 1, reviewed_run_id: "run_1", verification_evidence_id: "evidence_1", subject_digest: hash,
      outcome: "accepted", summary: "Inspected the implementation", findings: [] };
    expect(IndependentReviewVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(IndependentReviewVerdictSchema.safeParse({ ...verdict, findings: [{ severity: "blocking", description: "Data loss" }] }).success).toBe(false);
    expect(IndependentReviewVerdictSchema.safeParse({ ...verdict, subject_digest: "trust-me" }).success).toBe(false);
  });
  it("defaults the opt-in request without accepting an empty objective or an unbounded retry budget", () => {
    expect(CreateAutonomousGoalRequestSchema.parse({ project_id: "project_1", objective: "Make a working app" }))
      .toMatchObject({ verification_profile_id: "default", max_retries: 3 });
    for (const input of [{ objective: "  " }, { max_retries: 11 }, { max_retries: -1 }, { max_retries: 1.5 }]) {
      expect(CreateAutonomousGoalRequestSchema.safeParse({ project_id: "project_1", objective: "App", ...input }).success).toBe(false);
    }
  });

  it("requires measured successful checks, content hashes and unique check identities before passing", () => {
    expect(RunVerificationPayloadSchema.parse(passed)).toEqual(passed);
    for (const change of [{ checks: [] }, { checks: [{ ...passed.checks[0], exit_code: null }] },
      { checks: [{ ...passed.checks[0], exit_code: 1 }] }, { checks: [passed.checks[0], passed.checks[0]] },
      { subject_digest: "agent-says-ok" }, { subject_digest: null }, { checks: [{ ...passed.checks[0], duration_ms: -1 }] }]) {
      expect(RunVerificationPayloadSchema.safeParse({ ...passed, ...change }).success).toBe(false);
    }
    expect(RunVerificationPayloadSchema.safeParse({ ...passed, outcome: "failed", checks: [], reason: "Missing verifier" }).success).toBe(true);
    expect(RunVerificationPayloadSchema.safeParse({ ...passed, outcome: "failed", subject_digest: null, checks: [], reason: "No source measurement available" }).success).toBe(true);
  });

  it("rejects duplicate, absolute and traversal paths in the required inventory", () => {
    for (const path of ["../secret", "/absolute", "C:/absolute", "src/../secret", "src\\main.ts", "src//main.ts"]) {
      expect(RunVerificationPayloadSchema.safeParse({ ...passed, required_files: [{ ...passed.required_files[0], path }] }).success).toBe(false);
    }
    expect(RunVerificationPayloadSchema.safeParse({ ...passed, required_files: [passed.required_files[0], passed.required_files[0]] }).success).toBe(false);
  });

  it("keeps observations optional and never lets them convert an unsuccessful measurement into passing evidence", () => {
    const observation = { version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "design",
      cases: [{ case_id: "prototype", viewport: 390, assertions: 0, screenshot_digest: hash }] };
    const measured = { ...passed, checks: [{ ...passed.checks[0], observation }] };
    expect(RunVerificationPayloadSchema.parse(measured)).toEqual(measured);
    expect(RunVerificationPayloadSchema.parse(passed)).toEqual(passed);
    for (const change of [{ outcome: "failed" }, { outcome: "cancelled" }, { subject_digest: null },
      { checks: [{ ...measured.checks[0], exit_code: 1 }] }]) {
      expect(RunVerificationPayloadSchema.safeParse({ ...measured, ...change }).success).toBe(false);
    }
    const cases = Array.from({ length: 1600 }, (_, index) => ({ ...observation.cases[0], case_id: `case_${index}_${"x".repeat(100)}` }));
    expect(RunVerificationPayloadSchema.safeParse({ ...passed, checks: Array.from({ length: 8 }, (_, index) => ({
      ...passed.checks[0], id: `check_${index}`, observation: { ...observation, cases },
    })) }).success).toBe(false);
  });
});
