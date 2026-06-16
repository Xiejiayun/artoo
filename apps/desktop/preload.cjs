// Preload: expose a tiny, safe bridge to the web UI. Context-isolated — no Node
// access leaks to the renderer.
//
// `serverUrl` lets the web ApiClient target the desktop's configured server
// instead of its same-origin default. The #28 pairing flow replaces this static
// value with a paired endpoint + token handed to the renderer.
const { contextBridge } = require("electron");

const SERVER_URL = process.env.ARTOO_SERVER_URL ?? "http://localhost:4000";

contextBridge.exposeInMainWorld("artooDesktop", {
  serverUrl: SERVER_URL,
  platform: process.platform,
  electronVersion: process.versions.electron,
});
