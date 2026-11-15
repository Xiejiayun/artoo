import { createHash } from "node:crypto";
import { contextPacks, messages, runs, taskEnqueueEvents } from "@artoo/db";
import { ContextPackSchema, SourceInputsV1Schema, type SourceInputsV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** Caller holds the Task lock when freezing/accepting inputs or appending a source event. */
export async function readTaskSourceInputs(
  ctx: ServerContext,
  tx: DrizzleDb,
  taskId: string,
): Promise<SourceInputsV1 | undefined> {
  const rows = await tx
    .select({ eventId: taskEnqueueEvents.eventKey, message: messages })
    .from(taskEnqueueEvents)
    .innerJoin(
      messages,
      and(
        eq(messages.id, taskEnqueueEvents.messageId),
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.taskId, taskId),
      ),
    )
    .where(eq(taskEnqueueEvents.taskId, taskId))
    .orderBy(asc(taskEnqueueEvents.position));
  if (!rows.length) return undefined;
  const entries = rows
    .filter(({ message }) => message.moderatedAt === null)
    .map(({ eventId, message }) => ({
      event_id: eventId,
      message_id: message.id,
      body: message.body,
      actor_id: message.actorId,
    }));
  if (entries.length > 100 || entries.reduce((sum, entry) => sum + entry.body.length, 0) > 200000)
    throw AppError.conflict("Persisted source inputs exceed the execution context limit");
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
  return SourceInputsV1Schema.parse({ version: 1, digest, entries });
}

/** Checks only the trusted persisted latest Run/ContextPack; model output is never a cursor. */
export async function assertSourceInputsReviewed(ctx: ServerContext, tx: DrizzleDb, taskId: string): Promise<void> {
  const current = await readTaskSourceInputs(ctx, tx, taskId);
  if (!current) return;
  const [latest] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.organizationId, ctx.organizationId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  const [pack] = latest
    ? await tx
        .select()
        .from(contextPacks)
        .where(
          and(
            eq(contextPacks.id, latest.contextPackId!),
            eq(contextPacks.runId, latest.id),
            eq(contextPacks.taskId, taskId),
            eq(contextPacks.organizationId, ctx.organizationId),
          ),
        )
    : [];
  const frozen = ContextPackSchema.safeParse(pack?.payload);
  if (
    !latest ||
    latest.status !== "completed" ||
    !frozen.success ||
    frozen.data.source_inputs?.digest !== current.digest
  ) {
    throw AppError.conflict(
      "Source comments changed after the latest execution context. Request changes and run again before acceptance",
      { task_id: taskId },
    );
  }
}
