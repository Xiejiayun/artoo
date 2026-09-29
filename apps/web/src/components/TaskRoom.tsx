import { useQuery } from "@tanstack/react-query";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, EmptyState, ErrorState } from "../ui/index.js";
import { Inbox } from "../ui/Icon.js";
import { RoomConversation, RoomSkeleton } from "./RoomConversation.js";

/** Resolve the task room; task and goal rooms share the same conversation UI. */
export function TaskRoom({ taskId }: { taskId: string }): React.ReactNode {
  const api = useApi();
  const snapshot = useQuery({ queryKey: queryKeys.task(taskId), queryFn: () => api.getTask(taskId) });
  if (snapshot.isLoading) return <RoomSkeleton />;
  if (snapshot.isError || snapshot.data === undefined) return <ErrorState title="Failed to load task" action={<Button onClick={() => void snapshot.refetch()}>Retry</Button>} />;
  const roomId = snapshot.data.room?.id;
  if (!roomId) return <div className="task-room task-room--empty"><EmptyState icon={Inbox} title="No room for this task" description="This task has no activity room yet." /></div>;
  return <RoomConversation key={roomId} roomId={roomId} taskId={taskId} />;
}
