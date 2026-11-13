import { PreparedGoalEntryV1Schema } from "@artoo/domain";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { BootstrapResponse } from "../api/types.js";
import { queryKeys } from "./queryKeys.js";

/** Observes the existing bootstrap cache. Does not fetch before the auth gate. */
export function usePreparedGoalPolling(): boolean {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  // Subscribe to the mode, not the bootstrap object: unrelated query observer
  // changes during a child render must not update the owning shell.
  const snapshot = useCallback(() => {
    const entry = PreparedGoalEntryV1Schema.safeParse(client.getQueryData<BootstrapResponse>(queryKeys.bootstrap)?.goal_entry);
    return entry.success && entry.data.progress_updates === "polling";
  }, [client]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Goal, automation, release, checkpoint and conversation views already poll.
 * These active views otherwise depend on control-WS invalidations. */
const missingProgressPolls = new Set(["tasks", "task", "auditBundle", "approvals", "runUsage", "dependencies", "leases"]);
export function refreshPreparedTaskProgress(client: QueryClient): Promise<void> {
  return client.refetchQueries({ type: "active", predicate: query => typeof query.queryKey[0] === "string" && missingProgressPolls.has(query.queryKey[0]) },
    { cancelRefetch: false });
}
