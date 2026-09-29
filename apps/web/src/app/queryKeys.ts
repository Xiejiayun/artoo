/**
 * Centralized TanStack Query keys so WS patches and mutations invalidate the
 * exact cached snapshot. Keys mirror the server WS topics
 * (`task:`/`room:`/`run:`/`inbox:`).
 */
export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  session: ["session"] as const,
  tasks: (projectId: string) => ["tasks", projectId] as const,
  task: (taskId: string) => ["task", taskId] as const,
  messages: (roomId: string, threadRootId?: string) => threadRootId ? ["messages", roomId, "thread", threadRootId] as const : ["messages", roomId] as const,
  members: ["members"] as const,
  notifications: ["notifications"] as const,
  daemons: ["daemons"] as const,
  assistantTurns: (roomId: string, threadRootId?: string) => threadRootId ? ["assistantTurns", roomId, "thread", threadRootId] as const : ["assistantTurns", roomId] as const,
  runOutputs: (taskId: string) => ["runOutputs", taskId] as const,
  runUsage: (runId: string) => ["runUsage", runId] as const,
  computerRuntimes: (computerId: string) => ["computerRuntimes", computerId] as const,
  skillInstalls: ["skillInstalls"] as const,
  approvals: (status: string) => ["approvals", status] as const,
  memories: (filters: Record<string, string | undefined> = {}) => ["memories", filters] as const,
  memory: (memoryId: string) => ["memory", memoryId] as const,
  memoryContext: (projectId: string, taskId?: string) =>
    ["memoryContext", projectId, taskId ?? null] as const,
  auditBundle: (taskId: string) => ["auditBundle", taskId] as const,
};
