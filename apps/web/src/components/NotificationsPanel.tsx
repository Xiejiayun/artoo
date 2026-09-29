import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Notification } from "@artoo/domain";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Badge, Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function useNotifications() {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  useSubscription(bootstrap.data ? [`inbox:${bootstrap.data.user.id}`] : []);
  const query = useInfiniteQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ pageParam }) => api.listNotifications({ limit: 50, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.has_more && page.next_before ? page.next_before : undefined,
    enabled: !!bootstrap.data, refetchInterval: 8000,
  });
  const items = [...new Map(query.data?.pages.flatMap((page) => page.notifications).map((notification) => [notification.id, notification]) ?? []).values()];
  return { ...query, items, unreadCount: query.data?.pages[0]?.unread_count };
}

export function NotificationsButton(): React.ReactNode {
  const notifications = useNotifications(); const navigate = useNavigate();
  const unread = notifications.unreadCount;
  const label = notifications.error ? "sync unavailable" : unread === undefined ? notifications.isLoading ? "loading" : "unread count unavailable" : `${unread} unread`;
  return <Button size="sm" variant="ghost" aria-label={`Mentions, ${label}`} onClick={() => navigate("/channels?mentions=1")}>@ Mentions{unread !== undefined && unread > 0 && <Badge tone="accent">{unread}</Badge>}{notifications.error && <span aria-label="Mention sync unavailable">?</span>}</Button>;
}

export function NotificationsPanel({ onOpen }: { onOpen: (notification: Notification) => void }): React.ReactNode {
  const notifications = useNotifications();
  const [search] = useSearchParams();
  return <details className="product-card notifications-panel" open={search.has("mentions") || undefined}><summary>@ Mentions · {notifications.unreadCount === undefined ? "Unread count unavailable" : `${notifications.unreadCount} unread`}</summary><ActionError error={notifications.error} />{notifications.isLoading && <p role="status">Loading mentions…</p>}{notifications.data && notifications.items.length === 0 && <p>No mentions yet.</p>}
    <ul className="notifications-list">{notifications.items.map((notification) => <li key={notification.id}><Button variant={notification.read_at ? "ghost" : "secondary"} onClick={() => onOpen(notification)}>{!notification.read_at && <Badge tone="accent">Unread</Badge>}<span>{notification.body_preview}</span></Button><time dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString()}</time></li>)}</ul>
    {notifications.hasNextPage && <Button loading={notifications.isFetchingNextPage} disabled={notifications.isFetching} onClick={() => void notifications.fetchNextPage()}>Load earlier notifications</Button>}
    {notifications.error && <Button onClick={() => void notifications.refetch()}>Retry notification sync</Button>}
  </details>;
}
