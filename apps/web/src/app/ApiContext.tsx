import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { ApiClient } from "../api/client.js";
import { createApiCommandQueue, type ApiCommandQueue } from "../api/commandQueue.js";

interface ApiContextValue {
  client: ApiClient;
  /** Canonical @artoo/client-backed command queue for mutations (#27 dogfood). */
  commands: ApiCommandQueue;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): ReactNode {
  // One queue per provider instance; it owns the `online` reconnect-flush listener.
  const commands = useMemo(() => createApiCommandQueue(), []);
  useEffect(() => () => commands.dispose(), [commands]);
  const value = useMemo<ApiContextValue>(() => ({ client, commands }), [client, commands]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value === null) {
    throw new Error("useApi must be used within an ApiProvider");
  }
  return value;
}

/** Access the API client. Throws if used outside an {@link ApiProvider}. */
export function useApi(): ApiClient {
  return useApiContext().client;
}

/** Access the canonical command queue (#27 dogfood). Throws outside an ApiProvider. */
export function useCommands(): ApiCommandQueue {
  return useApiContext().commands;
}
