import { spawnSync } from "node:child_process";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Close only the POSIX process group created by this caller's detached spawn.
 * Pass that child.pid even if the child leader has already exited. Ownership
 * comes from the retained spawn handle; this utility never discovers targets
 * by process name or scans other processes. It only queries its own PGID to
 * prevent self-signalling, then probes/signals the supplied owned group.
 */
export async function closeOwnedProcessGroup(pgid, { termTimeoutMs = 5000, killTimeoutMs = 5000, pollIntervalMs = 50 } = {}) {
  const started = performance.now();
  const result = { pgid: Number.isSafeInteger(pgid) ? pgid : null, closed: false, forced: false,
    termSent: false, killSent: false, alreadyGone: false, elapsedMs: 0 };
  const finish = () => ({ ...result, elapsedMs: Math.max(0, performance.now() - started) });
  const fail = (stage, code, message) => { result.error = { stage, code, message }; return finish(); };
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return fail("validate", "INVALID_PGID", "Expected a positive owned detached-spawn PGID other than the current process");
  }
  if (process.platform === "win32") return fail("validate", "UNSUPPORTED_PLATFORM", "POSIX process-group cleanup is unavailable on Windows");
  if (![termTimeoutMs, killTimeoutMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 5000)
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    return fail("validate", "INVALID_TIMEOUT", "Each cleanup grace period must be between 0 and 5000 milliseconds");
  }

  // Node exposes no getpgrp(). This bounded exact-PID query is intentionally
  // limited to ourselves; querying a target leader would fail once it exits.
  const own = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
  });
  const ownText = own.stdout?.trim() ?? "", ownPgid = Number(ownText);
  if (own.error || own.status !== 0 || !/^[1-9]\d*$/.test(ownText) || !Number.isSafeInteger(ownPgid)) {
    return fail("self-group", own.error?.code ?? "SELF_PGID_UNAVAILABLE", "Unable to confirm the current process group; no target was signalled");
  }
  if (pgid === ownPgid) return fail("validate", "SELF_PROCESS_GROUP", "Refusing to signal the current process group");

  const probe = () => {
    try { process.kill(-pgid, 0); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  };
  const waitUntilGone = async (timeoutMs, phase) => {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      let uncertain;
      try { if (!probe()) return true; }
      catch (error) {
        if (error?.code !== "EPERM") throw error;
        // On macOS an exiting, not-yet-reaped owned group can briefly be
        // observable only as EPERM. It is not proof of disappearance. Keep
        // probing within this same budget; persistent uncertainty fails below.
        uncertain = error;
        result.probeErrors ??= [];
        if (!result.probeErrors.some((item) => item.stage === phase && item.code === error.code)) result.probeErrors.push({ stage: phase, code: error.code });
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { if (uncertain) throw uncertain; return false; }
      await pause(Math.min(pollIntervalMs, remaining));
    }
  };
  let stage = "initial-probe";
  try {
    if (!probe()) { result.closed = true; result.alreadyGone = true; return finish(); }
    stage = "term";
    try { process.kill(-pgid, "SIGTERM"); result.termSent = true; }
    catch (error) {
      if (error?.code !== "ESRCH") throw error;
      // Confirm disappearance even when it raced the signal. If a group now
      // exists again, do not escalate against a potentially reused identity.
      if (!probe()) { result.closed = true; return finish(); }
      return fail(stage, "GROUP_IDENTITY_CHANGED", "The group disappeared during signalling but could not be confirmed gone");
    }
    stage = "term-wait";
    if (await waitUntilGone(termTimeoutMs, stage)) { result.closed = true; return finish(); }
    stage = "kill";
    try { process.kill(-pgid, "SIGKILL"); result.killSent = true; result.forced = true; }
    catch (error) {
      if (error?.code !== "ESRCH") throw error;
      if (!probe()) { result.closed = true; return finish(); }
      return fail(stage, "GROUP_IDENTITY_CHANGED", "The group disappeared during signalling but could not be confirmed gone");
    }
    stage = "kill-wait";
    if (await waitUntilGone(killTimeoutMs, stage)) { result.closed = true; return finish(); }
    return fail(stage, "GROUP_STILL_PRESENT", "The owned process group remains observable after the bounded SIGKILL wait");
  } catch (error) {
    return fail(stage, typeof error?.code === "string" ? error.code : "GROUP_CLEANUP_ERROR", "The owned process group could not be confirmed closed");
  }
}
