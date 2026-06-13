import { createContext, useContext, type ReactNode } from "react";

import { ApiClient } from "../api/client.js";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): ReactNode {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** Access the API client. Throws if used outside an {@link ApiProvider}. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === null) {
    throw new Error("useApi must be used within an ApiProvider");
  }
  return client;
}
