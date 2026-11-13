// @vitest-environment jsdom
import { StrictMode, useSyncExternalStore } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client.js";
import { fakeApi } from "../test/utils.js";
import { ApiProvider, useCommands } from "./ApiContext.js";

function Probe({ send, settled }: { send(): Promise<string>; settled(value: unknown): void }) {
  const commands = useCommands();
  const pending = useSyncExternalStore(commands.subscribe, commands.pendingCount);
  return <><output aria-label="Pending commands">{pending}</output><button onClick={() => {
    void commands.submit(send, { key: "stable-provider-action" }).then(settled, settled);
  }}>Send command</button></>;
}

describe("API provider reconnect ownership", () => {
  it.each([false, true])("replays on online and removes its listener at unmount (StrictMode=%s)", async (strict) => {
    let available = false;
    const send = vi.fn(async () => {
      if (!available) throw new ApiClientError("network_error", "offline", 0);
      return "applied";
    });
    const settled = vi.fn();
    const surface = <ApiProvider client={fakeApi({})}><Probe send={send} settled={settled} /></ApiProvider>;
    const { unmount } = render(strict ? <StrictMode>{surface}</StrictMode> : surface);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send command" })); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Pending commands")).toHaveTextContent("1");
    available = true;
    await act(async () => { fireEvent(window, new Event("online")); });
    await waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith("applied"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Pending commands")).toHaveTextContent("0");

    available = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send command" })); });
    expect(send).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Pending commands")).toHaveTextContent("1");
    unmount();
    available = true;
    await act(async () => { fireEvent(window, new Event("online")); });
    expect(send).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining("Session ended") }));
  });
});
