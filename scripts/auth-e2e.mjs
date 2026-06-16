#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repoRoot, "apps", "web");

function resolveCommand(command, commandArgs) {
  if (command === "npm" && process.platform === "win32") {
    const npmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) {
      throw new Error(`cannot find npm CLI at ${npmCli}`);
    }
    return [process.execPath, [npmCli, ...commandArgs]];
  }
  if (command === "npx" && process.platform === "win32") {
    const npxCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (!existsSync(npxCli)) {
      throw new Error(`cannot find npx CLI at ${npxCli}`);
    }
    return [process.execPath, [npxCli, ...commandArgs]];
  }
  return [command, commandArgs];
}

function run(name, command, commandArgs, options = {}) {
  console.log(`\n==> ${name}`);
  const [exe, args] = resolveCommand(command, commandArgs);
  const result = spawnSync(exe, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(result.error.message);
  }
  if (result.status !== 0) {
    console.error(`\nFAILED: ${name}`);
    process.exit(result.status ?? 1);
  }
}

run("build server", "npm", ["run", "build", "--workspace", "@artoo/server"]);
run("build auth-enabled web dist", "npm", ["run", "build", "--workspace", "@artoo/web"], {
  env: { VITE_AUTH_ENABLED: "true" },
});
run("single-origin auth authority Playwright", "npx", ["playwright", "test", "--config=playwright.authority.config.ts"], {
  cwd: webRoot,
});

console.log("\nAuth authority E2E passed.");
