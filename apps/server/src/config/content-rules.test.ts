import { describe, expect, it } from "vitest";
import { contentRulesVersion, isContentBlocked, parseBlockedPhrases } from "./content-rules.js";

describe("bounded literal content rules", () => {
  it("normalizes case, compatibility forms, invisible direction characters and whitespace", () => {
    const phrases = parseBlockedPhrases(["Test Harm", "ＴＥＳＴ　ＨＡＲＭ", "test harm"]);
    expect(phrases).toEqual(["test harm"]);
    expect(isContentBlocked("A TEST\u200b\u202e\nHARM example", phrases)).toBe(true);
    expect(isContentBlocked("An ordinary team conversation", phrases)).toBe(false);
  });
  it("never executes a supplied regular expression", () => {
    const phrases = parseBlockedPhrases(["(a+)+$"]);
    expect(isContentBlocked("a".repeat(20000), phrases)).toBe(false);
    expect(isContentBlocked("Literal (a+)+$", phrases)).toBe(true);
  });
  it("rejects invalid or unbounded configuration and versions canonical rules", () => {
    for (const value of [null, ["ab"], ["   "], [4], ["x".repeat(201)], Array(129).fill("phrase")]) {
      expect(() => parseBlockedPhrases(value)).toThrow();
    }
    expect(contentRulesVersion(parseBlockedPhrases(["Bravo", "ALPHA"]))).toBe(contentRulesVersion(parseBlockedPhrases(["alpha", "bravo"])));
    expect(contentRulesVersion([])).not.toBe(contentRulesVersion(["alpha"]));
  });
});
