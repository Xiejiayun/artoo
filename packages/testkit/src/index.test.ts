import { describe, expect, it } from "vitest";

import { ARTOO_TESTKIT_PACKAGE } from "./index.js";

describe("testkit skeleton", () => {
  it("exports a package marker", () => {
    expect(ARTOO_TESTKIT_PACKAGE).toBe("@artoo/testkit");
  });
});
