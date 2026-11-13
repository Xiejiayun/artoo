import { useQuery } from "@tanstack/react-query";
import { useApi } from "./ApiContext.js";
import { queryKeys } from "./queryKeys.js";

export interface UseDaemonsOptions {
  enabled?: boolean;
  intervalMs?: number | false;
}

/**
 * Shared daemon presence query across DaemonBadge, ComputersPage, and
 * ConnectNodeDialog. Preserves DaemonBadge's `refetchOnMount: "always"` and
 * 5s baseline so presence snapshots stay within the 12s freshness window.
 */
export function useDaemons({ enabled = true, intervalMs = 5000 }: UseDaemonsOptions = {}) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.daemons,
    queryFn: () => api.listDaemons(),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    refetchOnMount: "always",
    retry: false,
  });
}
