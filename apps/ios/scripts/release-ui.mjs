#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getE2EReportContext, nativeReleaseImages, readXCTestScreenshots, writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { closeOwnedProcessGroup } from "../../../scripts/owned-process-group.mjs";
import { readReleaseToolchain } from "./release-toolchain.mjs";

const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(ios, "../..");
const caseName = "ReleaseReadinessUITests/testPublisherPolicyAndSupportBeforePairing()";

export function verifyReleaseUIResult(summary, tests, screenshots) {
  assert.equal(summary.result, "Passed");
  assert.equal(summary.totalTestCount, 1);
  assert.equal(summary.passedTests, 1);
  assert.equal(summary.failedTests, 0);
  assert.equal(summary.skippedTests, 0);
  assert.equal(summary.expectedFailures, 0);
  assert.deepEqual(summary.testFailures, []);
  const cases = [];
  function visit(nodes) {
    for (const node of nodes ?? []) {
      if (node.nodeType === "Failure Message") throw new Error("Release UI result contains a failure");
      if (node.nodeType === "Test Case") cases.push(node);
      visit(node.children);
    }
  }
  visit(tests.testNodes);
  assert.equal(cases.length, 1, "Exactly one release privacy case must run");
  assert.equal(cases[0].nodeIdentifier, caseName);
  assert.equal(cases[0].result, "Passed");
  for (const name of nativeReleaseImages) assert.equal(screenshots.filter((p) => p.caption === name
    || p.caption.startsWith(`${name}_`) || p.caption.startsWith(`${name}.`)).length, 1, `One actual screenshot is required: ${name}`);
}

