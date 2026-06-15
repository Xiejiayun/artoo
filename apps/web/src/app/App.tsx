import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter } from "react-router-dom";

import { ApiClient } from "../api/client.js";
import { ApiProvider } from "./ApiContext.js";
import { AppRoutes } from "./AppRoutes.js";
import { createQueryClient } from "./queryClient.js";
import { RealtimeProvider } from "./RealtimeContext.js";
import { SelectionProvider } from "./SelectionContext.js";

export interface AppProps {
  client?: ApiClient;
  queryClient?: QueryClient;
}

/** Root application: API + Query + Realtime + Selection providers, then routes. */
export function App({ client, queryClient }: AppProps = {}): React.ReactNode {
  const [apiClient] = useState(() => client ?? new ApiClient());
  const [resolvedQueryClient] = useState(() => queryClient ?? createQueryClient());

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <ApiProvider client={apiClient}>
        <RealtimeProvider>
          <SelectionProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </SelectionProvider>
        </RealtimeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
