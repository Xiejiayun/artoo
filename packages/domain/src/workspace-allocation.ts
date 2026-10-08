import { z } from "zod";

// Structural envelope only, matching existing retention DTO bounds. Target-OS
// lexical validity and exact allocation remain the protocol allocator's job.
const basePath = z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "base path must not contain NUL");

/** A dedicated setting; only an authorized administrator route may persist it. */
export const WorktreeBaseConfigurationSchema = z.object({
  version: z.literal(1),
  strategy: z.literal("per-run"),
  basePath,
}).strict();
export type WorktreeBaseConfiguration = z.infer<typeof WorktreeBaseConfigurationSchema>;

/**
 * Assignment-time snapshot, not permission or proof of root/branch coherence.
 * Later server/node integration must persist it once and enforce replay identity
 * before any write. This is a normal parsed DTO, not a runtime-frozen object.
 */
export const WorkspaceAllocationRecordSchema = z.object({
  version: z.literal(1),
  strategy: z.literal("per-run"),
  base_path: basePath,
}).strict();
export type WorkspaceAllocationRecord = z.infer<typeof WorkspaceAllocationRecordSchema>;
