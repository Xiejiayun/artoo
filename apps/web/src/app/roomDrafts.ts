/** Room drafts contain message text, never credentials. Keep each account and
 * server isolated, and erase drafts when the account session ends. */
const PREFIX = "artoo:room-draft:v1:";
export const DRAFTS_CLEARED_EVENT = "artoo:room-drafts-cleared";

export interface RoomDraft {
  body: string;
  mode?: "discussion" | "assistant";
  agentInstanceId?: string;
  mentionIds?: string[];
  submission?: { key: string; body: string; uncertain: boolean; mode?: "discussion" | "assistant"; agentInstanceId?: string; mentionIds?: string[] };
}

export function roomDraftKey(server: string, organizationId: string, userId: string, roomId: string, threadRootId?: string): string {
  return `${PREFIX}${JSON.stringify(threadRootId ? [server, organizationId, userId, roomId, threadRootId] : [server, organizationId, userId, roomId])}`;
}

export function readRoomDraft(key: string): RoomDraft {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object" && "body" in value && typeof value.body === "string") {
      const draft = value as RoomDraft;
      const pending = draft.submission;
      if (pending && (typeof pending.key !== "string" || typeof pending.body !== "string" || typeof pending.uncertain !== "boolean")) return { body: draft.body };
      return draft;
    }
  } catch { /* Private browsing or blocked storage still allows an in-memory draft. */ }
  return { body: "" };
}

export function writeRoomDraft(key: string, draft: RoomDraft): void {
  try {
    if (draft.body || draft.submission) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch { /* Preserve the React draft when persistent storage is unavailable. */ }
}

export function clearRoomDrafts(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new Event(DRAFTS_CLEARED_EVENT));
}
