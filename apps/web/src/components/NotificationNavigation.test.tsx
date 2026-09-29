// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import type { Channel, Message, Notification, Room } from "@artoo/domain";
import { ApiClient, ApiClientError } from "../api/client.js";
import { bootstrapFixture, fakeApi, messageFixture, renderWithProviders, roomFixture } from "../test/utils.js";
import { ChannelsPage } from "./ChannelsPage.js";
import { NotificationsButton, NotificationsPanel } from "./NotificationsPanel.js";
import { ProjectPicker } from "./ProjectPicker.js";

const first: Channel = { id: "channel_1", project_id: "proj_artoo", name: "engineering", description: "First project", created_at: "2026-09-29" };
const second: Channel = { ...first, id: "channel_2", project_id: "proj_second", name: "release" };
const root = messageFixture({ id: "root_old", room_id: first.id, kind: "text", body: "Historical discussion" });
const reply = messageFixture({ id: "reply_old", room_id: first.id, kind: "text", thread_root_id: root.id, body: "Exact old reply outside the latest page" });
function notice(overrides: Partial<Notification> = {}): Notification {
  return { id: "notification_old", room_id: first.id, message_id: reply.id, thread_root_id: root.id, actor_id: "colleague", body_preview: "Open historical mention", read_at: null, created_at: "2026-09-29", project_id: first.project_id, room_type: "project", room_name: first.name, channel_id: first.id, task_id: null, goal_id: null, ...overrides };
}
function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeApi({ bootstrap: async () => bootstrapFixture({ projects: [{ id: first.project_id, name: "First project", default_workspace: null }, { id: second.project_id, name: "Second project", default_workspace: null }] }), listChannels: async (project) => ({ channels: project === second.project_id ? [second] : [first] }), getRoom: async (id) => ({ room: roomFixture({ id, project_id: id === second.id ? second.project_id : first.project_id, type: "project", name: id === second.id ? second.name : first.name }) }), listMembers: async () => ({ members: [] }), listNotifications: async () => ({ notifications: [notice()], unread_count: 1, has_more: false, next_before: null }), listAssistantTurns: async () => ({ turns: [] }), listMessages: async () => ({ messages: [] }), getMessage: async (_, id) => ({ message: id === root.id ? root : reply }), ...overrides });
}
function Location(): React.ReactNode { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
afterEach(() => localStorage.clear());

describe("notification history", () => {
  it("uses the global unread count and keeps all loaded pages when the unread notification is older than 100 entries", async () => {
    const listNotifications = vi.fn<ApiClient["listNotifications"]>().mockImplementation(async (options) => {
      const page = options?.before === "second/+= ?&" ? 1 : options?.before === "third/+= ?&" ? 2 : 0;
      return { notifications: page < 2 ? Array.from({ length: 50 }, (_, index) => notice({ id: `read_${page * 50 + index}`, body_preview: `Read mention ${page * 50 + index}`, read_at: "2026-09-29" })) : [notice()], unread_count: 1, has_more: page < 2, next_before: ["second/+= ?&", "third/+= ?&", null][page] };
    });
    const onOpen = vi.fn();
    renderWithProviders(<><NotificationsButton /><NotificationsPanel onOpen={onOpen} /></>, { client: api({ listNotifications }), route: "/channels?mentions=1" });
    expect(await screen.findByRole("button", { name: "Mentions, 1 unread" })).toBeInTheDocument();
    expect(screen.queryByText("Open historical mention")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load earlier notifications" }));
    expect(await screen.findByText("Read mention 99")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load earlier notifications" }));
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(onOpen).toHaveBeenCalledWith(notice());
    expect(screen.getByText("Read mention 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mentions, 1 unread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load earlier notifications" })).not.toBeInTheDocument();
    expect(listNotifications.mock.calls.map(([options]) => options)).toEqual([{ limit: 50 }, { limit: 50, before: "second/+= ?&" }, { limit: 50, before: "third/+= ?&" }]);
  });

  it("waits for the exact historical reply to render before marking the notification read", async () => {
    let resolveReply!: (response: { message: Message }) => void;
    const pending = new Promise<{ message: Message }>((resolve) => { resolveReply = resolve; });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockImplementation(async () => {
      expect(screen.getByRole("region", { name: "Mentioned reply" })).toHaveTextContent(reply.body!);
      return { notification: { ...notice(), read_at: "2026-09-29" }, unread_count: 0 };
    });
    renderWithProviders(<ChannelsPage />, { client: api({ getMessage: async (_, id) => id === root.id ? { message: root } : pending, readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByText("Opening the mentioned conversation…")).toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
    await act(async () => resolveReply({ message: reply }));
    expect(await screen.findByText(reply.body!)).toBeInTheDocument();
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
  });

  it("leaves a failed message unread and supports retrying its exact lookup", async () => {
    let fail = true;
    const getMessage = vi.fn<ApiClient["getMessage"]>().mockImplementation(async (_, id) => {
      if (id === reply.id && fail) throw new ApiClientError("not_found", "Mentioned message could not be loaded", 404);
      return { message: id === root.id ? root : reply };
    });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...notice(), read_at: "2026-09-29" }, unread_count: 0 });
    renderWithProviders(<ChannelsPage />, { client: api({ getMessage, readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    const retry = await screen.findByRole("button", { name: "Retry opening message" });
    expect(readNotification).not.toHaveBeenCalled();
    expect(screen.queryByText(reply.body!)).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByText(reply.body!)).toBeInTheDocument();
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
    expect(getMessage.mock.calls.filter(([, id]) => id === reply.id)).toHaveLength(2);
  });

  it("does not consume a notification when its exact message belongs to another thread", async () => {
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<ChannelsPage />, { client: api({ getMessage: async (_, id) => ({ message: id === root.id ? root : { ...reply, thread_root_id: "another_root" } }), readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByText("The selected message does not belong to this thread.")).toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
  });
});

describe("channel project navigation", () => {
  it("waits for authoritative room metadata and corrects a conflicting project URL before allowing send", async () => {
    let resolveRoom!: (response: { room: Room }) => void;
    const pending = new Promise<{ room: Room }>((resolve) => { resolveRoom = resolve; });
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "safe_message", kind: "text", room_id: first.id, body: "Verified project context" }) });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { client: api({ getRoom: async () => pending, sendMessage }), route: `/channels?room=${first.id}&project=${second.project_id}` });
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(second.project_id));
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    await act(async () => resolveRoom({ room: roomFixture({ id: first.id, project_id: first.project_id, type: "project", name: first.name }) }));
    expect(await screen.findByRole("heading", { name: "# engineering" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    await userEvent.type(await screen.findByLabelText("Message", { exact: true }), "Verified project context");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(first.id, expect.objectContaining({ body: "Verified project context" }), expect.any(String)));
  });

  it("resolves a legacy room-only link into its real project", async () => {
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { client: api(), route: `/channels?room=${second.id}` });
    expect(await screen.findByRole("heading", { name: "# release" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(second.project_id);
  });

  it("does not allow sending or mark a notification read when room context lookup fails", async () => {
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<ChannelsPage />, { client: api({ getRoom: async () => { throw new ApiClientError("not_found", "Room unavailable", 404); }, readNotification }), route: `/channels?room=${first.id}&thread=${root.id}&message=${reply.id}&notification=notification_old&project=${first.project_id}` });
    expect(await screen.findByRole("button", { name: "Retry opening conversation" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
  });

  it.each(["task", "goal"] as const)("opens %s room notifications using verified context even though they are not channels", async (type) => {
    const roomId = `${type}_room`;
    const notification = notice({ room_id: roomId, project_id: second.project_id, room_type: type, room_name: `${type} discussion`, channel_id: null, task_id: type === "task" ? "task_1" : null, goal_id: type === "goal" ? "goal_1" : null });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...notification, read_at: "2026-09-29" }, unread_count: 0 });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { client: api({ listNotifications: async () => ({ notifications: [notification], unread_count: 1 }), getRoom: async () => ({ room: roomFixture({ id: roomId, type, project_id: second.project_id, name: `${type} discussion` }) }), getMessage: async (_, id) => ({ message: { ...(id === root.id ? root : reply), room_id: roomId } }), readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByRole("heading", { name: `${type} discussion` })).toBeInTheDocument();
    expect(await screen.findByText(reply.body!)).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(second.project_id);
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
  });

  it("clears the old conversation when changing project and sends only to the new channel", async () => {
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "new_message", kind: "text", room_id: second.id, body: "Second project only" }) });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /><Location /></>, { client: api({ sendMessage }), route: `/channels?room=${first.id}&thread=${root.id}&project=${first.project_id}&mentions=1` });
    expect(await screen.findByRole("complementary", { name: "Thread" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Project"), second.project_id);
    expect(await screen.findByRole("heading", { name: "# release" })).toBeInTheDocument();
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/channels?mentions=1");
    expect(screen.queryByRole("complementary", { name: "Thread" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Message", { exact: true }), "Second project only");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(second.id, expect.objectContaining({ body: "Second project only" }), expect.any(String)));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("selects a cross-project notification's project before displaying the exact reply", async () => {
    const cross = notice({ room_id: second.id, project_id: second.project_id, channel_id: second.id, room_name: second.name });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockImplementation(async () => {
      expect(screen.getByLabelText("Project")).toHaveValue(second.project_id);
      expect(screen.getByRole("region", { name: "Mentioned reply" })).toHaveTextContent(reply.body!);
      return { notification: { ...cross, read_at: "2026-09-29" }, unread_count: 0 };
    });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { client: api({ listNotifications: async () => ({ notifications: [cross], unread_count: 1 }), getMessage: async (_, id) => ({ message: { ...(id === root.id ? root : reply), room_id: second.id } }), readNotification }), route: "/channels?mentions=1" });
    expect(await screen.findByLabelText("Project")).toHaveValue(first.project_id);
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    expect(await within(thread).findByText(reply.body!)).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(second.project_id);
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
  });

  it("does not display a composer or mark read when the notification project is unavailable", async () => {
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<ChannelsPage />, { client: api({ getRoom: async (id) => ({ room: roomFixture({ id, project_id: "missing_project" }) }), readNotification }), route: `/channels?room=${first.id}&thread=${root.id}&message=${reply.id}&notification=notification_old&project=missing_project` });
    expect(await screen.findByText("This notification's project is unavailable. Select an available project to continue.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
  });
});
