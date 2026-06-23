import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter, HashRouter } from "react-router-dom";

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
  const desktop = desktopConfig();
  const [apiClient] = useState(
    () =>
      client ??
      new ApiClient({
        baseUrl: desktop?.apiBaseUrl,
        credentials: desktop === undefined ? "include" : "omit",
      }),
  );
  const [resolvedQueryClient] = useState(() => queryClient ?? createQueryClient());
  const resolvedAuth = authEnabled ?? import.meta.env.VITE_AUTH_ENABLED === "true";
  const Router = desktop === undefined ? BrowserRouter : HashRouter;

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <ApiProvider client={apiClient}>
        <RealtimeProvider url={desktop?.wsUrl}>
          <SelectionProvider>
            <Router>
              <AuthGate enabled={resolvedAuth}>
                <AppRoutes />
              </AuthGate>
            </Router>
          </SelectionProvider>
        </RealtimeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

interface DesktopConfig {
  apiBaseUrl: string;
  wsUrl: string;
}

export function desktopConfig(): DesktopConfig | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const serverUrl = window.artooDesktop?.serverUrl?.replace(/\/$/, "");
  if (serverUrl === undefined || serverUrl === "") {
    return undefined;
  }
  const wsUrl = serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return { apiBaseUrl: `${serverUrl}/api/v1`, wsUrl: `${wsUrl}/api/v1/ws` };
}
