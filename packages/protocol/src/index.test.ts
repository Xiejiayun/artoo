import { describe, expect, it } from "vitest";

import { ARTOO_PROTOCOL_PACKAGE } from "./index.js";

describe("protocol skeleton", () => {
  it("exports a package marker", () => {
    expect(ARTOO_PROTOCOL_PACKAGE).toBe("@artoo/protocol");
  });
});
