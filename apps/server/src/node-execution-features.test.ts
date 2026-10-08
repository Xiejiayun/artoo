import type { NodeTransport } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerContext } from "./context.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { createNodeRegistry } from "./ws/node-registry.js";

const feature = "workspace-allocation.per-run-v1";
const context = new Proxy({} as ServerContext, {
  get() { throw new Error("Session feature queries must not access server dependencies"); },
});

describe("current binding execution-feature snapshots", () => {
  const bindings: NodeBinding[] = [];
  const transports: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  // This predicate models an explicitly qualified current session. Actual
  // WebSocket negotiation is exercised by the separate managed transport gate.
  function bind(computerId = "computer_one", features?: readonly string[], registry = createNodeRegistry(),
    qualification: { state: "hello" | "ready" | "active" } = { state: "active" }): NodeBinding {
    const transport: NodeTransport = {
      send: vi.fn(async () => { throw new Error("Feature queries must not dispatch commands"); }),
      subscribe: vi.fn(() => vi.fn()),
      close: vi.fn(async () => {}),
    };
    const binding: NodeBinding = attachNodeBinding(context, transport, computerId, features,
      () => qualification.state === "active" && registry.get(computerId) === binding);
    registry.register(computerId, binding);
    bindings.push(binding);
    transports.push({ send: transport.send as ReturnType<typeof vi.fn>, close: transport.close as ReturnType<typeof vi.fn> });
    return binding;
  }
  afterEach(() => {
    for (const binding of bindings.splice(0)) binding.close();
    for (const transport of transports.splice(0)) {
      expect(transport.send).not.toHaveBeenCalled();
      expect(transport.close).not.toHaveBeenCalled();
    }
  });

  it("denies missing and empty feature snapshots", () => {
    expect(bind().supportsExecutionFeature(feature)).toBe(false);
    expect(bind("computer_empty", []).supportsExecutionFeature(feature)).toBe(false);
  });

  it("matches exact advertised strings and does not infer related support", () => {
    const binding = bind("computer_one", [feature, "future-feature.v2"]);
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    expect(binding.supportsExecutionFeature("future-feature.v2")).toBe(true);
    expect(binding.supportsExecutionFeature("workspace-allocation.per-run-v2")).toBe(false);
    expect(binding.supportsExecutionFeature(feature.toUpperCase())).toBe(false);
    expect(binding.supportsExecutionFeature("code.modify")).toBe(false);
  });

  it("copies the input list so later mutation cannot add or remove support", () => {
    const features = [feature];
    const binding = bind("computer_one", features);
    features.splice(0, 1, "later-feature.v1");
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    expect(binding.supportsExecutionFeature("later-feature.v1")).toBe(false);
  });

  it("denies support after close even while the registry still retains the binding", () => {
    const registry = createNodeRegistry();
    const binding = bind("computer_one", [feature], registry);
    registry.register("computer_one", binding);
    expect(registry.get("computer_one")?.supportsExecutionFeature(feature)).toBe(true);
    binding.close();
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    expect(registry.get("computer_one")?.supportsExecutionFeature(feature)).toBe(false);
  });

  it("does not inherit a replaced capable session's support on a legacy reconnect", () => {
    const registry = createNodeRegistry();
    const capable = bind("computer_one", [feature], registry);
    registry.register("computer_one", capable);
    const supports: NonNullable<ServerContext["supportsExecutionFeature"]> =
      (computerId, name) => registry.get(computerId)?.supportsExecutionFeature(name) ?? false;
    expect(supports("computer_one", feature)).toBe(true);
    const legacy = bind("computer_one", undefined, registry);
    registry.register("computer_one", legacy);
    expect(supports("computer_one", feature)).toBe(false);
    expect(capable.supportsExecutionFeature(feature)).toBe(false);
    capable.close();
    expect(registry.unregister("computer_one", capable)).toBe(false);
    expect(registry.get("computer_one")).toBe(legacy);
    expect(supports("computer_one", feature)).toBe(false);
  });

  it("denies after current-session unregister and never borrows another computer's support", () => {
    const registry = createNodeRegistry();
    const first = bind("computer_one", [feature], registry);
    const second = bind("computer_two", ["different-feature.v1"], registry);
    registry.register("computer_one", first);
    registry.register("computer_two", second);
    const supports = (computerId: string, name: string): boolean =>
      registry.get(computerId)?.supportsExecutionFeature(name) ?? false;
    expect(supports("computer_one", feature)).toBe(true);
    expect(supports("computer_two", feature)).toBe(false);
    expect(supports("computer_two", "different-feature.v1")).toBe(true);
    expect(supports("computer_missing", feature)).toBe(false);
    expect(registry.unregister("computer_one", first)).toBe(true);
    expect(first.supportsExecutionFeature(feature)).toBe(false);
    expect(supports("computer_one", feature)).toBe(false);
    expect(supports("computer_two", "different-feature.v1")).toBe(true);
  });

  it("denies managed hello and ready fixture states until active and current", () => {
    const registry = createNodeRegistry();
    const qualification: { state: "hello" | "ready" | "active" } = { state: "hello" };
    const binding = bind("computer_one", [feature], registry, qualification);
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "ready";
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "active";
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    qualification.state = "hello";
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "active";
    expect(registry.unregister("computer_one", binding)).toBe(true);
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
  });
});
