import { describe, expect, it } from "vitest";

import { createClaimLimiter } from "./claim-rate-limit.js";

describe("claim rate limiter (fixed window, per source)", () => {
  it("allows up to capacity within a window, then denies", () => {
    const limiter = createClaimLimiter({ capacity: 3, windowMs: 1000 });
    expect(limiter.tryConsume("1.2.3.4", 0)).toBe(true);
    expect(limiter.tryConsume("1.2.3.4", 100)).toBe(true);
    expect(limiter.tryConsume("1.2.3.4", 200)).toBe(true);
    expect(limiter.tryConsume("1.2.3.4", 300)).toBe(false); // 4th in window -> denied
  });

  it("resets when the window rolls over", () => {
    const limiter = createClaimLimiter({ capacity: 2, windowMs: 1000 });
    expect(limiter.tryConsume("s", 0)).toBe(true);
    expect(limiter.tryConsume("s", 10)).toBe(true);
    expect(limiter.tryConsume("s", 20)).toBe(false);
    // A new window (>= windowMs since the window start) resets the count.
    expect(limiter.tryConsume("s", 1000)).toBe(true);
  });

  it("tracks sources independently", () => {
    const limiter = createClaimLimiter({ capacity: 1, windowMs: 1000 });
    expect(limiter.tryConsume("a", 0)).toBe(true);
    expect(limiter.tryConsume("a", 1)).toBe(false);
    expect(limiter.tryConsume("b", 1)).toBe(true); // b has its own budget
  });
});
