import { useEffect, useState, useSyncExternalStore } from "react";
import { useCommands } from "../app/ApiContext.js";
import { useRealtime } from "../app/RealtimeContext.js";
import { Button } from "../ui/index.js";

const noSubscription = (): (() => void) => () => undefined;
const noStatus = (): string => "disconnected";

export function ConnectionStatus(): React.ReactNode {
  const commands = useCommands();
  const realtime = useRealtime();
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
  return <div className="connection-status" data-offline={!online || status !== "connected"} role="status" aria-label="Connection status">
    <span>{!online ? "Offline" : status === "connected" ? "Live updates connected" : status === "unauthenticated" ? "Sign in to reconnect" : "Reconnecting live updates…"}</span>
    {pending > 0 && <><span>{pending} pending command{pending === 1 ? "" : "s"}. Keep this window open until sent.</span><Button size="sm" onClick={() => void commands.flush()}>Retry pending</Button></>}
  </div>;
}
