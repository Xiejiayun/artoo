import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

/** Literal text only: never execute administrator-provided regular expressions. */
export function normalizeContent(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").replace(/\s+/gu, " ").trim();
}
export function parseBlockedPhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) throw AppError.validation("Use a list of at most 128 blocked phrases.");
  const phrases = value.map((phrase) => {
    if (typeof phrase !== "string" || phrase.length > 512) throw AppError.validation("Each blocked phrase must contain 3–200 characters.");
    const normalized = normalizeContent(phrase);
    if (normalized.length < 3 || normalized.length > 200) throw AppError.validation("Each blocked phrase must contain 3–200 characters.");
    return normalized;
  });
  return [...new Set(phrases)].sort();
}
export function contentRulesVersion(phrases: string[]): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(phrases)).digest("hex");
}
export function isContentBlocked(body: string, phrases: string[]): boolean {
  const normalized = normalizeContent(body);
  return phrases.some((phrase) => normalized.includes(phrase));
}

export const REMOVED_MESSAGE = "This message was removed by a team administrator.";
