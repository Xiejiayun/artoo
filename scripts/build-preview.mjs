import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
const npm = process.env.npm_execpath || resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const result = spawnSync(process.execPath, [npm, "run", "build"], {
  stdio: "inherit", windowsHide: true, env: { ...process.env, VITE_AUTH_ENABLED: "true" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
