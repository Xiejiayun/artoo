// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Notification } from "@artoo/domain";
import { ApiClient, ApiClientError } from "../api/client.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, messageFixture, renderWithProviders, roomFixture } from "../test/utils.js";
import { ChannelsPage } from "./ChannelsPage.js";
import { DaemonBadge } from "./DaemonBadge.js";
import { queryKeys } from "../app/queryKeys.js";

const channel: Channel = { id: "channel_1", project_id: "proj_artoo", name: "engineering", description: "Coordinate implementation", created_at: "2026-09-29" };
function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeApi({ bootstrap: async () => bootstrapFixture(), listChannels: async () => ({ channels: [channel] }), getRoom: async (id) => ({ room: roomFixture({ id, project_id: channel.project_id, type: "project", name: channel.name }) }), listMembers: async () => ({ members: [{ id: "colleague", display_name: "Jane" }] }), listNotifications: async () => ({ notifications: [] }), listAssistantTurns: async () => ({ turns: [] }), listMessages: async () => ({ messages: [] }), ...overrides });
}
afterEach(() => localStorage.clear());

describe("channel collaboration", () => {
  it("allows only team replies when a deep-linked thread belongs to an agent planning discussion", async () => {
    const root = messageFixture({ id: "planning_root", room_id: channel.id, kind: "text", body: "Planning discussion", payload: { discussion_id: "discussion_1" } });
    renderWithProviders(<ChannelsPage />, { client: api({ getMessage: async () => ({ message: root }) }), route: `/channels?room=${channel.id}&thread=${root.id}` });
    const panel = await screen.findByRole("complementary", { name: "Thread" });
    expect(await within(panel).findByLabelText("Message")).toBeEnabled();
    expect(within(panel).queryByLabelText("Message destination")).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("creates an independent channel and opens its shared conversation", async () => {
    const channels: Channel[] = [];
    const createChannel = vi.fn<ApiClient["createChannel"]>().mockImplementation(async (body) => { const created = { ...channel, name: body.name }; channels.push(created); return { channel: created }; });
    renderWithProviders(<ChannelsPage />, { client: api({ listChannels: async () => ({ channels: [...channels] }), createChannel }) });
    await userEvent.click(await screen.findByRole("button", { name: "New channel" }));
    await userEvent.type(screen.getByLabelText("Channel name"), "design");
    await userEvent.type(screen.getByLabelText("Channel description"), "Product ideas");
    await userEvent.click(screen.getByRole("button", { name: "Create channel" }));
    expect(await screen.findByRole("heading", { name: "# design" })).toBeInTheDocument();
    expect(createChannel).toHaveBeenCalledWith({ project_id: "proj_artoo", name: "design", description: "Product ideas" }, expect.any(String));
    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  });

  it("keeps root and thread drafts separate and submits real user mentions on replies", async () => {
    const root = messageFixture({ id: "root_1", room_id: channel.id, kind: "text", body: "Review this design", reply_count: 1 });
    const reply = messageFixture({ id: "reply_1", room_id: channel.id, kind: "text", body: "Existing reply", thread_root_id: root.id });
    const sent = messageFixture({ id: "reply_2", room_id: channel.id, kind: "text", body: "Please check", thread_root_id: root.id, payload: { mentions: [{ actor_type: "user", actor_id: "colleague" }] } });
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: sent });
    const listMessages = vi.fn<ApiClient["listMessages"]>().mockImplementation(async (_, options) => ({ messages: options?.thread_root_id ? [reply] : [root] }));
    renderWithProviders(<ChannelsPage />, { client: api({ listMessages, sendMessage, getMessage: async () => ({ message: root }) }) });
    await userEvent.type(await screen.findByLabelText("Message"), "Root draft");
    await userEvent.click(screen.getByRole("button", { name: "1 replies" }));
    const panel = await screen.findByRole("complementary", { name: "Thread" });
    await within(panel).findByText("Existing reply");
    expect(within(panel).getByLabelText("Message")).toHaveValue("");
    await userEvent.type(within(panel).getByLabelText("Message"), "Please check");
    await userEvent.click(within(panel).getByText("@ Notify people"));
    await userEvent.click(within(panel).getByLabelText("@Jane"));
    await userEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    expect(await within(panel).findByText("Message sent.")).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith(channel.id, expect.objectContaining({ body: "Please check", thread_root_id: root.id, mentions: [{ actor_type: "user", actor_id: "colleague" }], client_request_id: expect.any(String) }), expect.any(String));
    expect(within(panel).getByLabelText("Mentioned people")).toHaveTextContent("@Jane");
    await userEvent.click(within(panel).getByRole("button", { name: "Close thread" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Root draft");
  });

  it("opens a mentioned historical thread directly and marks only that notification read", async () => {
    const notification: Notification = { id: "notification_1", room_id: channel.id, message_id: "reply_old", thread_root_id: "root_old", actor_id: "colleague", body_preview: "Your review is needed", read_at: null, created_at: "2026-09-29", project_id: channel.project_id, room_type: "project", room_name: channel.name, channel_id: channel.id, task_id: null, goal_id: null };
    const getMessage = vi.fn<ApiClient["getMessage"]>().mockImplementation(async (_, id) => ({ message: messageFixture({ id, kind: "text", body: id === "root_old" ? "Archived conversation" : "Exact historical mention", room_id: channel.id, thread_root_id: id === "root_old" ? null : "root_old" }) }));
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...notification, read_at: "2026-09-29" } });
    renderWithProviders(<ChannelsPage />, { client: api({ listNotifications: async () => ({ notifications: [notification] }), getMessage, readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Your review is needed/ }));
    expect(await screen.findByText("Archived conversation")).toBeInTheDocument();
    expect(await screen.findByText("Exact historical mention")).toBeInTheDocument();
    expect(getMessage).toHaveBeenCalledWith(channel.id, "root_old");
    expect(getMessage).toHaveBeenCalledWith(channel.id, "reply_old");
    await waitFor(() => expect(readNotification).toHaveBeenCalledWith(notification.id, expect.any(String)));
  });
});

describe("execution daemon presence", () => {
  it("replaces cached online status with unknown when the control server cannot be reached", async () => {
    const listDaemons = vi.fn<ApiClient["listDaemons"]>().mockResolvedValueOnce({ daemons: [{ computer_id: "computer_1", display_name: "Worker", status: "online", connected: true, last_heartbeat_at: "2026-09-29T00:00:00Z", heartbeat_age_ms: 2000, active_runs: 2, runtimes: [] }] }).mockRejectedValue(new ApiClientError("network_error", "server unreachable", 0));
    const query = createTestQueryClient();
    renderWithProviders(<DaemonBadge computerId="computer_1" />, { client: api({ listDaemons }), queryClient: query });
    expect(await screen.findByText("Daemon: online")).toBeInTheDocument();
    expect(screen.getByText(/2 active runs/)).toBeInTheDocument();
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.daemons }); });
    expect(await screen.findByText("Daemon: unknown")).toBeInTheDocument();
    expect(screen.queryByText("Daemon: offline")).not.toBeInTheDocument();
    expect(screen.queryByText("Daemon: online")).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be verified/)).toBeInTheDocument();
  });
});
