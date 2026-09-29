const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createConnectionStore, normalizeServerUrl } = require("./connection-store.cjs");

function createDesktopController(options) {
  const store = createConnectionStore(options.directory, options.safeStorage, options.serverUrl);
  const request = options.fetch ?? globalThis.fetch;
  const spawnProcess = options.spawn ?? spawn;
  let child = null;
  let childClosed = null;
  let state = "stopped";
  let lastError;
  let stopRequested = false;
  let restartTimer;
  let restartCount = 0;
  let generation = 0;
  let launchedAt = 0;
  let operations = Promise.resolve();
  async function api(route, { method = "GET", body, authenticate = true } = {}) {
    const token = authenticate ? store.credentials()?.controlToken : null;
    const response = await request(`${store.connection().serverUrl}${route}`, {
      method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { throw new Error("The server returned an unexpected response"); }
    if (!response.ok) throw new Error(json?.error?.message ?? `Server request failed (${response.status})`);
    return json;
  }
  async function enroll() {
    const connection = store.connection();
    if (!connection.paired || !connection.deviceId) throw new Error("Pair this computer before starting its worker");
    if (!connection.computerId) {
      const enrolled = await api(`/api/v1/devices/${encodeURIComponent(connection.deviceId)}/enroll`, {
        method: "POST", body: { display_name: os.hostname(), hostname: os.hostname(), os: process.platform, arch: process.arch },
      });
      await store.setComputer(enrolled.computer_id);
    }
  }
  async function configureDaemon(input) {
    if (child !== null) throw new Error("Stop the worker before changing its configuration");
    if (!input || !Array.isArray(input.allowedRoots) || !Array.isArray(input.runtimes) || typeof input.trustedExecution !== "boolean") throw new Error("Invalid worker configuration");
    const roots = [];
    for (const root of input.allowedRoots) {
      if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) throw new Error("Workspace folders must be absolute paths");
      const canonical = await fs.realpath(root);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Workspace folders must be directories");
      roots.push(canonical);
    }
    const runtimes = [...new Set(input.runtimes)];
    if (!roots.length || !runtimes.length || runtimes.some((r) => !["codex", "claude-code"].includes(r))) throw new Error("Choose at least one workspace and a supported runtime");
    let worktreeBaseRepo;
    if (input.worktreeBaseRepo) {
      if (typeof input.worktreeBaseRepo !== "string" || !path.isAbsolute(input.worktreeBaseRepo)) throw new Error("The Git repository must be an absolute path");
      worktreeBaseRepo = await fs.realpath(input.worktreeBaseRepo);
      await fs.access(path.join(worktreeBaseRepo, ".git"));
    }
    await store.configureDaemon({ allowedRoots: [...new Set(roots)], runtimes, trustedExecution: input.trustedExecution, ...(worktreeBaseRepo ? { worktreeBaseRepo } : {}) });
  }
  async function launchWorker() {
    if (child !== null) return;
    const launchGeneration = generation;
    stopRequested = false;
    const config = store.daemonConfig();
    await configureDaemon(config);
    await api("/auth/session");
    await enroll();
    await fs.access(options.daemonEntry);
    if (generation !== launchGeneration || stopRequested) return;
    const connection = store.connection();
    const credentials = store.credentials();
    if (!credentials?.nodeToken) throw new Error("This device has no execution credential. Pair it as a desktop device");
    const nodeUrl = new URL("/api/v1/node", connection.serverUrl);
    nodeUrl.protocol = nodeUrl.protocol === "https:" ? "wss:" : "ws:";
    nodeUrl.searchParams.set("token", credentials.nodeToken);
    stopRequested = false;
    lastError = undefined;
    state = "starting";
    launchedAt = Date.now();
    const launched = spawnProcess(options.executable, [options.daemonEntry], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", NODE_OPTIONS: "",
        ARTOO_NODE_URL: nodeUrl.toString(), ARTOO_NODE_ID: connection.computerId,
        ARTOO_ALLOWED_ROOTS: config.allowedRoots.join(";"), ARTOO_RUNTIMES: config.runtimes.join(","),
        ARTOO_WORKTREE_BASE_REPO: config.worktreeBaseRepo ?? "", ARTOO_TRUSTED_EXECUTION: config.trustedExecution ? "1" : "0",
      },
    });
    child = launched;
    const epoch = generation;
    childClosed = new Promise((resolve) => {
      const ended = (code) => {
        if (child !== launched) return resolve();
        child = null;
        state = stopRequested ? "stopped" : "failed";
        if (!stopRequested) {
          lastError = `Worker exited${typeof code === "number" ? ` with code ${code}` : " before startup"}. Check runtime installation and server connectivity.`;
          if (restartCount < 3) {
            restartCount++;
            restartTimer = setTimeout(() => {
              const restart = operations.then(async () => {
                if (epoch === generation && !stopRequested) await launchWorker();
              });
              operations = restart.catch(() => { state = "failed"; });
            }, 1000 * 2 ** (restartCount - 1));
          }
        }
        resolve();
      };
      launched.once("exit", ended);
      launched.once("error", () => ended(null));
    });
  }
  async function stopWorker() {
    generation++;
    stopRequested = true;
    clearTimeout(restartTimer);
    const active = child;
    if (!active) { state = "stopped"; return; }
    state = "stopping";
    if (active.connected) active.send({ type: "shutdown" }); else active.kill("SIGTERM");
    let timeout;
    const stopped = await Promise.race([childClosed.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 12_000); })]);
    clearTimeout(timeout);
    if (!stopped) {
      // Keep state/handle honest: the caller can retry or close only after the
      // worker has acknowledged stopping its children.
      lastError = "Worker did not stop in time; active execution may still be running";
      throw new Error(lastError);
    }
  }
  const controller = {
    initialize: () => store.load(),
    getConnection: () => store.connection(),
    getToken: () => store.credentials()?.controlToken ?? null,
    async configureServer(serverUrl) {
      const normalized = normalizeServerUrl(serverUrl);
      if (normalized !== store.connection().serverUrl) await stopWorker();
      await store.configureServer(normalized);
    },
    async pairDevice({ code, displayName }) {
      store.requireSecureStorage();
      if (typeof code !== "string" || !code.trim() || typeof displayName !== "string" || !displayName.trim()) throw new Error("Pairing code and device name are required");
      await stopWorker();
      const claimed = await api("/api/v1/devices/claim", { method: "POST", authenticate: false, body: {
        code: code.trim(), display_name: displayName.trim(), platform: process.platform === "darwin" ? "macos" : "windows", app_version: options.version,
      } });
      await store.pair(claimed.device.id, claimed.control_token, claimed.node_token);
      await enroll();
      return store.connection();
    },
    async logout() {
      await stopWorker();
      // Local sign-out must remain possible after expiry/revocation or while
      // offline. The team owner can separately revoke the device on the server.
      try { await api("/auth/logout", { method: "POST" }); } catch {}
      await store.clear();
    },
    configureDaemon,
    async daemonStatus() {
      const observedChild = child;
      const observedGeneration = generation;
      const stillCurrent = () => child === observedChild && generation === observedGeneration && !stopRequested;
      if (observedChild && store.connection().computerId) {
        try {
          const result = await api(`/api/v1/computers/${encodeURIComponent(store.connection().computerId)}/runtimes`);
          const fresh = result.runtimes?.some((r) => r.last_seen_at && Date.parse(r.last_seen_at) >= launchedAt && Date.now() - Date.parse(r.last_seen_at) < 30_000);
          // A health request can finish after stop, logout, or a replacement
          // process starts. Only its original live worker may accept the result.
          if (stillCurrent()) {
            if (fresh) { state = "running"; restartCount = 0; }
            else if (state === "running") state = "unhealthy";
          }
        } catch { if (stillCurrent() && state === "running") state = "unhealthy"; }
      }
      return { state, ...(child?.pid ? { pid: child.pid } : {}), ...(lastError ? { lastError } : {}), config: store.daemonConfig() };
    },
    async startDaemon() { if (child) return; generation++; restartCount = 0; await launchWorker(); },
    stopDaemon: stopWorker,
    async restartDaemon() { await stopWorker(); restartCount = 0; await launchWorker(); },
  };
  // IPC calls can overlap; serialize lifecycle/settings changes so two start
  // clicks cannot create two writers and logout cannot race a pending launch.
  for (const method of ["configureServer", "pairDevice", "logout", "configureDaemon", "startDaemon", "stopDaemon", "restartDaemon"]) {
    const action = controller[method];
    controller[method] = (...args) => {
      const result = operations.then(() => action(...args));
      operations = result.catch(() => {});
      return result;
    };
  }
  return controller;
}

module.exports = { createDesktopController };
