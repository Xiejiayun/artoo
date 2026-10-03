import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const desktop = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(desktop, "main.cjs"), "utf8");
const preloadSource = readFileSync(join(desktop, "preload.cjs"), "utf8");

async function clipboardBridge() {
  type Handler = (event: any, input?: unknown) => unknown;
  const handles = new Map<string, Handler>(), listeners = new Map<string, Handler>();
  const clipboard = { writeText: vi.fn() };
  const permissionRequest = vi.fn(), permissionCheck = vi.fn();
  let ready!: Promise<void>;
  let window!: MockWindow;
  class MockWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "" }, setWindowOpenHandler: vi.fn(),
    });
    constructor() { super(); window = this; }
    loadFile(value: string) { this.webContents.mainFrame.url = pathToFileURL(value).href; }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => true,
    getPath: () => "/fixture/user-data", getVersion: () => "test", quit: vi.fn(),
    whenReady: () => ({ then(callback: () => Promise<void>) { ready = Promise.resolve().then(callback); return ready; } }),
  });
  const electron = {
    app, BrowserWindow: MockWindow, clipboard, safeStorage: {}, shell: {},
    dialog: { showErrorBox: vi.fn() },
    ipcMain: { handle: (name: string, handler: Handler) => handles.set(name, handler), on: (name: string, handler: Handler) => listeners.set(name, handler) },
    session: { defaultSession: {
      setPermissionRequestHandler: permissionRequest, setPermissionCheckHandler: permissionCheck,
      webRequest: { onHeadersReceived: vi.fn() },
    } },
  };
  const connection = { serverUrl: "https://server.example" };
  const controller = { initialize: async () => {}, getConnection: () => connection };
  const host = { env: {}, platform: process.platform, execPath: "/fixture/Electron", resourcesPath: "/fixture/resources", versions: { electron: "test" } };
  runInNewContext(mainSource, {
    require: (name: string) => name === "electron" ? electron : name === "./desktop-controller.cjs" ? { createDesktopController: () => controller } : require(name),
    __dirname: desktop, process: host, URL, Buffer,
  }, { filename: "main.cjs" });
  await ready;
  expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
  let sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const invoke = vi.fn((channel: string, value: unknown) => Promise.resolve().then(() => handles.get(channel)!(sender, value)));
  let bridge!: { writeClipboardText: (value: unknown) => Promise<void> };
  runInNewContext(preloadSource, {
    process: host,
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        ipcRenderer: { invoke, sendSync(channel: string) { const event = { ...sender, returnValue: undefined }; listeners.get(channel)!(event); return event.returnValue; } },
        contextBridge: { exposeInMainWorld(name: string, value: typeof bridge) { expect(name).toBe("artooDesktop"); bridge = value; } },
      };
    },
  }, { filename: "preload.cjs" });
  return { bridge, clipboard, invoke, window, handles, permissionRequest, permissionCheck,
    setSender(value: typeof sender) { sender = value; } };
}

describe("desktop clipboard write bridge", () => {
  it("forwards trusted calls through the preload and preserves exact Unicode and whitespace", async () => {
    const f = await clipboardBridge();
    const value = " \t/工作区/e\u0301/😀\r\nbranch name\n ";
    await expect(f.bridge.writeClipboardText(value)).resolves.toBeUndefined();
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith("artoo:writeClipboardText", value);
    expect(f.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(value);
    expect(Buffer.from(f.clipboard.writeText.mock.calls[0]![0], "utf8")).toEqual(Buffer.from(value, "utf8"));
  });

  it.each(["", "x".repeat(65_536), "界".repeat(21_845) + "x"])("accepts empty text and the exact UTF-8 byte limit", async (value) => {
    const f = await clipboardBridge();
    await expect(f.bridge.writeClipboardText(value)).resolves.toBeUndefined();
    expect(f.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(value);
  });

  it.each([undefined, null, 1, true, {}, [], new String("text"), "x".repeat(65_537), "界".repeat(21_846)].map((value) => ({ value })))("rejects invalid or over-limit input before writing", async ({ value }) => {
    const f = await clipboardBridge();
    await expect(f.bridge.writeClipboardText(value)).rejects.toThrow("Clipboard text must be a string of at most 64 KiB");
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each(["other contents", "child frame", "remote URL", "closed window"])("rejects an untrusted %s without writing", async (kind) => {
    const f = await clipboardBridge();
    const frame = f.window.webContents.mainFrame;
    if (kind === "other contents") f.setSender({ sender: {} as typeof f.window.webContents, senderFrame: frame });
    if (kind === "child frame") f.setSender({ sender: f.window.webContents, senderFrame: { url: frame.url } });
    if (kind === "remote URL") frame.url = "https://untrusted.example";
    if (kind === "closed window") f.window.emit("closed");
    await expect(f.bridge.writeClipboardText("must not be copied")).rejects.toThrow("Untrusted desktop request");
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("propagates native write failure and exposes no clipboard read or permission grant", async () => {
    const f = await clipboardBridge();
    f.clipboard.writeText.mockImplementation(() => { throw new Error("Clipboard unavailable"); });
    await expect(f.bridge.writeClipboardText("text")).rejects.toThrow("Clipboard unavailable");
    expect(Object.keys(f.bridge).filter((key) => /clipboard/i.test(key))).toEqual(["writeClipboardText"]);
    expect([...f.handles.keys()].filter((key) => /clipboard/i.test(key))).toEqual(["artoo:writeClipboardText"]);
    const response = vi.fn();
    f.permissionRequest.mock.calls[0]![0](f.window.webContents, "clipboard-read", response);
    expect(response).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.permissionCheck.mock.calls[0]![0]()).toBe(false);
  });
});
