import { describe, expect, it } from "vitest";

import { ARTOO_STORAGE_PACKAGE } from "./index.js";

describe("storage skeleton", () => {
  it("exports a package marker", () => {
    expect(ARTOO_STORAGE_PACKAGE).toBe("@artoo/storage");
  });
});
