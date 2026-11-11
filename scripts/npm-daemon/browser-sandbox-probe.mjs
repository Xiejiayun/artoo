// CI-only blank-page diagnosis. This does not qualify product behavior or modify
// host security policy. The subsequent protected verifier remains the acceptance gate.
import assert from "node:assert/strict";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { OwnedGitError, runOwnedGit } from "../../apps/artood/dist/owned/owned-git.js";

const MAX_OUTPUT = 64 * 1024, TIMEOUT = 30000, TERMINATION_TIMEOUT = 5000;
const prefix = "artoo-browser-sandbox-probe-";

function readHostSetting(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const bytes = Buffer.alloc(4097), length = readSync(descriptor, bytes, 0, bytes.length, 0);
    return { path, value: bytes.subarray(0, Math.min(length, 4096)).toString("utf8").trim(), truncated: length > 4096 };
  } catch (error) { return { path, unavailable: true, code: error.code ?? null }; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function fileFacts(path) {
  const stat = lstatSync(path);
  return { path, regular_file: stat.isFile(), symbolic_link: stat.isSymbolicLink(), bytes: stat.size,
    links: stat.nlink, mode: stat.mode.toString(8), device: stat.dev, inode: stat.ino, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs };
}

async function main() {
  assert.equal(process.argv.length, 3, "Provide one existing absolute evidence directory");
  const requestedEvidence = process.argv[2];
  assert.ok(isAbsolute(requestedEvidence), "Evidence directory must be absolute");
  const directoryStat = lstatSync(requestedEvidence);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), "Evidence directory must be a physical directory");
  const evidence = realpathSync.native(requestedEvidence), receiptPath = join(evidence, "browser-sandbox-probe.json");
  assert.equal(existsSync(receiptPath), false, "Do not overwrite a previous diagnostic receipt");
  const receipt = { version: 1, scope: "controlled-blank-page-sandbox-probe", started_at: new Date().toISOString(), passed: false,
    host: { platform: process.platform, architecture: arch(), kernel: release(), node: process.version,
      uid: process.getuid?.() ?? null, euid: process.geteuid?.() ?? null,
      settings: ["/etc/os-release", "/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "/proc/sys/user/max_user_namespaces", "/proc/self/attr/current"].map(readHostSetting) },
    limits: { timeout_ms: TIMEOUT, termination_timeout_ms: TERMINATION_TIMEOUT, combined_output_bytes: MAX_OUTPUT },
    sandbox_disabling_arguments: false, host_security_policy_changes: false,
    binary: null, argv: [], stdout: "", stderr: "", owned: null,
    temporary: { path: null, removed: false, retained: false }, error: null };
  let temporary, temporaryParent, attempted = false, status = null;
  try {
    assert.equal(process.platform, "linux", "This probe requires Linux");
    assert.ok(receipt.host.uid !== 0 && receipt.host.euid !== 0, "Sandbox qualification must run as a non-root service user");
    const requestedBinary = process.env.ARTOO_TEST_CHROMIUM;
    assert.ok(requestedBinary && isAbsolute(requestedBinary), "ARTOO_TEST_CHROMIUM must identify an installed absolute browser path");
    const binary = realpathSync.native(requestedBinary);
    receipt.binary = fileFacts(binary);
    assert.ok(receipt.binary.regular_file && !receipt.binary.symbolic_link && receipt.binary.links === 1
      && receipt.binary.bytes > 0 && receipt.binary.bytes <= 256 * 1024 * 1024, "Browser must satisfy the unchanged protected file bound");
    temporaryParent = realpathSync.native(tmpdir());
    temporary = realpathSync.native(mkdtempSync(join(temporaryParent, prefix)));
    receipt.temporary.path = temporary;
    // Fixed local content and the same ordinary sandbox policy as the verifier.
    // Only the diagnostic transport changes: dump a blank DOM and capture stderr.
    receipt.argv = ["--headless", "--dump-dom", `--user-data-dir=${temporary}`, "--enable-logging=stderr",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--disable-component-extensions-with-background-pages", "--disable-default-apps", "--disable-extensions", "--disable-sync",
      "--disable-breakpad", "--disable-crash-reporter", "--disable-crashpad-for-testing", "--noerrdialogs",
      "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain", "about:blank"];
    attempted = true;
    const result = await runOwnedGit({ cwd: temporary, args: receipt.argv, kind: "materialize", signal: new AbortController().signal },
      { gitExecutable: binary, readTimeoutMs: TIMEOUT, materializeTimeoutMs: TIMEOUT, terminationTimeoutMs: TERMINATION_TIMEOUT,
        maxOutputBytes: MAX_OUTPUT, guardParent: true,
        environment: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: temporary, TMP: temporary, TEMP: temporary,
          XDG_CACHE_HOME: join(temporary, "cache"), XDG_CONFIG_HOME: join(temporary, "config") } });
    status = result.status; receipt.owned = result.receipt;
    receipt.stdout = result.stdout.toString("utf8"); receipt.stderr = result.stderr.toString("utf8");
    assert.deepEqual(fileFacts(binary), receipt.binary, "Browser metadata changed during the probe");
    assert.equal(status, 0, "Browser exited unsuccessfully; inspect bounded stderr");
    assert.equal(receipt.owned.childStatus, 0); assert.equal(receipt.owned.childSignal, null);
    for (const key of ["spawned", "childExitObserved", "childCloseObserved", "cleanupConfirmed", "observersDisposed"]) assert.equal(receipt.owned[key], true, key);
    assert.equal(receipt.owned.groupState, "absent"); assert.ok(receipt.owned.groupAbsentObservedAt);
    assert.equal(receipt.owned.trigger, null); assert.equal(receipt.owned.outputTruncated, false);
    const guard = receipt.owned.parent_guard;
    assert.ok(guard, "Parent lifetime guardian receipt is required");
    for (const key of ["spawned", "exitObserved", "closeObserved", "groupAbsentObserved", "cleanupConfirmed"]) assert.equal(guard[key], true, `parent_guard.${key}`);
    assert.equal(guard.status, 0); assert.equal(guard.signal, null);
    assert.match(receipt.stdout.trim(), /^<html><head><\/head><body><\/body><\/html>$/, "The actual blank-page DOM was not returned");
    receipt.passed = true;
  } catch (error) {
    if (error instanceof OwnedGitError) {
      receipt.owned = error.receipt; status = error.receipt.childStatus;
      receipt.stdout = error.stdout.toString("utf8"); receipt.stderr = error.stderr.toString("utf8");
    }
    receipt.error = { name: error.name ?? "Error", code: error.code ?? null, message: String(error.message ?? error).slice(0, 2000) };
  } finally {
    if (temporary) {
      const closed = !attempted || receipt.owned?.cleanupConfirmed === true && receipt.owned.childExitObserved === true
        && receipt.owned.childCloseObserved === true && receipt.owned.groupState === "absent" && receipt.owned.parent_guard?.cleanupConfirmed === true;
      if (closed) {
        try {
          const stat = lstatSync(temporary);
          assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync.native(temporary) === temporary
            && dirname(temporary) === temporaryParent && basename(temporary).startsWith(prefix), "Temporary path identity changed; retain it");
          rmSync(temporary, { recursive: true }); receipt.temporary.removed = !existsSync(temporary);
          assert.equal(receipt.temporary.removed, true, "Temporary profile removal was not confirmed");
        } catch (error) {
          receipt.passed = false;
          receipt.cleanup_error = { name: error.name ?? "Error", code: error.code ?? null, message: String(error.message ?? error).slice(0, 2000) };
        }
      }
      receipt.temporary.retained = !receipt.temporary.removed;
    }
    receipt.browser_status = status; receipt.finished_at = new Date().toISOString();
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ receipt: receiptPath, passed: receipt.passed, browser_status: status,
    process_group_closed: receipt.owned?.groupState === "absent", temporary_retained: receipt.temporary.retained }));
  if (!receipt.passed) process.exitCode = 1;
}

await main().catch(error => { console.error(String(error.message ?? error)); process.exitCode = 1; });
