// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MessagesResponse } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { createTestQueryClient, fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { MessageSearch } from "./MessageSearch.js";

const message = (id: string, body: string, rest = {}) =>
  messageFixture({ id, kind: "text", body, room_id: "room_1", ...rest });
const page = (items: ReturnType<typeof message>[], more = false, before: string | null = null): MessagesResponse => ({
  messages: items,
  has_more: more,
  next_before: before,
  next_after: null,
});

describe("MessageSearch", () => {
  it("submits explicitly, loads older matches separately from the conversation, and opens reply deep links", async () => {
    const user = userEvent.setup();
    const listMessages = vi.fn(async (_room, options) =>
      options.before
        ? page([message("old", "Needle old"), message("duplicate", "Needle duplicate")])
        : page(
            [
              message("duplicate", "Needle duplicate"),
              message("reply", "Needle reply", { thread_root_id: "root & 1" }),
            ],
            true,
            "cursor",
          ),
    );
    const close = vi.fn();
    const queryClient = createTestQueryClient();
    renderWithProviders(<MessageSearch roomId="room_1" onClose={close} />, {
      client: fakeApi({ listMessages }),
      queryClient,
    });
    queryClient.setQueryData(queryKeys.messages("room_1"), page([message("conversation", "Ordinary conversation")]));
    await user.type(screen.getByLabelText("Search message text"), " Needle ");
    expect(listMessages).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("Needle reply")).toBeInTheDocument();
    expect(listMessages).toHaveBeenLastCalledWith("room_1", { q: "Needle", limit: 50 });
    const link = screen.getByRole("link", { name: "Open reply" });
    const target = new URL(link.getAttribute("href")!, "http://test.local");
    expect(Object.fromEntries(target.searchParams)).toEqual({ room: "room_1", thread: "root & 1", message: "reply" });
    await user.click(screen.getByRole("button", { name: "Load older matches" }));
    expect(await screen.findByText("Needle old")).toBeInTheDocument();
    expect(listMessages).toHaveBeenLastCalledWith("room_1", { q: "Needle", limit: 50, before: "cursor" });
    expect(
      within(screen.getByRole("list", { name: "Search results" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector("p")!.textContent),
    ).toEqual(["Needle reply", "Needle duplicate", "Needle old"]);
    expect(
      queryClient.getQueryData<MessagesResponse>(queryKeys.messages("room_1"))?.messages.map((item) => item.id),
    ).toEqual(["conversation"]);
    await user.click(link);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps a late old-query response out of the selected query and filters confirmed removals", async () => {
    const user = userEvent.setup();
    let finish!: (value: MessagesResponse) => void;
    const old = new Promise<MessagesResponse>((resolve) => {
      finish = resolve;
    });
    const api = fakeApi({
      listMessages: vi.fn(async (_room, options) =>
        options?.q === "first"
          ? old
          : page([message("visible", "Current result"), message("removed", "Private removed content")]),
      ),
    });
    const display = api.messageForDisplay.bind(api);
    api.messageForDisplay = (item) =>
      item.id === "removed" ? { ...item, payload: { moderation: "removed" }, body: "Removed" } : display(item);
    renderWithProviders(<MessageSearch roomId="room_1" onClose={vi.fn()} />, { client: api });
    const input = screen.getByLabelText("Search message text");
    await user.type(input, "first");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(1));
    await user.clear(input);
    await user.type(input, "second");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("Current result")).toBeInTheDocument();
    finish(page([message("stale", "Old query content")]));
    await waitFor(() => expect(screen.queryByText("Old query content")).not.toBeInTheDocument());
    expect(screen.queryByText("Private removed content")).not.toBeInTheDocument();
  });

  it("protects IME Enter, binds thread searches, and surfaces stalled pagination with retry", async () => {
    const user = userEvent.setup();
    const listMessages = vi.fn(async () => page([message("reply", "Reply")], true, null));
    renderWithProviders(<MessageSearch roomId="room_1" threadRootId="root" onClose={vi.fn()} />, {
      client: fakeApi({ listMessages }),
    });
    const input = screen.getByLabelText("Search message text");
    expect(input).toHaveAttribute("maxlength", "200");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文" } });
    fireEvent.submit(input.closest("form")!);
    expect(listMessages).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("Search pagination did not advance. Refresh the search.")).toBeInTheDocument();
    expect(listMessages).toHaveBeenCalledWith("room_1", { q: "中文", limit: 50, thread_root_id: "root" });
    listMessages.mockResolvedValueOnce(page([]));
    await user.click(screen.getByRole("button", { name: "Retry search" }));
    expect(await screen.findByText("No matching messages.")).toBeInTheDocument();
  });
});
