import { z } from "zod";

/** Observed SKILL.md metadata, never a tool grant or scheduler capability. */
export const NativeSkillSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2048),
  path: z.string().min(1).max(4096),
  scope: z.enum(["user", "workspace"]),
  workspace_root: z.string().min(1).max(4096).optional(),
}).strict().superRefine((skill, ctx) => {
  if ((skill.scope === "workspace") !== (skill.workspace_root !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["workspace_root"], message: "Only workspace skills require a workspace root" });
  }
});
export type NativeSkill = z.infer<typeof NativeSkillSchema>;

export const MAX_NATIVE_SKILLS = 128;
export const NativeSkillInventoryV1Schema = z.object({
  version: z.literal(1),
  observed_at: z.string().datetime(),
  skills: z.array(NativeSkillSchema).max(MAX_NATIVE_SKILLS),
  truncated: z.boolean(),
  unreadable_count: z.number().int().nonnegative(),
}).strict();
export type NativeSkillInventoryV1 = z.infer<typeof NativeSkillInventoryV1Schema>;
