import { useEffect, useState, useSyncExternalStore } from "react";
import { useCommands } from "../app/ApiContext.js";
import { usePreparedGoalPolling } from "../app/preparedGoalPolling.js";
import { useRealtime } from "../app/RealtimeContext.js";
import { Button, Tooltip } from "../ui/index.js";

const noSubscription = (): (() => void) => () => undefined;
const noStatus = (): string => "disconnected";

/** One owner for queue replay and browser listeners, shared by both displays. */
export function useConnectionStatus() {
  const commands = useCommands();
  const realtime = useRealtime();
  const preparedPolling = usePreparedGoalPolling();
  const [online, setOnline] = useState(navigator.onLine);
  const pending = useSyncExternalStore(commands.subscribe, commands.pendingCount);
  const status = useSyncExternalStore(realtime?.subscribeStatus ?? noSubscription, realtime?.getStatus ?? noStatus);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const beforeUnload = (event: BeforeUnloadEvent): void => { if (commands.pendingCount() > 0) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); window.removeEventListener("beforeunload", beforeUnload); };
  }, [commands]);
  useEffect(() => { if (status === "connected") void commands.flush(); }, [commands, status]);
  useEffect(() => {
    if (!preparedPolling || !online || pending === 0) return;
    // HTTP may recover without a navigator online event. The existing queue
    // preserves command identities, serial replay and terminal error handling.
    const timer = setInterval(() => { void commands.flush(); }, 5000);
    return () => clearInterval(timer);
  }, [commands, preparedPolling, online, pending]);
  return { online, pending, status, preparedPolling,
    healthy: online && status === "connected" && pending === 0 && !preparedPolling,
    retry: commands.flush };
}

type ConnectionState = ReturnType<typeof useConnectionStatus>;

export function ConnectionStatusIndicator({ state }: { state: ConnectionState }): React.ReactNode {
  if (!state.healthy) return null;
  return <Tooltip label="Live updates connected"><span className="os-connection-indicator" role="status" aria-label="Live updates connected" tabIndex={0}>
    <span className="os-status-dot" data-status="online" aria-hidden="true" />
  </span></Tooltip>;
}

export function ConnectionStatusBanner({ state }: { state: ConnectionState }): React.ReactNode {
  const { online, pending, status, preparedPolling } = state;
  if (state.healthy) return null;
  return <div className="connection-status" data-offline={!online || (!preparedPolling && status !== "connected")} role="status" aria-label="Connection status">
    <span>{!online ? "Offline" : preparedPolling ? "Automatic progress refresh" : status === "connected" ? "Live updates connected" : status === "unauthenticated" ? "Sign in to reconnect" : "Reconnecting live updates…"}</span>
    {pending > 0 && <><span>{pending} pending command{pending === 1 ? "" : "s"}. Keep this window open until sent.</span><Button size="sm" onClick={() => void state.retry()}>Retry pending</Button></>}
  </div>;
}

/** Standalone surface retained for embedders; the product shell owns one hook. */
export function ConnectionStatus(): React.ReactNode {
  const state = useConnectionStatus();
  return <><ConnectionStatusIndicator state={state} /><ConnectionStatusBanner state={state} /></>;
}
