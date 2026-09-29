import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Badge, type Tone } from "../ui/index.js";

const PRESENCE_MAX_AGE_MS = 12_000;
const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const isOnline = () => onlineManager.isOnline();

export function DaemonBadge({ computerId }: { computerId: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, isOnline);
  const unavailableSnapshot = useRef<number | null>(null);
  const [mountSnapshotVersion] = useState(() => query.getQueryState(queryKeys.daemons)?.dataUpdateCount ?? 0);
  const [startedAt] = useState(Date.now);
  const [, updateClock] = useState(0);
  useEffect(() => {
    const tick = () => updateClock((value) => value + 1);
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  useSubscription(bootstrap.data ? [`inbox:${bootstrap.data.user.id}`] : []);
  const daemons = useQuery({ queryKey: queryKeys.daemons, queryFn: () => api.listDaemons(), refetchInterval: 5000, refetchOnMount: "always", retry: false });
  const daemon = daemons.data?.daemons.find((item) => item.computer_id === computerId);
  const unavailable = !online || daemons.fetchStatus === "paused" || !!daemons.error;
  const snapshotVersion = query.getQueryState(queryKeys.daemons)?.dataUpdateCount ?? 0;
  useEffect(() => {
    // Browser connectivity alone cannot reconfirm a previously unknown sample.
    // A successful response advances this version even within the same millisecond.
    if (unavailable) unavailableSnapshot.current = snapshotVersion;
  }, [unavailable, snapshotVersion]);
  // A paused or hanging request need not produce an error. Expire the last
  // confirmed snapshot independently of polling, including after backgrounding.
  const snapshotAge = Math.max(0, Date.now() - (daemons.dataUpdatedAt || startedAt));
  // A remounted badge cannot know which connectivity changes happened while
  // it was absent. Require a new successful snapshot before trusting its cache.
  const awaitingMountConfirmation = daemons.data !== undefined && snapshotVersion === mountSnapshotVersion;
  const unconfirmed = unavailable || awaitingMountConfirmation || unavailableSnapshot.current === snapshotVersion || snapshotAge >= PRESENCE_MAX_AGE_MS;
  const status = unconfirmed ? "unknown" : daemon?.status ?? (daemons.isLoading ? "checking" : "unknown");
  const tones: Record<string, Tone> = { online: "success", reconnecting: "warning", stale: "warning", offline: "neutral", disabled: "neutral", unknown: "warning", checking: "neutral" };
  return <div className="daemon-presence" aria-label="Execution daemon">
    <Badge tone={tones[status]}>Daemon: {status}</Badge>
    <span className="t-subtle">{unconfirmed ? "Server connection unavailable or presence data is stale; daemon status cannot be verified." : daemon ? `${daemon.connected ? "Connected" : "Disconnected"} · ${daemon.active_runs} active runs` : "Waiting for server presence data."}</span>
    {unconfirmed && daemon && <span className="t-subtle">Last known: {daemon.active_runs} active runs</span>}
    {daemon?.last_heartbeat_at && <span className="t-subtle">Last heartbeat: <time dateTime={daemon.last_heartbeat_at}>{new Date(daemon.last_heartbeat_at).toLocaleString()}</time>{!unconfirmed && daemon.heartbeat_age_ms !== null ? ` (${Math.floor((daemon.heartbeat_age_ms + snapshotAge) / 1000)}s ago)` : ""}</span>}
  </div>;
}
