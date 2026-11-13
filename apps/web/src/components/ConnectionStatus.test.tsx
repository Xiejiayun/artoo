// @vitest-environment jsdom
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client.js";
import { useCommands } from "../app/ApiContext.js";
import { RealtimeProvider } from "../app/RealtimeContext.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import type { WebSocketLike } from "../ws/realtimeClient.js";
import { ConnectionStatusBanner, ConnectionStatusIndicator, useConnectionStatus } from "./ConnectionStatus.js";
import { ProductHeader } from "./ProductHeader.js";

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
}

function Shell({ send, settled }: { send?: () => Promise<string>; settled?: (value: unknown) => void }) {
  const state = useConnectionStatus();
  const commands = useCommands();
  return <>
    <ProductHeader onToggleMenu={() => undefined} menuOpen={false} detailsOpen={false} onToggleDetails={() => undefined}
      connectionIndicator={<ConnectionStatusIndicator state={state} />} />
    <ConnectionStatusBanner state={state} />
    {send && <button onClick={() => { void commands.submit(send, { key: "stable-connection-action" }).then(settled, settled); }}>Queue action</button>}
  </>;
}

function mount(options: { send?: () => Promise<string>; settled?: (value: unknown) => void } = {}) {
  const socket = new Socket();
  const result = renderWithProviders(<RealtimeProvider socketFactory={() => socket} reconnectDelayMs={0}>
    <Shell {...options} />
  </RealtimeProvider>, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listNotifications: async () => ({ notifications: [], unread_count: 0, has_more: false, next_before: null }) }) });
  return { socket, ...result };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("connection presentation and queue lifecycle", () => {
  it("moves only the healthy state into the header and restores the banner on offline or reconnect", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const { socket } = mount();
    expect(screen.getByRole("status", { name: "Connection status" })).toHaveTextContent("Reconnecting live updates");
    await act(async () => { socket.open(); });
    const header = within(screen.getByRole("banner"));
    const indicator = header.getByRole("status", { name: "Live updates connected" });
    expect(screen.queryByRole("status", { name: "Connection status" })).not.toBeInTheDocument();
    indicator.focus();
    expect(indicator).toHaveFocus();
    expect(indicator.parentElement).toHaveAttribute("data-tip", "Live updates connected");

    online.mockReturnValue(false);
    fireEvent(window, new Event("offline"));
    expect(screen.getByRole("status", { name: "Connection status" })).toHaveTextContent("Offline");
    expect(header.queryByRole("status")).not.toBeInTheDocument();
    online.mockReturnValue(true);
    fireEvent(window, new Event("online"));
    expect(header.getByRole("status", { name: "Live updates connected" })).toBeInTheDocument();
    await act(async () => { socket.onclose?.({ code: 1006, reason: "transport closed" }); });
    expect(screen.getByRole("status", { name: "Connection status" })).toHaveTextContent("Reconnecting live updates");
  });

  it("keeps authentication failure visible", async () => {
    const { socket } = mount();
    await act(async () => { socket.open(); socket.onclose?.({ code: 1008, reason: "unauthenticated" }); });
    expect(screen.getByRole("status", { name: "Connection status" })).toHaveTextContent("Sign in to reconnect");
    expect(screen.queryByLabelText("Live updates connected")).not.toBeInTheDocument();
  });

  it("keeps pending commands visible while connected, protects unload, and replays the same command on retry", async () => {
    let available = false;
    const send = vi.fn(async () => {
      if (!available) throw new ApiClientError("network_error", "temporary connection failure", 0);
      return "applied";
    });
    const settled = vi.fn();
    const { socket, unmount } = mount({ send, settled });
    await act(async () => { socket.open(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Queue action" })); });
    expect(send).toHaveBeenCalledTimes(1);
    const banner = screen.getByRole("status", { name: "Connection status" });
    expect(banner).toHaveTextContent("1 pending command. Keep this window open until sent.");
    expect(screen.queryByLabelText("Live updates connected")).not.toBeInTheDocument();
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    available = true;
    await act(async () => { fireEvent.click(within(banner).getByRole("button", { name: "Retry pending" })); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledExactlyOnceWith("applied");
    expect(screen.queryByRole("status", { name: "Connection status" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Live updates connected" })).toBeInTheDocument();
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    unmount();
    const removedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(removedUnload);
    expect(removedUnload.defaultPrevented).toBe(false);
  });
});
