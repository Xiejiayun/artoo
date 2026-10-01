import type { Capability, Task } from "@artoo/domain";
import type { BootstrapResponse } from "../api/types.js";

export const PRIORITY_LABELS: Record<Task["priority"], string> = {
  p0: "Urgent", p1: "High", p2: "Normal", p3: "Low",
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  "code.read": "Read code", "code.modify": "Write code", "code.review": "Review code",
  "test.run": "Run tests", "git.patch": "Create patches", "github.pr": "Manage pull requests",
  "browser.navigate": "Use browser", "browser.extract": "Extract web content", "desktop.operate": "Use desktop",
  "doc.write": "Write documents", "research.web": "Research the web", "shell.run": "Run commands",
};

/** Keep human labels consistent across list, board and details; IDs remain a truthful fallback. */
export function taskAssigneeName(task: Task, bootstrap?: BootstrapResponse): string {
  if (!task.assignee_id) return "Unassigned";
  if (task.assignee_type === "agent") return bootstrap?.agents.find((agent) => agent.id === task.assignee_id)?.display_name ?? task.assignee_id;
  if (task.assignee_type === "user" && task.assignee_id === bootstrap?.user.id) return bootstrap.user.display_name;
  return task.assignee_id;
}

export function taskUpdatedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
