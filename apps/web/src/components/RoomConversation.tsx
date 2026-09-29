import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Member } from "@artoo/domain";
import { ApiClientError } from "../api/client.js";
import type { BootstrapResponse, MessagesResponse } from "../api/types.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { appendMessages, mergeMessages } from "../app/roomMessages.js";
import { messageIdentity } from "../app/messageIdentity.js";
import { DRAFTS_CLEARED_EVENT, readRoomDraft, roomDraftKey, writeRoomDraft, type RoomDraft } from "../app/roomDrafts.js";
import { Button, EmptyState, ErrorState, Select, Skeleton, Textarea } from "../ui/index.js";
import { Icon, Activity, Inbox } from "../ui/Icon.js";
import { MessageCard } from "./MessageCard.js";
import { ActionError } from "./ActionError.js";
import { CollaborationPanel } from "./CollaborationPanel.js";
import { AssistantTurns } from "./AssistantTurns.js";

export function RoomSkeleton(): React.ReactNode {
  return <div className="task-room"><p role="status" aria-label="Loading activity">Loading activity...</p><div aria-hidden="true" className="u-stack">{Array.from({ length: 4 }, (_, i) => <div key={i} className="msg msg--skeleton"><Skeleton width={28} height={28} radius="var(--radius-pill)" /><div className="msg__main u-stack-sm"><Skeleton height={12} width="32%" /><Skeleton height={14} width={i % 2 === 0 ? "80%" : "55%"} /></div></div>)}</div></div>;
}

/** All room surfaces use the same ordered, paginated server history. Refetches
 * catch up from the newest cursor without replacing pages the user has opened. */
