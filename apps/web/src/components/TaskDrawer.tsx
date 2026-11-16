import { useState } from "react";
import { Link } from "react-router-dom";
import { useSubscription } from "../app/RealtimeContext.js";
import { useProjectControlView } from "../app/useProjectControlView.js";
import { useProject } from "../app/useProject.js";
import { Modal, Button } from "../ui/index.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import { TaskRoom } from "./TaskRoom.js";
import { ControlTaskFacts } from "./ControlTaskFacts.js";

/** Presentation only: all writes remain in the existing task/run owners. */
export function TaskDrawer({ taskId, projectId, onClose, onSelectTask }: {
  taskId: string;
  projectId: string;
  onClose: () => void;
  onSelectTask: (id: string) => void;
}): React.ReactNode {
  const [tab, setTab] = useState<"details" | "conversation">("details");
  const { bootstrap } = useProject();
  const control = useProjectControlView(projectId);
  const observation = control.entries.find((entry) => entry.task.id === taskId);
  useSubscription([`task:${taskId}`, `project:${projectId}`]);
  return <Modal open onClose={onClose} title="Task workspace" variant="drawer">
    <div className="cowork-drawer-tools"><div role="group" aria-label="Task view"><Button size="sm" aria-pressed={tab === "details"} onClick={() => setTab("details")}>Details & evidence</Button><Button size="sm" aria-pressed={tab === "conversation"} onClick={() => setTab("conversation")}>Conversation</Button></div><Link to={`/?task=${encodeURIComponent(taskId)}&project=${encodeURIComponent(projectId)}`}>Open workspace ↗</Link></div>
    {tab === "details" ? <>{observation && !control.isError && <div className="cowork-drawer-observation"><ControlTaskFacts entry={observation} bootstrap={bootstrap.data} /></div>}<TaskDetailPanel taskId={taskId} onSelectTask={onSelectTask} /></> : <TaskRoom taskId={taskId} />}
  </Modal>;
}
