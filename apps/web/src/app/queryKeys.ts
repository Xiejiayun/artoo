/**
 * Centralized TanStack Query keys so WS patches and mutations invalidate the
 * exact cached snapshot. Keys mirror the server WS topics
 * (`task:`/`room:`/`run:`/`inbox:`).
 */
export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  tasks: (projectId: string) => ["tasks", projectId] as const,
  task: (taskId: string) => ["task", taskId] as const,
  messages: (roomId: string) => ["messages", roomId] as const,
  approvals: (status: string) => ["approvals", status] as const,
};
