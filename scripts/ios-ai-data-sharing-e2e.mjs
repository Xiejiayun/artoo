#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildTestServer } from "../apps/server/dist/test-support.js";
import { buildAiDataSharingPolicy } from "../apps/server/dist/config/ai-data-sharing.js";
import { createSession } from "../apps/server/dist/auth/auth-service.js";
import { getE2EReportContext, writeE2EReport } from "./e2e-report.mjs";

const output = resolve("artifacts/ai-data-sharing", `native-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(output, { recursive: true });
const report = { ...getE2EReportContext(), started_at: new Date().toISOString(), passed: false, phases: [], checks: [], cleanup: {},
  scope: "iPhone native UI against authenticated migrated fixture server. Explicit fictional AI recipient; no external AI, Google OAuth, physical device, or App Store acceptance." };
const photos = [];
const save = () => { writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); writeE2EReport({ outputPath: join(output, "report.html"), title: "Artoo iOS · AI data sharing", report, screenshots: photos }); };
save();
async function run(name, command, args, cwd = process.cwd()) {
  const phase = { name, started_at: new Date().toISOString() }; report.phases.push(phase); save();
  const log = [];
  const logPath = join(output, `${name}.log`); writeFileSync(logPath, "");
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  phase.pid = child.pid; save();
  const record = (data) => { log.push(data); appendFileSync(logPath, data); };
  child.stdout.on("data", record); child.stderr.on("data", record);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  const text = Buffer.concat(log).toString(); writeFileSync(join(output, `${name}.log`), text);
  phase.exit_code = code; phase.finished_at = new Date().toISOString(); save();
  assert.equal(code, 0, `${name} failed; see its retained log`); return text;
}
let server, device, secretDirectory;
try {
  const source = join(output, "source"); mkdirSync(source);
  for (const name of ["project.yml", "Sources", "Resources", "Configuration", "Tests", "UITests"]) cpSync(resolve("apps/ios", name), join(source, name), { recursive: true });
  await run("generate", "xcodegen", ["generate"], source);
  const derived = join(output, "DerivedData");
  await run("build", "xcodebuild", ["-project", join(source, "Artoo.xcodeproj"), "-scheme", "ArtooUI", "-configuration", "Release", "-derivedDataPath", derived,
    "-jobs", "2", "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES", "build-for-testing"]);
  server = await buildTestServer({ aiDataSharingPolicy: buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Fixture AI recipient (test only)", privacy_url: "https://provider.example.com/privacy" }] }),
    authConfig: { enforceApiAuth: true }, deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: randomUUID() }, enableDevRoutes: false });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://localhost:${server.app.server.address().port}`;
  const owner = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" });
  const request = async (path, payload) => {
    const res = await server.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${owner.raw}` }, payload });
    assert.ok(res.statusCode < 300, `${path}: ${res.statusCode}`); return res.json();
  };
  const { task } = await request("/api/v1/tasks", { project_id: "proj_artoo", title: "Native consent acceptance task", acceptance_criteria: ["Share only after permission"], required_capabilities: ["code.modify"] });
  await request(`/api/v1/tasks/${task.id}/ready`, {});
  device = (await run("create", "xcrun", ["simctl", "create", "Artoo AI consent E2E", "com.apple.CoreSimulator.SimDeviceType.iPhone-16", "com.apple.CoreSimulator.SimRuntime.iOS-26-5"])).trim();
  report.owned_simulator = device; save();
  await run("boot", "xcrun", ["simctl", "boot", device]); await run("boot-ready", "xcrun", ["simctl", "bootstatus", device, "-b"]);
  const pairing = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
  const products = join(derived, "Build/Products");
  const manifests = readdirSync(products).filter((name) => name.endsWith(".xctestrun"));
  let manifest;
  // plutil output is a build manifest containing no fixture credentials yet.
  for (const name of manifests) {
    const candidate = JSON.parse(await run("read-manifest", "plutil", ["-convert", "json", "-o", "-", join(products, name)]));
    if (JSON.stringify(candidate).includes("ArtooUITests")) { manifest = candidate; break; }
  }
  assert.ok(manifest);
  let configured = 0;
  function prepare(value) {
    if (typeof value === "string") return value.replaceAll("__TESTROOT__", products);
    if (Array.isArray(value)) return value.map(prepare);
    if (!value || typeof value !== "object") return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prepare(item)]));
    if (next.BlueprintName === "ArtooUITests" || next.TestBundlePath?.includes("ArtooUITests.xctest")) {
      next.EnvironmentVariables = { ...next.EnvironmentVariables, ARTOO_AI_ORIGIN: origin, ARTOO_AI_CODE: pairing.code, ARTOO_AI_TASK: task.id, ARTOO_AI_TOKEN: owner.raw }; configured++;
    }
    return next;
  }
  manifest = prepare(manifest); assert.equal(configured, 1);
  secretDirectory = mkdtempSync(join(tmpdir(), "artoo-ai-consent-runner-"));
  const json = join(secretDirectory, "runner.json"), path = join(secretDirectory, "runner.xctestrun");
  writeFileSync(json, JSON.stringify(manifest), { mode: 0o600 });
  await run("prepare-runner", "plutil", ["-convert", "xml1", "-o", path, json]);
  await run("native-ui", "xcodebuild", ["-xctestrun", path, "-destination", `platform=iOS Simulator,id=${device}`, "-parallel-testing-enabled", "NO",
    "-only-testing:ArtooUITests/AIDataSharingUITests/testPermissionAboveAssignmentAndDurableWithdrawal", "-resultBundlePath", join(output, "Consent.xcresult"), "test-without-building"]);
  report.checks.push("Native nested assignment consent, decline without run, one authorized run, offline withdrawal and relaunch completed");
  report.passed = true;
} catch (error) { report.error = String(error); }
finally {
  if (secretDirectory) { rmSync(secretDirectory, { recursive: true, force: true }); report.cleanup.runner_credentials_removed = !existsSync(secretDirectory); }
  if (existsSync(join(output, "Consent.xcresult"))) {
    try {
      const attachments = join(output, "attachments");
      await run("attachments", "xcrun", ["xcresulttool", "export", "attachments", "--path", join(output, "Consent.xcresult"), "--output-path", attachments]);
      const manifest = JSON.parse(readFileSync(join(attachments, "manifest.json"), "utf8"));
      for (const test of manifest) for (const item of test.attachments ?? []) {
        const caption = item.suggestedHumanReadableName ?? "";
        if (!/^Native (AI disclosure|declined disclosure|recorded AI permission|withdrawal reports|withdrawn permission)/.test(caption)) continue;
        const path = join(attachments, item.exportedFileName);
        const data = readFileSync(path);
        if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
          const png = join(output, `native-${photos.length + 1}.png`); writeFileSync(png, data); photos.push({ path: png, caption });
        }
      }
    } catch (error) { report.attachment_error = String(error); report.passed = false; }
  }
  if (device) {
    try { await run("shutdown", "xcrun", ["simctl", "shutdown", device]); await run("delete", "xcrun", ["simctl", "delete", device]); report.cleanup.owned_simulator_deleted = true; }
    catch (error) { report.cleanup.simulator_error = String(error); report.passed = false; }
  }
  if (server) { try { await server.close(); report.cleanup.server_closed = true; } catch (error) { report.cleanup.server_error = String(error); report.passed = false; } }
  report.finished_at = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: report.passed, report: join(output, "report.html"), error: report.error }));
if (!report.passed) process.exitCode = 1;
