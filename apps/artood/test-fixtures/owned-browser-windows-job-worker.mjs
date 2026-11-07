// Native nested-Job fixture worker. Only the local test controller invokes this file.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { launchOwnedBrowser } from "../dist/owned-browser.js";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";

if (process.platform !== "win32" || process.env.ARTOO_WINDOWS_BROWSER_JOB_NATIVE_WINDOW !== "1") throw new Error("Explicit native browser Job fixture window is required");
const [rootArg, mode, executableArg, bundleArg, manifestSha256] = process.argv.slice(2);
if (![rootArg, executableArg, bundleArg].every(value => typeof value === "string" && isAbsolute(value))
  || !["normal", "abort", "outer-cancel"].includes(mode) || !/^sha256:[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("Invalid fixed fixture inputs");
const root = realpathSync.native(rootArg), workspace = join(root, "workspace"), temporary = realpathSync.native(join(root, "temporary"));
const executablePath = realpathSync.native(executableArg), directory = realpathSync.native(bundleArg);
// Arguments carry local installation coordinates, never authority. Requalify all
// installation ACL/reparse/hash checks in this process to obtain its own backend.
const backend = prepareWindowsProcessInstallation({ directory, manifestSha256, writableWorkspaceRoots: [root] });
const controller = new AbortController();
const owned = await launchOwnedBrowser({ workspace, executablePath, windowsProcessBackend: backend, signal: controller.signal });
const names = readdirSync(temporary).filter(name => name.startsWith("artoo-owned-browser-"));
assert.equal(names.length, 1, "Dedicated fixture TEMP must contain the one owned browser profile");
const profile = join(temporary, names[0]), tail = relative(temporary, realpathSync.native(profile));
assert.ok(tail && tail !== ".." && !tail.startsWith(".." + sep) && !isAbsolute(tail));
assert.equal(lstatSync(profile).isSymbolicLink(), false);
const context = await owned.browser.newContext(), page = await context.newPage();
await page.setContent("<!doctype html><html lang='en'><title>Nested Job</title><h1>Real Windows renderer</h1></html>");
assert.equal(await page.title(), "Nested Job");
const session = await owned.browser.newBrowserCDPSession();
const { processInfo } = await session.send("SystemInfo.getProcessInfo"); await session.detach();
assert.ok(processInfo.some(item => item.id === owned.processId), "CDP must report the owned Chrome root");
assert.ok(processInfo.some(item => item.id !== owned.processId), "The real browser must exercise descendants");
const facts = { version: 1, mode, worker_pid: process.pid, browser_pid: owned.processId, profile,
  nested_job: true, real_renderer: true, cdp_process_count: processInfo.length };
if (mode === "outer-cancel") {
  const ready = join(root, "ready.json"), temporaryReady = join(root, "ready.tmp");
  assert.equal(existsSync(ready), false);
  writeFileSync(temporaryReady, JSON.stringify(facts), { flag: "wx" });
  renameSync(temporaryReady, ready);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (mode === "normal") {
  await page.close(); await context.close();
  const first = owned.close(); assert.equal(owned.close(), first); await first;
  assert.equal(existsSync(profile), false);
  writeFileSync(join(root, "facts.json"), JSON.stringify({ ...facts, page_closed: true, context_closed: true,
    close_passed: true, profile_removed: true, repeated_close_same_promise: true }));
} else {
  controller.abort(); let closeError;
  try { await owned.close(); } catch (error) { closeError = error; }
  assert.ok(closeError instanceof Error); assert.match(closeError.message, /launch or session failed|profile is retained/);
  assert.equal(existsSync(profile), true, "Confirmed cleanup must not erase an externally cancelled session's retained profile");
  writeFileSync(join(root, "facts.json"), JSON.stringify({ ...facts, close_passed: false, external_abort_rejected: true,
    profile_retained: true, close_error: closeError.message }));
}
