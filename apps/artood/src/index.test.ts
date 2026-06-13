import { describe, expect, it } from "vitest";

import { createArtoodPlaceholder } from "./index.js";

describe("artood skeleton", () => {
  it("exports a placeholder", () => {
    expect(createArtoodPlaceholder()).toBe("artoo-artood");
  });
});
