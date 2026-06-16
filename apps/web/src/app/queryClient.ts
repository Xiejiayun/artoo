import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiClientError } from "../api/client.js";
import { queryKeys } from "./queryKeys.js";

/** True for an unauthorized (#34: session expired / missing) API failure. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/** True when a query key is the AuthGate session probe (`queryKeys.session`). */
function isSessionQuery(queryKey: readonly unknown[]): boolean {
  return (
    queryKey.length === queryKeys.session.length &&
    queryKey.every((part, index) => part === queryKeys.session[index])
  );
}

/**
 * Shared TanStack Query client. Queries hold the API snapshot; WS patches
 * invalidate the relevant `task:`/`room:`/`run:`/`inbox:` query keys. Retries
 * are disabled so failures surface as explicit, testable error states.
 *
 * Central 401 path (#34): when any protected query/mutation fails with a 401 —
 * e.g. the session expired after AuthGate already rendered the app — we
 * invalidate the session query so AuthGate re-probes `/auth/session`, gets a
 * 401, and falls back to the login page instead of stranding the user on a
 * failed product view. The session probe's own 401 is skipped so it can't loop.
 */
export function createQueryClient(): QueryClient {
  // Forward-declared so the cache error handlers can re-probe the session on
  // the very client they belong to.
  let client: QueryClient;

  const reauthOnUnauthorized = (error: unknown): void => {
    if (!isUnauthorized(error)) {
      return;
    }
    void client.invalidateQueries({ queryKey: queryKeys.session });
  };

  client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // AuthGate already turns the session probe's 401 into the login page;
        // re-invalidating it here would refetch → 401 → invalidate forever.
        if (isSessionQuery(query.queryKey)) {
          return;
        }
        reauthOnUnauthorized(error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        reauthOnUnauthorized(error);
      },
    }),
    defaultOptions: {
      queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  return client;
}
