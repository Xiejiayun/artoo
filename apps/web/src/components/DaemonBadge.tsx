import { useQuery } from "@tanstack/react-query";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Badge, type Tone } from "../ui/index.js";

export function DaemonBadge({ computerId }: { computerId: string }): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  useSubscription(bootstrap.data ? [`inbox:${bootstrap.data.user.id}`] : []);
  const daemons = useQuery({ queryKey: queryKeys.daemons, queryFn: () => api.listDaemons(), refetchInterval: 5000, retry: false });
  const daemon = daemons.data?.daemons.find((item) => item.computer_id === computerId);
  // Previously cached online/offline data cannot attest current presence while
  // the control server is unreachable. Keep the two conditions distinct.
  const status = daemons.error ? "unknown" : daemon?.status ?? (daemons.isLoading ? "checking" : "unknown");
  const tones: Record<string, Tone> = { online: "success", reconnecting: "warning", stale: "warning", offline: "neutral", disabled: "neutral", unknown: "warning", checking: "neutral" };
  return <div className="daemon-presence" aria-label="Execution daemon"><Badge tone={tones[status]}>Daemon: {status}</Badge><span className="t-subtle">{daemons.error ? "Server connection unavailable; daemon status cannot be verified." : daemon ? `${daemon.connected ? "Connected" : "Disconnected"} · ${daemon.active_runs} active runs` : "Waiting for server presence data."}</span>{daemon?.last_heartbeat_at && <span className="t-subtle">Last heartbeat: <time dateTime={daemon.last_heartbeat_at}>{new Date(daemon.last_heartbeat_at).toLocaleString()}</time>{!daemons.error && daemon.heartbeat_age_ms !== null ? ` (${Math.floor(daemon.heartbeat_age_ms / 1000)}s ago)` : ""}</span>}</div>;
}
