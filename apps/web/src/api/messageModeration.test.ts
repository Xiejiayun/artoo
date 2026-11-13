import { expect, it } from "vitest";
import type { Message } from "@artoo/domain";
import { ApiClient } from "./client.js";
import { mergeMessages } from "../app/roomMessages.js";
import { removedMessage, REMOVED_MESSAGE } from "./messageModeration.js";

const message: Message = { id: "msg_old", organization_id: "org_default", room_id: "room_team", actor_type: "user", actor_id: "user_A", kind: "text", body: "Original private fixture", payload: { secret_display_hint: "original" }, created_at: "2026-10-10T00:00:00Z" };

it("a delayed original history page cannot restore a learned removal", async () => {
  let release!: (response: Response) => void;
  const client = new ApiClient({ fetch: () => new Promise<Response>((resolve) => { release = resolve; }) });
  const pending = client.listMessages("room_team");
  await Promise.resolve();
  client.noteMessageRemoved("room_team", "msg_old");
  release(Response.json({ messages: [message], next_before: "cursor", has_more: true }));
  const result = await pending;
  expect(result.messages[0]!.body).toBe(REMOVED_MESSAGE);
  expect(result.messages[0]!.payload).toEqual({ moderation: "removed" });
  expect(result.next_before).toBe("cursor");
  expect(mergeMessages(result.messages, [message])[0]!.body).toBe(REMOVED_MESSAGE);
});
it("older/later page ordering preserves a tombstone without hiding unrelated messages", () => {
  const other = { ...message, id: "other", body: "Keep visible" };
  for (const pages of [[[message], [removedMessage(message)]], [[removedMessage(message)], [message]]]) {
    const merged = mergeMessages(...pages, [other]);
    expect(merged.find((item) => item.id === "msg_old")?.body).toBe(REMOVED_MESSAGE);
    expect(merged.find((item) => item.id === "other")?.body).toBe("Keep visible");
  }
});
it("a visibility refresh carries removals into a later single-message response", async () => {
  const client = new ApiClient({ fetch: async (url) => String(url).endsWith("/visibility")
    ? Response.json({ removed_message_ids: ["msg_old"] }) : Response.json({ message }) });
  await client.messageVisibility("room_team", ["msg_old"]);
  expect((await client.getMessage("room_team", "msg_old")).message.body).toBe(REMOVED_MESSAGE);
  expect(client.messageForDisplay({ ...message, room_id: "another_room" }).body).toBe(message.body);
});

it("preserves the planning identity when redacting a root, while removing other payload text", () => {
  const root = { ...message, payload: { discussion_id: "discussion_team", private_content: "Do not retain" } };
  expect(removedMessage(root).payload).toEqual({ moderation: "removed", discussion_id: "discussion_team" });
});

it("validates complete compact state and remembers removals across delayed reads", async () => {
  let requestBody: unknown;
  const client = new ApiClient({ fetch: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ version: 1, states: [{ id: "msg_old", status: "removed", reply_count: 3 }] });
  } });
  expect((await client.reconcileMessages("room_team", ["msg_old", "msg_old"])).states).toHaveLength(1);
  expect(requestBody).toEqual({ version: 1, message_ids: ["msg_old", "msg_old"] });
  expect(client.messageForDisplay(message).body).toBe(REMOVED_MESSAGE);
});

it.each([
  { version: 2, states: [] }, { version: 1, states: [] },
  { version: 1, states: [{ id: "other", status: "removed", reply_count: 1 }] },
  { version: 1, states: [{ id: "msg_old", status: "visible", reply_count: -1 }] },
  { version: 1, states: [{ id: "msg_old", status: "visible", reply_count: 1.5 }] },
  { version: 1, states: [{ id: "msg_old", status: "removed", reply_count: 1 }, { id: "msg_old", status: "removed", reply_count: 1 }] },
])("rejects invalid/incomplete compact state %j without accepting tombstones", async (response) => {
  const client = new ApiClient({ fetch: async () => Response.json(response) });
  await expect(client.reconcileMessages("room_team", ["msg_old"])).rejects.toThrow("incomplete or invalid");
  expect(client.messageForDisplay(message).body).toBe(message.body);
});

it("surfaces unavailable cached IDs while preserving confirmed removals", async () => {
  const client = new ApiClient({ fetch: async () => Response.json({ version: 1, states: [
    { id: "msg_old", status: "removed", reply_count: 1 }, { id: "unknown", status: "unavailable" },
  ] }) });
  await expect(client.reconcileMessages("room_team", ["msg_old", "unknown"])).rejects.toThrow("unavailable");
  expect(client.messageForDisplay(message).body).toBe(REMOVED_MESSAGE);
});
