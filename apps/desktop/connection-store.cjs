const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeServerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid server URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Use an HTTPS server origin, or HTTP on localhost for local testing");
  }
  return url.origin;
}

function createConnectionStore(directory, safeStorage, initialServer = "http://localhost:4000") {
  const filename = path.join(directory, "connection.json");
  let state = {
    serverUrl: normalizeServerUrl(initialServer), deviceId: null, computerId: null,
    encryptedCredentials: null,
    daemon: { allowedRoots: [], runtimes: ["codex"], trustedExecution: false },
  };
  async function save() {
    await fs.mkdir(directory, { recursive: true });
    const temp = `${filename}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, filename);
  }
  function requireSecureStorage() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("OS secure credential storage is unavailable; unlock your account before pairing");
  }
  return {
    requireSecureStorage,
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(filename, "utf8"));
        if (saved && typeof saved.serverUrl === "string") {
          state = { ...state, ...saved, serverUrl: normalizeServerUrl(saved.serverUrl) };
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error("Saved connection could not be read; restore or remove the connection file before pairing again");
      }
    },
    connection: () => ({ serverUrl: state.serverUrl, paired: !!state.encryptedCredentials, deviceId: state.deviceId, computerId: state.computerId }),
    daemonConfig: () => ({ ...state.daemon, allowedRoots: [...state.daemon.allowedRoots], runtimes: [...state.daemon.runtimes] }),
    credentials() {
      if (!state.encryptedCredentials) return null;
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure credential storage is unavailable");
      try { return JSON.parse(safeStorage.decryptString(Buffer.from(state.encryptedCredentials, "base64"))); }
      catch { throw new Error("Stored credentials cannot be unlocked. Reconnect this device"); }
    },
    async configureServer(value) {
      const serverUrl = normalizeServerUrl(value);
      if (serverUrl !== state.serverUrl) {
        state = { ...state, serverUrl, deviceId: null, computerId: null, encryptedCredentials: null, daemon: { ...state.daemon, trustedExecution: false } };
        await save();
      }
    },
    async pair(deviceId, controlToken, nodeToken) {
      requireSecureStorage();
      if (typeof deviceId !== "string" || typeof controlToken !== "string" || !controlToken || typeof nodeToken !== "string" || !nodeToken) throw new Error("Server did not return desktop credentials");
      const encrypted = safeStorage.encryptString(JSON.stringify({ controlToken, nodeToken })).toString("base64");
      state = { ...state, deviceId, computerId: null, encryptedCredentials: encrypted };
      await save();
    },
    async setComputer(computerId) { state = { ...state, computerId }; await save(); },
    async configureDaemon(daemon) { state = { ...state, daemon }; await save(); },
    async clear() { state = { ...state, deviceId: null, computerId: null, encryptedCredentials: null }; await save(); },
  };
}

module.exports = { createConnectionStore, normalizeServerUrl };
