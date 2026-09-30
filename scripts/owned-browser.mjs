async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => ({ completed: true }), () => ({ completed: false, reason: "close rejected" })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ completed: false, reason: "close timed out" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Close only the BrowserServer returned by this run's launchServer().
 * Playwright's kill() targets its owned process group/tree and waits for its
 * temporary profile cleanup. A fulfilled close/kill alone is not evidence of
 * shutdown: independently require the ChildProcess exit event as well.
 */
export async function closeOwnedBrowser(browserServer, { gracefulTimeoutMs = 10_000, forceTimeoutMs = 10_000 } = {}) {
  const child = browserServer.process();
  const report = { pid: child?.pid ?? null, closed: false, method: "graceful", forced: false, stdio_released_after_exit: [] };
  if (!child?.pid) return { ...report, error: "Owned browser process is unavailable" };
  let onExit;
  const exited = new Promise((resolve) => {
    onExit = () => {
      // Chrome's detached crash reporter can inherit stderr after the browser
      // has exited. Node then withholds ChildProcess "close", which Playwright
      // needs to remove its profile and stop its WebSocket server. Release only
      // our stream handles, and only after the real browser exit is observed.
      // Still await Playwright's cleanup promise below; exit alone is not pass.
      for (const [index, stream] of (child.stdio ?? []).entries()) {
        if (stream && !stream.destroyed) {
          report.stdio_released_after_exit.push(index);
          stream.destroy();
        }
      }
      resolve();
    };
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else child.once("exit", onExit);
  });
  try {
    const graceful = await within(Promise.all([Promise.resolve().then(() => browserServer.close()), exited]), gracefulTimeoutMs);
    if (graceful.completed) report.closed = true;
    else {
      report.method = "forced"; report.forced = true; report.graceful_error = graceful.reason;
      // Never scan/kill browser names or unrelated PIDs. BrowserServer retains
      // the exact process handle and private group created by launchServer().
      const forced = await within(Promise.all([Promise.resolve().then(() => browserServer.kill()), exited]), forceTimeoutMs);
      report.closed = forced.completed;
      if (!forced.completed) report.error = `Owned browser forced ${forced.reason}; process exit and cleanup were not both confirmed`;
    }
    return { ...report, exit_code: child.exitCode, signal: child.signalCode };
  } finally { child.off("exit", onExit); }
}
