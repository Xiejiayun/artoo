const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createDesktopController } = require("./desktop-controller.cjs");

if (process.env.ARTOO_DESKTOP_DATA_DIR) app.setPath("userData", path.resolve(process.env.ARTOO_DESKTOP_DATA_DIR));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const devUrl = !app.isPackaged ? process.env.ARTOO_DEV_URL : undefined;
const rendererPath = path.join(__dirname, "renderer", "index.html");
let mainWindow;
let controller;
let quitting = false;
let shutdownPending = false;
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
});

function trustedUrl(value) {
  try {
    const url = new URL(value);
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === "file:" && path.resolve(fileURLToPath(url)) === path.resolve(rendererPath);
  } catch { return false; }
}
function checkSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedUrl(event.senderFrame.url)) {
    throw new Error("Untrusted desktop request");
  }
}
async function openExternal(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Only Web links can be opened");
  await shell.openExternal(url.toString());
}
function installBridge() {
  ipcMain.on("artoo:initial", (event) => {
    try { checkSender(event); event.returnValue = controller.getConnection(); }
    catch { event.returnValue = null; }
  });
  for (const method of ["getConnection", "getToken", "configureServer", "pairDevice", "logout", "daemonStatus", "configureDaemon", "startDaemon", "stopDaemon", "restartDaemon"]) {
    ipcMain.handle(`artoo:${method}`, (event, input) => { checkSender(event); return controller[method](input); });
  }
  ipcMain.handle("artoo:prepareManagedWorkspace", (event) => { checkSender(event); return controller.prepareManagedWorkspace(); });
  ipcMain.handle("artoo:chooseDirectory", async (event) => {
    checkSender(event);
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("artoo:chooseExecutable", async (event) => {
    checkSender(event);
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: process.platform === "win32" ? [{ name: "Codex program", extensions: ["exe", "cmd"] }] : [] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("artoo:openExternal", async (event, value) => { checkSender(event); return openExternal(value); });
  ipcMain.handle("artoo:writeClipboardText", (event, value) => {
    checkSender(event);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("Clipboard text must be a string of at most 64 KiB");
    clipboard.writeText(value);
  });
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 832, title: "Artoo",
    minWidth: 360, minHeight: 540, backgroundColor: "#ffffff", autoHideMenuBar: true,
    ...(process.platform === "win32" ? { icon: path.join(__dirname, "resources", "AppIcon.ico") } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!trustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => {}); return { action: "deny" }; });
  mainWindow.on("closed", () => { mainWindow = null; });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(rendererPath);
}

if (primaryInstance) app.whenReady().then(async () => {
  controller = createDesktopController({ directory: app.getPath("userData"), safeStorage,
    serverUrl: process.env.ARTOO_SERVER_URL, executable: process.execPath,
    daemonEntry: app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "daemon", "artood.mjs") : path.join(__dirname, "daemon", "artood.mjs"), version: app.getVersion() });
  await controller.initialize();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // CORS is enforced by the server's explicit desktop-origin configuration.
  // The shell never rewrites authorization or CORS response headers.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["file://*/*"] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders,
      "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'"],
    } });
  });
  installBridge();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => { dialog.showErrorBox("Artoo could not start", error.message); quitting = true; app.quit(); });

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (quitting || !controller) return;
  event.preventDefault();
  if (shutdownPending) return;
  shutdownPending = true;
  void controller.stopDaemon().then(() => { quitting = true; app.quit(); }).catch((error) => {
    shutdownPending = false;
    dialog.showErrorBox("Worker is still stopping", error.message);
    if (!mainWindow) createWindow();
  });
});
