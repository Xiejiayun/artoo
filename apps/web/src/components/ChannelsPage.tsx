import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Notification } from "@artoo/domain";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import type { NotificationsResponse } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, EmptyState, Input, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { MessageCard } from "./MessageCard.js";
import { RoomConversation } from "./RoomConversation.js";
import { NotificationsPanel } from "./NotificationsPanel.js";

export function ChannelsPage(): React.ReactNode {
  const api = useApi();
  const { projectId, setSelectedProjectId, bootstrap } = useProject();
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const requestedRoomId = search.get("room");
  const linkedProject = search.get("project");
  const roomContext = useQuery({ queryKey: ["room", requestedRoomId], queryFn: () => api.getRoom(requestedRoomId!), enabled: !!requestedRoomId });
  const room = roomContext.data?.room.id === requestedRoomId ? roomContext.data.room : undefined;
  const destinationProject = room ? room.project_id : linkedProject;
  const appliedProject = useRef<string | null>(null);
  const projectKnown = !destinationProject || !!bootstrap.data?.projects.some((project) => project.id === destinationProject);
  const projectReady = !destinationProject || projectKnown && projectId === destinationProject;
  useEffect(() => {
    // Apply each deep link once. Router navigation can be deferred after an
    // explicit picker change; its old URL must not undo the new selection.
    const link = destinationProject ? `${requestedRoomId ?? ""}:${destinationProject}` : null;
    if (!link) appliedProject.current = null;
    else if (projectKnown && appliedProject.current !== link) {
      appliedProject.current = link;
      if (projectId !== destinationProject) setSelectedProjectId(destinationProject!);
    }
  }, [destinationProject, requestedRoomId, projectKnown, projectId, setSelectedProjectId]);
  const channels = useQuery({ queryKey: ["channels", projectId], queryFn: () => api.listChannels(projectId!), enabled: !!projectId && projectReady, refetchInterval: 10000 });
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const roomId = requestedRoomId ?? channels.data?.channels[0]?.id;
  const selected = channels.data?.channels.find((channel) => channel.id === roomId);
  // Channel-list entries and room metadata are server-authoritative. A URL's
  // project hint alone never permits composing into a different project's room.
  const roomReady = requestedRoomId ? !!room && !roomContext.error && projectReady : !!selected;
  const threadRootId = search.get("thread") ?? undefined;
  const openRoom = (room: string, thread?: string): void => { setSearch({ room, ...(projectId ? { project: projectId } : {}), ...(thread ? { thread } : {}) }); };
  const openNotification = (notification: Notification): void => {
    if (notification.project_id) setSelectedProjectId(notification.project_id);
    setSearch({ room: notification.room_id, thread: notification.thread_root_id ?? notification.message_id,
      message: notification.message_id, ...(notification.project_id ? { project: notification.project_id } : {}),
      ...(!notification.read_at ? { notification: notification.id } : {}) });
  };
  return <section className="product-page channels-page" aria-label="Channels"><header className="action-row"><h1 className="t-h1">Channels</h1><Button variant="primary" disabled={!projectId} onClick={() => setCreating(!creating)}>New channel</Button></header>
    <NotificationsPanel onOpen={openNotification} />
    {creating && projectId && <ChannelForm key={projectId} projectId={projectId} onCreated={(id) => { setCreating(false); openRoom(id); }} onClose={() => setCreating(false)} />}
    <ActionError error={channels.error} />{channels.isLoading && <p role="status">Loading channels…</p>}
    {requestedRoomId && <><ActionError error={roomContext.error} />{roomContext.isLoading && <p role="status">Checking the conversation's project…</p>}{roomContext.error && <Button onClick={() => void roomContext.refetch()}>Retry opening conversation</Button>}</>}
    {!projectReady && <p role={bootstrap.data && !projectKnown ? "alert" : "status"}>{bootstrap.data && !projectKnown ? "This notification's project is unavailable. Select an available project to continue." : "Opening the notification's project…"}</p>}
    {projectReady && <div className={`channels-layout${threadRootId ? " has-thread" : ""}`}><nav className="product-list" aria-label="Channel list">{channels.data?.channels.map((channel) => <button key={channel.id} aria-current={channel.id === roomId ? "page" : undefined} className={channel.id === roomId ? "is-selected" : ""} onClick={() => openRoom(channel.id)}># {channel.name}</button>)}</nav>
      {roomId && roomReady ? <article className="channel-main u-stack"><header><h2>{selected || room?.type === "project" ? "# " : ""}{selected?.name ?? room?.name ?? "Shared discussion"}</h2>{selected?.description && <p className="t-subtle">{selected.description}</p>}</header><RoomConversation key={roomId} roomId={roomId} onOpenThread={(id) => openRoom(roomId, id)} /></article> : !roomId && <EmptyState title="No channels yet" description="Create a channel for your project team to share ideas and discuss work in threads." />}
      {roomId && roomReady && threadRootId && <ThreadPanel key={`${roomId}:${threadRootId}`} roomId={roomId} threadRootId={threadRootId} focusedMessageId={search.get("message") ?? undefined} notificationId={search.get("notification") ?? undefined} onClose={() => openRoom(roomId)} />}
    </div>}
  </section>;
}

function ChannelForm({ projectId, onCreated, onClose }: { projectId: string; onCreated: (id: string) => void; onClose: () => void }): React.ReactNode {
  const api = useApi(); const query = useQueryClient();
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [key] = useState(newIdempotencyKey);
  const create = useMutation({ mutationFn: () => api.createChannel({ project_id: projectId, name: name.trim(), description: description.trim() }, key), onSuccess: async ({ channel }) => { await query.invalidateQueries({ queryKey: ["channels", projectId] }); onCreated(channel.id); } });
  return <form className="product-card u-stack" aria-label="Create channel" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><Input label="Channel name" value={name} required maxLength={80} disabled={create.isPending} onChange={(event) => setName(event.target.value)} /><Textarea label="Channel description" value={description} maxLength={2000} disabled={create.isPending} onChange={(event) => setDescription(event.target.value)} /><ActionError error={create.error} /><div className="action-row"><Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>Create channel</Button><Button disabled={create.isPending} onClick={onClose}>Cancel</Button></div></form>;
}

export function ThreadPanel({ roomId, threadRootId, focusedMessageId, notificationId, onClose }: { roomId: string; threadRootId: string; focusedMessageId?: string; notificationId?: string; onClose: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const readAttempts = useRef(new Set<string>());
  const root = useQuery({ queryKey: ["message", roomId, threadRootId], queryFn: () => api.getMessage(roomId, threadRootId), refetchInterval: 8000 });
  const focused = useQuery({ queryKey: ["message", roomId, focusedMessageId], queryFn: () => api.getMessage(roomId, focusedMessageId!), enabled: !!focusedMessageId && focusedMessageId !== threadRootId });
  const target = focusedMessageId === threadRootId ? root.data?.message : focused.data?.message;
  const rootValid = root.data?.message.id === threadRootId && root.data.message.room_id === roomId && !root.data.message.thread_root_id;
  const targetValid = !focusedMessageId || target?.id === focusedMessageId && target.room_id === roomId && (target.thread_root_id ?? target.id) === threadRootId;
  const ready = rootValid && targetValid && !root.error && !focused.error;
  const read = useMutation({ mutationFn: (id: string) => api.readNotification(id, newIdempotencyKey()), onSuccess: (result) => {
    query.setQueryData<InfiniteData<NotificationsResponse>>(queryKeys.notifications, (current) => current ? { ...current, pages: current.pages.map((page) => ({ ...page, unread_count: result.unread_count ?? page.unread_count, notifications: page.notifications.map((item) => item.id === result.notification.id ? result.notification : item) })) } : current);
    void query.invalidateQueries({ queryKey: queryKeys.notifications });
  } });
  const markRead = read.mutate;
  useEffect(() => {
    // Effects run after the exact target and its thread are rendered. A failed
    // or mismatched deep link must never consume a personal notification.
    if (ready && focusedMessageId && notificationId && !readAttempts.current.has(notificationId)) {
      readAttempts.current.add(notificationId); markRead(notificationId);
    }
  }, [ready, focusedMessageId, notificationId, markRead]);
  const invalid = root.data && !rootValid || target && !targetValid;
  return <aside className="thread-panel u-stack" aria-label="Thread"><header className="action-row"><h2>Thread</h2><Button size="sm" onClick={onClose}>Close thread</Button></header>
    <ActionError error={root.error ?? focused.error ?? read.error} />
    {(root.isLoading || focused.isLoading) && <p role="status">Opening the mentioned conversation…</p>}
    {invalid && <p role="alert">The selected message does not belong to this thread.</p>}
    {(root.error || focused.error) && <Button onClick={() => { void root.refetch(); if (focusedMessageId && focusedMessageId !== threadRootId) void focused.refetch(); }}>Retry opening message</Button>}
    {read.error && notificationId && ready && <Button onClick={() => markRead(notificationId)}>Retry marking notification read</Button>}
    {ready && root.data && <><MessageCard message={root.data.message} />
      {target && target.id !== threadRootId && <section className="product-card u-stack-sm" aria-label="Mentioned reply"><h3>Mentioned reply</h3><MessageCard message={target} /></section>}
      <RoomConversation key={`${roomId}:${threadRootId}`} roomId={roomId} threadRootId={threadRootId} hiddenMessageId={target?.id} allowAssistant={typeof root.data.message.payload.discussion_id !== "string"} /></>}
  </aside>;
}
