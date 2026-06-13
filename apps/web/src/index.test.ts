import { describe, expect, it } from "vitest";

import { createWebPlaceholder } from "./index.js";

describe("web skeleton", () => {
  it("exports a placeholder", () => {
    expect(createWebPlaceholder()).toBe("artoo-web");
  });
});
