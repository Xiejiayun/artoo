import { describe, expect, it } from "vitest";

import { ARTOO_DB_PACKAGE } from "./index.js";

describe("db skeleton", () => {
  it("exports a package marker", () => {
    expect(ARTOO_DB_PACKAGE).toBe("@artoo/db");
  });
});
