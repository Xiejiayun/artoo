import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contextPacks, eventLog, runEvidence, runs } from "@artoo/db";
import { ApplicationPublicationVerificationAckV1Schema, ContextPackSchema, VerificationRequirementSchema,
  canonicalReleaseJson, type ApplicationPublicationVerificationAckV1 } from "@artoo/domain";
import type { RunEventMessage } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** Called only after qualified full-frame ingestion commits. Server evidence IDs
 * are returned as server facts, bound to the exact original node event body and
 * paired connection; a later publication request cannot supply these facts. */
export async function committedApplicationVerificationReceipt(ctx: ServerContext, frame: RunEventMessage,
  session: { computerId: string; sessionId: string }, isCurrent: () => boolean,
): Promise<ApplicationPublicationVerificationAckV1 | undefined> {
  if (frame.event.type !== "run.verification" || frame.event.payload.application?.publication === undefined) return undefined;
  if (!isCurrent() || session.computerId !== frame.node_id) throw AppError.conflict("Application verification receipt lost its original paired session");
  const [stored] = await ctx.db.db.select({ run: runs, context: contextPacks.payload, evidence: runEvidence, event: eventLog })
    .from(runs).innerJoin(contextPacks, and(eq(contextPacks.id, runs.contextPackId), eq(contextPacks.runId, runs.id),
      eq(contextPacks.taskId, runs.taskId), eq(contextPacks.organizationId, ctx.organizationId)))
    .innerJoin(runEvidence, and(eq(runEvidence.runId, runs.id), eq(runEvidence.organizationId, ctx.organizationId),
      eq(runEvidence.requestId, frame.event.payload.request_id)))
    .innerJoin(eventLog, and(eq(eventLog.id, runEvidence.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .where(and(eq(runs.id, frame.run_id), eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, session.computerId)));
  const context = ContextPackSchema.safeParse(stored?.context), requirement = VerificationRequirementSchema.safeParse(stored?.run.verificationRequirement);
  if (!stored || !context.success || !requirement.success || !context.data.app_publication
    || !context.data.application_publication || !requirement.data.application_publication
    || context.data.application_publication.publisher_session_id !== session.sessionId
    || requirement.data.application_publication.publisher_session_id !== session.sessionId
    || requirement.data.request_id !== frame.event.payload.request_id
    || requirement.data.profile_id !== frame.event.payload.profile_id
    || !isDeepStrictEqual(stored.evidence.payload, frame.event.payload)
    || !isDeepStrictEqual(stored.event.payload, stored.evidence.payload)
    || stored.event.type !== "run.verification" || stored.event.runId !== frame.run_id
    || stored.event.sequence !== frame.sequence
    || stored.event.taskId !== stored.run.taskId || stored.event.actorType !== "system" || stored.event.actorId !== session.computerId
    || !isCurrent()) throw AppError.conflict("Application verification receipt lacks its original committed event, evidence or session");
  return ApplicationPublicationVerificationAckV1Schema.parse({ version: 1, request_id: stored.evidence.requestId,
    evidence_id: stored.evidence.id, event_id: stored.event.id, publisher_session_id: session.sessionId,
    payload_digest: `sha256:${createHash("sha256").update(canonicalReleaseJson(frame.event.payload)).digest("hex")}` });
}
