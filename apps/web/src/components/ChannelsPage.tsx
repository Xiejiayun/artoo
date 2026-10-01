import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Member, Notification } from "@artoo/domain";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import type { BootstrapResponse, NotificationsResponse } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { messageIdentity } from "../app/messageIdentity.js";
import { Button, EmptyState, ErrorState, Input, Modal, SearchInput, Skeleton, Textarea } from "../ui/index.js";
import { Hash, Info, MessageSquare, Plus, X } from "lucide-react";
import { Icon } from "../ui/Icon.js";
import { ActionError } from "./ActionError.js";
import { MessageCard } from "./MessageCard.js";
import { RoomConversation } from "./RoomConversation.js";
import { NotificationsPanel } from "./NotificationsPanel.js";

export function ChannelsPage(): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const { projectId, setSelectedProjectId, bootstrap } = useProject();
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const requestedRoomId = search.get("room");
  const roomContext = useQuery({ queryKey: ["room", requestedRoomId], queryFn: () => api.getRoom(requestedRoomId!), enabled: !!requestedRoomId });
  const room = roomContext.data?.room.id === requestedRoomId ? roomContext.data.room : undefined;
  const destinationProject = room && !roomContext.error ? room.project_id : undefined;
  const appliedProject = useRef<string | null>(null);
  const projectKnown = !destinationProject || !!bootstrap.data?.projects.some((project) => project.id === destinationProject);
  const projectReady = !destinationProject || projectKnown && projectId === destinationProject;
  const needsProjectRefresh = !!destinationProject && !!bootstrap.data && !projectKnown;
  // A peer can create this project after the current account snapshot loaded.
  // Keep this lookup tied to the current verified room and account, so an old
  // navigation response cannot authorize or select a different destination.
  const refreshedProjects = useQuery({
    queryKey: ["notification-project", requestedRoomId, destinationProject, bootstrap.data?.organization.id, bootstrap.data?.user.id],
    queryFn: () => api.bootstrap(), enabled: needsProjectRefresh,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const refreshedIdentityMatches = !!refreshedProjects.data && refreshedProjects.data.organization.id === bootstrap.data?.organization.id
    && refreshedProjects.data.user.id === bootstrap.data?.user.id;
  const refreshedProjectKnown = refreshedIdentityMatches && !!refreshedProjects.data?.projects.some((project) => project.id === destinationProject);
  const projectRefreshFailed = needsProjectRefresh && !refreshedProjects.isFetching
    && (refreshedProjects.isError || !!refreshedProjects.data && !refreshedProjectKnown);
  useEffect(() => {
    if (needsProjectRefresh && !refreshedProjects.isFetching && !refreshedProjects.error && refreshedProjectKnown) {
      query.setQueryData(queryKeys.bootstrap, refreshedProjects.data);
    }
  }, [needsProjectRefresh, refreshedProjects.isFetching, refreshedProjects.error, refreshedProjects.data, refreshedProjectKnown, query]);
  useEffect(() => {
    // Apply each deep link once. Router navigation can be deferred after an
    // explicit picker change; its old URL must not undo the new selection.
    const link = destinationProject ? `${requestedRoomId ?? ""}:${destinationProject}` : null;
    if (!link) appliedProject.current = null;
    else if (projectKnown && appliedProject.current !== link) {
      appliedProject.current = link;
      if (projectId !== destinationProject) setSelectedProjectId(destinationProject!);
      // Entering a verified room also refreshes its people's names. Bootstrap
      // can already know a new project while the member cache is still older.
      void query.invalidateQueries({ queryKey: queryKeys.members });
    }
  }, [destinationProject, requestedRoomId, projectKnown, projectId, setSelectedProjectId, query]);
  const channels = useQuery({ queryKey: ["channels", projectId], queryFn: () => api.listChannels(projectId!), enabled: !!projectId && projectReady, refetchInterval: 10000 });
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const roomId = requestedRoomId ?? channels.data?.channels[0]?.id;
  const selected = channels.data?.channels.find((channel) => channel.id === roomId);
  // Channel-list entries and room metadata are server-authoritative. A URL's
  // project hint alone never permits composing into a different project's room.
  const roomReady = requestedRoomId ? !!room && !roomContext.error && projectReady : !!selected;
  const threadRootId = search.get("thread") ?? undefined;
  const openRoom = (room: string, thread?: string): void => { setShowDetails(false); setSearch({ room, ...(projectId ? { project: projectId } : {}), ...(thread ? { thread } : {}) }); };
  const openNotification = (notification: Notification): void => {
    setSearch({ room: notification.room_id, thread: notification.thread_root_id ?? notification.message_id,
      message: notification.message_id, ...(notification.project_id ? { project: notification.project_id } : {}),
      ...(!notification.read_at ? { notification: notification.id } : {}) });
  };
  const visibleChannels = channels.data?.channels.filter((channel) => `${channel.name} ${channel.description ?? ""}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];
  const roomName = selected?.name ?? room?.name ?? "Shared discussion";
  if (!bootstrap.data) return <section className="product-page channels-page" aria-label="Channels"><div className="channel-welcome">{bootstrap.error
    ? <ErrorState title="Could not open your workspace" description="Check your connection and try again. Your saved conversations and drafts are kept." action={<Button variant="primary" onClick={() => void bootstrap.refetch()}>Retry workspace</Button>} />
    : <div className="u-stack" role="status" aria-label="Loading workspace"><Skeleton height={24} width={200} /><Skeleton height={16} width={280} /><p className="t-muted">Loading your workspace…</p></div>}</div></section>;
  return <section className="product-page channels-page" aria-label="Channels">
    {bootstrap.error && <div className="action-row"><ActionError error={bootstrap.error} /><Button size="sm" onClick={() => void bootstrap.refetch()}>Retry workspace</Button></div>}
    {creating && projectId && <ChannelForm key={projectId} projectId={projectId} onCreated={(id) => { setCreating(false); openRoom(id); }} onClose={() => setCreating(false)} />}
    {requestedRoomId && <><ActionError error={roomContext.error} />{roomContext.isLoading && <p role="status">Checking the conversation's project…</p>}{roomContext.error && <Button onClick={() => void roomContext.refetch()}>Retry opening conversation</Button>}</>}
    {!projectReady && <>
      <ActionError error={needsProjectRefresh ? refreshedProjects.error : undefined} />
      <p role={projectRefreshFailed ? "alert" : "status"}>{projectRefreshFailed
        ? refreshedProjects.error ? "Could not refresh access to this conversation's project."
          : !refreshedIdentityMatches ? "Your account changed while opening this conversation. Retry opening the project."
            : "This notification's project is unavailable. Select an available project to continue."
        : "Opening the notification's project…"}</p>
      {projectRefreshFailed && <Button onClick={() => void refreshedProjects.refetch()}>Retry opening project</Button>}
    </>}
    <div className={`channels-layout${threadRootId ? " has-thread" : ""}`}>
      <aside className="channel-directory">
        <header className="channel-directory__heading"><div><h1>Channels</h1><p>A place for every conversation</p></div><Button variant="ghost" size="sm" iconLeft={Plus} aria-label="New channel" title="New channel" disabled={!projectId} onClick={() => setCreating(true)} /></header>
        <SearchInput aria-label="Find a channel" placeholder="Find a channel" value={filter} onChange={(event) => setFilter(event.target.value)} onClear={() => setFilter("")} />
        <NotificationsPanel onOpen={openNotification} />
        <div className="channel-directory__label"><span>Project channels</span><span>{channels.data?.channels.length ?? ""}</span></div>
        <ActionError error={channels.error} />
        {channels.error && <Button size="sm" onClick={() => void channels.refetch()}>Retry channels</Button>}
        {channels.isLoading && <div className="u-stack" role="status" aria-label="Loading channels"><Skeleton height={40} /><Skeleton height={40} /><Skeleton height={40} /></div>}
        <nav className="channel-list" aria-label="Channel list">{visibleChannels.map((channel) => <button key={channel.id} aria-label={`# ${channel.name}`} title={channel.description || channel.name} aria-current={channel.id === roomId ? "page" : undefined} className={`channel-list__item${channel.id === roomId ? " is-selected" : ""}`} onClick={() => openRoom(channel.id)}><Icon icon={Hash} size={18} /><span><strong>{channel.name}</strong>{channel.description && <small>{channel.description}</small>}</span></button>)}</nav>
        {filter && !visibleChannels.length && <p className="channel-directory__hint" role="status">No channels match “{filter}”.</p>}
        <Button className="channel-directory__create" variant="ghost" iconLeft={Plus} disabled={!projectId} onClick={() => setCreating(true)}>Add a channel</Button>
        <p className="channel-directory__foot"><Icon icon={MessageSquare} size={16} /> Keep the conversation connected to your work.</p>
      </aside>
      {roomId && roomReady ? <article className="channel-main u-stack"><header className="channel-header"><div className="channel-header__identity"><span className="channel-header__icon" aria-hidden="true"><Icon icon={selected || room?.type === "project" ? Hash : MessageSquare} size={24} /></span><div><h2>{selected || room?.type === "project" ? "# " : ""}{roomName}</h2><p>{selected?.description || "Share ideas, ask questions, and move work forward together."}</p></div></div><Button variant="ghost" size="sm" iconLeft={Info} aria-label="Conversation details" title="Conversation details" onClick={() => setShowDetails(true)} /></header><RoomConversation key={roomId} roomId={roomId} onOpenThread={(id) => openRoom(roomId, id)} /></article> : !roomId && <div className="channel-welcome"><EmptyState icon={MessageSquare} title="Bring your team together" description="Create your first channel to share updates, make decisions, and keep replies in context." action={<Button variant="primary" iconLeft={Plus} disabled={!projectId} onClick={() => setCreating(true)}>Create a channel</Button>} /></div>}
      {/* Read attempts and errors belong to one notification, including when
          several notifications point into the same thread. */}
      {roomId && roomReady && threadRootId && <ThreadPanel key={`${roomId}:${threadRootId}:${search.get("notification") ?? ""}`} roomId={roomId} threadRootId={threadRootId} focusedMessageId={search.get("message") ?? undefined} notificationId={search.get("notification") ?? undefined} onClose={() => openRoom(roomId)} />}
    </div>
    <Modal open={showDetails} onClose={() => setShowDetails(false)} title="Conversation details"><div className="u-stack"><h2>{roomName}</h2><p>{selected?.description || "A shared conversation for your project team."}</p><p className="t-muted">Everyone with access to this project can participate. Use threads to keep replies together and @ mentions to bring someone into the conversation.</p>{selected?.created_at && <p className="t-caption t-muted">Created {new Date(selected.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>}</div></Modal>
  </section>;
}

function ChannelForm({ projectId, onCreated, onClose }: { projectId: string; onCreated: (id: string) => void; onClose: () => void }): React.ReactNode {
  const api = useApi(); const query = useQueryClient();
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [key] = useState(newIdempotencyKey);
  const create = useMutation({ mutationFn: () => api.createChannel({ project_id: projectId, name: name.trim(), description: description.trim() }, key), onSuccess: async ({ channel }) => { await query.invalidateQueries({ queryKey: ["channels", projectId] }); onCreated(channel.id); } });
  return <Modal open onClose={() => { if (!create.isPending) onClose(); }} title="Create a channel"><form className="u-stack channel-create" aria-label="Create channel" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !create.isPending) create.mutate(); }}><p className="t-muted">Give your team a shared place for a topic, project, or ongoing discussion.</p><Input label="Channel name" placeholder="e.g. design-reviews" helperText="Choose a name your team will recognize." value={name} required maxLength={80} disabled={create.isPending} onChange={(event) => setName(event.target.value)} /><Textarea label="Channel description" placeholder="What will your team discuss here?" value={description} maxLength={2000} disabled={create.isPending} onChange={(event) => setDescription(event.target.value)} /><ActionError error={create.error} /><div className="action-row"><Button disabled={create.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" iconLeft={Plus} loading={create.isPending} disabled={!name.trim()}>Create channel</Button></div></form></Modal>;
}

export function ThreadPanel({ roomId, threadRootId, focusedMessageId, notificationId, onClose }: { roomId: string; threadRootId: string; focusedMessageId?: string; notificationId?: string; onClose: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  // RoomConversation loads these shared queries. Observe cache updates without
  // adding identity requests when a thread or historical mention is opened.
  const bootstrap = useQuery<BootstrapResponse>({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), enabled: false });
  const members = useQuery<{ members: Member[] }>({ queryKey: queryKeys.members, queryFn: () => api.listMembers(), enabled: false });
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
  return <aside className="thread-panel u-stack" aria-label="Thread"><header className="thread-panel__header"><div><h2>Thread</h2><p>Keep the conversation in context</p></div><Button ref={closeButton} size="sm" variant="ghost" iconLeft={X} aria-label="Close thread" title="Close thread" onClick={onClose} /></header>
    <ActionError error={root.error ?? focused.error ?? read.error} />
    {(root.isLoading || focused.isLoading) && <p role="status">Opening the mentioned conversation…</p>}
    {invalid && <p role="alert">The selected message does not belong to this thread.</p>}
    {(root.error || focused.error) && <Button onClick={() => { void root.refetch(); if (focusedMessageId && focusedMessageId !== threadRootId) void focused.refetch(); }}>Retry opening message</Button>}
    {read.error && notificationId && ready && <Button onClick={() => markRead(notificationId)}>Retry marking notification read</Button>}
    {ready && root.data && <><MessageCard message={root.data.message} {...messageIdentity(root.data.message, bootstrap.data, members.data?.members)} />
      {target && target.id !== threadRootId && <section className="product-card u-stack-sm" aria-label="Mentioned reply"><h3>Mentioned reply</h3><MessageCard message={target} {...messageIdentity(target, bootstrap.data, members.data?.members)} /></section>}
      <RoomConversation key={`${roomId}:${threadRootId}`} roomId={roomId} threadRootId={threadRootId} hiddenMessageId={target?.id} allowAssistant={typeof root.data.message.payload.discussion_id !== "string"} /></>}
  </aside>;
}
