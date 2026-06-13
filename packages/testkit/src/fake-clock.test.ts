import { describe, expect, it } from "vitest";

import { createFakeClock } from "./fake-clock.js";

describe("createFakeClock", () => {
  it("starts at the given instant and does not drift", () => {
    const clock = createFakeClock("2026-06-11T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-06-11T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("advances deterministically", () => {
    const clock = createFakeClock("2026-06-11T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.nowIso()).toBe("2026-06-11T00:00:01.500Z");
    expect(clock.now().getTime()).toBe(new Date("2026-06-11T00:00:01.500Z").getTime());
  });

  it("set jumps to a specific instant", () => {
    const clock = createFakeClock();
    clock.set(new Date("2030-01-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2030-01-01T00:00:00.000Z");
  });
});
