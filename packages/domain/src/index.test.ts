import { describe, expect, it } from "vitest";

import { ARTOO_DOMAIN_PACKAGE } from "./index.js";

describe("domain skeleton", () => {
  it("exports a package marker", () => {
    expect(ARTOO_DOMAIN_PACKAGE).toBe("@artoo/domain");
  });
});
