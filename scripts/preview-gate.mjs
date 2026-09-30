#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const suite = args.find((arg) => arg.startsWith("--suite="))?.slice(8) ?? "shared";
if (args.some((arg) => arg !== "--list" && !/^--suite=(shared|ios|desktop|mac)$/.test(arg))) {
  throw new Error("Usage: npm run verify:preview -- [--suite=shared|ios|desktop|mac] [--list]");
}
const npm = [process.env.npm_execpath, resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].find((path) => path && existsSync(path));
const runNpm = (name, ...command) => ({ name, command: npm ? process.execPath : "npm", args: npm ? [npm, ...command] : command });
const runNode = (name, script) => ({ name, command: process.execPath, args: [script] });
const checks = {
  shared: [
    runNpm("typecheck", "run", "typecheck"),
    runNpm("production preview build", "run", "build:preview"),
    // Keep PGlite/WASM concurrency bounded on hosted runners.
    runNpm("unit and integration tests", "test", "--", "--maxWorkers=2"),
    runNode("E2E report integrity", "scripts/e2e-report.test.mjs"),
    runNode("E2E owned browser cleanup", "scripts/owned-browser.test.mjs"),
    runNode("native execution fixture integrity", "scripts/fixtures/ios-ui-execution.test.mjs"),
    runNode("device signing selection", "apps/ios/scripts/archive-device.test.mjs"),
    runNode("SDK-aware iPhone simulator selection", "apps/ios/scripts/simulator-selection.test.mjs"),
    runNode("native static API contracts", "apps/ios/scripts/verify-contracts.mjs"),
    runNpm("browser workflows", "run", "test:e2e", "--workspace", "@artoo/web"),
    runNpm("authentication browser workflows", "run", "e2e:auth"),
    runNpm("production dependency audit", "audit", "--omit=dev"),
    { name: "diff whitespace", command: "git", args: ["diff", "--check"] },
  ],
  ios: [
    runNode("SDK-aware iPhone simulator selection", "apps/ios/scripts/simulator-selection.test.mjs"),
    runNpm("production server and browser build", "run", "build:preview"),
    runNode("native static API contracts", "apps/ios/scripts/verify-contracts.mjs"),
    runNode("Xcode build and XCTest", "apps/ios/scripts/test-macos.mjs"),
    runNode("native and browser UI synchronization", "scripts/ios-ui-e2e.mjs"),
  ],
  desktop: [runNpm(process.platform === "darwin" ? "Mac packaged application smoke" : "Windows installed package smoke", "run", process.platform === "darwin" ? "smoke:mac" : "smoke:win", "--workspace", "@artoo/desktop")],
  mac: [
    runNode("Installed live provider opt-in and evidence routing", "apps/desktop/scripts/installed-live-provider.test.mjs"),
    runNode("Mac distribution configuration and mount integrity", "apps/desktop/scripts/mac-distribution.test.mjs"),
    runNpm("Mac execution and worker shutdown regressions", "test", "--", "--maxWorkers=1",
      "apps/artood/src/main.test.ts", "apps/artood/src/process-adapter.test.ts", "apps/server/src/desktop-worker-posix.test.ts"),
    runNpm("Mac DMG installation smoke", "run", "smoke:mac:dmg", "--workspace", "@artoo/desktop"),
  ],
}[suite];
if (args.includes("--list")) {
  console.log(JSON.stringify({ suite, checks: checks.map(({ name }) => name) }, null, 2));
} else {
  if (suite === "ios" && process.platform !== "darwin") throw new Error("The iOS suite requires macOS with Xcode, an iOS simulator and XcodeGen.");
  if (suite === "mac" && process.platform !== "darwin") throw new Error("The Mac suite requires macOS with a graphical desktop session.");
  if (suite === "desktop" && process.platform !== "darwin" && (process.platform !== "win32" || process.env.ARTOO_DESKTOP_INTERACTIVE !== "1")) {
    throw new Error("The desktop suite requires a logged-in Windows desktop. Set ARTOO_DESKTOP_INTERACTIVE=1 only in that session; hosted headless CI is not certified.");
  }
  const report = { suite, platform: process.platform, started_at: new Date().toISOString(), checks: [], passed: false };
  for (const check of checks) {
    console.log(`\n==> ${check.name}`);
    const started = Date.now();
    const result = spawnSync(check.command, check.args, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
    const passed = !result.error && result.status === 0;
    report.checks.push({ name: check.name, passed, exit_code: result.status, duration_ms: Date.now() - started });
    if (!passed) { console.error(result.error?.message ?? `${check.name} exited ${result.status ?? result.signal}`); break; }
  }
  report.passed = report.checks.length === checks.length && report.checks.every((check) => check.passed);
  const directory = resolve(root, "artifacts/preview-gate");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${suite}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
  console.log(`\n${suite} suite ${report.passed ? "passed" : "failed"}. This result covers only the selected suite.`);
  console.log("Real Google login, deployed TLS/WebSocket connectivity, real model credentials, signing and physical iOS devices remain separate acceptance checks; see docs/shared-server.md.");
}
