import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Member, Message } from "@artoo/domain";
import { ArrowDown, AtSign, ChevronDown, MessageSquare, Send } from "lucide-react";
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
import { Icon } from "../ui/Icon.js";
import { MessageCard } from "./MessageCard.js";
import { ActionError } from "./ActionError.js";
import { CollaborationPanel } from "./CollaborationPanel.js";
import { AssistantTurns } from "./AssistantTurns.js";
import "../ui/conversation.css";

export function RoomSkeleton(): React.ReactNode {
  return <div className="task-room conversation conversation--loading"><p role="status" aria-label="Loading messages">Loading messages…</p><div aria-hidden="true" className="u-stack">{Array.from({ length: 4 }, (_, i) => <div key={i} className="msg msg--skeleton"><Skeleton width={36} height={36} radius="var(--radius-md)" /><div className="msg__main u-stack-sm"><Skeleton height={12} width="24%" /><Skeleton height={14} width={i % 2 === 0 ? "80%" : "55%"} /></div></div>)}</div></div>;
}

/** All room surfaces use the same ordered, paginated server history. Refetches
 * catch up from the newest cursor without replacing pages the user has opened. */
export function RoomConversation({ roomId, taskId, goalId, threadRootId, onOpenThread, allowAssistant = true, hiddenMessageId }: { roomId: string; taskId?: string; goalId?: string; threadRootId?: string; onOpenThread?: (messageId: string) => void; allowAssistant?: boolean; hiddenMessageId?: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [followRequest, setFollowRequest] = useState(0);
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
  const visibleCount = items.filter((item) => item.id !== hiddenMessageId).length;
  const identity = bootstrap.data;
  const people = members.data?.members ?? (identity ? [{ id: identity.user.id, display_name: identity.user.display_name }] : []);
  const storageKey = identity ? roomDraftKey(api.getStorageScope(), identity.organization.id, identity.user.id, roomId, threadRootId) : null;
  return <section className="task-room conversation" aria-label={threadRootId ? "Thread replies" : goalId ? "Goal conversation" : taskId ? "Task conversation" : "Channel conversation"}>
    <header className="conversation__header"><h2><Icon icon={MessageSquare} size={15} />{threadRootId ? "Replies" : "Conversation"}</h2><span>{visibleCount} {threadRootId ? visibleCount === 1 ? "reply" : "replies" : visibleCount === 1 ? "message" : "messages"}</span></header>
    <ActionError error={messages.error ?? earlier.error} />
    {messages.error && <Button size="sm" onClick={() => void messages.refetch()}>Retry message sync</Button>}
    <MessageTimeline key={`${roomId}:${threadRootId ?? ""}`} items={items} identity={identity} people={people} hiddenMessageId={hiddenMessageId} threadRootId={threadRootId} onOpenThread={onOpenThread} followRequest={followRequest} hasEarlier={!!messages.data.has_more && !!messages.data.next_before} loadingEarlier={earlier.isPending} onLoadEarlier={() => earlier.mutate()}><AssistantTurns roomId={roomId} threadRootId={threadRootId} messages={items} allowActions={allowAssistant} /></MessageTimeline>
    {storageKey && identity ? <MessageComposer key={`${storageKey}:${allowAssistant}`} roomId={roomId} threadRootId={threadRootId} storageKey={storageKey} bootstrap={identity} people={people} peopleError={members.error} allowAssistant={allowAssistant} onMessageSent={() => setFollowRequest((value) => value + 1)} /> : <div className="conversation__account"><ActionError error={bootstrap.error} /><p role="status">Loading your account before composing a message…</p>{bootstrap.error && <Button onClick={() => void bootstrap.refetch()}>Retry account</Button>}</div>}
    {!threadRootId && (taskId || goalId) && <CollaborationPanel key={`collaboration:${roomId}`} roomId={roomId} taskId={taskId} goalId={goalId} />}
  </section>;
}

function dateKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date();
  if (dateKey(iso) === dateKey(today.toISOString())) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(iso) === dateKey(yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function isContinuation(previous: Message | undefined, message: Message): boolean {
  if (!previous || message.actor_type === "system" || previous.kind !== "text" || message.kind !== "text" || previous.actor_id !== message.actor_id || previous.actor_type !== message.actor_type || previous.payload.assistant_turn_id || message.payload.assistant_turn_id) return false;
  const elapsed = new Date(message.created_at).getTime() - new Date(previous.created_at).getTime();
  return elapsed >= 0 && elapsed < 5 * 60 * 1000 && dateKey(previous.created_at) === dateKey(message.created_at);
}

/** Only follow arrivals while the reader is at the bottom. Loading history
 * preserves the visible offset; arriving messages get an explicit jump action. */
function MessageTimeline({ items, identity, people, hiddenMessageId, threadRootId, onOpenThread, followRequest, hasEarlier, loadingEarlier, onLoadEarlier, children }: { items: Message[]; identity?: BootstrapResponse; people: Member[]; hiddenMessageId?: string; threadRootId?: string; onOpenThread?: (messageId: string) => void; followRequest: number; hasEarlier: boolean; loadingEarlier: boolean; onLoadEarlier: () => void; children: React.ReactNode }): React.ReactNode {
  const visible = useMemo(() => items.filter((item) => item.id !== hiddenMessageId), [items, hiddenMessageId]);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stickToLatest = useRef(true);
  const previousItems = useRef<Message[] | null>(null);
  const historyAnchor = useRef<{ element: HTMLElement | null; offset: number; height: number; firstId?: string } | null>(null);
  const [newMessages, setNewMessages] = useState(0);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const jumpToLatest = (): void => {
    stickToLatest.current = true;
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    setNewMessages(0);
    setAwayFromLatest(false);
  };
  useLayoutEffect(jumpToLatest, [followRequest]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const previous = previousItems.current;
    const lastId = previous?.at(-1)?.id;
    const lastIndex = lastId ? visible.findIndex((item) => item.id === lastId) : -1;
    const arrivals = lastIndex >= 0 ? visible.length - lastIndex - 1 : 0;
    const anchor = historyAnchor.current;
    if (anchor && visible[0]?.id !== anchor.firstId) {
      // Anchor to an existing row, not the total height: messages can arrive at
      // the bottom while an older page is loading, and the reader may scroll.
      element.scrollTop += anchor.element?.isConnected ? anchor.element.offsetTop - anchor.offset : element.scrollHeight - anchor.height;
      historyAnchor.current = null;
      stickToLatest.current = false;
      setAwayFromLatest(element.scrollHeight - element.clientHeight - element.scrollTop > 64);
      if (arrivals > 0) setNewMessages((count) => count + arrivals);
    } else if (previous === null || stickToLatest.current) {
      jumpToLatest();
    } else if (arrivals > 0) {
      setNewMessages((count) => count + arrivals);
    }
    previousItems.current = visible;
  }, [visible]);
  useEffect(() => {
    if (!loadingEarlier) historyAnchor.current = null;
  }, [loadingEarlier]);
  useEffect(() => {
    // Text wrapping and viewport resizing must keep a reader at the latest
    // message without pulling somebody away from an earlier conversation.
    if (typeof ResizeObserver === "undefined" || !content.current || !viewport.current) return;
    const observer = new ResizeObserver(() => {
      if (stickToLatest.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    });
    observer.observe(content.current);
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  return <div className="conversation__history">
    <div className="conversation__viewport" ref={viewport} role="region" aria-label="Message history" tabIndex={0} onKeyDown={(event) => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Home") {
        event.preventDefault();
        stickToLatest.current = false;
        event.currentTarget.scrollTop = 0;
        setAwayFromLatest(event.currentTarget.scrollHeight > event.currentTarget.clientHeight);
      } else if (event.key === "End") {
        event.preventDefault();
        jumpToLatest();
      }
    }} onScroll={() => {
      const element = viewport.current;
      if (!element) return;
      const nearBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
      stickToLatest.current = nearBottom;
      setAwayFromLatest(!nearBottom);
      if (nearBottom) setNewMessages(0);
    }}><div className="conversation__content" ref={content}>
      {hasEarlier && <div className="conversation__earlier"><Button size="sm" variant="ghost" loading={loadingEarlier} onClick={() => {
        const firstRow = content.current?.querySelector<HTMLElement>(".conversation__messages > li") ?? null;
        if (viewport.current) historyAnchor.current = { element: firstRow, offset: firstRow?.offsetTop ?? 0, height: viewport.current.scrollHeight, firstId: visible[0]?.id };
        stickToLatest.current = false;
        onLoadEarlier();
      }}>Load earlier messages</Button></div>}
      {visible.length === 0 ? <div className="conversation__empty"><EmptyState icon={MessageSquare} title={threadRootId ? "Start the conversation" : "A space for your team"} description={threadRootId ? "Share your thoughts or ask a question. Replies stay together here." : "Share an update, ask a question, or bring your team together around an idea."} /></div> : <ul aria-label="Messages" className="messages conversation__messages">{visible.map((message, index) => {
        const previous = visible[index - 1];
        const startsDate = !previous || dateKey(previous.created_at) !== dateKey(message.created_at);
        return <li key={message.id}>
          {startsDate && <div className="conversation__date" role="separator" aria-label={dateLabel(message.created_at)}><time dateTime={message.created_at}>{dateLabel(message.created_at)}</time></div>}
          <MessageCard message={message} {...messageIdentity(message, identity, people)} compact={isContinuation(previous, message)} onOpenThread={onOpenThread && !threadRootId ? () => onOpenThread(message.id) : undefined} />
        </li>;
      })}</ul>}
      {children}
    </div></div>
    {awayFromLatest && <div className="conversation__jump"><Button size="sm" variant={newMessages ? "primary" : "secondary"} iconLeft={ArrowDown} onClick={jumpToLatest}>{newMessages ? `${newMessages} new ${newMessages === 1 ? "message" : "messages"}` : "Jump to latest"}</Button></div>}
    <span className="conversation__sr-only" role="status" aria-live="polite">{newMessages ? `${newMessages} new ${newMessages === 1 ? "message" : "messages"}. Jump to latest to read.` : ""}</span>
  </div>;
}

function discussionDraft(draft: RoomDraft): RoomDraft {
  return { ...draft, mode: "discussion", agentInstanceId: undefined, submission: draft.submission?.mode === "assistant" ? undefined : draft.submission };
}

function MessageComposer({ roomId, threadRootId, storageKey, bootstrap, people, peopleError, allowAssistant, onMessageSent }: { roomId: string; threadRootId?: string; storageKey: string; bootstrap: BootstrapResponse; people: Member[]; peopleError: unknown; allowAssistant: boolean; onMessageSent: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [draft, setDraft] = useState<RoomDraft>(() => allowAssistant ? readRoomDraft(storageKey) : discussionDraft(readRoomDraft(storageKey)));
  const [sent, setSent] = useState(false);
  const active = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sendInFlight = useRef(false);
  const restoreFocus = useRef(false);
  const draftGeneration = useRef(0);
  const persist = (next: RoomDraft): void => { setDraft(next); writeRoomDraft(storageKey, next); };
  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
  }, [draft.body]);
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
      onMessageSent();
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
    onSettled: () => { sendInFlight.current = false; },
  });
  useEffect(() => {
    if (mutation.isPending || !restoreFocus.current) return;
    if (!draft.submission?.uncertain && (document.activeElement === document.body || form.current?.contains(document.activeElement))) textarea.current?.focus();
    restoreFocus.current = false;
  }, [mutation.isPending, draft.submission?.uncertain]);
  const send = (): void => {
    if (!active.current || !draft.body.trim() || mutation.isPending || sendInFlight.current) return;
    const body = draft.body.trim();
    const submission = draft.submission?.body === body ? { ...draft.submission, uncertain: true } : { key: newIdempotencyKey(), body, uncertain: true, mode: draft.mode, agentInstanceId: draft.agentInstanceId, mentionIds: draft.mentionIds };
    setSent(false);
    sendInFlight.current = true;
    restoreFocus.current = form.current?.contains(document.activeElement) ?? false;
    persist({ ...draft, body, submission });
    mutation.mutate({ submission, generation: draftGeneration.current });
  };
  return <form ref={form} className="message-composer conversation-composer" aria-label="Send room message" onSubmit={(event) => { event.preventDefault(); send(); }}>
    <div className="conversation-composer__surface">
      {allowAssistant && <div className="conversation-composer__toolbar"><Select className="conversation-composer__destination" label="Message destination" value={draft.mode ?? "discussion"} disabled={mutation.isPending || draft.submission?.uncertain} onChange={(event) => { mutation.reset(); setSent(false); persist({ ...draft, mode: event.target.value as "discussion" | "assistant", submission: undefined }); }}><option value="discussion">Team discussion</option><option value="assistant">Send to agent</option></Select><Icon icon={ChevronDown} size={13} />
        {draft.mode === "assistant" && <Select className="conversation-composer__agent" label="Execution agent" value={draft.agentInstanceId ?? ""} disabled={mutation.isPending || draft.submission?.uncertain} onChange={(event) => { mutation.reset(); persist({ ...draft, agentInstanceId: event.target.value, submission: undefined }); }}><option value="">Choose automatically</option>{bootstrap.agent_instances.map((instance) => <option key={instance.id} value={instance.id}>{bootstrap.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? instance.runtime} · {bootstrap.computers.find((computer) => computer.id === instance.computer_id)?.display_name ?? instance.computer_id} · {instance.status}</option>)}</Select>}
      </div>}
      <Textarea className="conversation-composer__input" ref={textarea} label="Message" rows={2} value={draft.body} maxLength={20000} disabled={mutation.isPending || draft.submission?.uncertain} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) {
          event.preventDefault();
          send();
        }
      }} onChange={(event) => { mutation.reset(); setSent(false); persist({ ...draft, body: event.target.value, submission: event.target.value.trim() === draft.submission?.body ? draft.submission : undefined }); }} placeholder={draft.mode === "assistant" ? "Ask your agent to help…" : threadRootId ? "Reply to this thread…" : "Message your team…"} />
      <div className="conversation-composer__footer">
        {draft.mode !== "assistant" && <details className="conversation-composer__mentions"><summary><Icon icon={AtSign} size={16} /><span>Notify people{draft.mentionIds?.length ? ` (${draft.mentionIds.length})` : ""}</span></summary><fieldset className="mention-picker" disabled={mutation.isPending || draft.submission?.uncertain}><legend>People to notify</legend>{peopleError ? <p className="t-subtle">Member list is unavailable. Refresh to load other people.</p> : null}{people.map((person) => <label key={person.id}><input type="checkbox" checked={draft.mentionIds?.includes(person.id) ?? false} onChange={(event) => { mutation.reset(); persist({ ...draft, mentionIds: event.target.checked ? [...(draft.mentionIds ?? []), person.id] : (draft.mentionIds ?? []).filter((id) => id !== person.id), submission: undefined }); }} />@{person.display_name}</label>)}</fieldset></details>}
        <span className="conversation-composer__hint">Enter to send · Shift + Enter for a new line</span>
        <Button className="conversation-composer__send" type="submit" variant="primary" iconLeft={Send} loading={mutation.isPending} disabled={!draft.body.trim()}>{draft.submission?.uncertain && !mutation.isPending ? "Retry sending message" : draft.mode === "assistant" ? "Send to agent" : "Send message"}</Button>
      </div>
    </div>
    {draft.mode === "assistant" && <p className="conversation-composer__context">The agent can execute work using the selected computer and runtime. Required approvals still apply. Follow-ups wait for the current run to finish.</p>}
    <ActionError error={mutation.error} />
    <p className="conversation-composer__status" role="status" aria-live="polite">{mutation.isPending ? "Sending message…" : draft.submission?.uncertain ? "Delivery is unconfirmed. Retry safely with the same message." : sent ? draft.mode === "assistant" ? "Agent request submitted." : "Message sent." : draft.body ? "Draft saved on this device." : ""}</p>
  </form>;
}
