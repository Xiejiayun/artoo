import { describe, expect, it } from "vitest";
import { messageVisibilityBatchLimit } from "./message-sync.js";

describe("message sync capability negotiation", () => {
  it("keeps the original wire bound for absent, unknown or invalid capabilities", () => {
    for (const value of [undefined, null, {}, { version: 2, visibility_batch_limit: 500 },
      { version: 1, visibility_batch_limit: 501 }, { version: 1, visibility_batch_limit: 0 },
      { version: 1, visibility_batch_limit: 100.5 }, { version: 1, visibility_batch_limit: "500" }]) {
      expect(messageVisibilityBatchLimit(value)).toBe(100);
    }
  });
  it("honors a supported server's bounded capability, including smaller limits", () => {
    expect(messageVisibilityBatchLimit({ version: 1, visibility_batch_limit: 500 })).toBe(500);
    expect(messageVisibilityBatchLimit({ version: 1, visibility_batch_limit: 50 })).toBe(50);
  });
});
