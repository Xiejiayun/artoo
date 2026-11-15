import { describe, expect, it } from "vitest";
import { CreateTaskRequestSchema } from "./api.js";
import { EnqueueSourceV1Schema, SourceInputsV1Schema } from "./enqueue-source.js";

describe("versioned task enqueue provenance", () => {
  it("preserves ordinary requests and requires explicit strict source identity", () => {
    expect(CreateTaskRequestSchema.parse({ project_id: "p", title: "Task" }).enqueue_source).toBeUndefined();
    const source = { version: 1, kind: "issue", key: "repository/1", event_id: "comment/1" };
    expect(EnqueueSourceV1Schema.parse(source)).toEqual({ ...source, target_key: "default" });
    for (const invalid of [
      { ...source, version: 2 },
      { ...source, key: " " },
      { ...source, event_id: undefined },
      { ...source, kind: "agent" },
      { ...source, actor_id: "other" },
      { ...source, command: "run" },
      { ...source, comment: " " },
      { ...source, comment: "x".repeat(20001) },
    ]) {
      expect(EnqueueSourceV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
  it("bounds the frozen input contract without accepting claimed authority", () => {
    const snapshot = { version: 1, digest: `sha256:${"a".repeat(64)}`, entries: [] };
    expect(SourceInputsV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(SourceInputsV1Schema.safeParse({ ...snapshot, execution_authorized: true }).success).toBe(false);
    expect(
      SourceInputsV1Schema.safeParse({
        ...snapshot,
        entries: Array.from({ length: 11 }, (_, i) => ({
          event_id: String(i),
          message_id: String(i),
          actor_id: "actor",
          body: "x".repeat(20000),
        })),
      }).success,
    ).toBe(false);
  });
});
