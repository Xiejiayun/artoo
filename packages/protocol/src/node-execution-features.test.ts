import { describe, expect, it } from "vitest";

import { nodeHelloSchema } from "./node-messages.js";

const hello = {
  kind: "node.hello",
  node_id: "computer_one",
  protocol_version: "2026-06-11",
  artood_version: "0.1.0",
  machine: { hostname: "workstation", os: "linux", arch: "x64" },
};
const feature = "workspace-allocation.per-run-v1";

describe("node.hello execution features", () => {
  it("preserves the exact parsed legacy hello shape when features are omitted", () => {
    const parsed = nodeHelloSchema.parse(hello);
    expect(parsed).toEqual(hello);
    expect(Object.hasOwn(parsed, "execution_features")).toBe(false);
  });

  it("preserves explicit empty feature lists", () => {
    expect(nodeHelloSchema.parse({ ...hello, execution_features: [] }).execution_features).toEqual([]);
  });

  it("preserves known and unknown feature strings through JSON serialization", () => {
    const value = { ...hello, execution_features: [feature, "future-feature.v2"] };
    expect(nodeHelloSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("does not infer features from the protocol or artood version", () => {
    const parsed = nodeHelloSchema.parse({ ...hello, protocol_version: "future", artood_version: "999.0.0" });
    expect(Object.hasOwn(parsed, "execution_features")).toBe(false);
  });

  it("accepts both inclusive size boundaries without changing strings", () => {
    const execution_features = Array.from({ length: 32 }, (_, i) => String(i).padEnd(128, "x"));
    expect(nodeHelloSchema.parse({ ...hello, execution_features }).execution_features).toEqual(execution_features);
  });

  it.each([
    ["null list", null],
    ["string instead of list", feature],
    ["object instead of list", {}],
    ["empty entry", [""]],
    ["oversized entry", ["x".repeat(129)]],
    ["too many entries", Array.from({ length: 33 }, () => feature)],
    ["number entry", [123]],
    ["boolean entry", [true]],
    ["nested list", [[feature]]],
  ])("rejects %s", (_label, execution_features) => {
    expect(nodeHelloSchema.safeParse({ ...hello, execution_features }).success).toBe(false);
  });
});
