import { nodeHeartbeatSchema } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createAdapterRegistry } from "./adapter-registry.js";
import { createRegistryHeartbeat } from "./heartbeat.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";

describe("createRegistryHeartbeat", () => {
  const registry = createAdapterRegistry([
    codexRuntime({ allowedRoots: ["/ws"] }),
    claudeCodeRuntime({ allowedRoots: ["/ws"] })
  ]);

  it("emits a schema-valid heartbeat carrying each runtime's capability tags", () => {
    const beat = createRegistryHeartbeat({ nodeId: "computer_1", registry });
    const hb = beat();
    expect(nodeHeartbeatSchema.safeParse(hb).success).toBe(true);
    expect(hb.node_id).toBe("computer_1");
    expect(hb.runtimes).toEqual([
      { runtime: "codex", status: "available", capabilities: ["code.read", "code.modify"] },
      {
        runtime: "claude-code",
        status: "available",
        capabilities: ["code.read", "code.modify", "code.review"]
      }
    ]);
  });

  it("never emits undefined capabilities", () => {
    const beat = createRegistryHeartbeat({ nodeId: "n", registry });
    for (const rt of beat().runtimes) {
      expect(Array.isArray(rt.capabilities)).toBe(true);
    }
  });

  it("generates a monotonically increasing sequence per process", () => {
    const beat = createRegistryHeartbeat({ nodeId: "n", registry });
    expect(beat().sequence).toBe(0);
    expect(beat().sequence).toBe(1);
    expect(beat().sequence).toBe(2);
  });

  it("defaults resources to zeros and running instances to []", () => {
    const hb = createRegistryHeartbeat({ nodeId: "n", registry })();
    expect(hb.resources).toEqual({ cpu_load: 0, memory_used_pct: 0, disk_free_gb: 0 });
    expect(hb.running_instances).toEqual([]);
  });

  it("uses injected resources and running instances when provided", () => {
    const hb = createRegistryHeartbeat({
      nodeId: "n",
      registry,
      resources: () => ({ cpu_load: 0.5, memory_used_pct: 40, disk_free_gb: 12 }),
      runningInstances: () => ["ai_1", "ai_2"]
    })();
    expect(hb.resources).toEqual({ cpu_load: 0.5, memory_used_pct: 40, disk_free_gb: 12 });
    expect(hb.running_instances).toEqual(["ai_1", "ai_2"]);
  });
});
