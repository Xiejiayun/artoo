// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import type { Channel, Message, Notification, Room } from "@artoo/domain";
import { ApiClient, ApiClientError } from "../api/client.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, messageFixture, renderWithProviders, roomFixture } from "../test/utils.js";
import { queryKeys } from "../app/queryKeys.js";
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
function cachedProjects(projects: ReturnType<typeof bootstrapFixture>["projects"] = [{ id: first.project_id, name: "First project", default_workspace: null }]) {
  const query = createTestQueryClient();
  query.setDefaultOptions({ queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } });
  const snapshot = bootstrapFixture({ projects });
  query.setQueryData(queryKeys.bootstrap, snapshot);
  return { query, snapshot };
}
const lateNotice = () => notice({ room_id: second.id, project_id: second.project_id, channel_id: second.id, room_name: second.name });
const withLateProject = () => bootstrapFixture({ projects: [{ id: first.project_id, name: "First project", default_workspace: null }, { id: second.project_id, name: "Second project", default_workspace: null }] });
function lateProjectApi(bootstrap: ApiClient["bootstrap"], readNotification: ApiClient["readNotification"], overrides: Partial<ApiClient> = {}): ApiClient {
  return api({ bootstrap, readNotification, listNotifications: async () => ({ notifications: [lateNotice()], unread_count: 1 }),
    getMessage: async (roomId, id) => ({ message: { ...(id === root.id ? root : reply), room_id: roomId } }), ...overrides });
}
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

  it("full-reply viewing preserves the failed read, route and draft until an explicit retry", async () => {
    let acknowledged = false;
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockRejectedValueOnce(new ApiClientError("network_error", "Read confirmation unavailable", 0))
      .mockImplementation(async () => { acknowledged = true; return { notification: { ...notice(), read_at: "2026-09-29" }, unread_count: 0 }; });
    const getMessage = vi.fn<ApiClient["getMessage"]>().mockImplementation(async (_, id) => ({ message: id === root.id ? root : reply }));
    const sendMessage = vi.fn<ApiClient["sendMessage"]>();
    renderWithProviders(<><Location /><ChannelsPage /></>, { client: api({ getMessage, readNotification, sendMessage,
      listNotifications: async () => ({ notifications: [{ ...notice(), read_at: acknowledged ? "2026-09-29" : null }], unread_count: acknowledged ? 0 : 1 }),
    }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    await screen.findByRole("button", { name: "Retry marking notification read" });
    const thread = screen.getByRole("complementary", { name: "Thread" });
    await userEvent.type(await within(thread).findByLabelText("Message", { exact: true }), "Do not send this draft");
    const route = screen.getByLabelText("Current route").textContent;
    const lookups = getMessage.mock.calls.length;
    const open = within(thread).getByRole("button", { name: "Read full reply" });
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Mentioned reply" });
    expect(dialog.querySelector(".msg__text")?.textContent).toBe(reply.body);
    expect(readNotification).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(open).toHaveFocus();
    expect(screen.getByLabelText("Current route").textContent).toBe(route);
    expect(within(thread).getByLabelText("Message", { exact: true })).toHaveValue("Do not send this draft");
    expect(getMessage).toHaveBeenCalledTimes(lookups); expect(readNotification).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled(); expect(acknowledged).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Retry marking notification read" }));
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry marking notification read" })).not.toBeInTheDocument());
    expect(within(thread).getByLabelText("Message", { exact: true })).toHaveValue("Do not send this draft");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not consume a notification when its exact message belongs to another thread", async () => {
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<ChannelsPage />, { client: api({ getMessage: async (_, id) => ({ message: id === root.id ? root : { ...reply, thread_root_id: "another_root" } }), readNotification }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByText("The selected message does not belong to this thread.")).toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
  });

  it("retries an unread notification after another notification in the same thread succeeds", async () => {
    const firstNotice = notice();
    const secondNotice = notice({ id: "notification_second", message_id: "reply_second", body_preview: "Second mention in the same thread" });
    const readIds = new Set<string>();
    let firstFailed = false;
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockImplementation(async (id) => {
      if (id === firstNotice.id && !firstFailed) {
        firstFailed = true;
        throw new ApiClientError("network_error", "Temporary read failure", 0);
      }
      readIds.add(id);
      return { notification: { ...(id === firstNotice.id ? firstNotice : secondNotice), read_at: "2026-09-29" }, unread_count: 2 - readIds.size };
    });
    renderWithProviders(<ChannelsPage />, { client: api({
      listNotifications: async () => ({ notifications: [firstNotice, secondNotice].map((item) => ({ ...item, read_at: readIds.has(item.id) ? "2026-09-29" : null })), unread_count: 2 - readIds.size }),
      getMessage: async (_, id) => ({ message: id === root.id ? root : { ...reply, id, body: id === reply.id ? reply.body : "Exact second reply" } }),
      readNotification,
    }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByRole("button", { name: "Retry marking notification read" })).toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: "Thread" });
    await userEvent.type(await within(panel).findByLabelText("Message", { exact: true }), "Keep this thread draft");
    const openMentions = async (): Promise<void> => {
      const summary = screen.getByText(/^@ Mentions ·/);
      if (!(summary.parentElement as HTMLDetailsElement).open) await userEvent.click(summary);
    };
    await openMentions();
    await userEvent.click(screen.getByRole("button", { name: /Second mention in the same thread/ }));
    await waitFor(() => expect(readIds.has(secondNotice.id)).toBe(true));
    expect(readIds.has(firstNotice.id)).toBe(false);
    expect(await within(screen.getByRole("complementary", { name: "Thread" })).findByLabelText("Message", { exact: true })).toHaveValue("Keep this thread draft");
    await openMentions();
    await userEvent.click(screen.getByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByRole("region", { name: "Mentioned reply" })).toHaveTextContent(reply.body!);
    await waitFor(() => expect(readIds.has(firstNotice.id)).toBe(true));
    expect(readNotification.mock.calls.map(([id]) => id)).toEqual([firstNotice.id, secondNotice.id, firstNotice.id]);
    expect(await within(screen.getByRole("complementary", { name: "Thread" })).findByLabelText("Message", { exact: true })).toHaveValue("Keep this thread draft");
  });
});

describe("channel project navigation", () => {
  it("waits for authoritative room metadata and corrects a conflicting project URL before allowing send", async () => {
    let resolveRoom!: (response: { room: Room }) => void;
    const pending = new Promise<{ room: Room }>((resolve) => { resolveRoom = resolve; });
    const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "safe_message", kind: "text", room_id: first.id, body: "Verified project context" }) });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { client: api({ getRoom: async () => pending, sendMessage }), route: `/channels?room=${first.id}&project=${second.project_id}` });
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(first.project_id));
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

  it("refreshes cached projects before exposing a later project's thread or marking its mention read", async () => {
    const { query } = cachedProjects();
    let resolveBootstrap!: (value: ReturnType<typeof bootstrapFixture>) => void;
    const pending = new Promise<ReturnType<typeof bootstrapFixture>>((resolve) => { resolveBootstrap = resolve; });
    const bootstrap = vi.fn<ApiClient["bootstrap"]>().mockReturnValue(pending);
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockImplementation(async () => {
      expect(screen.getByLabelText("Project")).toHaveValue(second.project_id);
      expect(screen.getByRole("region", { name: "Mentioned reply" })).toHaveTextContent(reply.body!);
      return { notification: { ...lateNotice(), read_at: "2026-09-30" }, unread_count: 0 };
    });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(bootstrap, readNotification), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Thread" })).not.toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
    await act(async () => resolveBootstrap(withLateProject()));
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(second.project_id));
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps the destination blocked after project refresh failure until the user retries", async () => {
    const { query } = cachedProjects();
    const bootstrap = vi.fn<ApiClient["bootstrap"]>().mockRejectedValueOnce(new ApiClientError("unknown", "Project access refresh failed", 503)).mockResolvedValueOnce(withLateProject());
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...lateNotice(), read_at: "2026-09-30" }, unread_count: 0 });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(bootstrap, readNotification), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    const retry = await screen.findByRole("button", { name: "Retry opening project" });
    expect(screen.getByText("Project access refresh failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(second.project_id));
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("does not trust a refreshed list that still excludes the destination or repeatedly refresh it", async () => {
    const { query, snapshot } = cachedProjects();
    const bootstrap = vi.fn<ApiClient["bootstrap"]>().mockResolvedValue(snapshot);
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(bootstrap, readNotification), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByText("This notification's project is unavailable. Select an available project to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry opening project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(readNotification).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it.each(["user", "organization"] as const)("does not apply a project refresh from a different %s", async (identity) => {
    const { query, snapshot } = cachedProjects(), refreshed = withLateProject();
    query.setQueryData(queryKeys.members, { members: [] });
    const wrongIdentity = { ...refreshed, [identity]: { ...refreshed[identity], id: "different_identity" } };
    const readNotification = vi.fn<ApiClient["readNotification"]>();
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(async () => wrongIdentity, readNotification), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    expect(await screen.findByText("Your account changed while opening this conversation. Retry opening the project.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    expect(screen.queryByLabelText("Message", { exact: true })).not.toBeInTheDocument();
    expect(query.getQueryData(queryKeys.bootstrap)).toEqual(snapshot);
    expect(query.getQueryState(queryKeys.members)?.isInvalidated).toBe(false);
    expect(readNotification).not.toHaveBeenCalled();
  });

  it("ignores a late project refresh after the user opens another notification", async () => {
    const { query, snapshot } = cachedProjects();
    query.setQueryData(queryKeys.members, { members: [] });
    let resolveBootstrap!: (value: ReturnType<typeof bootstrapFixture>) => void;
    const pending = new Promise<ReturnType<typeof bootstrapFixture>>((resolve) => { resolveBootstrap = resolve; });
    const bootstrap = vi.fn<ApiClient["bootstrap"]>().mockReturnValue(pending), readNotification = vi.fn<ApiClient["readNotification"]>();
    const listMembers = vi.fn<ApiClient["listMembers"]>().mockResolvedValue({ members: [] });
    const back = notice({ id: "already_read_a", body_preview: "Return to project A", read_at: "2026-09-29" });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /><Location /></>, { queryClient: query, client: lateProjectApi(bootstrap, readNotification, {
      listNotifications: async () => ({ notifications: [lateNotice(), back], unread_count: 1 }),
      listMembers,
    }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    const summary = screen.getByText(/^@ Mentions ·/);
    if (!(summary.parentElement as HTMLDetailsElement).open) await userEvent.click(summary);
    await userEvent.click(screen.getByRole("button", { name: "Return to project A" }));
    expect(await screen.findByRole("region", { name: "Mentioned reply" })).toHaveTextContent(reply.body!);
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(1));
    await act(async () => resolveBootstrap(withLateProject()));
    expect(screen.getByLabelText("Project")).toHaveValue(first.project_id);
    expect(screen.getByLabelText("Current route")).toHaveTextContent(`room=${first.id}`);
    expect(query.getQueryData(queryKeys.bootstrap)).toEqual(snapshot);
    expect(query.getQueryState(queryKeys.members)?.isInvalidated).toBe(false);
    expect(listMembers).toHaveBeenCalledTimes(1); // The departed B response must not refresh A again.
    expect(readNotification).not.toHaveBeenCalled();
  });

  it.each([false, true])("refreshes a cached member list after authorized project recovery while tolerating member lookup failure: %s", async (membersFail) => {
    const { query } = cachedProjects();
    query.setQueryData(queryKeys.members, { members: [] });
    const listMembers = vi.fn<ApiClient["listMembers"]>().mockImplementation(async () => {
      if (membersFail) throw new ApiClientError("network_error", "Member lookup unavailable", 0);
      return { members: [{ id: "colleague", display_name: "New project colleague" }] };
    });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...lateNotice(), read_at: "2026-09-30" }, unread_count: 0 });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(async () => withLateProject(), readNotification, {
      listMembers, getMessage: async (roomId, id) => ({ message: { ...(id === root.id ? root : reply), room_id: roomId, actor_id: "colleague", actor_type: "user" } }),
    }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(second.project_id));
    const mentioned = await screen.findByRole("region", { name: "Mentioned reply" });
    expect(await within(mentioned).findByText(membersFail ? "user:colleague" : "New project colleague", { exact: true })).toBeInTheDocument();
    expect(mentioned).toHaveTextContent(reply.body!);
    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
    expect(listMembers).toHaveBeenCalled();
    if (!membersFail) expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("refreshes member names on verified room navigation even when bootstrap already knows the new project", async () => {
    const { query } = cachedProjects(withLateProject().projects);
    query.setQueryData(queryKeys.members, { members: [] });
    const bootstrap = vi.fn<ApiClient["bootstrap"]>();
    const listMembers = vi.fn<ApiClient["listMembers"]>().mockResolvedValue({ members: [{ id: "colleague", display_name: "New project colleague" }] });
    const readNotification = vi.fn<ApiClient["readNotification"]>().mockResolvedValue({ notification: { ...lateNotice(), read_at: "2026-09-30" }, unread_count: 0 });
    renderWithProviders(<><ProjectPicker /><ChannelsPage /></>, { queryClient: query, client: lateProjectApi(bootstrap, readNotification, {
      listMembers, getMessage: async (roomId, id) => ({ message: { ...(id === root.id ? root : reply), room_id: roomId, actor_id: "colleague", actor_type: "user" } }),
    }), route: "/channels?mentions=1" });
    await userEvent.click(await screen.findByRole("button", { name: /Open historical mention/ }));
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(second.project_id));
    const mentioned = await screen.findByRole("region", { name: "Mentioned reply" });
    expect(await within(mentioned).findByText("New project colleague", { exact: true })).toBeInTheDocument();
    expect(mentioned).toHaveTextContent(reply.body!);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(bootstrap).not.toHaveBeenCalled();
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
