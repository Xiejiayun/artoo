import { describe, expect, it } from "vitest";

import { CAPABILITIES, CapabilitySchema, isCapability, matchCapabilities } from "./capabilities.js";

describe("capabilities", () => {
  it("matches when required is a subset of offered", () => {
    expect(
      matchCapabilities(["code.modify", "test.run"], ["code.modify", "test.run", "git.patch"]),
    ).toBe(true);
  });

  it("fails when a required capability is missing", () => {
    expect(matchCapabilities(["github.pr"], ["code.modify"])).toBe(false);
  });

  it("empty required always matches", () => {
    expect(matchCapabilities([], ["code.read"])).toBe(true);
  });

  it("isCapability guards unknown strings", () => {
    expect(isCapability("code.review")).toBe(true);
    expect(isCapability("fly.drone")).toBe(false);
  });

  it("schema parses the full vocabulary", () => {
    for (const cap of CAPABILITIES) {
      expect(CapabilitySchema.parse(cap)).toBe(cap);
    }
  });
});
