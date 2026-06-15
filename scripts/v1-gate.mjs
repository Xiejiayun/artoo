#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipE2e = args.has("--skip-e2e") || process.env.ARTOO_V1_SKIP_E2E === "1";

const checks = [
  ["typecheck", "npm", ["run", "typecheck"]],
  ["build", "npm", ["run", "build"]],
  ["unit/integration tests", "npm", ["test"]],
  ...(skipE2e
    ? []
    : [["Playwright E2E", "npm", ["run", "test:e2e", "--workspace", "@artoo/web"]]]),
  ["whitespace diff", "git", ["diff", "--check"]],
];

function resolveCommand(command, commandArgs) {
  if (command === "npm" && process.platform === "win32") {
    const npmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) {
      throw new Error(`cannot find npm CLI at ${npmCli}`);
    }
    return [process.execPath, [npmCli, ...commandArgs]];
  }
  return [command, commandArgs];
}

let failed = false;
for (const [name, command, commandArgs] of checks) {
  console.log(`\n==> ${name}`);
  const [exe, args] = resolveCommand(command, commandArgs);
  const result = spawnSync(exe, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(result.error.message);
  }
  if (result.status !== 0) {
    console.error(`\nFAILED: ${name}`);
    failed = true;
    break;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\nAll automated v1 gates passed.");
  if (skipE2e) {
    console.log("Playwright E2E was skipped; do not use this as a release gate result.");
  }
  console.log("Manual/gated release checks are listed in docs/v1-release-gates.md.");
}
