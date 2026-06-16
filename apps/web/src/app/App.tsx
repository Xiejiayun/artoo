import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter } from "react-router-dom";

import { ApiClient } from "../api/client.js";
import { AuthGate } from "../components/AuthGate.js";
import { ApiProvider } from "./ApiContext.js";
import { AppRoutes } from "./AppRoutes.js";
import { createQueryClient } from "./queryClient.js";
import { RealtimeProvider } from "./RealtimeContext.js";
import { SelectionProvider } from "./SelectionContext.js";

export interface AppProps {
  client?: ApiClient;
  queryClient?: QueryClient;
  /** Force the #34 auth gate on/off; defaults to `VITE_AUTH_ENABLED === "true"`. */
  authEnabled?: boolean;
}

/** Root application: API + Query + Realtime + Selection providers, auth gate, then routes. */
export function App({ client, queryClient, authEnabled }: AppProps = {}): React.ReactNode {
  const [apiClient] = useState(() => client ?? new ApiClient());
  const [resolvedQueryClient] = useState(() => queryClient ?? createQueryClient());
  const resolvedAuth = authEnabled ?? import.meta.env.VITE_AUTH_ENABLED === "true";

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <ApiProvider client={apiClient}>
        <RealtimeProvider>
          <SelectionProvider>
            <BrowserRouter>
              <AuthGate enabled={resolvedAuth}>
                <AppRoutes />
              </AuthGate>
            </BrowserRouter>
          </SelectionProvider>
        </RealtimeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
