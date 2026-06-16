// Electron main process for the artoo desktop shell (spike, #30).
//
// Responsibilities kept to the shell seam only (not the full product):
//  - host the web reference UI (dev: a Vite URL; packaged: the bundled renderer)
//  - target a configurable server URL (the #28 pairing flow replaces this static
//    URL with a paired endpoint + token)
//  - own the lifecycle seam for a client-managed local `artood` (#29 implements
//    the real start/stop/status/heartbeat control plane)
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** Server the UI talks to. #28 will replace this with a paired-device endpoint. */
const SERVER_URL = process.env.ARTOO_SERVER_URL ?? "http://localhost:4000";
/** When set (dev/smoke), load the live web dev server (its proxy reaches the API). */
const DEV_URL = process.env.ARTOO_DEV_URL;

let mainWindow = null;
/** #29 seam: handle to a supervised local artood child process. */
let artood = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    title: "Artoo",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  // External links open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * #29 seam (spike stub): supervise a client-managed local `artood`. Configured
 * via ARTOO_ARTOOD_CMD; absent in the spike. The real control plane (start/stop/
 * status/restart + runtime heartbeat) is #29's slice — here we only own the seam.
 */
function startArtoodSupervision() {
  const command = process.env.ARTOO_ARTOOD_CMD;
  if (!command) {
    return;
  }
  const [bin, ...args] = command.split(" ");
  artood = spawn(bin, args, { stdio: "ignore", windowsHide: true });
  artood.on("exit", () => {
    artood = null;
  });
}

function stopArtoodSupervision() {
  if (artood !== null) {
    artood.kill();
    artood = null;
  }
}

app.whenReady().then(() => {
  startArtoodSupervision();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit on all-windows-closed (except macOS convention); always stop the child.
app.on("window-all-closed", () => {
  stopArtoodSupervision();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("before-quit", stopArtoodSupervision);

module.exports = { SERVER_URL };
