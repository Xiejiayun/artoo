import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiClient } from "../api/client.js";
import { WorkspaceLayout } from "../components/WorkspaceLayout.js";
import { ApiProvider } from "./ApiContext.js";
import { createQueryClient } from "./queryClient.js";
import { RealtimeProvider } from "./RealtimeContext.js";

export interface AppProps {
  client?: ApiClient;
  queryClient?: QueryClient;
}

/** Root application: wires the API client + TanStack Query providers. */
export function App({ client, queryClient }: AppProps = {}): React.ReactNode {
  const [apiClient] = useState(() => client ?? new ApiClient());
  const [resolvedQueryClient] = useState(() => queryClient ?? createQueryClient());

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <ApiProvider client={apiClient}>
        <RealtimeProvider>
          <WorkspaceLayout />
        </RealtimeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
