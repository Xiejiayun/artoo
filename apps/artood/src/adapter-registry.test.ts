import type { RuntimeAdapter } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createAdapterRegistry } from "./adapter-registry.js";

function stubAdapter(id: string): RuntimeAdapter {
  return {
    runtimeId: id,
    async start(config) {
      return { runId: config.runId };
    },
    async *streamEvents() {},
    async stop() {},
    async collectArtifacts() {
      return [];
    }
  };
}

describe("createAdapterRegistry", () => {
  it("resolves a registered runtime to its adapter", () => {
    const codex = stubAdapter("codex");
    const claude = stubAdapter("claude-code");
    const registry = createAdapterRegistry([
      { runtime: "codex", adapter: codex, capabilities: ["code.modify"] },
      { runtime: "claude-code", adapter: claude, capabilities: ["code.modify", "code.review"] }
    ]);
    expect(registry.resolve("codex")).toBe(codex);
    expect(registry.resolve("claude-code")).toBe(claude);
  });

  it("resolves an unknown runtime to undefined (no fallback)", () => {
    const registry = createAdapterRegistry([{ runtime: "codex", adapter: stubAdapter("codex") }]);
    expect(registry.resolve("mystery")).toBeUndefined();
  });

  it("reports registered runtimes + capabilities for heartbeat", () => {
    const registry = createAdapterRegistry([
      { runtime: "codex", adapter: stubAdapter("codex"), capabilities: ["code.modify"] },
      { runtime: "mock", adapter: stubAdapter("mock") }
    ]);
    expect(registry.runtimes()).toEqual([
      { runtime: "codex", capabilities: ["code.modify"] },
      { runtime: "mock", capabilities: [] }
    ]);
  });

  it("last registration wins for a duplicate runtime id", () => {
    const first = stubAdapter("first");
    const second = stubAdapter("second");
    const registry = createAdapterRegistry([
      { runtime: "x", adapter: first },
      { runtime: "x", adapter: second }
    ]);
    expect(registry.resolve("x")).toBe(second);
  });
});
