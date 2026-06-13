import { describe, expect, it } from "vitest";

import { createServerPlaceholder } from "./index.js";

describe("server skeleton", () => {
  it("exports a placeholder", () => {
    expect(createServerPlaceholder()).toBe("artoo-server");
  });
});
