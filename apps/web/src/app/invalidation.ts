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

  // Output chunks stream directly into the run timeline. They do not alter
  // task state, chat messages, or collaboration records.
  if (event.type === "run.output") return keys;

  if (event.type.startsWith("run.") && typeof event.run_id === "string") keys.push(queryKeys.runUsage(event.run_id));

  if (typeof event.task_id === "string") {
    keys.push(queryKeys.task(event.task_id));
    // Any task activity (runs, approvals, messages, events) changes its audit bundle.
    keys.push(queryKeys.auditBundle(event.task_id));
  }
  if (typeof event.room_id === "string") {
    keys.push(queryKeys.messages(event.room_id));
    // Room-prefix invalidation also refreshes every independently cached thread.
    keys.push(queryKeys.assistantTurns(event.room_id));
    keys.push(["collaboration", event.room_id]);
  }
  if (event.type === "message.moderated") {
    keys.push(queryKeys.notifications);
    if (event.room_id && typeof event.payload.message_id === "string") keys.push(["message", event.room_id, event.payload.message_id]);
  }
  if (event.type.startsWith("channel.")) keys.push(["channels"]);
  if (event.type === "message.mention" || event.type.startsWith("notification.")) keys.push(queryKeys.notifications);
  if (event.type.startsWith("computer.") || event.type.startsWith("daemon.") || event.type.startsWith("agent.")) keys.push(queryKeys.daemons);
  if (event.type.startsWith("goal.") || event.type.startsWith("plan.") || event.type.startsWith("checkpoint.")) {
    keys.push(["goals"], ["plans"], ["checkpoints"]);
  }
  if (event.type.startsWith("computer.") || event.type.startsWith("agent.") || event.type.startsWith("device.")) {
    keys.push(queryKeys.bootstrap, ["devices"], ["computerRuntimes"]);
  }
  if (event.type.startsWith("lease.")) keys.push(["leases"]);
  if (event.type.startsWith("dependency.")) keys.push(["dependencies"]);
  // Runtime lifecycle events also transition tasks without a separate
  // task.updated event. Keep the rail and Board aligned with task detail.
  if (
    typeof event.project_id === "string" &&
    (event.type === "task.created" || event.type === "task.updated" ||
      ["run.started", "run.completed", "run.failed", "run.cancelled", "approval.resolved"].includes(event.type))
  ) {
    keys.push(queryKeys.tasks(event.project_id));
  }
  // inbox activity (approvals, blocked/awaiting) refreshes the pending list + badge.
  if (topic.startsWith("inbox:") || event.type.startsWith("approval.")) {
    keys.push(queryKeys.approvals("pending"));
    keys.push(queryKeys.approvals("needs_more_info"));
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
