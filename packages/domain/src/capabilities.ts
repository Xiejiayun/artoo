/**
 * Capability vocabulary (design.md §6.3).
 *
 * Single source of truth shared by the core scheduler matcher (task #5) and the
 * future skill.yaml capability declarations (v0.1-complete). The Zod enum is the
 * canonical list; the const tuple and union type are derived from it.
 */
import { z } from "zod";

export const CapabilitySchema = z.enum([
  "code.read",
  "code.modify",
  "code.review",
  "test.run",
  "git.patch",
  "github.pr",
  "browser.navigate",
  "browser.extract",
  "desktop.operate",
  "doc.write",
  "research.web",
  "shell.run",
]);

export const CAPABILITIES = CapabilitySchema.options;
export type Capability = z.infer<typeof CapabilitySchema>;

/** Pure: true iff every required capability is present in the offered set. */
export function matchCapabilities(
  required: readonly Capability[],
  offered: readonly Capability[],
): boolean {
  const offeredSet = new Set<Capability>(offered);
  return required.every((cap) => offeredSet.has(cap));
}

/** Narrowing guard for untrusted input. */
export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
