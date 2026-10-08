import { describe, expect, it } from "vitest";
import { qualifyRunEventMessage } from "./run-event-receipt.js";

const base = {
  kind: "run.event", node_id: "computer_receipt", run_id: "run_receipt", sequence: 1,
  event: { type: "artifact.created", payload: { type: "report", uri: "report.txt",
    metadata: { result: { b: 2, a: 1 } }, checksum: null } },
};
const identity = (raw: unknown) => qualifyRunEventMessage(raw).bodyIdentity;
const artifact = (payload: Record<string, unknown>) => ({ ...base, event: { type: "artifact.created", payload } });

describe("qualified parsed wire-event identity", () => {
  it("pins independent canonical bytes and ignores nested object insertion order", () => {
    expect(identity(base)).toBe("run-event-body-v1:sha256:d562ee2e9e635f9713f3e8fd544c9175299d9aab9d8c7c7db6e480422f0d7362");
    expect(identity(artifact({ ...base.event.payload, metadata: { result: { a: 1, b: 2 } } }))).toBe(identity(base));
    expect(identity(artifact({ ...base.event.payload, metadata: { result: { a: 1, b: 3 } } }))).not.toBe(identity(base));
  });

  it("preserves array order and distinguishes absent from explicit null", () => {
    expect(identity(artifact({ ...base.event.payload, metadata: { order: [1, 2] } })))
      .not.toBe(identity(artifact({ ...base.event.payload, metadata: { order: [2, 1] } })));
    expect(identity(artifact({ type: "report", uri: "report.txt" })))
      .not.toBe(identity(artifact({ type: "report", uri: "report.txt", checksum: null })));
    const started = { ...base, event: { type: "run.lifecycle", payload: { phase: "started" } } };
    expect(identity(started)).not.toBe(identity({ ...started, event: { ...started.event, payload: { phase: "started", reason: null } } }));
  });

  it("uses the existing defaults and stripping instead of inventing wire normalization", () => {
    const missing = artifact({ type: "report", uri: "report.txt" });
    expect(identity(missing)).toBe(identity(artifact({ type: "report", uri: "report.txt", metadata: {} })));
    expect(identity({ ...base, supplied_body_hash: "forged", event: { ...base.event, discarded: "unknown" } })).toBe(identity(base));
    expect(identity(artifact({ ...base.event.payload, discarded: "unknown" }))).toBe(identity(base));
  });

  it("models serialized JSON: undefined may disappear and toJSON may normalize", () => {
    expect(identity(artifact({ ...base.event.payload, metadata: { result: { a: 1, b: 2 }, omitted: undefined } }))).toBe(identity(base));
    expect(identity({ toJSON: () => base })).toBe(identity(base));
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => identity(cyclic)).toThrow();
    expect(() => identity({ ...base, sequence: 1n })).toThrow();
    expect(() => identity(undefined)).toThrow("not a JSON frame");
  });

  it("matches schema handling of special keys and preserves keys inside unknown nested metadata", () => {
    const top = artifact({ ...base.event.payload, metadata: JSON.parse('{"__proto__":{"tag":1},"constructor":"kept"}') });
    const parsed = qualifyRunEventMessage(top).message.event;
    if (parsed.type !== "artifact.created") throw new Error("Expected artifact");
    expect(Object.hasOwn(parsed.payload.metadata, "__proto__")).toBe(false); // current Zod record behavior
    expect(parsed.payload.metadata.constructor).toBe("kept");
    expect(identity(top)).toBe(identity(artifact({ ...base.event.payload, metadata: { constructor: "kept" } })));
    const nested = (tag: number) => artifact({ ...base.event.payload,
      metadata: { nested: JSON.parse(`{"__proto__":{"tag":${tag}},"constructor":"kept"}`) } });
    const qualified = qualifyRunEventMessage(nested(1)).message.event;
    if (qualified.type !== "artifact.created") throw new Error("Expected artifact");
    expect(Object.hasOwn(qualified.payload.metadata.nested as object, "__proto__")).toBe(true);
    expect(identity(nested(1))).not.toBe(identity(nested(2)));
  });

  it("detaches the exact parsed snapshot used by downstream mapping", () => {
    const raw = structuredClone(base), qualified = qualifyRunEventMessage(raw);
    raw.event.payload.metadata.result.a = 9;
    raw.event.payload.uri = "mutated.txt";
    expect(qualified.message.event).toEqual(base.event);
    expect(qualified.bodyIdentity).toBe(identity(base));
  });
});
