import type { Message } from "@artoo/domain";
import type { MessagesResponse } from "../api/types.js";

/** Merge overlapping pages, preserving immutable message IDs and server order. */
export function mergeMessages(...pages: Message[][]): Message[] {
  const messages = new Map<string, Message>();
  for (const page of pages) for (const message of page) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

export function appendMessages(current: MessagesResponse | undefined, page: MessagesResponse): MessagesResponse {
  if (!current) return page;
  return {
    ...current,
    messages: mergeMessages(current.messages, page.messages),
    next_after: page.next_after ?? current.next_after,
  };
}
