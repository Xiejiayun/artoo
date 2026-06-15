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
  memories: (filters: Record<string, string | undefined> = {}) => ["memories", filters] as const,
  memory: (memoryId: string) => ["memory", memoryId] as const,
  memoryContext: (projectId: string, taskId?: string) =>
    ["memoryContext", projectId, taskId ?? null] as const,
  auditBundle: (taskId: string) => ["auditBundle", taskId] as const,
};
