import type { EventEnvelope } from "@artoo/domain";
import type { QueryKey } from "@tanstack/react-query";

import { queryKeys } from "./queryKeys.js";

/**
 * Maps a server WS push (`{topic, event}`, where event is a domain
 * EventEnvelope) to the TanStack Query keys that should be invalidated. v0.1
 * uses invalidate-and-refetch (no granular patch), which is self-healing across
 * reconnects.
 *
 * Routing mirrors the server (engineer's WS contract): events carry
 * task_id/room_id/project_id/run_id; the topic indicates which subscription
 * delivered it.
 */
export function invalidationsForEvent(topic: string, event: EventEnvelope): QueryKey[] {
  const keys: QueryKey[] = [];

  if (typeof event.task_id === "string") {
    keys.push(queryKeys.task(event.task_id));
  }
  if (typeof event.room_id === "string") {
    keys.push(queryKeys.messages(event.room_id));
  }
  // task.created / task.updated change the project's left-rail list.
  if (
    typeof event.project_id === "string" &&
    (event.type === "task.created" || event.type === "task.updated")
  ) {
    keys.push(queryKeys.tasks(event.project_id));
  }
  // inbox activity (approvals, blocked/awaiting) refreshes the pending list + badge.
  if (topic.startsWith("inbox:") || event.type.startsWith("approval.")) {
    keys.push(queryKeys.approvals("pending"));
  }
  // memory curation (propose/accept/reject/supersede) refreshes the memory lists
  // and the accepted-only ContextPack context preview. Prefix keys invalidate
  // every filtered list / context query.
  if (event.type.startsWith("memory.")) {
    keys.push(["memories"]);
    keys.push(["memoryContext"]);
    const memoryId = event.payload["memory_id"];
    if (typeof memoryId === "string") {
      keys.push(queryKeys.memory(memoryId));
    }
  }

  return dedupeKeys(keys);
}

function dedupeKeys(keys: QueryKey[]): QueryKey[] {
  const seen = new Set<string>();
  const result: QueryKey[] = [];
  for (const key of keys) {
    const id = JSON.stringify(key);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(key);
    }
  }
  return result;
}
