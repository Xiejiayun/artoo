import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, EmptyState, Input, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { MessageCard } from "./MessageCard.js";
import { RoomConversation } from "./RoomConversation.js";
import { NotificationsPanel } from "./NotificationsPanel.js";

export function ChannelsPage(): React.ReactNode {
  const api = useApi();
  const { projectId } = useProject();
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const channels = useQuery({ queryKey: ["channels", projectId], queryFn: () => api.listChannels(projectId!), enabled: !!projectId, refetchInterval: 10000 });
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const roomId = search.get("room") ?? channels.data?.channels[0]?.id;
  const selected = channels.data?.channels.find((channel) => channel.id === roomId);
  const threadRootId = search.get("thread") ?? undefined;
  const openRoom = (room: string, thread?: string): void => { setSearch({ room, ...(thread ? { thread } : {}) }); };
  return <section className="product-page channels-page" aria-label="Channels"><header className="action-row"><h1 className="t-h1">Channels</h1><Button variant="primary" disabled={!projectId} onClick={() => setCreating(!creating)}>New channel</Button></header>
    <NotificationsPanel onOpen={openRoom} />
    {creating && projectId && <ChannelForm key={projectId} projectId={projectId} onCreated={(id) => { setCreating(false); openRoom(id); }} onClose={() => setCreating(false)} />}
    <ActionError error={channels.error} />{channels.isLoading && <p role="status">Loading channels…</p>}
    <div className={`channels-layout${threadRootId ? " has-thread" : ""}`}><nav className="product-list" aria-label="Channel list">{channels.data?.channels.map((channel) => <button key={channel.id} aria-current={channel.id === roomId ? "page" : undefined} className={channel.id === roomId ? "is-selected" : ""} onClick={() => openRoom(channel.id)}># {channel.name}</button>)}</nav>
      {roomId ? <article className="channel-main u-stack"><header><h2># {selected?.name ?? "Shared discussion"}</h2>{selected?.description && <p className="t-subtle">{selected.description}</p>}</header><RoomConversation key={roomId} roomId={roomId} onOpenThread={(id) => openRoom(roomId, id)} /></article> : <EmptyState title="No channels yet" description="Create a channel for your project team to share ideas and discuss work in threads." />}
      {roomId && threadRootId && <ThreadPanel key={`${roomId}:${threadRootId}`} roomId={roomId} threadRootId={threadRootId} onClose={() => openRoom(roomId)} />}
    </div>
  </section>;
}

function ChannelForm({ projectId, onCreated, onClose }: { projectId: string; onCreated: (id: string) => void; onClose: () => void }): React.ReactNode {
  const api = useApi(); const query = useQueryClient();
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [key] = useState(newIdempotencyKey);
  const create = useMutation({ mutationFn: () => api.createChannel({ project_id: projectId, name: name.trim(), description: description.trim() }, key), onSuccess: async ({ channel }) => { await query.invalidateQueries({ queryKey: ["channels", projectId] }); onCreated(channel.id); } });
  return <form className="product-card u-stack" aria-label="Create channel" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><Input label="Channel name" value={name} required maxLength={80} disabled={create.isPending} onChange={(event) => setName(event.target.value)} /><Textarea label="Channel description" value={description} maxLength={2000} disabled={create.isPending} onChange={(event) => setDescription(event.target.value)} /><ActionError error={create.error} /><div className="action-row"><Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>Create channel</Button><Button disabled={create.isPending} onClick={onClose}>Cancel</Button></div></form>;
}

export function ThreadPanel({ roomId, threadRootId, onClose }: { roomId: string; threadRootId: string; onClose: () => void }): React.ReactNode {
  const api = useApi();
  const root = useQuery({ queryKey: ["message", roomId, threadRootId], queryFn: () => api.getMessage(roomId, threadRootId), refetchInterval: 8000 });
  return <aside className="thread-panel u-stack" aria-label="Thread"><header className="action-row"><h2>Thread</h2><Button size="sm" onClick={onClose}>Close thread</Button></header><ActionError error={root.error} />{root.isLoading && <p role="status">Loading thread…</p>}{root.data && <><MessageCard message={root.data.message} /><RoomConversation key={`${roomId}:${threadRootId}`} roomId={roomId} threadRootId={threadRootId} allowAssistant={typeof root.data.message.payload.discussion_id !== "string"} /></>}</aside>;
}
