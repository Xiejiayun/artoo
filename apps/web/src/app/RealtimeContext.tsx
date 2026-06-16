import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import { RealtimeClient, type SocketFactory } from "../ws/realtimeClient.js";
import { invalidationsForEvent } from "./invalidation.js";
import { queryKeys } from "./queryKeys.js";

const RealtimeContext = createContext<RealtimeClient | null>(null);

export interface RealtimeProviderProps {
  url?: string;
  /** Injectable for tests; defaults to a real WebSocket. */
  socketFactory?: SocketFactory;
  reconnectDelayMs?: number;
  children: ReactNode;
}

/**
 * Owns the realtime WS connection and turns server pushes into query
 * invalidations. Connects on mount, closes on unmount.
 */
export function RealtimeProvider({
  url = "/api/v1/ws",
  socketFactory,
  reconnectDelayMs,
  children,
}: RealtimeProviderProps): ReactNode {
  const queryClient = useQueryClient();
  const ref = useRef<RealtimeClient | null>(null);

  if (ref.current === null) {
    ref.current = new RealtimeClient({
      url: resolveWsUrl(url),
      socketFactory,
      reconnectDelayMs,
      onEvent: (topic, event) => {
        for (const key of invalidationsForEvent(topic, event)) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      },
      // #28 3b: the control WS closes 1008 on a terminal auth failure (no/expired/
      // revoked session). Re-probe the session so the #34 AuthGate routes the user
      // to the login page instead of the client silently reconnect-looping.
      onUnauthenticated: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.session });
      },
    });
  }

  useEffect(() => {
    const client = ref.current;
    client?.connect();
    return () => client?.close();
  }, []);

  return <RealtimeContext.Provider value={ref.current}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

/**
 * Keep the realtime client subscribed to `topics` while mounted. No-op when
 * there is no provider (e.g. isolated component tests).
 */
export function useSubscription(topics: string[]): void {
  const client = useRealtime();
  const key = topics.join(",");
  useEffect(() => {
    if (client === null || topics.length === 0) {
      return;
    }
    client.subscribe(topics);
    return () => client.unsubscribe(topics);
    // topics are tracked via their stable joined `key`.

  }, [client, key]);
}

function resolveWsUrl(path: string): string {
  if (path.startsWith("ws://") || path.startsWith("wss://")) {
    return path;
  }
  if (typeof window !== "undefined" && window.location !== undefined) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${path}`;
  }
  return path;
}
