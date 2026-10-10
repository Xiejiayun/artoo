import type { Message } from "@artoo/domain";

export const REMOVED_MESSAGE = "This message was removed by a team administrator.";
export function removedMessage(message: Message): Message {
  return { ...message, body: REMOVED_MESSAGE, payload: { moderation: "removed", ...(typeof message.payload?.discussion_id === "string" ? { discussion_id: message.payload.discussion_id } : {}) } };
}
export function isRemovedMessage(message: Message): boolean { return message.payload?.moderation === "removed"; }
