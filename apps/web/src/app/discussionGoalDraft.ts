/** Navigation drafts are editable text, never an execution grant or prepared request. */
export interface DiscussionGoalDraft {
  version: 1;
  organizationId: string;
  userId: string;
  projectId: string;
  roomId: string;
  messageId: string;
  objective: string;
}

export function readDiscussionGoalDraft(value: unknown, scope: { organizationId: string; userId: string; projectId: string }): DiscussionGoalDraft | undefined {
  if (!value || typeof value !== "object") return;
  const draft = value as Partial<DiscussionGoalDraft>;
  if (draft.version !== 1 || draft.organizationId !== scope.organizationId || draft.userId !== scope.userId || draft.projectId !== scope.projectId
    || typeof draft.roomId !== "string" || !draft.roomId || typeof draft.messageId !== "string" || !draft.messageId
    || typeof draft.objective !== "string" || !draft.objective.trim() || draft.objective.length > 10000) return;
  return draft as DiscussionGoalDraft;
}
