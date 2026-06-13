import { describe, expect, it } from "vitest";

import {
  EVENT_SCHEMA_VERSION,
  isCoreEventType,
  isKnownMessageKind,
  normalizeMessageKind,
  parseEvent,
} from "./events.js";

const baseEvent = {
  id: "evt_1",
  type: "task.created",
  schema_version: EVENT_SCHEMA_VERSION,
  organization_id: "org_default",
  actor: { type: "user", id: "user_1" },
  occurred_at: "2026-06-13T00:00:00Z",
  correlation_id: "corr_1",
};

describe("event envelope", () => {
  it("validates a well-formed core event and defaults payload", () => {
    const result = parseEvent(baseEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.known).toBe(true);
      expect(result.value.event.payload).toEqual({});
    }
  });

  it("forward-compat: unknown type parses with known=false and does not throw", () => {
    const result = parseEvent({ ...baseEvent, type: "future.event.v2" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.known).toBe(false);
    }
  });

  it("rejects a malformed envelope (missing actor)", () => {
    const result = parseEvent({ ...baseEvent, actor: undefined });
    expect(result.ok).toBe(false);
  });

  it("isCoreEventType narrows known types incl. failure/cancel lifecycle", () => {
    expect(isCoreEventType("run.completed")).toBe(true);
    expect(isCoreEventType("run.failed")).toBe(true);
    expect(isCoreEventType("run.cancelled")).toBe(true);
    expect(isCoreEventType("not.an.event")).toBe(false);
  });
});

describe("message kinds", () => {
  it("known kinds pass through", () => {
    expect(normalizeMessageKind("approval_request")).toBe("approval_request");
    expect(isKnownMessageKind("text")).toBe(true);
  });

  it("unknown kind degrades to system_notice", () => {
    expect(normalizeMessageKind("future_kind")).toBe("system_notice");
    expect(isKnownMessageKind("future_kind")).toBe(false);
  });
});
