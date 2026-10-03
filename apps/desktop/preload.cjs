const { contextBridge, ipcRenderer } = require("electron");
const initial = ipcRenderer.sendSync("artoo:initial");
if (!initial) throw new Error("Desktop configuration is unavailable");
const invoke = (method) => (input) => ipcRenderer.invoke(`artoo:${method}`, input);
contextBridge.exposeInMainWorld("artooDesktop", {
  serverUrl: initial.serverUrl, platform: process.platform, electronVersion: process.versions.electron,
  getConnection: invoke("getConnection"), getToken: invoke("getToken"),
  configureServer: invoke("configureServer"), pairDevice: invoke("pairDevice"), logout: invoke("logout"),
  daemonStatus: invoke("daemonStatus"), configureDaemon: invoke("configureDaemon"),
  startDaemon: invoke("startDaemon"), stopDaemon: invoke("stopDaemon"), restartDaemon: invoke("restartDaemon"),
  chooseDirectory: invoke("chooseDirectory"), chooseExecutable: invoke("chooseExecutable"), openExternal: invoke("openExternal"),
  writeClipboardText: invoke("writeClipboardText"),
});
