import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { chromium, type Browser } from "playwright";
import { closeObservedWindowsProcesses } from "./owned/windows-browser-exit.js";
import { WindowsBrowserObserverSession } from "./owned/windows-browser-session.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { assertWindowsBrowserSessionClosure, startWindowsJobBrowserProcess, type WindowsJobBrowserProcess } from "./owned/windows-job-browser.js";

export interface OwnedBrowserOptions {
  workspace: string; executablePath?: string; launchTimeoutMs?: number; signal?: AbortSignal;
  /** Opaque node-local authority; never accepted from task text or a serialized receipt. */
  windowsProcessBackend?: PreparedWindowsProcessBackend;
}
export interface OwnedBrowser { browser: Browser; processId: number; close(): Promise<void> }
const inside = (path: string, root: string): boolean => { const tail = relative(root, path); return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)); };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Chromium inherits the verifier's owned POSIX process group. Playwright's own launcher detaches it. */
export async function launchOwnedBrowser(options: OwnedBrowserOptions): Promise<OwnedBrowser> {
  const windowsBackend = options.windowsProcessBackend;
  if (windowsBackend !== undefined && process.platform !== "win32") throw new Error("Windows browser process backend is supported only on Windows");
  const root = realpathSync.native(options.workspace);
  const executable = realpathSync.native(options.executablePath ?? chromium.executablePath());
  if (!isAbsolute(executable) || inside(executable, root) || !lstatSync(executable).isFile()) throw new Error("Browser executable must be a protected external program");
  const timeout = options.launchTimeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new Error("Invalid browser launch timeout");
  // Backend/observer preparation and Chrome/CDP admission share this deadline.
  const launchDeadline = performance.now() + timeout;
  const temporary = realpathSync.native(tmpdir());
  if (inside(temporary, root)) throw new Error("Browser profile must be outside the coding workspace");
  const profile = mkdtempSync(join(temporary, "artoo-owned-browser-"));
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: profile, TMP: profile, TEMP: profile,
    XDG_CACHE_HOME: join(profile, "cache"), XDG_CONFIG_HOME: join(profile, "config"),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
  };
  let browser: Browser | undefined, child: ChildProcess | undefined, closed = false, closePromise: Promise<void> | undefined;
  let observer: WindowsBrowserObserverSession | undefined, windowsJob: WindowsJobBrowserProcess | undefined;
  let launchCompleted = false, launchFailure: Error | undefined;
  let browserPid: number | undefined;
  let spawnError: Error | undefined;
  let rejectLaunch!: (error: Error) => void;
  const failedLaunch = new Promise<never>((_, reject) => { rejectLaunch = reject; });
  void failedLaunch.catch(() => {});
  const failLaunch = (error: Error) => { if (!launchFailure) { launchFailure = error; rejectLaunch(error); } };
  const requireLaunching = (): number => {
    if (launchFailure) throw launchFailure;
    if (options.signal?.aborted) throw new Error("Browser launch cancelled");
    const remaining = Math.floor(launchDeadline - performance.now());
    if (remaining < 1) throw new Error("Browser launch deadline elapsed");
    return remaining;
  };
  const duringLaunch = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, failedLaunch, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser launch deadline elapsed")), requireLaunching());
    })]); } finally { clearTimeout(timer); }
  };
  const logFile = join(profile, "chromium.log");
  const diagnostics = (): string => {
    try { const stat = lstatSync(logFile); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024 ? readFileSync(logFile, "utf8").slice(-4000) : "Chromium diagnostic log is unavailable"; }
    catch { return "Chromium diagnostic log is unavailable"; }
  };
  let resolveClosed!: () => void;
  const observedClose = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const bounded = async (operation: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  async function terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (windowsJob) { windowsJob.cancel(); return; }
    if (!child?.pid || closed) return;
    // Windows uses this ChildProcess's original HANDLE. A separate PID-based tree
    // scan races exit and spends the bounded confirmation interval on another process.
    // Descendants still require the observations/final audit below; the outer native
    // Job contains the verifier's complete process tree. kill() alone proves no exit.
    if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
    try { child.kill(signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const cancelled = () => {
    failLaunch(new Error("Browser launch or session cancelled"));
    observer?.abort();
    // Both calls target locally created ChildProcesses. Cleanup remains cached.
    void terminate("SIGKILL").catch(() => {});
    if (launchCompleted) void close().catch(() => {});
  };
  async function closeWindowsJob(): Promise<void> {
    const owned = windowsJob!, connectedBrowser = browser;
    // One close deadline includes graceful request, native drain, stream EOF and
    // CDP disconnect. Repeated close/cancel calls cannot renew it.
    const deadline = performance.now() + 10000;
    const wait = async <T>(operation: Promise<T>, maximumMs = 10000): Promise<T> => {
      void operation.catch(() => {}); // A late CDP result remains observed after the fixed deadline.
      const remaining = Math.floor(Math.min(maximumMs, deadline - performance.now()));
      if (remaining < 1) throw new Error("Windows browser close deadline elapsed; its profile is retained");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Windows browser close deadline elapsed; its profile is retained")), remaining);
      })]); } finally { clearTimeout(timer); }
    };
    let gracefulError: unknown;
    if (connectedBrowser && owned.process.exitCode === null && !launchFailure) {
      try {
        await wait((async () => { const session = await connectedBrowser.newBrowserCDPSession(); await session.send("Browser.close"); })(), 1000);
        // Root exit can precede Job-empty/helper-close. Preserve time for both.
        if (owned.process.exitCode === null) await wait(observedClose, 1000);
      } catch (error) { gracefulError = error; }
    }
    const localCloseCancelled = owned.process.exitCode === null && !launchFailure && !options.signal?.aborted;
    if (owned.process.exitCode === null) owned.cancel();
    const receipt = await wait(owned.closed);
    // A real Job receipt and both stream EOFs precede the final CDP disconnect.
    // Failed or late close never schedules a later profile deletion.
    if (connectedBrowser) await wait(connectedBrowser.close());
    if (launchFailure || options.signal?.aborted) throw new Error("Owned Windows browser launch or session failed; its profile is retained", { cause: launchFailure });
    assertWindowsBrowserSessionClosure(receipt, localCloseCancelled);
    if (gracefulError !== undefined) {
      process.stderr.write(JSON.stringify({ event: "browser_job_exit_confirmed_after_graceful_error", parent_pid: receipt.rootPid,
        command_error: (gracefulError instanceof Error ? gracefulError.message : "Unknown graceful close error").slice(0, 1000) }) + "\n");
    }
  }
  function close(): Promise<void> {
    // Set the owner closing marker before any async body can request Browser.close
    // or kill. Expected Chrome exit must not poison the observer's final audit.
    return closePromise ??= Promise.resolve().then(async () => {
      try {
      if (windowsJob) {
        await closeWindowsJob();
      } else if (process.platform === "win32" && child?.pid) {
        if (!observer) throw new Error("The owned Windows browser observer is unavailable");
        const parentPid = child.pid, connectedBrowser = browser;
        const result = await closeObservedWindowsProcesses({ parentPid, parentClosed: () => closed,
          terminateParent: () => terminate("SIGKILL"),
          ...(connectedBrowser ? {
            requestGracefulClose: async (remainingMs: number) => {
              const deadline = performance.now() + remainingMs;
              let commandError: unknown, settled = false;
              await bounded((async () => {
                try { const session = await connectedBrowser.newBrowserCDPSession(); await session.send("Browser.close"); }
                catch (error) { commandError = error; }
                finally { settled = true; }
              })(), remainingMs);
              if (!closed && performance.now() < deadline) await bounded(observedClose, deadline - performance.now());
              if (commandError) throw commandError;
              if (!settled && !closed) throw new Error("Graceful browser close timed out");
            },
            // Disconnect before the final OS audit. No asynchronous work may reopen
            // the interval between that audit and profile removal below.
            closeConnection: async () => { await connectedBrowser.close(); },
          } : {}),
          finalAudit: remainingMs => observer!.finalAudit(remainingMs),
          observe: async () => {
            // CDP misses some crashpad/utility helpers. OS ancestry is an additional
            // bounded observation, not proof of complete process lifetime containment.
            const osIds = await observer!.observe();
            const cdpIds: number[] = [];
            if (connectedBrowser) {
              let observed = false;
              await bounded((async () => {
                const session = await connectedBrowser.newBrowserCDPSession();
                const { processInfo } = await session.send("SystemInfo.getProcessInfo");
                if (!processInfo.some(({ id }) => id === parentPid)) throw new Error("CDP root differs from the owned browser");
                for (const { id } of processInfo) {
                  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid browser process observation");
                  cdpIds.push(id);
                }
                observed = true;
              })(), 1000);
              if (!observed) throw new Error("Owned browser CDP observation timed out");
            }
            return [...new Set([parentPid, ...osIds, ...cdpIds])];
          },
        });
        if (result.terminationError !== undefined) {
          const detail = result.terminationError instanceof Error ? result.terminationError.message : "Unknown termination command error";
          process.stderr.write(JSON.stringify({ event: "browser_exit_confirmed_after_command_error", parent_pid: parentPid,
            observed_process_count: result.observedProcessCount, command_error: detail.slice(0, 1000) }) + "\n");
        }
        if (result.gracefulError !== undefined) {
          const detail = result.gracefulError instanceof Error ? result.gracefulError.message : "Unknown graceful close error";
          process.stderr.write(JSON.stringify({ event: "browser_exit_confirmed_after_graceful_error", parent_pid: parentPid,
            observed_process_count: result.observedProcessCount, command_error: detail.slice(0, 1000) }) + "\n");
        }
      } else if (browser && !closed) {
        // CDP Browser.close closes Chromium, rather than only disconnecting a client.
        await bounded((async () => { const session = await browser!.newBrowserCDPSession(); await session.send("Browser.close"); })().catch(() => {}), 1000);
        await bounded(observedClose, 1000);
      }
      if (!closed) { await terminate("SIGTERM"); await bounded(observedClose, 1000); }
      if (!closed) { await terminate("SIGKILL"); await bounded(observedClose, 3000); }
      if (child && !closed) throw new Error("Browser process exit remains unconfirmed; its profile is retained");
      if (browser && process.platform !== "win32") await bounded(browser.close().catch(() => {}), 1000);
      // An empty final response is withheld until this observer's exit, actual
      // close and both output EOFs fit inside the original final-audit budget.
      observer?.assertCompleted();
      // The outer verifier owns/reaps the inherited group; never detach browser helpers.
      // Antivirus and recently closed Windows browser handles can briefly hold
      // the profile. Retries are bounded and only start after observed exit.
      rmSync(profile, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 5 : 0, retryDelay: 200 });
      } catch (error) {
        windowsJob?.cancel();
        observer?.abort();
        try { await observer?.cleanup(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Browser and observer cleanup is unconfirmed; its profile is retained"); }
        throw error;
      } finally { options.signal?.removeEventListener("abort", cancelled); }
    });
  }
  try {
    options.signal?.addEventListener("abort", cancelled, { once: true });
    requireLaunching();
    if (process.platform === "win32" && windowsBackend === undefined) observer = new WindowsBrowserObserverSession({ executable, profile, launchDeadline,
      ...(options.signal ? { signal: options.signal } : {}), onFailure: () => {
        failLaunch(new Error("Owned browser observer failed"));
        void terminate("SIGKILL").catch(() => {});
        if (launchCompleted && !closePromise) void close().catch(() => {});
      } });
    requireLaunching();
    const argv = [
      "--headless", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--enable-logging", `--log-file=${logFile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--disable-component-extensions-with-background-pages", "--disable-default-apps", "--disable-extensions", "--disable-sync",
      "--disable-breakpad", "--disable-crash-reporter", "--disable-crashpad-for-testing", "--noerrdialogs",
      "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain", "about:blank",
    ];
    const unexpectedExit = () => {
      if (!closePromise) {
        observer?.abort(); failLaunch(new Error("Owned browser exited unexpectedly"));
        if (launchCompleted) void close().catch(() => {});
      }
    };
    if (windowsBackend !== undefined) {
      windowsJob = startWindowsJobBrowserProcess(windowsBackend, { executable, args: argv, cwd: profile, env: environment,
        ...(options.signal ? { signal: options.signal } : {}) });
      windowsJob.process.once("exit", unexpectedExit);
      void windowsJob.closed.then(() => {
        closed = true; resolveClosed();
        if (!closePromise) unexpectedExit();
      }, error => {
        failLaunch(error instanceof Error ? error : new Error("Owned Windows browser Job failed"));
        if (launchCompleted && !closePromise) void close().catch(() => {});
      });
      browserPid = (await duringLaunch(windowsJob.started)).pid;
    } else {
      child = spawn(executable, argv, { cwd: profile, env: environment, detached: false, windowsHide: true, stdio: "ignore" });
      child.once("error", (error) => { spawnError = error; failLaunch(error); observer?.abort(); });
      child.once("exit", unexpectedExit);
      child.once("close", () => { closed = true; resolveClosed(); });
      browserPid = child.pid;
    }
    const portFile = join(profile, "DevToolsActivePort");
    let endpoint: string | undefined;
    while (performance.now() < launchDeadline) {
      requireLaunching();
      if (spawnError) throw spawnError;
      if (closed) throw new Error(`Chromium exited before becoming ready: ${diagnostics()}`);
      try {
        const stat = lstatSync(portFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error("Invalid Chromium DevTools endpoint file");
        const [port, path] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
        if (port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536 && path && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
      } catch (error) { if (!["ENOENT", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await duringLaunch(delay(Math.min(20, requireLaunching())));
    }
    if (!endpoint) throw new Error(`Chromium startup timed out: ${diagnostics()}`);
    const connecting = chromium.connectOverCDP(endpoint, { timeout: requireLaunching() });
    // A connection that completes after a failed launch is still ours to close;
    // it cannot revive admission or observer state.
    void connecting.then(connected => { if (closePromise) return connected.close(); }).catch(() => {});
    browser = await duringLaunch(connecting);
    if (windowsJob) {
      requireLaunching();
      await duringLaunch((async () => {
        const session = await browser!.newBrowserCDPSession();
        try {
          const { processInfo } = await session.send("SystemInfo.getProcessInfo");
          if (!processInfo.some(({ id, type }) => type === "browser" && id === browserPid)) {
            throw new Error("CDP root differs from the owned Windows browser Job");
          }
        } finally { await session.detach(); }
      })());
    }
    if (observer) { requireLaunching(); await duringLaunch(observer.bind(browserPid!)); }
    requireLaunching();
    if (closed || !browserPid) throw new Error("Chromium exited during connection");
    launchCompleted = true;
    return { browser, processId: browserPid, close };
  } catch (error) {
    failLaunch(error instanceof Error ? error : new Error("Browser launch failed"));
    observer?.abort();
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Browser startup failed and cleanup is unconfirmed"); }
    throw error;
  }
}
