import { useState } from "react";
import { Link } from "react-router-dom";
import { useSubscription } from "../app/RealtimeContext.js";
import { Modal, Button } from "../ui/index.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import { TaskRoom } from "./TaskRoom.js";

/** Presentation only: all writes remain in the existing task/run owners. */
export function TaskDrawer({ taskId, projectId, onClose, onSelectTask }: {
  taskId: string;
  projectId: string;
  onClose: () => void;
  onSelectTask: (id: string) => void;
}): React.ReactNode {
  const [tab, setTab] = useState<"details" | "conversation">("details");
  useSubscription([`task:${taskId}`, `project:${projectId}`]);
  return <Modal open onClose={onClose} title="Task workspace" variant="drawer">
    <div className="cowork-drawer-tools"><div role="group" aria-label="Task view"><Button size="sm" aria-pressed={tab === "details"} onClick={() => setTab("details")}>Details & evidence</Button><Button size="sm" aria-pressed={tab === "conversation"} onClick={() => setTab("conversation")}>Conversation</Button></div><Link to={`/?task=${encodeURIComponent(taskId)}&project=${encodeURIComponent(projectId)}`}>Open workspace ↗</Link></div>
    {tab === "details" ? <TaskDetailPanel taskId={taskId} onSelectTask={onSelectTask} /> : <TaskRoom taskId={taskId} />}
  </Modal>;
}
