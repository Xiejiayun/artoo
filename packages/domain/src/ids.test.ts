import { describe, expect, it } from "vitest";

import { createSystemClock, type Clock } from "./clock.js";
import { ID_PREFIXES, createUlidIdGen, formatId, type IdGen } from "./ids.js";

describe("ids", () => {
  it("formatId joins prefix and body", () => {
    expect(formatId("evt", "ABC")).toBe("evt_ABC");
  });

  it("createUlidIdGen produces prefixed, distinct ids", () => {
    const gen = createUlidIdGen();
    const a = gen.generate(ID_PREFIXES.task);
    const b = gen.generate(ID_PREFIXES.task);
    expect(a.startsWith("task_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("supports an injected deterministic IdGen", () => {
    let n = 0;
    const fixed: IdGen = { generate: (prefix) => formatId(prefix, String(++n).padStart(3, "0")) };
    expect(fixed.generate(ID_PREFIXES.run)).toBe("run_001");
    expect(fixed.generate(ID_PREFIXES.run)).toBe("run_002");
  });
});

describe("clock", () => {
  it("system clock returns a Date and ISO string", () => {
    const clock = createSystemClock();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(typeof clock.nowIso()).toBe("string");
  });

  it("supports an injected fixed clock", () => {
    const fixed: Clock = {
      now: () => new Date("2026-06-13T00:00:00.000Z"),
      nowIso: () => "2026-06-13T00:00:00.000Z",
    };
    expect(fixed.nowIso()).toBe("2026-06-13T00:00:00.000Z");
    expect(fixed.now().getUTCFullYear()).toBe(2026);
  });
});
