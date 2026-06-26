import { describe, expect, it } from "vitest";

import {
  asRunStatus,
  evaluateResume,
  isTerminalRunStatus,
  reconcileRun,
  type RunResumeFact,
} from "./resume.js";

describe("resume-from-checkpoint evaluation (#115 P2)", () => {
  it("classifies terminal run statuses", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("queued")).toBe(false);
  });

  it("reconciles a single run per #128 §3", () => {
    expect(reconcileRun({ run_id: "r", status: "running", updated_since_checkpoint: true })).toBe("continue");
    expect(reconcileRun({ run_id: "r", status: "running", updated_since_checkpoint: false })).toBe("stale_blocker");
    expect(reconcileRun({ run_id: "r", status: "completed", updated_since_checkpoint: false })).toBe("completed");
    expect(reconcileRun({ run_id: "r", status: "failed", updated_since_checkpoint: true })).toBe("failed_blocker");
    expect(reconcileRun({ run_id: "r", status: "cancelled", updated_since_checkpoint: true })).toBe("failed_blocker");
    expect(reconcileRun({ run_id: "r", status: null, updated_since_checkpoint: false })).toBe("missing_blocker");
  });

  it("evaluates a mixed checkpoint into continue / completed / blockers", () => {
    const facts = new Map<string, RunResumeFact>([
      ["run_live", { run_id: "run_live", status: "running", updated_since_checkpoint: true }],
      ["run_done", { run_id: "run_done", status: "completed", updated_since_checkpoint: true }],
      ["run_dead", { run_id: "run_dead", status: "failed", updated_since_checkpoint: true }],
      ["run_stale", { run_id: "run_stale", status: "running", updated_since_checkpoint: false }],
      // run_gone deliberately absent → treated as missing
    ]);
    const result = evaluateResume(
      { active_runs: ["run_live", "run_done", "run_dead", "run_stale", "run_gone"] },
      facts,
    );
    expect(result.continue_runs).toEqual(["run_live"]);
    expect(result.completed_runs).toEqual(["run_done"]);
    expect(result.blockers).toEqual([
      { run_id: "run_dead", type: "failed_run", reason: "failed_blocker" },
      { run_id: "run_stale", type: "stale_runtime", reason: "stale_blocker" },
      { run_id: "run_gone", type: "failed_run", reason: "missing_blocker" },
    ]);
    expect(result.safe_to_resume).toBe(false);
  });

  it("is safe_to_resume when every active run continues or completed", () => {
    const result = evaluateResume(
      { active_runs: ["a", "b"] },
      {
        a: { run_id: "a", status: "running", updated_since_checkpoint: true },
        b: { run_id: "b", status: "completed", updated_since_checkpoint: true },
      },
    );
    expect(result.blockers).toHaveLength(0);
    expect(result.safe_to_resume).toBe(true);
  });

  it("accepts a plain record as facts and preserves checkpoint order", () => {
    const result = evaluateResume(
      { active_runs: ["z", "a"] },
      {
        a: { run_id: "a", status: "running", updated_since_checkpoint: true },
        z: { run_id: "z", status: "failed", updated_since_checkpoint: true },
      },
    );
    expect(result.blockers[0]!.run_id).toBe("z"); // follows active_runs order, not insertion
    expect(result.continue_runs).toEqual(["a"]);
  });

  it("asRunStatus narrows valid statuses and rejects junk", () => {
    expect(asRunStatus("running")).toBe("running");
    expect(asRunStatus("nonsense")).toBeNull();
  });
});