export function RoomConversation({ roomId, taskId, goalId, threadRootId, onOpenThread, allowAssistant = true, hiddenMessageId }: { roomId: string; taskId?: string; goalId?: string; threadRootId?: string; onOpenThread?: (messageId: string) => void; allowAssistant?: boolean; hiddenMessageId?: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const key = queryKeys.messages(roomId, threadRootId);
  const threadQuery = threadRootId ? { thread_root_id: threadRootId } : {};
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const members = useQuery({ queryKey: queryKeys.members, queryFn: () => api.listMembers(), staleTime: 30000 });
  useSubscription([`room:${roomId}`]);
  const messages = useQuery({
    queryKey: key,
    queryFn: async () => {
      const cached = query.getQueryData<MessagesResponse>(key);
      let after = cached?.next_after ?? undefined;
      let page = await api.listMessages(roomId, { limit: 50, ...threadQuery, ...(after ? { after } : {}) });
      const initialPage = page;
      let received = page.messages;
      // Bound a reconnect catch-up burst; further pages arrive on the next poll.
      for (let count = 1; after && page.has_more && page.next_after && page.next_after !== after && count < 20; count++) {
        after = page.next_after;
        page = await api.listMessages(roomId, { limit: 100, after, ...threadQuery });
        received = mergeMessages(received, page.messages);
      }
      // Reply counts on recent roots can change even without a new root. This
      // bounded snapshot also reconciles clients whose WebSocket is unavailable.
      if (cached?.next_after && onOpenThread && !threadRootId) {
        const latest = await api.listMessages(roomId, { limit: 50 });
        received = mergeMessages(received, latest.messages);
      }
      const current = query.getQueryData<MessagesResponse>(key);
      const result = { ...initialPage, messages: received, next_after: page.next_after ?? initialPage.next_after };
      // Read the latest cache after awaiting to preserve concurrently loaded history.
      return cached?.next_after && current ? appendMessages(current, result) : { ...result, messages: mergeMessages(current?.messages ?? [], result.messages) };
    },
    refetchInterval: 8000,
  });
  const earlier = useMutation({
    mutationFn: () => api.listMessages(roomId, { limit: 50, before: messages.data!.next_before!, ...threadQuery }),
    onSuccess: (page) => query.setQueryData<MessagesResponse>(key, (current) => ({
      ...current,
      messages: mergeMessages(page.messages, current?.messages ?? []),
      next_before: page.next_before,
      next_after: current?.next_after ?? page.next_after,
      has_more: page.has_more,
    })),
  });
  if (messages.isLoading) return <RoomSkeleton />;
  if (!messages.data) return <ErrorState title="Failed to load messages" action={<Button onClick={() => void messages.refetch()}>Retry</Button>} />;
  const items = messages.data.messages;
  const identity = bootstrap.data;
  const people = members.data?.members ?? (identity ? [{ id: identity.user.id, display_name: identity.user.display_name }] : []);
  const storageKey = identity ? roomDraftKey(api.getStorageScope(), identity.organization.id, identity.user.id, roomId, threadRootId) : null;
  return <section className="task-room" aria-label={threadRootId ? "Thread replies" : goalId ? "Goal conversation" : taskId ? "Task conversation" : "Channel conversation"}>
    <header className="task-room__header"><h2 className="task-room__title"><Icon icon={Activity} size={16} /> Activity</h2><span className="task-room__count">{items.length} loaded</span></header>
    <ActionError error={messages.error ?? earlier.error} />
    {messages.error && <Button size="sm" onClick={() => void messages.refetch()}>Retry message sync</Button>}
    {messages.data.has_more && messages.data.next_before && <Button loading={earlier.isPending} onClick={() => earlier.mutate()}>Load earlier messages</Button>}
    {items.length === 0 ? <div className="task-room--empty"><EmptyState icon={Inbox} title={threadRootId ? "No replies yet" : "No activity yet"} description="Messages, run events, and approvals will appear here." /></div> : <ul aria-label="Messages" className="messages">{items.filter((message) => message.id !== hiddenMessageId).map((message) => <li key={message.id}><MessageCard message={message} {...messageIdentity(message, identity, people)} />{onOpenThread && !threadRootId && <Button size="sm" variant="ghost" onClick={() => onOpenThread(message.id)}>{message.reply_count ? `${message.reply_count} replies` : "Reply in thread"}</Button>}</li>)}</ul>}
    {storageKey && identity ? <MessageComposer key={`${storageKey}:${allowAssistant}`} roomId={roomId} threadRootId={threadRootId} storageKey={storageKey} bootstrap={identity} people={people} peopleError={members.error} allowAssistant={allowAssistant} /> : <div><ActionError error={bootstrap.error} /><p role="status">Loading your account before composing a message…</p>{bootstrap.error && <Button onClick={() => void bootstrap.refetch()}>Retry account</Button>}</div>}
    <AssistantTurns roomId={roomId} threadRootId={threadRootId} messages={items} allowActions={allowAssistant} />
    {!threadRootId && (taskId || goalId) && <CollaborationPanel key={`collaboration:${roomId}`} roomId={roomId} taskId={taskId} goalId={goalId} />}
  </section>;
}

function discussionDraft(draft: RoomDraft): RoomDraft {
  return { ...draft, mode: "discussion", agentInstanceId: undefined, submission: draft.submission?.mode === "assistant" ? undefined : draft.submission };
}

function MessageComposer({ roomId, threadRootId, storageKey, bootstrap, people, peopleError, allowAssistant }: { roomId: string; threadRootId?: string; storageKey: string; bootstrap: BootstrapResponse; people: Member[]; peopleError: unknown; allowAssistant: boolean }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [draft, setDraft] = useState<RoomDraft>(() => allowAssistant ? readRoomDraft(storageKey) : discussionDraft(readRoomDraft(storageKey)));
  const [sent, setSent] = useState(false);
  const active = useRef(true);
  const draftGeneration = useRef(0);
  const persist = (next: RoomDraft): void => { setDraft(next); writeRoomDraft(storageKey, next); };
  useEffect(() => {
    active.current = true;
    if (!allowAssistant) writeRoomDraft(storageKey, discussionDraft(readRoomDraft(storageKey)));
    const cleared = (): void => { draftGeneration.current++; setDraft({ body: "" }); setSent(false); };
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    return () => { active.current = false; window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared); };
  }, [storageKey, allowAssistant]);
  const mutation = useMutation({
    mutationFn: ({ submission }: { submission: NonNullable<RoomDraft["submission"]>; generation: number }) => allowAssistant && submission.mode === "assistant"
      ? api.sendToAssistant(roomId, { body: submission.body, client_request_id: submission.key, ...(threadRootId ? { thread_root_id: threadRootId } : {}), ...(submission.agentInstanceId ? { agent_instance_id: submission.agentInstanceId } : {}) }, submission.key)
      : api.sendMessage(roomId, { kind: "text", body: submission.body, payload: {}, mentions: (submission.mentionIds ?? []).map((id) => ({ actor_type: "user", actor_id: id })), assignments: [], client_request_id: submission.key, ...(threadRootId ? { thread_root_id: threadRootId } : {}) }, submission.key),
    onSuccess: ({ message }, { submission, generation }) => {
      if (!active.current || generation !== draftGeneration.current) return;
      persist({ body: "", mode: submission.mode, agentInstanceId: submission.agentInstanceId });
      setSent(true);
      query.setQueryData<MessagesResponse>(queryKeys.messages(roomId, threadRootId), (current) => appendMessages(current, { messages: [message] }));
      void query.invalidateQueries({ queryKey: queryKeys.messages(roomId) });
      void query.invalidateQueries({ queryKey: queryKeys.assistantTurns(roomId) });
      if (threadRootId) void query.invalidateQueries({ queryKey: ["message", roomId, threadRootId] });
    },
    onError: (error, { submission, generation }) => {
      if (!active.current || generation !== draftGeneration.current) return;
      // A transport/server failure can mean the write succeeded but its reply
      // was lost. Preserve its exact payload and key across manual retry/reload.
      const uncertain = !(error instanceof ApiClientError && error.status >= 400 && error.status < 500);
      persist({ body: submission.body, mode: submission.mode, agentInstanceId: submission.agentInstanceId, mentionIds: submission.mentionIds, submission: { ...submission, uncertain } });
    },
  });
  return <form className="message-composer" aria-label="Send room message" onSubmit={(event) => {
    event.preventDefault();
    if (!active.current || !draft.body.trim() || mutation.isPending) return;
    const body = draft.body.trim();
    const submission = draft.submission?.body === body ? { ...draft.submission, uncertain: true } : { key: newIdempotencyKey(), body, uncertain: true, mode: draft.mode, agentInstanceId: draft.agentInstanceId, mentionIds: draft.mentionIds };
    setSent(false);
    persist({ ...draft, body, submission });
    mutation.mutate({ submission, generation: draftGeneration.current });
  }}>
    {allowAssistant && <Select label="Message destination" value={draft.mode ?? "discussion"} disabled={mutation.isPending || draft.submission?.uncertain} onChange={(event) => { mutation.reset(); setSent(false); persist({ ...draft, mode: event.target.value as "discussion" | "assistant", submission: undefined }); }}><option value="discussion">Team discussion</option><option value="assistant">Send to agent</option></Select>}
    {draft.mode === "assistant" && <Select label="Execution agent" value={draft.agentInstanceId ?? ""} disabled={mutation.isPending || draft.submission?.uncertain} onChange={(event) => { mutation.reset(); persist({ ...draft, agentInstanceId: event.target.value, submission: undefined }); }}><option value="">Choose automatically</option>{bootstrap.agent_instances.map((instance) => <option key={instance.id} value={instance.id}>{bootstrap.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? instance.runtime} · {bootstrap.computers.find((computer) => computer.id === instance.computer_id)?.display_name ?? instance.computer_id} · {instance.status}</option>)}</Select>}
    <Textarea label="Message" value={draft.body} maxLength={20000} disabled={mutation.isPending || draft.submission?.uncertain} onChange={(event) => { mutation.reset(); setSent(false); persist({ ...draft, body: event.target.value, submission: event.target.value.trim() === draft.submission?.body ? draft.submission : undefined }); }} placeholder={draft.mode === "assistant" ? "Ask the agent to work on this task or follow up on its reply" : "Share context or a progress update with your team"} />
    {draft.mode !== "assistant" && <details><summary>@ Notify people{draft.mentionIds?.length ? ` (${draft.mentionIds.length})` : ""}</summary><fieldset className="mention-picker" disabled={mutation.isPending || draft.submission?.uncertain}><legend>People to notify</legend>{peopleError ? <p className="t-subtle">Member list is unavailable. Refresh to load other people.</p> : null}{people.map((person) => <label key={person.id}><input type="checkbox" checked={draft.mentionIds?.includes(person.id) ?? false} onChange={(event) => { mutation.reset(); persist({ ...draft, mentionIds: event.target.checked ? [...(draft.mentionIds ?? []), person.id] : (draft.mentionIds ?? []).filter((id) => id !== person.id), submission: undefined }); }} />@{person.display_name}</label>)}</fieldset></details>}
    <p className="t-subtle">{draft.mode === "assistant" ? "The agent can execute work using the selected computer and runtime. Required approvals still apply. Follow-ups wait for the current run to finish." : "Team discussion is shared across your connected devices. Messages do not interrupt active execution."}</p>
    <ActionError error={mutation.error} />
    <p role="status" aria-live="polite">{mutation.isPending ? "Sending message…" : draft.submission?.uncertain ? "Delivery is unconfirmed. Retry safely with the same message." : sent ? draft.mode === "assistant" ? "Agent request submitted." : "Message sent." : draft.body ? "Draft saved on this device." : ""}</p>
    <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!draft.body.trim()}>{draft.submission?.uncertain && !mutation.isPending ? "Retry sending message" : draft.mode === "assistant" ? "Send to agent" : "Send message"}</Button>
  </form>;
}
