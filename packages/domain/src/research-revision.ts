import { z } from "zod";
import { ProductSourceDestinationMappingV1Schema } from "./product-source-semantics.js";
import { ReleaseCapabilitiesV1Schema, canonicalReleaseJson } from "./release-capabilities.js";
import { ProductResearchRevisionContextV1Schema } from "./research-revision-context.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const root = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/u);
// Portable comparison for advertised Windows scopes. The server independently
// validates absolute paths using the node OS before storing or executing them.
function scopeKey(root: string): string {
  const value = root.replaceAll("\\", "/").toLowerCase(), prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : "";
  const floor = prefix === "//" ? 2 : /^[a-z]:\//u.test(value) ? 1 : 0, parts: string[] = [];
  for (const part of value.split(/\/+/u)) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length > floor) parts.pop(); } else parts.push(part);
  }
  return prefix + parts.join("/");
}
export const ResearchRevisionParticipantV1Schema = z.object({ instance_id: id, agent_id: id,
  runtime: id, model_profile_id: id.nullable(), effort_profile_id: id.nullable() }).strict();
export const ResearchDestinationSlotV1Schema = z.object({ slot_id: id, index: z.number().int().min(0).max(10),
  mapping: ProductSourceDestinationMappingV1Schema, writer: ResearchRevisionParticipantV1Schema,
  reviewer: ResearchRevisionParticipantV1Schema }).strict().refine(value => value.writer.agent_id !== value.reviewer.agent_id
  && value.writer.instance_id !== value.reviewer.instance_id, "Independent destination participants are required");
export type ResearchDestinationSlotV1 = z.infer<typeof ResearchDestinationSlotV1Schema>;

/** Frozen by the trusted initial route selection. Members are already prepared local
 * scopes, not templates or permission to create profiles during execution. */
export const ResearchDestinationPoolSnapshotV1Schema = z.object({ version: z.literal(1),
  project_id: id, goal_id: id, plan_id: id, next_task_id: id, base_research_task_id: id,
  actor_user_id: id, consent_id: id.nullable(), policy_version: id, goal_digest: digest, plan_digest: digest,
  max_retries: z.number().int().min(0).max(10),
  source: z.object({ computer_id: id, workspace_root: root, release: ReleaseCapabilitiesV1Schema,
    writer: ResearchRevisionParticipantV1Schema, reviewer: ResearchRevisionParticipantV1Schema }).strict(),
  destination: z.object({ computer_id: id, writer_agent_id: id, reviewer_agent_id: id }).strict(),
  members: z.array(ResearchDestinationSlotV1Schema).min(1).max(11),
}).strict().superRefine((value, ctx) => {
  const first = value.members[0];
  const roots = value.members.map(member => scopeKey(member.mapping.destination_release.binding.workspace_root));
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  const sameRole = (a: z.infer<typeof ResearchRevisionParticipantV1Schema>, b: z.infer<typeof ResearchRevisionParticipantV1Schema>) =>
    a.agent_id === b.agent_id && a.runtime === b.runtime && a.model_profile_id === b.model_profile_id && a.effort_profile_id === b.effort_profile_id;
  if (value.members.length !== value.max_retries + 1 || value.source.computer_id === value.destination.computer_id
    || value.source.writer.agent_id === value.source.reviewer.agent_id || value.source.writer.instance_id === value.source.reviewer.instance_id
    || value.source.writer.agent_id === value.destination.reviewer_agent_id
    || value.source.release.binding.workspace_root !== value.source.workspace_root || value.source.release.binding.project_id !== value.project_id
    || new Set(value.members.map(member => member.slot_id)).size !== value.members.length
    || new Set(value.members.flatMap(member => [member.writer.instance_id, member.reviewer.instance_id])).size !== value.members.length * 2
    || roots.some((root, index) => roots.slice(0, index).some(other => inside(root, other) || inside(other, root)))
    || value.members.some((member, index) => member.index !== index
      || member.mapping.destination_release.binding.project_id !== value.project_id
      || canonicalReleaseJson(member.mapping.source_release) !== canonicalReleaseJson(value.source.release)
      || member.writer.agent_id !== value.destination.writer_agent_id || member.reviewer.agent_id !== value.destination.reviewer_agent_id
      || !first || !sameRole(member.writer, first.writer) || !sameRole(member.reviewer, first.reviewer))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Research destination pool changed its original source, bounded slots or fixed team roles" });
  }
});
export type ResearchDestinationPoolSnapshotV1 = z.infer<typeof ResearchDestinationPoolSnapshotV1Schema>;

export const ResearchRevisionIntentV1Schema = z.object({ version: z.literal(1), revision_id: id,
  project_id: id, goal_id: id, plan_id: id, next_task_id: id, base_research_task_id: id, auxiliary_task_id: id,
  actor_user_id: id, consent_id: id.nullable(), policy_version: id, goal_digest: digest, plan_digest: digest,
  pool_id: id, pool_digest: digest, slot_id: id, generation: z.number().int().min(1).max(10),
  attempt_index: z.number().int().positive(), authorization_event_id: id,
  predecessor_revision_id: id.nullable(),
  parent_review: z.object({ review_id: id, handoff_id: id, request_digest: digest, result_digest: digest }).strict(),
  baseline: ProductResearchRevisionContextV1Schema.shape.baseline,
  execution_authorized: z.literal(false),
}).strict();
export type ResearchRevisionIntentV1 = z.infer<typeof ResearchRevisionIntentV1Schema>;
export function canonicalResearchRevisionValueV1(value: unknown): string { return canonicalReleaseJson(value); }
