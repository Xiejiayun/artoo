import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import { RealtimeClient, type SocketFactory } from "../ws/realtimeClient.js";
import { invalidationsForEvent } from "./invalidation.js";
import { queryKeys } from "./queryKeys.js";
import { appendRunOutput, type RunOutputChunk } from "./runOutputs.js";
import type { MessagesResponse } from "../api/types.js";

const RealtimeContext = createContext<RealtimeClient | null>(null);

export interface RealtimeProviderProps {
  tokenProvider?: () => string | null | undefined | Promise<string | null | undefined>;
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
  tokenProvider,
  children,
}: RealtimeProviderProps): ReactNode {
  const queryClient = useQueryClient();
  const ref = useRef<RealtimeClient | null>(null);

  if (ref.current === null) {
    ref.current = new RealtimeClient({
      url: resolveWsUrl(url),
      socketFactory,
      reconnectDelayMs,
      tokenProvider,
      onEvent: (topic, event) => {
        if (event.type === "sync.required") { void queryClient.invalidateQueries(); return; }
        if (event.room_id && typeof event.payload.thread_root_id === "string") {
          const rootId = event.payload.thread_root_id;
          const count = event.payload.root_reply_count;
          if (typeof count === "number") queryClient.setQueriesData<MessagesResponse>({ queryKey: queryKeys.messages(event.room_id) }, (current) => current ? { ...current, messages: current.messages.map((message) => message.id === rootId ? { ...message, reply_count: Math.max(count, message.reply_count ?? 0) } : message) } : current);
          void queryClient.invalidateQueries({ queryKey: ["message", event.room_id, rootId] });
        }
        if (event.type === "run.output" && event.task_id) {
          queryClient.setQueryData<RunOutputChunk[]>(queryKeys.runOutputs(event.task_id), (previous) => appendRunOutput(previous, event));
        }
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
    const unsubscribe = client?.subscribeStatus(() => {
      if (client.getStatus() === "connected") void queryClient.invalidateQueries();
    });
    client?.connect();
    return () => { unsubscribe?.(); client?.close(); };
  }, [queryClient]);

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
