import { describe, expect, it } from "vitest";

import { RunEventDeduper, runEventKey } from "./ingest.js";

describe("runEventKey", () => {
  it("is stable and composed of (node_id, run_id, sequence)", () => {
    expect(runEventKey({ node_id: "n1", run_id: "r1", sequence: 7 })).toBe("n1:r1:7");
  });
});

describe("RunEventDeduper", () => {
  it("records a first-seen event and reports it as newly recorded", () => {
    const d = new RunEventDeduper();
    expect(d.isDuplicate({ node_id: "n1", run_id: "r1", sequence: 1 })).toBe(false);
    expect(d.record({ node_id: "n1", run_id: "r1", sequence: 1 })).toBe(true);
    expect(d.isDuplicate({ node_id: "n1", run_id: "r1", sequence: 1 })).toBe(true);
  });

  it("treats a replayed (node_id, run_id, sequence) as a duplicate", () => {
    const d = new RunEventDeduper();
    expect(d.record({ node_id: "n1", run_id: "r1", sequence: 1 })).toBe(true);
    expect(d.record({ node_id: "n1", run_id: "r1", sequence: 1 })).toBe(false);
  });

  it("keeps sequences within a run independent", () => {
    const d = new RunEventDeduper();
    d.record({ node_id: "n1", run_id: "r1", sequence: 1 });
    expect(d.isDuplicate({ node_id: "n1", run_id: "r1", sequence: 2 })).toBe(false);
  });

  it("keeps different runs and nodes independent", () => {
    const d = new RunEventDeduper();
    d.record({ node_id: "n1", run_id: "r1", sequence: 1 });
    expect(d.isDuplicate({ node_id: "n1", run_id: "r2", sequence: 1 })).toBe(false);
    expect(d.isDuplicate({ node_id: "n2", run_id: "r1", sequence: 1 })).toBe(false);
  });
});
