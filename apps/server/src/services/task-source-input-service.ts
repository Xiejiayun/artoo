import { createHash } from "node:crypto";
import { contextPacks, messages, runs, taskEnqueueEvents } from "@artoo/db";
import { ContextPackSchema, SourceInputsV1Schema, type SourceInputsV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, is, isNull } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** Read-only snapshot for accounting/comparison; this alone cannot fence execution or review. */
export async function readTaskSourceInputs(
  ctx: ServerContext,
  tx: DrizzleDb,
  taskId: string,
): Promise<SourceInputsV1 | undefined> {
  return collectTaskSourceInputs(ctx, tx, taskId, false);
}

/** Caller holds the Task lock. Message locks live through this same transaction. */
export async function freezeTaskSourceInputs(
  ctx: ServerContext,
  tx: DrizzleDb,
  taskId: string,
): Promise<SourceInputsV1 | undefined> {
  if (!is(tx, PgTransaction)) throw AppError.conflict("Freezing source inputs requires a database transaction");
  try {
    return await collectTaskSourceInputs(ctx, tx, taskId, true);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    if ((cause as { code?: string } | null)?.code === "55P03")
      throw AppError.conflict("Source comments are changing; retry the complete operation", {
        reason: "source_inputs_busy",
        task_id: taskId,
      });
    throw error;
  }
}

async function collectTaskSourceInputs(
  ctx: ServerContext,
  tx: DrizzleDb,
  taskId: string,
  lockMessages: boolean,
): Promise<SourceInputsV1 | undefined> {
  const scopedMessage = and(
    eq(messages.id, taskEnqueueEvents.messageId),
    eq(messages.organizationId, ctx.organizationId),
    eq(messages.taskId, taskId),
  );
  const query = tx
    .select({
      event_id: taskEnqueueEvents.eventKey,
      message_id: messages.id,
      body: messages.body,
      actor_id: messages.actorId,
    })
    .from(taskEnqueueEvents)
    .innerJoin(messages, scopedMessage)
    .where(and(eq(taskEnqueueEvents.taskId, taskId), isNull(messages.moderatedAt)))
    .orderBy(asc(taskEnqueueEvents.position))
    // One extra visible row proves overflow without materializing all history.
    .limit(101);
  // Moderation locks message -> Task event. Never wait in the opposite order
  // while owning Task: fail the whole owner transaction and let moderation finish.
  const rows = await (lockMessages ? query.for("share", { of: messages, noWait: true }) : query);
  if (!rows.length) {
    const [history] = await tx
      .select({ id: messages.id })
      .from(taskEnqueueEvents)
      .innerJoin(messages, scopedMessage)
      .where(eq(taskEnqueueEvents.taskId, taskId))
      .limit(1);
    // Entirely moderated history still has an empty input digest that review
    // must compare. A source event without a matching message is not an input.
    if (!history) return undefined;
  }
  const entries = rows;
  if (entries.length > 100 || entries.reduce((sum, entry) => sum + entry.body.length, 0) > 200000)
    throw AppError.conflict("Persisted source inputs exceed the execution context limit");
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
  return SourceInputsV1Schema.parse({ version: 1, digest, entries });
}

/** Checks only the trusted persisted latest Run/ContextPack; model output is never a cursor. */
export async function assertSourceInputsReviewed(ctx: ServerContext, tx: DrizzleDb, taskId: string): Promise<void> {
  const current = await freezeTaskSourceInputs(ctx, tx, taskId);
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
