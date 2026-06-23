// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { desktopConfig } from "./App.js";

describe("desktopConfig", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "artooDesktop");
  });

  it("returns undefined outside the desktop bridge", () => {
    expect(desktopConfig()).toBeUndefined();
  });

  it("resolves absolute API and websocket URLs from the desktop bridge", () => {
    Object.defineProperty(window, "artooDesktop", {
      configurable: true,
      value: {
        serverUrl: "http://127.0.0.1:47831/",
        platform: "win32",
        electronVersion: "33.4.11",
      },
    });

    expect(desktopConfig()).toEqual({
      apiBaseUrl: "http://127.0.0.1:47831/api/v1",
      wsUrl: "ws://127.0.0.1:47831/api/v1/ws",
    });
  });

  it("maps https server URLs to secure websocket URLs", () => {
    Object.defineProperty(window, "artooDesktop", {
      configurable: true,
      value: {
        serverUrl: "https://artoo.example.test",
        platform: "win32",
        electronVersion: "33.4.11",
      },
    });

    expect(desktopConfig()?.wsUrl).toBe("wss://artoo.example.test/api/v1/ws");
  });
});
