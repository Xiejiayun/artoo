#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const suite = args.find((arg) => arg.startsWith("--suite="))?.slice(8) ?? "shared";
if (args.some((arg) => arg !== "--list" && !/^--suite=(shared|shared-checks|desktop)$/.test(arg))) {
  throw new Error("Usage: npm run verify:preview -- [--suite=shared|shared-checks|desktop] [--list]");
}
const npm = [process.env.npm_execpath, resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].find(
  (path) => path && existsSync(path),
);
const runNpm = (name, ...command) => ({
  name,
  command: npm ? process.execPath : "npm",
  args: npm ? [npm, ...command] : command,
});
const runNode = (name, script) => ({ name, command: process.execPath, args: [script] });
// CI partitions this inventory into two two-worker jobs and one serial
// Windows process job; its aggregate checks actual reporter file coverage.
// The default local shared suite still executes it here exactly once.
const unitAndIntegration = runNpm("unit and integration tests", "test", "--", "--maxWorkers=2");
const suites = {
  shared: [
    runNpm("typecheck", "run", "typecheck"),
    runNpm("production preview build", "run", "build:preview"),
    // Keep PGlite/WASM concurrency bounded on hosted runners.
    unitAndIntegration,
    runNode("CI Vitest partition coverage", "scripts/ci-vitest-coverage.test.mjs"),
    runNode("npm daemon CLI and release contract", "scripts/npm-daemon/cli.test.mjs"),
    runNode("Fixed application service host packaging", "apps/artood/scripts/build-application-service-host.test.mjs"),
    runNode("Fixed application runtime packaging", "apps/artood/scripts/build-application-runtime.test.mjs"),
    runNode("E2E report integrity", "scripts/e2e-report.test.mjs"),
    runNode("PNG evidence integrity", "scripts/png-evidence.test.mjs"),
    runNode("E2E owned browser cleanup", "scripts/owned-browser.test.mjs"),
    runNpm("browser workflows", "run", "test:e2e", "--workspace", "@artoo/web"),
    runNpm("enabled scheduler mirror workflows", "run", "test:e2e:scheduler", "--workspace", "@artoo/web"),
    runNpm("enabled execution capacity workflows", "run", "test:e2e:capacity", "--workspace", "@artoo/web"),
    runNpm(
      "enabled enqueue business workflows",
      "test",
      "--",
      "--config",
      "vitest.enqueue.config.mjs",
      "--maxWorkers=2",
    ),
    runNpm("authentication browser workflows", "run", "e2e:auth"),
    runNpm("production dependency audit", "audit", "--omit=dev"),
    { name: "diff whitespace", command: "git", args: ["diff", "--check"] },
  ],
  desktop: [runNpm("Windows installed package smoke", "run", "smoke:win", "--workspace", "@artoo/desktop")],
};
const checks =
  suite === "shared-checks" ? suites.shared.filter((check) => check !== unitAndIntegration) : suites[suite];
if (args.includes("--list")) {
  console.log(JSON.stringify({ suite, checks: checks.map(({ name }) => name) }, null, 2));
} else {
  if (suite === "desktop" && (process.platform !== "win32" || process.env.ARTOO_DESKTOP_INTERACTIVE !== "1")) {
    throw new Error(
      "The desktop suite requires a logged-in Windows desktop. Set ARTOO_DESKTOP_INTERACTIVE=1 only in that session; hosted headless CI is not certified.",
    );
  }
  const report = { suite, platform: process.platform, started_at: new Date().toISOString(), checks: [], passed: false };
  for (const check of checks) {
    console.log(`\n==> ${check.name}`);
    const started = Date.now();
    const result = spawnSync(check.command, check.args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    const passed = !result.error && result.status === 0;
    report.checks.push({ name: check.name, passed, exit_code: result.status, duration_ms: Date.now() - started });
    if (!passed) {
      console.error(result.error?.message ?? `${check.name} exited ${result.status ?? result.signal}`);
      break;
    }
  }
  report.passed = report.checks.length === checks.length && report.checks.every((check) => check.passed);
  const directory = resolve(root, "artifacts/preview-gate");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${suite}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
  console.log(`\n${suite} suite ${report.passed ? "passed" : "failed"}. This result covers only the selected suite.`);
  console.log(
    "Real Google login, deployed TLS/WebSocket connectivity, real model credentials and signed distribution remain separate acceptance checks; see docs/shared-server.md.",
  );
}
