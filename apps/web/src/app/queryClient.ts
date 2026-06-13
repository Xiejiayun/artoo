import { QueryClient } from "@tanstack/react-query";

/**
 * Shared TanStack Query client. Queries hold the API snapshot; WS patches
 * invalidate the relevant `task:`/`room:`/`run:`/`inbox:` query keys. Retries
 * are disabled so failures surface as explicit, testable error states.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
