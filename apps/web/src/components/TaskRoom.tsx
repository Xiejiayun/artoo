import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useApi, useCommands } from "../app/ApiContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Button, EmptyState, ErrorState, Skeleton, Textarea } from "../ui/index.js";
import { Icon, Activity, Inbox } from "../ui/Icon.js";
import { MessageCard } from "./MessageCard.js";
import { ActionError } from "./ActionError.js";
import { CollaborationPanel } from "./CollaborationPanel.js";

function RoomSkeleton(): React.ReactNode {
  return (
    <div className="task-room">
      <p className="task-room-loading-label" role="status" aria-label="Loading activity">
        Loading activity...
      </p>
      <div aria-hidden="true" className="u-stack">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="msg msg--skeleton">
            <Skeleton width={28} height={28} radius="var(--radius-pill)" />
            <div className="msg__main u-stack-sm">
              <Skeleton height={12} width="32%" />
              <Skeleton height={14} width={i % 2 === 0 ? "80%" : "55%"} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Center pane: the task room / activity feed (#73). Resolves the task's room
 * from the snapshot, then renders its messages as defensive cards. A pure
 * projection — no lifecycle inference. Loading/empty/error states use the ui
 * primitives.
 */
export function TaskRoom({ taskId }: { taskId: string }): React.ReactNode {
  const api = useApi();
  const snapshot = useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  });
  const roomId = snapshot.data?.room?.id ?? null;
  useSubscription(roomId === null ? [] : [`room:${roomId}`]);
  const messages = useQuery({
    queryKey: roomId === null ? ["messages", "pending"] : queryKeys.messages(roomId),
    queryFn: () => api.listMessages(roomId as string),
    enabled: roomId !== null,
  });

  if (snapshot.isLoading) {
    return <RoomSkeleton />;
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return <ErrorState title="Failed to load task" />;
  }
  if (roomId === null) {
    return (
      <div className="task-room task-room--empty">
        <EmptyState icon={Inbox} title="No room for this task" description="This task has no activity room yet." />
      </div>
    );
  }
  if (messages.isLoading) {
    return <RoomSkeleton />;
  }
  if (messages.isError || messages.data === undefined) {
    return <ErrorState title="Failed to load messages" />;
  }

  const items = messages.data.messages;

  return (
    <div className="task-room">
      <header className="task-room__header">
        <h2 className="task-room__title">
          <Icon icon={Activity} size={16} /> Activity
        </h2>
        <span className="task-room__count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <div className="task-room--empty">
          <EmptyState
            icon={Inbox}
            title="No activity yet"
            description="Messages, run events, and approvals for this task will appear here."
          />
        </div>
      ) : (
        <ul aria-label="Messages" className="messages">
          {items.map((message) => (
            <li key={message.id}>
              <MessageCard message={message} />
            </li>
          ))}
        </ul>
      )}
      <MessageComposer key={roomId} roomId={roomId} />
      <CollaborationPanel key={`collaboration:${roomId}`} roomId={roomId} taskId={taskId} />
    </div>
  );
}

function MessageComposer({ roomId }: { roomId: string }): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const mutation = useMutation({
    mutationFn: (text: string) => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.sendMessage(roomId, { kind: "text", body: text, payload: {}, mentions: [], assignments: [] }, key), { key });
    },
    onSuccess: async () => {
      setBody("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.messages(roomId) });
    },
  });
  return <form className="message-composer" onSubmit={(event) => { event.preventDefault(); if (body.trim()) mutation.mutate(body.trim()); }}>
    <Textarea label="Message" value={body} maxLength={20000} disabled={mutation.isPending} onChange={(event) => setBody(event.target.value)} placeholder="Share context or a progress update with your team" />
    <p className="t-subtle">Messages are recorded in this task room. Use Stop run to interrupt active execution.</p>
    <ActionError error={mutation.error} />
    <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!body.trim()}>Send message</Button>
  </form>;
}
