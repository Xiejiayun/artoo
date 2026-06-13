import { describe, expect, it } from "vitest";

import { createFixedIdGen } from "./fixed-idgen.js";

describe("createFixedIdGen", () => {
  it("produces sequential zero-padded ids per prefix", () => {
    const gen = createFixedIdGen();
    expect(gen.generate("evt")).toMatch(/^evt_0{26}$/);
    expect(gen.generate("evt")).toMatch(/^evt_0{25}1$/);
  });

  it("keeps prefixes independent", () => {
    const gen = createFixedIdGen();
    gen.generate("evt");
    expect(gen.generate("run")).toMatch(/^run_0{26}$/);
  });

  it("is monotonic and reset() restarts the sequence", () => {
    const gen = createFixedIdGen();
    gen.generate("evt");
    gen.generate("evt");
    gen.reset();
    expect(gen.generate("evt")).toMatch(/^evt_0{26}$/);
  });
});
