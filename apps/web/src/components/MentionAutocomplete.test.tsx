// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Member } from "@artoo/domain";
import { ApiClientError, type ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { RoomConversation } from "./RoomConversation.js";

const people: Member[] = [{ id: "alice", display_name: "Alice" }, { id: "anna", display_name: "Anna" }, { id: "chinese", display_name: "安娜" }];
function render(overrides: Partial<ApiClient> = {}) {
  return renderWithProviders(<RoomConversation roomId="room_1" projectId="proj_artoo" />, { client: fakeApi({
    bootstrap: async () => bootstrapFixture(), listMessages: async () => ({ messages: [] }), listAssistantTurns: async () => ({ turns: [] }),
    listMembers: async () => ({ members: people }), listChannels: async () => ({ channels: [] }), ...overrides,
  }) });
}
afterEach(() => localStorage.clear());

it("chooses a member with arrows and Enter without sending, synchronizes fallback selection, and sends the real recipient", async () => {
  const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "@Anna" }) });
  render({ sendMessage });
  const input = await screen.findByLabelText("Message");
  await userEvent.type(input, "@a");
  const list = await screen.findByRole("listbox", { name: "People to mention" });
  expect(screen.getByText("↑/↓ to choose · Enter to mention · Esc to close")).toBeInTheDocument();
  expect(within(list).getAllByRole("option")).toHaveLength(2);
  await userEvent.keyboard("{ArrowDown}");
  expect(within(list).getByRole("option", { name: "@Anna" })).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", within(list).getByRole("option", { name: "@Anna" }).id);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(input).toHaveValue("@Anna "));
  expect(input).toHaveFocus();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByText("Enter to send · Shift + Enter for a new line")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Notify people (1)"));
  expect(screen.getByRole("checkbox", { name: "@Anna" })).toBeChecked();
  await userEvent.click(input);
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Message sent.");
  expect(sendMessage).toHaveBeenCalledWith("room_1", expect.objectContaining({ body: "@Anna", mentions: [{ actor_type: "user", actor_id: "anna" }] }), expect.any(String));
});

it("does not infer recipients from emails or unmatched text, and Escape dismisses without sending", async () => {
  const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "@a" }) });
  render({ sendMessage });
  const input = await screen.findByLabelText("Message");
  await userEvent.type(input, "a@example.com");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.clear(input);
  await userEvent.type(input, "@unmatched");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.clear(input);
  await userEvent.type(input, "@a");
  await screen.findByRole("listbox");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).toHaveValue("@a");
  expect(sendMessage).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Message sent.");
  expect(sendMessage).toHaveBeenCalledWith("room_1", expect.objectContaining({ body: "@a", mentions: [] }), expect.any(String));
});

it("preserves text and punctuation when picking at the caret, deduplicates recipients, and restores them with the draft", async () => {
  const first = render();
  const input = await screen.findByLabelText("Message") as HTMLTextAreaElement;
  await userEvent.type(input, "Before @al, after");
  input.setSelectionRange(10, 10); fireEvent.select(input);
  await userEvent.click(await screen.findByRole("option", { name: "@Alice" }));
  await waitFor(() => expect(input).toHaveValue("Before @Alice, after"));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  input.setSelectionRange(input.value.length, input.value.length); fireEvent.select(input);
  await userEvent.type(input, " @al");
  await userEvent.click(await screen.findByRole("option", { name: "@Alice" }));
  expect(screen.getByText("Notify people (1)")).toBeInTheDocument();
  first.unmount();
  render();
  expect(await screen.findByLabelText("Message")).toHaveValue("Before @Alice, after @Alice ");
  await userEvent.click(screen.getByText("Notify people (1)"));
  expect(screen.getByRole("checkbox", { name: "@Alice" })).toBeChecked();
});

it("keeps IME commitment and held Enter inert and preserves Shift+Enter newline behavior", async () => {
  const sendMessage = vi.fn<ApiClient["sendMessage"]>();
  render({ sendMessage });
  const input = await screen.findByLabelText("Message");
  await userEvent.type(input, "@安");
  await screen.findByRole("option", { name: "@安娜" });
  fireEvent.compositionStart(input);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(input).toHaveValue("@安");
  expect(sendMessage).not.toHaveBeenCalled();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(input).toHaveValue("@安\n");
  expect(sendMessage).not.toHaveBeenCalled();
});

it("keeps same-name members distinguishable and hides suggestions for agent execution", async () => {
  render({ listMembers: async () => ({ members: [{ id: "one", display_name: "Same" }, { id: "two", display_name: "Same" }] }) });
  const input = await screen.findByLabelText("Message");
  await userEvent.type(input, "@Same");
  expect(await screen.findByRole("option", { name: "@Same one" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "@Same two" })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("Message destination"), "assistant");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.click(input);
  await userEvent.type(input, " @Same");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("keeps recipients and the same request identity when an uncertain send is restored and retried", async () => {
  const sendMessage = vi.fn<ApiClient["sendMessage"]>().mockRejectedValueOnce(new ApiClientError("network_error", "Connection lost", 0))
    .mockResolvedValue({ message: messageFixture({ id: "sent", kind: "text", body: "@Alice" }) });
  const first = render({ sendMessage });
  await userEvent.type(await screen.findByLabelText("Message"), "@al");
  await userEvent.click(await screen.findByRole("option", { name: "@Alice" }));
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Retry sending message" });
  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  first.unmount();
  render({ sendMessage });
  await userEvent.click(await screen.findByRole("button", { name: "Retry sending message" }));
  await screen.findByText("Message sent.");
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ body: "@Alice", mentions: [{ actor_type: "user", actor_id: "alice" }] });
  expect(sendMessage.mock.calls[1]).toEqual(sendMessage.mock.calls[0]);
});

it("preserves the original message when expanding a mention would exceed its length limit", async () => {
  render();
  const input = await screen.findByLabelText("Message") as HTMLTextAreaElement;
  const body = "X".repeat(19996) + " @a";
  fireEvent.change(input, { target: { value: body } });
  input.setSelectionRange(body.length, body.length); fireEvent.select(input);
  await userEvent.click(await screen.findByRole("option", { name: "@Alice" }));
  expect(input).toHaveValue(body);
  expect(await screen.findByRole("alert")).toHaveTextContent("message length limit");
  expect(screen.queryByText("Notify people (1)")).not.toBeInTheDocument();
});
