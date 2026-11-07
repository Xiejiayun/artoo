const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { createConnectionStore, normalizeServerUrl } = require("./connection-store.cjs");
const { createManagedProfileStore } = require("./managed-profile-store.cjs");
const { validateCodexSettings } = require("./codex-settings.cjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANAGED_ENV = /^(ARTOO_MANAGED_|ARTOO_JOURNAL_|ARTOO_WORKER_LAUNCH_ID$)/i;
const LOCAL_AUTOMATION_ENV = /^(ARTOO_WINDOWS_PROCESS_|ARTOO_VERIFICATION_PROFILES_FILE$|ARTOO_RELEASE_PROFILES_FILE$|ARTOO_OWNED_RESULT_PROFILES_FILE$)/i;
function inside(candidate, root) {
  const suffix = path.relative(root, candidate);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix);
}
async function protectedConfigBytes(filename, roots, label, maximum = 1024 * 1024) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/u.test(filename)
    || path.resolve(filename) !== filename || path.parse(filename).root.startsWith("\\\\")) throw new Error(`${label} must be an absolute local physical file`);
  if (roots.some(root => inside(filename, root))) throw new Error(`${label} must be outside every allowed workspace folder`);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || await fs.realpath(filename) !== filename) {
    throw new Error(`${label} must be a bounded regular physical file without links`);
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const opened = await handle.stat(), named = await fs.lstat(filename);
    if (length > maximum || [opened, named].some(stat => !stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size !== length || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs)
      || await fs.realpath(filename) !== filename) throw new Error(`${label} changed while reading`);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function createDesktopController(options) {
  const store = createConnectionStore(options.directory, options.safeStorage, options.serverUrl);
  const platform = options.platform ?? process.platform;
  const profiles = platform === "darwin" ? createManagedProfileStore(options.directory, { platform }) : null;
  const request = options.fetch ?? globalThis.fetch;
  const spawnProcess = options.spawn ?? spawn;
  let child = null;
  let childClosed = null;
  let activeLaunch = null;
  let closureFailure;
  let preparing = false;
  let state = "stopped";
  let lastError;
  let stopRequested = false;
  let restartTimer;
  let restartCount = 0;
  let generation = 0;
  let launchedAt = 0;
  let operations = Promise.resolve();
  const workerConfig = () => ({ ...store.daemonConfig(), allowNewAllocations: store.daemonConfig().allowNewAllocations === true });
  const selectedIdentity = () => ({ serverOrigin: store.connection().serverUrl, nodeId: store.connection().computerId });
  const configurationLocked = () => child !== null || preparing || state === "stopping" || !!closureFailure;
  async function nativeVerificationSettings(input, roots, allowNewAllocations) {
    if (input === undefined) return undefined;
    if (platform !== "win32") throw new Error("Native automatic-task verification is available only on Windows");
    if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1 || typeof input.profilesFile !== "string"
      || Object.keys(input).some(key => !["version", "profilesFile"].includes(key))) throw new Error("Invalid native verification configuration");
    if (allowNewAllocations) throw new Error("Native verification requires ordinary workspaces without managed task allocations");
    let profiles;
    try { profiles = JSON.parse((await protectedConfigBytes(input.profilesFile, roots, "Verification profiles file")).toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw new Error("Verification profiles file must contain valid JSON"); throw error; }
    if (!Array.isArray(profiles) || !profiles.length || profiles.length > 64) throw new Error("Verification profiles file must contain one to 64 local profiles");
    return { version: 1, profilesFile: input.profilesFile };
  }
  async function nativePublicationSettings(input, roots, verification) {
    if (input === undefined) return undefined;
    if (platform !== "win32") throw new Error("Native product publication is available only on Windows");
    if (!verification) throw new Error("Automatic product publication requires automatic task verification");
    if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1 || typeof input.profilesFile !== "string"
      || Object.keys(input).some(key => !["version", "profilesFile"].includes(key))) throw new Error("Invalid native publication configuration");
    let profiles;
    try { profiles = JSON.parse((await protectedConfigBytes(input.profilesFile, roots, "Publication profiles file")).toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw new Error("Publication profiles file must contain valid JSON"); throw error; }
    if (!Array.isArray(profiles) || !profiles.length || profiles.length > 64) throw new Error("Publication profiles file must contain one to 64 local profiles");
    return { version: 1, profilesFile: input.profilesFile };
  }
  async function nativeVerificationEnvironment(config) {
    if (!config.nativeVerification) return {};
    const root = path.dirname(options.daemonEntry), bundleFile = path.join(root, "bundle-manifest.json");
    let bundle;
    try { bundle = JSON.parse((await protectedConfigBytes(bundleFile, config.allowedRoots, "Packaged worker manifest", 8 * 1024 * 1024)).toString("utf8")); }
    catch (error) { if (error.code === "ENOENT") throw new Error("This desktop installation does not include a native Windows verification bundle"); throw error; }
    const native = bundle?.windows_process;
    if (bundle?.format !== "artoo.desktop-daemon.v1" || bundle.node_target !== "node24" || !native || typeof native !== "object"
      || native.directory !== "native/windows-process" || native.executable !== "Artoo.WindowsProcessHost.exe"
      || !/^sha256:[a-f0-9]{64}$/.test(native.manifest_sha256) || Object.keys(native).some(key => !["directory", "manifest_sha256", "executable"].includes(key))) {
      throw new Error("This desktop installation has no supported native Windows verification binding");
    }
    const directory = path.join(root, "native", "windows-process");
    const manifest = await protectedConfigBytes(path.join(directory, "manifest.json"), config.allowedRoots, "Native process manifest");
    if (`sha256:${createHash("sha256").update(manifest).digest("hex")}` !== native.manifest_sha256) throw new Error("The packaged native process manifest has changed");
    // Saving only checks local configuration. The daemon still checks all protected
    // files, ACLs and actual native process support before it can advertise verification.
    return { ARTOO_VERIFICATION_PROFILES_FILE: config.nativeVerification.profilesFile,
      ARTOO_WINDOWS_PROCESS_BUNDLE: directory, ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: native.manifest_sha256,
      ...(config.nativePublication ? { ARTOO_RELEASE_PROFILES_FILE: config.nativePublication.profilesFile } : {}) };
  }
  async function profileStatus() {
    if (!profiles) return { state: "unsupported" };
    if (preparing || activeLaunch?.kind === "provision") return { state: "preparing" };
    if (!store.connection().paired || !store.connection().computerId) return { state: "unprepared" };
    try { return { state: (await profiles.inspect(selectedIdentity())).state }; }
    catch { return { state: "incomplete", lastError: "Saved workspace preparation could not be verified. Its existing data has been retained." }; }
  }
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
  async function enroll(session) {
    const connection = store.connection();
    if (!connection.paired || !connection.deviceId) throw new Error("Pair this computer before starting its worker");
    if (!connection.computerId) {
      if (!["owner", "admin"].includes(session?.user?.role)) {
        // A member may pair their own control client. Starting local execution
        // requires an administrator to enroll it first, possibly on another app.
        const result = await api("/api/v1/devices");
        const enrolled = result.devices?.find((device) => device.id === connection.deviceId);
        if (!enrolled?.computer_id) throw new Error("Ask an owner or admin to enroll this computer before starting its worker");
        await store.setComputer(enrolled.computer_id);
        return;
      }
      const enrolled = await api(`/api/v1/devices/${encodeURIComponent(connection.deviceId)}/enroll`, {
        method: "POST", body: { display_name: os.hostname(), hostname: os.hostname(), os: platform, arch: process.arch },
      });
      await store.setComputer(enrolled.computer_id);
    }
  }
  async function configureDaemon(input) {
    if (configurationLocked()) throw new Error("Stop the worker before changing its configuration");
    if (!input || !Array.isArray(input.allowedRoots) || !Array.isArray(input.runtimes) || typeof input.trustedExecution !== "boolean") throw new Error("Invalid worker configuration");
    if (input.allowNewAllocations !== undefined && typeof input.allowNewAllocations !== "boolean") throw new Error("Invalid separate-workspace setting");
    const allowNewAllocations = input.allowNewAllocations === true;
    if (input.nativeVerification !== undefined && allowNewAllocations) throw new Error("Native verification requires ordinary workspaces without managed task allocations");
    if (allowNewAllocations && (!profiles || !store.connection().computerId || (await profiles.inspect(selectedIdentity())).state !== "ready")) {
      throw new Error("Prepare separate task workspaces on this Mac before enabling new allocations");
    }
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
    if (allowNewAllocations && !worktreeBaseRepo) throw new Error("Choose a Git repository for separate task workspaces before enabling new allocations");
    const codex = await validateCodexSettings(input.codex, store.daemonConfig().codex);
    const nativeVerification = await nativeVerificationSettings(input.nativeVerification, roots, allowNewAllocations);
    const nativePublication = await nativePublicationSettings(input.nativePublication, roots, nativeVerification);
    if (nativeVerification) await nativeVerificationEnvironment({ nativeVerification, nativePublication, allowedRoots: roots });
    await store.configureDaemon({ allowedRoots: [...new Set(roots)], runtimes, trustedExecution: input.trustedExecution, allowNewAllocations,
      codex: codex.config, ...(worktreeBaseRepo ? { worktreeBaseRepo } : {}), ...(nativeVerification ? { nativeVerification } : {}), ...(nativePublication ? { nativePublication } : {}) }, codex.keyUpdate);
  }
  function observeChild(launched, attempt) {
    child = launched;
    activeLaunch = attempt;
    attempt.child = launched;
    attempt.failed = new Promise((resolve) => { attempt.fail = (error) => {
      attempt.error ??= error;
      if (child === launched) { lastError = attempt.error.message; if (state !== "stopping") state = "failed"; }
      resolve(attempt.error);
    }; });
    childClosed = new Promise((resolve) => {
      let finished = false;
      const ended = () => {
        if (finished) return;
        finished = true;
        const confirmedWorkerCleanup = attempt.kind === "worker" && attempt.stopped && attempt.closed;
        // A failed IPC request remains an error for that Stop call. A later
        // correlated stopped reply plus exit 0 and close is affirmative cleanup
        // proof; provisioning protocol errors can never use this exception.
        const successfulExit = attempt.exited && attempt.exitCode === 0 && (!attempt.error || confirmedWorkerCleanup);
        const cleanStop = attempt.kind === "worker" && attempt.stopRequested && successfulExit && (!attempt.managed || attempt.stopped);
        const outcome = { successfulExit, cleanStop };
        if (child !== launched || activeLaunch !== attempt) { resolve(outcome); return; }
        child = null; activeLaunch = null;
        if (attempt.kind === "provision") {
          if (attempt.abandoned || !successfulExit) {
            state = "failed";
            lastError = attempt.error?.message ?? "Workspace preparation did not finish successfully; its incomplete setup is retained";
          }
        } else if (cleanStop) {
          state = "stopped"; closureFailure = undefined; lastError = undefined;
        } else {
          state = "failed";
          lastError = attempt.error?.message ?? (attempt.stopRequested
            ? (attempt.exitCode !== 0 ? `Worker stopped with exit code ${attempt.exitCode ?? "unknown"}; cleanup was not confirmed`
              : "Worker exited without confirming cleanup; active execution remains uncertain")
            : `Worker exited${typeof attempt.exitCode === "number" ? ` with code ${attempt.exitCode}` : " before startup"}. Check runtime installation and server connectivity.`);
          if (attempt.stopRequested || attempt.managed) closureFailure = new Error(lastError);
          // A prepared worker failure stays visible and never falls back to an
          // ordinary worker through the automatic restart path.
          if (!attempt.stopRequested && !attempt.managed && restartCount < 3) {
            restartCount++;
            restartTimer = setTimeout(() => {
              const restart = operations.then(async () => {
                if (attempt.generation === generation && !stopRequested) await launchWorker();
              });
              operations = restart.catch((error) => { state = "failed"; lastError = error.message; });
            }, 1000 * 2 ** (restartCount - 1));
          }
        }
        resolve(outcome);
      };
      launched.on("message", (message) => {
        if (child !== launched || activeLaunch !== attempt || !message || typeof message !== "object") return;
        if (attempt.kind === "provision") {
          if (message.type !== "journal.provisioned" || attempt.abandoned) return;
          if (message.requestId !== attempt.requestId || typeof message.namespace !== "string" || !UUID.test(message.namespace)) {
            attempt.fail(new Error("Workspace preparation returned an unmatched reply; its incomplete setup is retained"));
          } else if (attempt.namespace && attempt.namespace !== message.namespace) {
            attempt.fail(new Error("Workspace preparation returned conflicting identities; its incomplete setup is retained"));
          } else attempt.namespace = message.namespace;
        } else if (message.launchId === attempt.launchId) {
          if (message.type === "worker.ready" && !attempt.stopRequested && !attempt.stopped && !attempt.error) attempt.ready = true;
          if (message.type === "worker.stopped") { attempt.stopped = true; state = "stopping"; }
        }
      });
      launched.once("exit", (code, signal) => {
        attempt.exited = true; attempt.exitCode = code; attempt.exitSignal = signal;
        if (child === launched && attempt.managed) state = attempt.stopRequested ? "stopping" : "failed";
        // Ordinary workers keep their existing exit-based observer. Prepared
        // execution additionally joins close so owned IPC/stdio has closed.
        if (attempt.kind === "worker" && !attempt.managed && !attempt.error) ended();
      });
      launched.once("close", (code, signal) => {
        attempt.closed = true;
        if (!attempt.exited) { attempt.exitCode = code; attempt.exitSignal = signal; }
        ended();
      });
      // ChildProcess 'error' can mean failed IPC or a failed kill while the
      // process still lives. Only exit/close may release its owned handle.
      launched.on("error", (error) => attempt.fail(new Error(`Worker process error: ${error.message}`)));
    });
    return childClosed;
  }
  async function observeWithinBudget(closed, attempt) {
    let timeout;
    try {
      return await Promise.race([closed, attempt.failed.then((error) => ({ error })), new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timeout: true }), 12_000);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async function prepareManagedWorkspace() {
    if (!profiles) throw new Error("Separate task workspaces are currently available only on macOS");
    if (configurationLocked() || state !== "stopped") throw new Error("Stop the worker before preparing separate task workspaces");
    await enroll(await api("/auth/session"));
    await fs.access(options.daemonEntry);
    const identity = selectedIdentity();
    const preparation = await profiles.beginPreparation(identity);
    if (preparation.kind === "existing") return;
    preparing = true; state = "preparing"; lastError = undefined;
    const attempt = { kind: "provision", requestId: preparation.requestId, generation };
    try {
      // Provisioning has no provider credentials, node endpoint or adapters.
      // Supply only the OS environment needed to execute the bundled child.
      const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|LC_CTYPE|TZ|USER|LOGNAME|SHELL)$/i.test(key)));
      const launched = spawnProcess(options.executable, [options.daemonEntry, "--provision-managed-journal"], {
        windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", NODE_OPTIONS: "",
          ARTOO_JOURNAL_VERSION: "1", ARTOO_JOURNAL_SERVER_ORIGIN: identity.serverOrigin,
          ARTOO_JOURNAL_NODE_ID: identity.nodeId, ARTOO_JOURNAL_DIRECTORY: preparation.location.directory,
          ARTOO_JOURNAL_CONTROLLER_SCOPE: preparation.location.controllerScope, ARTOO_JOURNAL_REQUEST_ID: preparation.requestId },
      });
      const closed = observeChild(launched, attempt);
      const result = await observeWithinBudget(closed, attempt);
      if (result.error) throw result.error;
      if (result.timeout) throw new Error("Workspace preparation has not closed; its incomplete setup is retained and the process is still owned");
      if (!result.successfulExit || !attempt.namespace) throw new Error("Workspace preparation requires a matching reply and successful child exit; its incomplete setup is retained");
      await profiles.completePreparation(identity, { requestId: attempt.requestId, namespace: attempt.namespace });
      state = "stopped"; lastError = undefined;
    } catch (error) {
      attempt.abandoned = true;
      state = child ? "stopping" : "failed"; lastError = error.message;
      throw error;
    } finally { preparing = false; }
  }
  async function launchWorker() {
    if (child !== null) return;
    const launchGeneration = generation;
    stopRequested = false;
    const config = workerConfig();
    await configureDaemon(config);
    const codex = config.codex;
    const session = await api("/auth/session");
    await enroll(session);
    await fs.access(options.daemonEntry);
    if (generation !== launchGeneration || stopRequested) return;
    const connection = store.connection();
    const credentials = store.credentials();
    if (!credentials?.nodeToken) throw new Error("This device has no execution credential. Pair it as a desktop device");
    const nodeUrl = new URL("/api/v1/node", connection.serverUrl);
    nodeUrl.protocol = nodeUrl.protocol === "https:" ? "wss:" : "ws:";
    nodeUrl.searchParams.set("token", credentials.nodeToken);
    const profile = profiles ? await profiles.inspect(selectedIdentity()) : { state: "unprepared" };
    if (profile.state === "incomplete") throw new Error("Separate workspace preparation is incomplete; finish recovery before starting this computer's worker");
    const binding = profile.state === "ready" ? profile.binding : undefined;
    if (binding && (binding.serverOrigin !== connection.serverUrl || binding.nodeId !== connection.computerId)) throw new Error("Prepared workspace identity does not match this enrolled computer");
    if (config.allowNewAllocations && !binding) throw new Error("Prepare separate task workspaces before enabling new allocations");
    if (config.nativeVerification && binding) throw new Error("Native verification cannot use a managed worker");
    const nativeEnvironment = await nativeVerificationEnvironment(config);
    const launchId = randomUUID();
    stopRequested = false;
    lastError = undefined;
    closureFailure = undefined;
    state = "starting";
    launchedAt = Date.now();
    let launched;
    try { launched = spawnProcess(options.executable, [options.daemonEntry, ...(binding ? ["--prepared-journal"] : [])], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ARTOO_CODEX_/i.test(key) && !MANAGED_ENV.test(key) && !(platform === "win32" && LOCAL_AUTOMATION_ENV.test(key)))), ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", NODE_OPTIONS: "",
        ARTOO_NODE_URL: nodeUrl.toString(), ARTOO_NODE_ID: connection.computerId,
        ARTOO_WORKER_LAUNCH_ID: launchId,
        ...(binding ? { ARTOO_MANAGED_EXECUTION: config.allowNewAllocations ? "1" : "0", ARTOO_JOURNAL_VERSION: "1",
          ARTOO_JOURNAL_SERVER_ORIGIN: binding.serverOrigin, ARTOO_JOURNAL_NODE_ID: binding.nodeId,
          ARTOO_JOURNAL_DIRECTORY: binding.directory, ARTOO_JOURNAL_NAMESPACE: binding.expectedNamespace,
          ARTOO_JOURNAL_CONTROLLER_SCOPE: binding.controllerScope } : {}),
        ARTOO_ALLOWED_ROOTS: config.allowedRoots.join(";"), ARTOO_RUNTIMES: config.runtimes.join(","),
        ARTOO_WORKTREE_BASE_REPO: config.worktreeBaseRepo ?? "", ARTOO_TRUSTED_EXECUTION: config.trustedExecution ? "1" : "0",
        ...nativeEnvironment,
        // Explicitly replace inherited overrides; changing connection mode must
        // never reuse a parent process's provider or secret.
        ARTOO_CODEX_BINARY: codex.binaryPath, ARTOO_CODEX_MODEL: codex.model,
        ARTOO_CODEX_PROVIDER_URL: codex.mode === "responses" ? codex.baseUrl : undefined,
        ARTOO_CODEX_PROVIDER_KEY: codex.mode === "responses" && codex.authMode === "api-key" ? store.codexApiKey() : undefined,
      },
    }); } catch (error) { state = "failed"; lastError = error.message; throw error; }
    observeChild(launched, { kind: "worker", managed: !!binding, launchId, generation, nodeId: connection.computerId,
      runtimes: config.runtimes, ready: false, stopped: false, stopRequested: false });
  }
  async function stopWorker() {
    generation++;
    stopRequested = true;
    clearTimeout(restartTimer);
    const active = child;
    if (!active) { if (closureFailure) throw closureFailure; state = "stopped"; return; }
    const attempt = activeLaunch;
    attempt.stopRequested = true;
    state = "stopping";
    try {
      if (active.connected && attempt.kind === "worker") active.send({ type: "shutdown", launchId: attempt.launchId }, (error) => {
        if (error) attempt.fail(new Error(`Worker shutdown IPC failed: ${error.message}`));
      });
      else active.kill("SIGTERM");
    } catch (error) { attempt.fail(new Error(`Worker shutdown could not be requested: ${error.message}`)); }
    const result = await observeWithinBudget(childClosed, attempt);
    if (result.error) throw result.error;
    if (result.timeout) {
      // Keep state/handle honest: the caller can retry or close only after the
      // worker has acknowledged stopping its children.
      lastError = "Worker did not stop in time; active execution may still be running";
      throw new Error(lastError);
    }
    if (!result.cleanStop) throw closureFailure ?? new Error(lastError ?? "Worker cleanup was not confirmed");
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
      const session = await api("/auth/session");
      if (["owner", "admin"].includes(session?.user?.role)) await enroll(session);
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
    prepareManagedWorkspace,
    async daemonStatus() {
      const observedChild = child;
      const observedLaunch = activeLaunch;
      const observedGeneration = generation;
      const stillCurrent = () => child === observedChild && activeLaunch === observedLaunch && generation === observedGeneration && !stopRequested
        && !observedLaunch?.error && !observedLaunch?.exited && !observedLaunch?.stopped;
      if (observedChild && observedLaunch?.kind === "worker" && store.connection().computerId) {
        try {
          const result = await api(`/api/v1/computers/${encodeURIComponent(store.connection().computerId)}/runtimes`);
          const fresh = result.runtimes?.some((r) => {
            const timestamp = Date.parse(r.last_seen_at), age = Date.now() - timestamp;
            return Number.isFinite(timestamp) && timestamp >= launchedAt && age >= 0 && age < 30_000
              && (!observedLaunch.managed || (r.computer_id === observedLaunch.nodeId && observedLaunch.runtimes.includes(r.runtime)));
          });
          // A health request can finish after stop, logout, or a replacement
          // process starts. Only its original live worker may accept the result.
          if (stillCurrent()) {
            if (fresh && (!observedLaunch.managed || observedLaunch.ready)) { state = "running"; restartCount = 0; }
            else if (state === "running") state = "unhealthy";
          }
        } catch { if (stillCurrent() && state === "running") state = "unhealthy"; }
      }
      const managedWorkspace = await profileStatus();
      return { state, ...(child?.pid ? { pid: child.pid } : {}), ...(lastError ? { lastError } : {}), config: workerConfig(),
        configurationLocked: configurationLocked(), managedWorkspace };
    },
    async startDaemon() { if (child) return; generation++; restartCount = 0; await launchWorker(); },
    stopDaemon: stopWorker,
    async restartDaemon() { await stopWorker(); restartCount = 0; await launchWorker(); },
  };
  // IPC calls can overlap; serialize lifecycle/settings changes so two start
  // clicks cannot create two writers and logout cannot race a pending launch.
  for (const method of ["configureServer", "pairDevice", "logout", "configureDaemon", "prepareManagedWorkspace", "startDaemon", "stopDaemon", "restartDaemon"]) {
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
