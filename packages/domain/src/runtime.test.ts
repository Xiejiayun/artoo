import { describe, expect, it } from "vitest";

import { isRuntimeStale } from "./runtime.js";

const NOW = "2026-06-13T00:00:00.000Z";
const STALE_MS = 30_000;

describe("isRuntimeStale", () => {
  it("treats a null/absent last_seen_at as stale (anomalous row)", () => {
    expect(isRuntimeStale(null, NOW, STALE_MS)).toBe(true);
    expect(isRuntimeStale(undefined, NOW, STALE_MS)).toBe(true);
  });

  it("a just-now heartbeat is fresh", () => {
    expect(isRuntimeStale(NOW, NOW, STALE_MS)).toBe(false);
  });

  it("uses a strict threshold — exactly at the threshold is still fresh", () => {
    const exactly = "2026-06-12T23:59:30.000Z"; // 30s before NOW
    expect(isRuntimeStale(exactly, NOW, STALE_MS)).toBe(false);
    const justOver = "2026-06-12T23:59:29.999Z"; // 30.001s before NOW
    expect(isRuntimeStale(justOver, NOW, STALE_MS)).toBe(true);
  });

  it("an old heartbeat is stale", () => {
    expect(isRuntimeStale("2026-06-12T00:00:00.000Z", NOW, STALE_MS)).toBe(true);
  });

  it("parses timestamptz-style strings (space + offset) to the same instant", () => {
    // 2026-06-13 08:00:00+08 == 2026-06-13T00:00:00Z (the Postgres round-trip form)
    expect(isRuntimeStale("2026-06-13 08:00:00+08", NOW, STALE_MS)).toBe(false);
  });

  it("treats an unparseable timestamp as stale (safe exclusion)", () => {
    expect(isRuntimeStale("not-a-date", NOW, STALE_MS)).toBe(true);
  });
});
