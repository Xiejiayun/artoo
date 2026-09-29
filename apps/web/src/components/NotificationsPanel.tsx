import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function useNotifications() {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  useSubscription(bootstrap.data ? [`inbox:${bootstrap.data.user.id}`] : []);
  return useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.listNotifications(), enabled: !!bootstrap.data, refetchInterval: 8000 });
}

export function NotificationsButton(): React.ReactNode {
  const notifications = useNotifications(); const navigate = useNavigate();
  const unread = notifications.data?.notifications.filter((notification) => !notification.read_at).length ?? 0;
  return <Button size="sm" variant="ghost" aria-label={`Mentions, ${notifications.error ? "sync unavailable" : `${unread} unread`}`} onClick={() => navigate("/channels?mentions=1")}>@ Mentions{unread > 0 && <Badge tone="accent">{unread}</Badge>}{notifications.error && <span aria-label="Mention sync unavailable">?</span>}</Button>;
}

export function NotificationsPanel({ onOpen }: { onOpen: (roomId: string, threadRootId: string) => void }): React.ReactNode {
  const api = useApi(); const query = useQueryClient(); const notifications = useNotifications();
  const [search] = useSearchParams();
  const read = useMutation({ mutationFn: (id: string) => api.readNotification(id, newIdempotencyKey()), onSuccess: () => query.invalidateQueries({ queryKey: queryKeys.notifications }) });
  const unread = notifications.data?.notifications.filter((notification) => !notification.read_at).length ?? 0;
  return <details className="product-card notifications-panel" open={search.has("mentions") || undefined}><summary>@ Mentions · {unread} unread</summary><ActionError error={notifications.error ?? read.error} />{notifications.isLoading && <p role="status">Loading mentions…</p>}{notifications.data?.notifications.length === 0 && <p>No mentions yet.</p>}
    <ul className="notifications-list">{notifications.data?.notifications.map((notification) => <li key={notification.id}><Button variant={notification.read_at ? "ghost" : "secondary"} onClick={() => { if (!notification.read_at) read.mutate(notification.id); onOpen(notification.room_id, notification.thread_root_id ?? notification.message_id); }}>{!notification.read_at && <Badge tone="accent">Unread</Badge>}<span>{notification.body_preview}</span></Button><time dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString()}</time></li>)}</ul>
  </details>;
}
