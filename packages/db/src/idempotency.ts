import { and, eq } from "drizzle-orm";

import type { DbClient, DrizzleDb } from "@artoo/storage";

import { appendEvent, type EventInput } from "./event-writer.js";
import { idempotencyKeys } from "./schema.js";

export interface IdempotentParams {
  /**
   * Idempotency scope. For re-entrant operations (assign/retry after
   * review->ready or blocked->ready) this MUST include the attempt/run dimension
   * (e.g. `task:t1:assign:run_2`), NOT just the task id, or a legitimate second
   * assignment is mis-deduped as a replay (Round 17/18).
   */
  scope: string;
  key: string;
  /** Hash of the request body; reusing a key with a different body is a conflict. */
  requestHash: string;
  now: string;
}

export interface IdempotentResult<T> {
  replayed: boolean;
  response: T;
  eventIds: string[];
}

export class IdempotencyConflictError extends Error {
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super(`idempotency key reused with a different request: ${scope}/${key}`);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Canonical write-with-idempotency, all in one transaction. The first call runs
 * `fn`, appends its events, and stores `{response, eventIds}` keyed by
 * (scope,key). A replay with the same key returns the stored response and writes
 * NO new events. Reusing the key with a different request hash is a conflict.
 */
export async function runIdempotent<T>(
  client: DbClient,
  params: IdempotentParams,
  fn: (tx: DrizzleDb) => Promise<{ response: T; events: EventInput[] }>,
): Promise<IdempotentResult<T>> {
  return client.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, params.scope), eq(idempotencyKeys.key, params.key)));
    const prior = existing[0];
    if (prior !== undefined) {
      if (prior.requestHash !== params.requestHash) {
        throw new IdempotencyConflictError(params.scope, params.key);
      }
      return {
        replayed: true,
        response: prior.responseJson as T,
        eventIds: prior.eventIds as string[],
      };
    }

    const { response, events } = await fn(tx);
    const eventIds: string[] = [];
    for (const event of events) {
      const row = await appendEvent(tx, event);
      eventIds.push(row.id);
    }
    await tx.insert(idempotencyKeys).values({
      scope: params.scope,
      key: params.key,
      requestHash: params.requestHash,
      responseJson: response as unknown,
      eventIds,
      createdAt: params.now,
    });
    return { replayed: false, response, eventIds };
  });
}
