import { describe, expect, it } from "vitest";

import {
  ARTIFACT_TYPES,
  ArtifactPayloadSchema,
  RunLifecyclePayloadSchema,
  RunOutputPayloadSchema,
  RunStartPayloadSchema,
} from "./node-payloads.js";

describe("node payloads", () => {
  it("RunStartPayload validates a full start-command payload", () => {
    const payload = {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "mock",
      workspace: { root: "C:/workspace/artoo" },
      context_pack: { id: "ctx_1" },
      policy_snapshot: {
        filesystem_write_scope: ["C:/workspace/artoo"],
        requires_approval: ["git.push"],
      },
      artifact_rules: { paths: ["*.patch"] },
    };
    expect(RunStartPayloadSchema.parse(payload).run_id).toBe("run_1");
  });

  it("RunOutput / RunLifecycle / Artifact payloads validate", () => {
    expect(RunOutputPayloadSchema.parse({ stream: "stdout", text: "hi" }).stream).toBe("stdout");
    expect(RunLifecyclePayloadSchema.parse({ phase: "started" }).phase).toBe("started");
    expect(ArtifactPayloadSchema.parse({ type: "patch", uri: "fix.patch" }).metadata).toEqual({});
    expect(ARTIFACT_TYPES).toContain("pull_request");
  });

  it("rejects an unknown artifact type", () => {
    expect(ArtifactPayloadSchema.safeParse({ type: "hologram", uri: "x" }).success).toBe(false);
  });
});
