import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { MessageCard } from "./MessageCard.js";

/**
 * Center pane: the task room. Resolves the task's room from the snapshot, then
 * renders its messages as defensive cards. A pure projection — no lifecycle
 * inference.
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
    return <p role="status">Loading task…</p>;
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return <p role="alert">Failed to load task.</p>;
  }
  if (roomId === null) {
    return <p className="no-room">No room for this task.</p>;
  }
  if (messages.isLoading) {
    return <p role="status">Loading messages…</p>;
  }
  if (messages.isError || messages.data === undefined) {
    return <p role="alert">Failed to load messages.</p>;
  }

  if (messages.data.messages.length === 0) {
    return <p className="empty">No messages yet.</p>;
  }

  return (
    <ul aria-label="Messages" className="messages">
      {messages.data.messages.map((message) => (
        <li key={message.id}>
          <MessageCard message={message} />
        </li>
      ))}
    </ul>
  );
}