export async function main() {
  const started = new Date().toISOString();
  const output = join(root, "artifacts/ios", `release-ui-${started.replace(/[:.]/g, "-")}`);
  mkdirSync(output, { recursive: true });
  const report = { ...getE2EReportContext(), started_at: started, passed: false, checks: [], devices: [],
    scope: "Fresh iPhone and iPad simulator release UI: native publisher links, public Safari pages and landscape. Captures normalize UIImage display orientation once; raw screen PNG attachments are retained separately. No paired account, eleven-case business acceptance, physical-device or TestFlight claim." };
  let child, abortReason;
  const screenshots = [];
  const stop = () => {
    abortReason ??= "Release UI verification interrupted";
    if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const save = () => {
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: join(output, "report.html"), title: "Artoo · publisher release UI", report, screenshots });
  };
  async function run(name, command, args, { cwd = output, timeout = 60_000, cleanup = false } = {}) {
    if (abortReason && !cleanup) throw new Error(abortReason);
    const began = Date.now(), fd = openSync(join(output, `${name}.log`), "w");
    let pgid, timer, killTimer, timedOut = false;
    const entry = { name, command, args, passed: false };
    report.checks.push(entry);
    try {
      let text = "";
      entry.exit_code = await new Promise((done, reject) => {
        child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", fd] });
        pgid = child.pid;
        child.stdout.on("data", (part) => { writeSync(fd, part); text += part.toString(); if (text.length > 32 * 1024 * 1024) child.kill("SIGTERM"); });
        timer = setTimeout(() => {
          timedOut = true;
          try { process.kill(-pgid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") reject(error); }
          killTimer = setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); } }, 5000);
        }, timeout);
        child.once("error", reject);
        child.once("close", (code) => { clearTimeout(timer); clearTimeout(killTimer); child = null; done(code); });
      });
      writeFileSync(join(output, `${name}-stdout.log`), text);
      entry.passed = entry.exit_code === 0 && !timedOut;
      assert.ok(entry.passed, `${name} failed; see retained logs`);
      return text;
    } finally {
      clearTimeout(timer); clearTimeout(killTimer); closeSync(fd);
      entry.timed_out = timedOut; entry.duration_ms = Date.now() - began;
      entry.process_cleanup = pgid ? await closeOwnedProcessGroup(pgid) : { closed: true, not_started: true };
      entry.passed = entry.passed && entry.process_cleanup.closed;
      console.log(JSON.stringify({ phase: name, passed: entry.passed, exit: entry.exit_code }));
      assert.ok(entry.process_cleanup.closed, `${name} process cleanup is incomplete`);
    }
  }
  save();
  try {
    assert.equal(process.platform, "darwin");
    assert.equal(process.argv.length, 2, "Usage: node apps/ios/scripts/release-ui.mjs");
    report.toolchain = readReleaseToolchain();
    const inventory = JSON.parse(await run("runtimes", "xcrun", ["simctl", "list", "runtimes", "--json"]));
    const sdk = report.toolchain.iphonesimulator.split(".").map(Number);
    const compatible = (version) => {
      const parts = version.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((parts[i] ?? 0) !== (sdk[i] ?? 0)) return (parts[i] ?? 0) < (sdk[i] ?? 0);
      return true;
    };
    const runtime = inventory.runtimes.filter((r) => r.isAvailable && r.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-")
      && Number(r.version.split(".")[0]) >= 26 && compatible(r.version))
      .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
    assert.ok(runtime, "An available iOS 26+ simulator runtime is required");
    report.runtime = { identifier: runtime.identifier, version: runtime.version };
    const snapshot = join(output, "source"); mkdirSync(snapshot);
    for (const name of ["project.yml", "Sources", "Resources", "Configuration", "Tests", "UITests"]) cpSync(join(ios, name), join(snapshot, name), { recursive: true });
    await run("generate", "xcodegen", ["generate"], { cwd: snapshot });
    const common = ["-project", join(snapshot, "Artoo.xcodeproj"), "-scheme", "ArtooUI", "-configuration", "Release",
      "-derivedDataPath", join(output, "DerivedData"), "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES"];
    await run("build", "xcodebuild", [...common, "-jobs", "2", "-destination", "generic/platform=iOS Simulator", "build-for-testing"], { timeout: 900_000 });
    for (const [kind, type] of [["iphone", "com.apple.CoreSimulator.SimDeviceType.iPhone-16"], ["ipad", "com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro"]]) {
      const directory = join(output, "devices", kind); mkdirSync(directory, { recursive: true });
      const entry = { kind, passed: false, created_by_this_run: false };
      report.devices.push(entry);
      const bundle = join(directory, "ReleasePrivacy.xcresult");
      try {
        const udid = (await run(`${kind}-create`, "xcrun", ["simctl", "create", `Artoo publisher ${kind} ${started}`, type, runtime.identifier])).trim();
        assert.match(udid, /^[A-F0-9-]{36}$/i); entry.udid = udid; entry.created_by_this_run = true;
        await run(`${kind}-boot`, "xcrun", ["simctl", "boot", udid]);
        await run(`${kind}-boot-ready`, "xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000 });
        await run(`${kind}-test`, "xcodebuild", [...common, "-destination", `platform=iOS Simulator,id=${udid}`, "-parallel-testing-enabled", "NO",
          "-resultBundlePath", bundle, `-only-testing:ArtooUITests/${caseName.slice(0, -2)}`, "test-without-building"], { timeout: 420_000 });
        entry.xctest_passed = true;
      } catch (error) { entry.error = error.message; }
      finally {
        if (existsSync(bundle)) {
          try {
            await run(`${kind}-attachments`, "xcrun", ["xcresulttool", "export", "attachments", "--path", bundle, "--output-path", join(directory, "ui-attachments")], { cleanup: true });
            const photos = readXCTestScreenshots(join(directory, "ui-attachments"));
            screenshots.push(...photos.map((p) => ({ ...p, caption: `${kind} · ${p.caption}` })));
            const summary = JSON.parse(await run(`${kind}-summary`, "xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", bundle], { cleanup: true }));
            const tests = JSON.parse(await run(`${kind}-tests`, "xcrun", ["xcresulttool", "get", "test-results", "tests", "--path", bundle], { cleanup: true }));
            writeFileSync(join(directory, "summary.json"), JSON.stringify(summary));
            writeFileSync(join(directory, "tests.json"), JSON.stringify(tests));
            verifyReleaseUIResult(summary, tests, photos);
            entry.passed = entry.xctest_passed === true; entry.photos = photos.length;
          } catch (error) { entry.passed = false; entry.evidence_error = error.message; }
        }
        if (entry.created_by_this_run) {
          try {
            // Delete only the exact fresh UUID returned by this run's create.
            await run(`${kind}-shutdown`, "xcrun", ["simctl", "shutdown", entry.udid], { cleanup: true });
            await run(`${kind}-delete`, "xcrun", ["simctl", "delete", entry.udid], { cleanup: true });
            entry.owned_device_removed = true;
          } catch (error) { entry.passed = false; entry.cleanup_error = error.message; }
        }
        writeFileSync(join(directory, "report.json"), JSON.stringify(entry, null, 2)); save();
      }
      if (!entry.passed) throw new Error(`${kind} release UI did not pass`);
    }
    report.passed = report.devices.length === 2 && report.devices.every((d) => d.passed && d.owned_device_removed)
      && report.checks.every((c) => c.passed);
  } catch (error) { report.error = error.message; report.passed = false; }
  finally {
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = JSON.stringify(report.source) === JSON.stringify(report.source_at_finish);
    report.passed = report.passed && report.source_stable && !abortReason;
    report.finished_at = new Date().toISOString(); save();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    console.log(JSON.stringify({ passed: report.passed, report: join(output, "report.html"), devices: report.devices }));
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
