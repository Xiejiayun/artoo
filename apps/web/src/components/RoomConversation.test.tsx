// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalSchema } from "@artoo/domain";
import { ApiClient, ApiClientError } from "../api/client.js";
import type { AssistantTurn, MessagesResponse } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { clearRoomDrafts, roomDraftKey, writeRoomDraft } from "../app/roomDrafts.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { RoomConversation } from "./RoomConversation.js";
import { GoalsPage } from "./GoalsPage.js";
import { LogoutButton } from "./LogoutButton.js";

function chatApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeApi({
    bootstrap: async () => bootstrapFixture(), listMessages: async () => ({ messages: [] }), listAssistantTurns: async () => ({ turns: [] }),
    listDecisions: async () => ({ decisions: [] }), listHandoffs: async () => ({ handoffs: [] }), listBlockers: async () => ({ blockers: [] }),
    listChannels: async () => ({ channels: [] }), listDiscussions: async () => ({ discussions: [] }),
    ...overrides,
  });
}
afterEach(() => { localStorage.clear(); });

describe("RoomConversation", () => {
  it("uses complete compact state for empty-delta refreshes and preserves paginated history", async () => {
    const query = createTestQueryClient();
    const snapshot = bootstrapFixture({ message_sync: { version: 1, visibility_batch_limit: 500, reconciliation_version: 1 } });
    query.setQueryData(queryKeys.bootstrap, snapshot);
    const cached = Array.from({ length: 250 }, (_, index) => messageFixture({ id: `compact_${index}`, actor_type: "user", kind: "text",
      body: `Compact history ${index}`, sequence: index + 1, reply_count: index === 0 ? 1 : 0 }));
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: cached, next_after: "cursor", next_before: "older", has_more: true });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValue({ messages: [], next_after: "cursor" });
    const client = chatApi({ bootstrap: async () => snapshot, listMessages });
    const reconcile = vi.fn<ApiClient["reconcileMessages"]>().mockImplementation(async (room, ids) => {
      client.noteMessageRemoved(room, "compact_249");
      return { version: 1, states: ids.map((id) => ({ id, status: id === "compact_249" ? "removed" : "visible", reply_count: id === "compact_0" ? 7 : 0 })) };
    });
    client.reconcileMessages = reconcile;
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" onOpenThread={() => undefined} />, { client, queryClient: query });
    await waitFor(() => expect(query.getQueryState(queryKeys.messages("room_1"))?.fetchStatus).toBe("idle"));
    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([{ limit: 50, after: "cursor" }]);
    expect(reconcile.mock.calls.map((call) => call[1])).toEqual([cached.map((message) => message.id)]);
    expect(await screen.findByRole("button", { name: "7 replies" })).toBeInTheDocument();
    expect(screen.queryByText("Compact history 249")).not.toBeInTheDocument();
    expect(query.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))).toMatchObject({ next_before: "older", has_more: true });
    listMessages.mockClear(); reconcile.mockClear();
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.messages("room_1") }); });
    expect(listMessages).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(query.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))!.messages).toHaveLength(250);
    expect(screen.queryByText("Compact history 249")).not.toBeInTheDocument();
  });

  it.each([false, true])("redacts confirmed removals in every cache when a later batch fails (compact=%s)", async (compact) => {
    const query = createTestQueryClient();
    const snapshot = bootstrapFixture({ ...(compact ? { message_sync: { version: 1, visibility_batch_limit: 100, reconciliation_version: 1 } } : {}) });
    query.setQueryData(queryKeys.bootstrap, snapshot);
    const cached = Array.from({ length: 101 }, (_, index) => messageFixture({ id: `partial_${index}`, room_id: "room_1", actor_type: "user", kind: "text", body: `Partial history ${index}`, sequence: index + 1 }));
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: cached, next_after: "cursor" });
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1", "root"), { messages: [cached[0]!] });
    query.setQueryData(queryKeys.message("room_1", cached[0]!.id), { message: cached[0] });
    const client = chatApi({ bootstrap: async () => snapshot });
    let fail = true;
    const checked: string[][] = [];
    const check = async (room: string, ids: string[]): Promise<void> => {
      checked.push(ids);
      if (fail && ids.includes("partial_100")) { fail = false; throw new Error("Second batch failed"); }
      if (ids.includes("partial_0")) client.noteMessageRemoved(room, "partial_0");
    };
    client.messageVisibility = async (room, ids) => { await check(room, ids); return []; };
    client.reconcileMessages = async (room, ids) => { await check(room, ids); return { version: 1, states: ids.map((id) => ({ id, status: id === "partial_0" ? "removed" : "visible", reply_count: 0 })) }; };
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client, queryClient: query });
    expect(await screen.findByText("Second batch failed")).toBeInTheDocument();
    expect(screen.queryByText("Partial history 0")).not.toBeInTheDocument();
    for (const key of [queryKeys.messages("room_1"), queryKeys.messages("room_1", "root")]) {
      expect(query.getQueryData<MessagesResponse>(key)!.messages[0]!.payload.moderation).toBe("removed");
    }
    expect(query.getQueryData<{ message: { payload: unknown } }>(queryKeys.message("room_1", "partial_0"))!.message.payload).toEqual({ moderation: "removed" });
    await userEvent.click(screen.getByRole("button", { name: "Retry message sync" }));
    await waitFor(() => expect(screen.queryByText("Second batch failed")).not.toBeInTheDocument());
    expect(checked.flat()).toEqual([...cached.map((message) => message.id), ...cached.map((message) => message.id)]);
  });

  it("preserves history loaded during compact reconciliation and a newer realtime reply count", async () => {
    const query = createTestQueryClient();
    const snapshot = bootstrapFixture({ message_sync: { version: 1, visibility_batch_limit: 500, reconciliation_version: 1 } });
    query.setQueryData(queryKeys.bootstrap, snapshot);
    const root = messageFixture({ id: "root", actor_type: "user", kind: "text", body: "Root with newer replies", reply_count: 1, sequence: 2 });
    const old = messageFixture({ id: "old", actor_type: "user", kind: "text", body: "Concurrent earlier page", sequence: 1 });
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: [root], next_after: "cursor" });
    const reconcile = vi.fn<ApiClient["reconcileMessages"]>().mockImplementation(async () => {
      query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: [old, { ...root, reply_count: 9 }], next_after: "cursor", next_before: "earlier", has_more: true });
      return { version: 1, states: [{ id: "root", status: "visible", reply_count: 7 }] };
    });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" onOpenThread={() => undefined} />, { client: chatApi({ bootstrap: async () => snapshot, reconcileMessages: reconcile,
      listMessages: async () => ({ messages: [{ ...root, reply_count: 2 }], next_after: "cursor" }) }), queryClient: query });
    expect(await screen.findByRole("button", { name: "9 replies" })).toBeInTheDocument();
    expect(screen.getByText("Concurrent earlier page")).toBeInTheDocument();
    expect(query.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))).toMatchObject({ next_before: "earlier", has_more: true });
  });

  it("retains the root projection snapshot for legacy agent text even with compact state", async () => {
    const query = createTestQueryClient();
    const snapshot = bootstrapFixture({ message_sync: { version: 1, visibility_batch_limit: 500, reconciliation_version: 1 } });
    query.setQueryData(queryKeys.bootstrap, snapshot);
    const legacy = messageFixture({ id: "legacy", actor_type: "agent", kind: "text", body: "Legacy response", payload: {} });
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: [legacy], next_after: "cursor" });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValue({ messages: [] });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" onOpenThread={() => undefined} />, { client: chatApi({ bootstrap: async () => snapshot, listMessages,
      reconcileMessages: async () => ({ version: 1, states: [{ id: "legacy", status: "visible", reply_count: 0 }] }) }), queryClient: query });
    await waitFor(() => expect(query.getQueryState(queryKeys.messages("room_1"))?.fetchStatus).toBe("idle"));
    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([{ limit: 50, after: "cursor" }, { limit: 50 }]);
  });

  it.each([undefined, { version: 1 as const, visibility_batch_limit: 500 }])("reconciles all 250 cached messages and missed reply counts with capability %j", async (capability) => {
    const query = createTestQueryClient();
    const snapshot = bootstrapFixture({ ...(capability ? { message_sync: capability } : {}) });
    query.setQueryData(queryKeys.bootstrap, snapshot);
    const cached = Array.from({ length: 250 }, (_, index) => messageFixture({ id: `cached_${index}`, kind: "text", sequence: index + 1,
      body: `History ${index}`, reply_count: index === 0 ? 1 : 0 }));
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: cached, next_after: "latest-cursor", has_more: true, next_before: "older-cursor" });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockImplementation(async (_room, options) => options?.after
      ? { messages: [], next_after: "latest-cursor" }
      : { messages: [{ ...cached[0]!, reply_count: 7 }] });
    const client = chatApi({ bootstrap: async () => snapshot, listMessages });
    const visibility = vi.fn<ApiClient["messageVisibility"]>().mockImplementation(async (room, ids) => {
      if (ids.includes("cached_249")) client.noteMessageRemoved(room, "cached_249");
      return ids.includes("cached_249") ? ["cached_249"] : [];
    });
    client.messageVisibility = visibility;
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" onOpenThread={() => undefined} />, { client, queryClient: query });
    await waitFor(() => expect(query.getQueryState(queryKeys.messages("room_1"))?.fetchStatus).toBe("idle"));
    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([{ limit: 50, after: "latest-cursor" }, { limit: 50 }]);
    expect(visibility.mock.calls).toHaveLength(capability ? 1 : 3);
    expect(visibility.mock.calls.flatMap((call) => call[1])).toEqual(cached.map((message) => message.id));
    expect(await screen.findByRole("button", { name: /7 replies/ })).toBeInTheDocument();
    expect(screen.queryByText("History 249")).not.toBeInTheDocument();
    const updated = query.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))!;
    expect(updated.messages).toHaveLength(250);
    expect(updated.messages.at(-1)!.payload.moderation).toBe("removed");
    expect(updated.next_before).toBe("older-cursor");
    expect(updated.has_more).toBe(true);
    listMessages.mockClear(); visibility.mockClear();
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.messages("room_1") }); });
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(visibility.mock.calls.flatMap((call) => call[1])).toEqual(cached.map((message) => message.id));
    expect(query.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))!.messages.at(-1)!.payload.moderation).toBe("removed");
  });

  it("surfaces a visibility batch failure and retries all cached identifiers", async () => {
    const query = createTestQueryClient();
    query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), { messages: [messageFixture({ id: "old", kind: "text", body: "Old history" })], next_after: "cursor" });
    const visibility = vi.fn<ApiClient["messageVisibility"]>().mockRejectedValueOnce(new Error("Removal sync unavailable")).mockResolvedValue([]);
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ messageVisibility: visibility }), queryClient: query });
    expect(await screen.findByText("Removal sync unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry message sync" }));
    await waitFor(() => expect(screen.queryByText("Removal sync unavailable")).not.toBeInTheDocument());
    expect(visibility.mock.calls.map((call) => call[1])).toEqual([["old"], ["old"]]);
  });

  it("renders a goal conversation after its initial message request completes", async () => {
    let resolveMessages!: (page: MessagesResponse) => void;
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockImplementationOnce(() => new Promise((resolve) => { resolveMessages = resolve; }));
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" goalId="goal_1" />, { client: chatApi({ listMessages }) });
    expect(screen.getByRole("status", { name: "Loading messages" })).toBeInTheDocument();
    await waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    await act(async () => { resolveMessages({ messages: [messageFixture({ id: "goal_message", kind: "text", body: "Goal planning is ready" })] }); });
    expect(await screen.findByRole("region", { name: "Goal conversation" })).toBeInTheDocument();
    expect(screen.getByText("Goal planning is ready")).toBeInTheDocument();
  });

  it("offers only the conversation project's agents for execution", async () => {
    const data = bootstrapFixture();
    data.agents.push({ ...data.agents[0]!, id: "foreign_agent", display_name: "Other project agent" });
    data.agent_instances.push({ ...data.agent_instances[0]!, id: "foreign_instance", agent_id: "foreign_agent", project_id: "other_project" });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ bootstrap: async () => data }) });
    await userEvent.selectOptions(await screen.findByLabelText("Message destination"), "assistant");
    const select = within(screen.getByLabelText("Execution agent"));
    expect(select.getByRole("option", { name: /Mock Coder/ })).toHaveValue("instance_mock_coder");
    expect(select.queryByRole("option", { name: /Other project agent/ })).not.toBeInTheDocument();
  });

  it("sends with Enter, keeps Shift+Enter as a new line, and returns focus to the composer", async () => {
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "First line\nSecond line" }) });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ sendMessage }) });
    const message = await screen.findByLabelText("Message");
    await userEvent.type(message, "First line{Shift>}{Enter}{/Shift}Second line");
    expect(message).toHaveValue("First line\nSecond line");
    expect(sendMessage).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("room_1", expect.objectContaining({ body: "First line\nSecond line" }), expect.any(String));
    expect(message).toHaveValue("");
    expect(message).toHaveFocus();
  });

  it("does not send while committing IME composition or repeating a held Enter key", async () => {
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "你好" }) });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ sendMessage }) });
    const message = await screen.findByLabelText("Message");
    fireEvent.change(message, { target: { value: "你好" } });
    fireEvent.compositionStart(message);
    fireEvent.keyDown(message, { key: "Enter" });
    fireEvent.compositionEnd(message);
    fireEvent.keyDown(message, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    fireEvent.keyDown(message, { key: "Enter", repeat: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(message).toHaveValue("你好");
    fireEvent.keyDown(message, { key: "Enter" });
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not move a reader browsing history when messages arrive and lets them jump to latest", async () => {
    const first = messageFixture({ id: "first", kind: "text", body: "Earlier conversation", sequence: 1 });
    const second = messageFixture({ id: "second", kind: "text", body: "First arrival", sequence: 2 });
    const third = messageFixture({ id: "third", kind: "text", body: "Second arrival", sequence: 3 });
    const query = createTestQueryClient();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages: async () => ({ messages: [first] }) }), queryClient: query });
    const history = await screen.findByRole("region", { name: "Message history" });
    let height = 1000;
    let top = 0;
    Object.defineProperties(history, { scrollHeight: { get: () => height }, clientHeight: { get: () => 300 }, scrollTop: { get: () => top, set: (value: number) => { top = Math.min(value, height - 300); } } });
    history.scrollTop = 100;
    fireEvent.scroll(history);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    height = 1200;
    await act(async () => { query.setQueryData(queryKeys.messages("room_1"), { messages: [first, second] }); });
    expect(await screen.findByRole("button", { name: "1 new message" })).toBeInTheDocument();
    expect(history.scrollTop).toBe(100);
    height = 1400;
    await act(async () => { query.setQueryData(queryKeys.messages("room_1"), { messages: [first, second, third] }); });
    await userEvent.click(await screen.findByRole("button", { name: "2 new messages" }));
    expect(history.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: /new messages|Jump to latest/ })).not.toBeInTheDocument();
    height = 1600;
    await act(async () => { query.setQueryData(queryKeys.messages("room_1"), { messages: [first, second, third, messageFixture({ id: "fourth", kind: "text", body: "Followed arrival", sequence: 4 })] }); });
    await screen.findByText("Followed arrival");
    expect(history.scrollTop).toBe(1300);
  });

  it("Home preserves the reader at the start and End resumes following arrivals", async () => {
    const first = messageFixture({ id: "first", kind: "text", body: "First message", sequence: 1 });
    const query = createTestQueryClient();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages: async () => ({ messages: [first] }) }), queryClient: query });
    const history = await screen.findByRole("region", { name: "Message history" });
    let height = 1000, top = 700;
    Object.defineProperties(history, { scrollHeight: { get: () => height }, clientHeight: { get: () => 300 }, scrollTop: { get: () => top, set: (value: number) => { top = Math.min(value, height - 300); } } });
    fireEvent.keyDown(history, { key: "Home" });
    expect(history.scrollTop).toBe(0);
    const second = messageFixture({ id: "second", kind: "text", body: "Later arrival", sequence: 2 });
    height = 1200;
    await act(async () => { query.setQueryData(queryKeys.messages("room_1"), { messages: [first, second] }); });
    expect(history.scrollTop).toBe(0);
    expect(await screen.findByRole("button", { name: "1 new message" })).toBeInTheDocument();
    fireEvent.keyDown(history, { key: "End" });
    expect(history.scrollTop).toBe(900);
    expect(screen.queryByRole("button", { name: /new message|Jump to latest/ })).not.toBeInTheDocument();
  });

  it("preserves the visible history offset when an earlier page is prepended", async () => {
    const latest = messageFixture({ id: "latest", kind: "text", body: "Latest message", sequence: 2 });
    const oldest = messageFixture({ id: "oldest", kind: "text", body: "Older message", sequence: 1 });
    let resolveEarlier!: (page: MessagesResponse) => void;
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValueOnce({ messages: [latest], has_more: true, next_before: "before", next_after: "after" }).mockImplementationOnce(() => new Promise((resolve) => { resolveEarlier = resolve; }));
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages }) });
    const history = await screen.findByRole("region", { name: "Message history" });
    Object.defineProperties(history, { scrollHeight: { get: () => screen.queryByText("Older message") ? 1400 : 1000 }, clientHeight: { get: () => 300 } });
    Object.defineProperty(screen.getByText("Latest message").closest("li")!, "offsetTop", { get: () => screen.queryByText("Older message") ? 450 : 50 });
    history.scrollTop = 100;
    fireEvent.scroll(history);
    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await act(async () => { resolveEarlier({ messages: [oldest], has_more: false }); });
    await screen.findByText("Older message");
    expect(history.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /new messages/ })).not.toBeInTheDocument();
  });

  it("anchors earlier pages independently of arrivals and scrolling while they load", async () => {
    const latest = messageFixture({ id: "latest", kind: "text", body: "Latest message", sequence: 2 });
    const arrival = messageFixture({ id: "arrival", kind: "text", body: "New arrival", sequence: 3 });
    const oldest = messageFixture({ id: "oldest", kind: "text", body: "Older message", sequence: 1 });
    let resolveEarlier!: (page: MessagesResponse) => void;
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValueOnce({ messages: [latest], has_more: true, next_before: "before", next_after: "after" }).mockImplementationOnce(() => new Promise((resolve) => { resolveEarlier = resolve; }));
    const query = createTestQueryClient();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages }), queryClient: query });
    const history = await screen.findByRole("region", { name: "Message history" });
    Object.defineProperties(history, { scrollHeight: { get: () => screen.queryByText("Older message") ? 1500 : screen.queryByText("New arrival") ? 1100 : 1000 }, clientHeight: { get: () => 300 } });
    Object.defineProperty(screen.getByText("Latest message").closest("li")!, "offsetTop", { get: () => screen.queryByText("Older message") ? 450 : 50 });
    history.scrollTop = 100;
    fireEvent.scroll(history);
    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await act(async () => { query.setQueryData<MessagesResponse>(queryKeys.messages("room_1"), (current) => ({ ...current, messages: [latest, arrival] })); });
    await screen.findByRole("button", { name: "1 new message" });
    history.scrollTop = 150;
    fireEvent.scroll(history);
    await act(async () => { resolveEarlier({ messages: [oldest], has_more: false }); });
    await screen.findByText("Older message");
    expect(history.scrollTop).toBe(550);
    expect(screen.getByRole("button", { name: "1 new message" })).toBeInTheDocument();
  });

  it("groups consecutive messages while retaining date and actor boundaries", async () => {
    const messages = [
      messageFixture({ id: "first", kind: "text", body: "Morning", sequence: 1, created_at: "2026-09-28T10:00:00Z" }),
      messageFixture({ id: "second", kind: "text", body: "A quick follow-up", sequence: 2, created_at: "2026-09-28T10:01:00Z" }),
      messageFixture({ id: "third", kind: "text", body: "Next day", sequence: 3, created_at: "2026-09-29T10:00:00Z" }),
      messageFixture({ id: "fourth", kind: "text", body: "Agent response", sequence: 4, actor_type: "agent", actor_id: "agent_mock_coder", created_at: "2026-09-29T10:01:00Z" }),
    ];
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages: async () => ({ messages }) }) });
    expect((await screen.findByText("Morning")).closest("article")).not.toHaveClass("msg--compact");
    expect(screen.getByText("A quick follow-up").closest("article")).toHaveClass("msg--compact");
    expect(screen.getByText("Next day").closest("article")).not.toHaveClass("msg--compact");
    expect(screen.getByText("Agent response").closest("article")).not.toHaveClass("msg--compact");
    expect(within(screen.getByRole("list", { name: "Messages" })).getAllByRole("separator")).toHaveLength(2);
  });

  it("loads room and thread assistant turns independently and refreshes both from a room event", async () => {
    const base: AssistantTurn = { id: "root_turn", room_id: "room_1", task_id: "task_1", run_id: null, user_message_id: "request", response_message_id: null, status: "waiting", error: "Root waiting reason", created_at: "2026-09-29", updated_at: "2026-09-29" };
    const thread = { ...base, id: "thread_turn", thread_root_id: "thread_1", error: "Thread waiting reason" };
    const listAssistantTurns = vi.fn<ApiClient["listAssistantTurns"]>().mockImplementation(async (_, rootId) => ({ turns: [rootId ? thread : base] }));
    const query = createTestQueryClient();
    renderWithProviders(<><RoomConversation roomId="room_1" projectId="proj_artoo" /><RoomConversation roomId="room_1" threadRootId="thread_1" /></>, { client: chatApi({ listAssistantTurns }), queryClient: query });
    expect(await screen.findByText("Root waiting reason")).toBeInTheDocument();
    expect(await screen.findByText("Thread waiting reason")).toBeInTheDocument();
    expect(listAssistantTurns).toHaveBeenCalledWith("room_1", "thread_1");
    expect(query.getQueryData(queryKeys.assistantTurns("room_1"))).toEqual({ turns: [base] });
    expect(query.getQueryData(queryKeys.assistantTurns("room_1", "thread_1"))).toEqual({ turns: [thread] });
    listAssistantTurns.mockClear();
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.assistantTurns("room_1") }); });
    expect(listAssistantTurns).toHaveBeenCalledWith("room_1", undefined);
    expect(listAssistantTurns).toHaveBeenCalledWith("room_1", "thread_1");
  });

  it("converts stored assistant drafts to team replies and hides coordinator-owned turn actions in planning threads", async () => {
    const turn: AssistantTurn = { id: "planned_turn", room_id: "room_1", task_id: "planning_task", thread_root_id: "planning_root", run_id: null, user_message_id: "request", response_message_id: null, status: "waiting", error: null, created_at: "2026-09-29", updated_at: "2026-09-29" };
    const sendToAssistant = vi.fn<ApiClient["sendToAssistant"]>();
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "My feedback", thread_root_id: "planning_root" }) });
    const client = chatApi({ sendToAssistant, sendMessage, listAssistantTurns: async () => ({ turns: [turn] }) });
    const key = roomDraftKey(client.getStorageScope(), "org_default", "user_1", "room_1", "planning_root");
    writeRoomDraft(key, { body: "My feedback", mode: "assistant", agentInstanceId: "instance_mock_coder", submission: { key: "old-assistant-request", body: "My feedback", mode: "assistant", uncertain: true } });
    renderWithProviders(<RoomConversation roomId="room_1" threadRootId="planning_root" allowAssistant={false} />, { client });
    expect(await screen.findByLabelText("Message")).toHaveValue("My feedback");
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.queryByLabelText("Message destination")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Execution agent")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open execution task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel agent request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry agent request" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(sendToAssistant).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("room_1", expect.objectContaining({ body: "My feedback", thread_root_id: "planning_root", client_request_id: expect.not.stringContaining("old-assistant-request") }), expect.any(String));
  });

  it("submits an explicit agent request with a durable logical ID and selected runtime across retries", async () => {
    const turn: AssistantTurn = { id: "turn_1", room_id: "room_1", task_id: "task_1", run_id: null, user_message_id: "request", response_message_id: null, status: "queued", error: null, created_at: "2026-09-29", updated_at: "2026-09-29" };
    const sendToAssistant = vi.fn<ApiClient["sendToAssistant"]>().mockRejectedValueOnce(new ApiClientError("network_error", "Response lost", 0)).mockResolvedValueOnce({ turn, message: messageFixture({ id: "request", kind: "text", body: "Please continue", payload: { assistant_turn_id: "turn_1" } }) });
    const sendMessage = vi.fn<ApiClient["sendMessage"]>();
    const client = chatApi({ sendToAssistant, sendMessage });
    const first = renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    await userEvent.selectOptions(await screen.findByLabelText("Message destination"), "assistant");
    await userEvent.selectOptions(screen.getByLabelText("Execution agent"), "instance_mock_coder");
    await userEvent.type(screen.getByLabelText("Message"), "Please continue");
    await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByText(/Delivery is unconfirmed/)).toBeInTheDocument();
    first.unmount();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    expect(await screen.findByLabelText("Execution agent")).toHaveValue("instance_mock_coder");
    expect(screen.getByLabelText("Message destination")).toHaveValue("assistant");
    await userEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    expect(await screen.findByText("Agent request submitted.")).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
    const firstCall = sendToAssistant.mock.calls[0]!;
    expect(firstCall[1]).toEqual({ body: "Please continue", client_request_id: firstCall[2], agent_instance_id: "instance_mock_coder" });
    expect(sendToAssistant.mock.calls[1]).toEqual(firstCall);
  });

  it("shows waiting reasons and exposes explicit retry and cancel for agent execution", async () => {
    const turn: AssistantTurn = { id: "turn_waiting", room_id: "room_1", task_id: "task_execution", run_id: null, user_message_id: "request", response_message_id: null, status: "waiting", error: "Execution approval is required", created_at: "2026-09-29", updated_at: "2026-09-29" };
    const assistantTurnAction = vi.fn<ApiClient["assistantTurnAction"]>().mockResolvedValue({ turn });
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listAssistantTurns: async () => ({ turns: [turn] }), assistantTurnAction }) });
    expect(await screen.findByText("Execution approval is required")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry agent request" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel agent request" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Cancel agent request" }));
    expect(assistantTurnAction.mock.calls.map(([id, action]) => [id, action])).toEqual([["turn_waiting", "retry"], ["turn_waiting", "cancel"]]);
    expect(screen.getByRole("button", { name: "Open execution task" })).toBeInTheDocument();
  });
  it("preserves earlier pages while catching up incrementally, deduplicating by ID and ordering by server sequence", async () => {
    const one = messageFixture({ id: "z", kind: "text", body: "earlier", sequence: 1, created_at: "2026-09-30T12:00:00Z" });
    const two = messageFixture({ id: "a", kind: "text", body: "latest", sequence: 2, created_at: "2026-09-29T12:00:00Z" });
    const three = messageFixture({ id: "b", kind: "text", body: "arrived", sequence: 3 });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValueOnce({ messages: [two], next_before: "older/cursor", next_after: "newer/cursor", has_more: true })
      .mockResolvedValueOnce({ messages: [one, two], next_before: "first", next_after: "newer/cursor", has_more: false })
      .mockResolvedValueOnce({ messages: [two, three], next_before: "newer/cursor", next_after: "last", has_more: false });
    const query = createTestQueryClient();
    renderWithProviders(<RoomConversation roomId="room_1" taskId="task_1" />, { client: chatApi({ listMessages }), queryClient: query });
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText("earlier")).toBeInTheDocument();
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.messages("room_1") }); });
    expect(await screen.findByText("arrived")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("earlier");
    expect(rows[1]).toHaveTextContent("latest");
    expect(rows[2]).toHaveTextContent("arrived");
    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([{ limit: 50 }, { limit: 50, before: "older/cursor" }, { limit: 50, after: "newer/cursor" }]);
  });

  it("keeps the same send key and text after a lost response and a page reload", async () => {
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockRejectedValueOnce(new ApiClientError("network_error", "Response lost", 0)).mockResolvedValueOnce({ message: messageFixture({ id: "sent", kind: "text", body: "A durable message" }) });
    const client = chatApi({ sendMessage });
    const first = renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    await userEvent.type(await screen.findByLabelText("Message"), "A durable message");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Delivery is unconfirmed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    const originalKey = sendMessage.mock.calls[0]![2];
    first.unmount();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    expect(await screen.findByLabelText("Message")).toHaveValue("A durable message");
    await userEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(sendMessage.mock.calls[1]![2]).toBe(originalKey);
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(await screen.findByText("A durable message")).toBeInTheDocument();
  });

  it("isolates drafts by room, user and server and clears them on sign out", async () => {
    const client = chatApi({ logout: async () => undefined });
    const first = renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    await userEvent.type(await screen.findByLabelText("Message"), "Private draft");
    first.unmount();
    const otherRoom = renderWithProviders(<RoomConversation roomId="room_2" />, { client });
    expect(await screen.findByLabelText("Message")).toHaveValue(""); otherRoom.unmount();
    const otherAccount = renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ bootstrap: async () => bootstrapFixture({ user: { id: "different", email: "other@example.test", display_name: "Other", role: "owner" } }) }) });
    expect(await screen.findByLabelText("Message")).toHaveValue(""); otherAccount.unmount();
    const otherServer = renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ getStorageScope: () => "https://other.example.test/api/v1" }) });
    expect(await screen.findByLabelText("Message")).toHaveValue(""); otherServer.unmount();
    const query = createTestQueryClient(); query.setQueryData(queryKeys.session, { user: { id: "user_1", email: "j@x.com" } });
    const restored = renderWithProviders(<><LogoutButton /><RoomConversation roomId="room_1" projectId="proj_artoo" /></>, { client, queryClient: query });
    expect(await screen.findByLabelText("Message")).toHaveValue("Private draft");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(Object.keys(localStorage).filter((key) => key.startsWith("artoo:room-draft:"))).toEqual([]));
    restored.unmount();
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client });
    expect(await screen.findByLabelText("Message")).toHaveValue("");
  });

  it("does not restore a pending draft when its late failure arrives after logout", async () => {
    let reject!: (error: Error) => void;
    const sendMessage = vi.fn(() => new Promise<{ message: ReturnType<typeof messageFixture> }>((_, fail) => { reject = fail; }));
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ sendMessage }) });
    await userEvent.type(await screen.findByLabelText("Message"), "Pending old account");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await act(async () => { clearRoomDrafts(); reject(new ApiClientError("network_error", "late", 0)); });
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(Object.keys(localStorage).filter((key) => key.startsWith("artoo:room-draft:"))).toEqual([]);
  });

  it("shows friendly bootstrap names for people and agents", async () => {
    renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: chatApi({ listMessages: async () => ({ messages: [messageFixture({ id: "human", kind: "text", body: "Hello" }), messageFixture({ id: "agent", kind: "text", actor_type: "agent", actor_id: "agent_mock_coder", body: "Hi" })] }) }) });
    expect(await screen.findByText("J (you)")).toBeInTheDocument();
    expect(screen.getByText("Mock Coder")).toBeInTheDocument();
  });

  it("makes goal discussions readable and writable with the same room composer", async () => {
    const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: "goal_room", owner_user_id: "user_1", title: "Shared outcome", objective: "Deliver it", priority: "p2", status: "draft", stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: "2026-09-29", updated_at: "2026-09-29" });
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", room_id: "goal_room", body: "Goal update" }) });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockResolvedValue({ messages: [messageFixture({ id: "old", kind: "text", room_id: "goal_room", body: "Goal history" })] });
    renderWithProviders(<GoalsPage />, { client: chatApi({ listGoals: async () => ({ goals: [goal] }), listPlans: async () => ({ plans: [] }), listCheckpoints: async () => ({ checkpoints: [] }), listMessages, sendMessage }) });
    expect(await screen.findByText("Goal history")).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText("Message"), "Goal update");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith("goal_room", expect.objectContaining({ body: "Goal update" }), expect.any(String));
    expect(screen.getByRole("region", { name: "Team collaboration" })).toBeInTheDocument();
  });
});
