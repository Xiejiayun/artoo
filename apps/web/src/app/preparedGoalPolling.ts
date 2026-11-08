import { PreparedGoalEntryV1Schema } from "@artoo/domain";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { BootstrapResponse } from "../api/types.js";
import { queryKeys } from "./queryKeys.js";

/** Observes the existing bootstrap cache. Does not fetch before the auth gate. */
export function usePreparedGoalPolling(): boolean {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const snapshot = useSyncExternalStore(subscribe, () => client.getQueryData<BootstrapResponse>(queryKeys.bootstrap), () => undefined);
  const entry = PreparedGoalEntryV1Schema.safeParse(snapshot?.goal_entry);
  return entry.success && entry.data.progress_updates === "polling";
}

/** Goal, automation, release, checkpoint and conversation views already poll.
 * These active views otherwise depend on control-WS invalidations. */
const missingProgressPolls = new Set(["tasks", "task", "auditBundle", "approvals", "runUsage", "dependencies", "leases"]);
export function refreshPreparedTaskProgress(client: QueryClient): Promise<void> {
  return client.refetchQueries({ type: "active", predicate: query => typeof query.queryKey[0] === "string" && missingProgressPolls.has(query.queryKey[0]) },
    { cancelRefetch: false });
}
