#!/usr/bin/env node
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const vendorVersion = "26.15.3";
const releaseName = "dmg-builder@1.2.5";
const checksums = {
  "dmgbuild-bundle-arm64-75c8a6c.tar.gz": "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb",
  "dmgbuild-bundle-x86_64-75c8a6c.tar.gz": "1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433",
};

function executableFile(path) {
  assert.ok(statSync(path).isFile(), `dmgbuild path is not a regular file: ${path}`);
  try { accessSync(path, constants.X_OK); }
  catch { throw new Error(`dmgbuild path is not executable: ${path}`); }
  return path;
}

export function configureDmgbuild(env, cwd) {
  const custom = env.CUSTOM_DMGBUILD_PATH?.trim();
  const path = executableFile(custom ? resolve(cwd, custom) : launcher);
  return {
    env: { ...env, CUSTOM_DMGBUILD_PATH: path,
      // The executable shebang must use the same Node as electron-builder.
      ...(!custom ? { PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}` } : {}) },
    policy: { source: custom ? "caller_override" : "repository_default", path,
      clean_detach_attempts: custom ? null : 10, toolset: custom ? null : releaseName },
  };
}

export function assertDmgbuildCompatibility(version, source) {
  const message = "Review the DMG launcher toolset pins before changing the installed dmg-builder";
  assert.equal(version, vendorVersion, message);
  for (const fragment of [
    `releaseName: "${releaseName}"`,
    'filenameWithExt: `dmgbuild-bundle-${arch}-75c8a6c.tar.gz`',
    ...Object.entries(checksums).map(([name, sha]) => `${JSON.stringify(name)}: ${JSON.stringify(sha)}`),
  ]) assert.ok(source.includes(fragment), message);
}

export function installedDownloader(from = require) {
  // Follow the actual build dependency chain before resolving the vendor's
  // downloader; an unrelated hoisted dmg-builder must not choose the toolset.
  const builderRequire = createRequire(from.resolve("electron-builder/package.json"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  const vendorRequire = createRequire(appBuilderRequire.resolve("dmg-builder/package.json"));
  const { version } = vendorRequire("./package.json");
  assertDmgbuildCompatibility(version, readFileSync(vendorRequire.resolve("./out/dmgUtil.js"), "utf8"));
  return vendorRequire("app-builder-lib/out/util/electronGet.js").downloadBuilderToolset;
}

export async function resolveDmgbuild({ arch = process.arch, download } = {}) {
  assert.ok(["x64", "arm64"].includes(arch), `Unsupported dmgbuild host architecture: ${arch}`);
  const vendorArch = arch === "arm64" ? "arm64" : "x86_64";
  const directory = await (download ?? installedDownloader())({ releaseName,
    filenameWithExt: `dmgbuild-bundle-${vendorArch}-75c8a6c.tar.gz`, checksums: { ...checksums } });
  return executableFile(resolve(directory, "dmgbuild"));
}

export async function runDmgbuild(args, options) {
  // argparse accepts abbreviated long options; protect the declared policy
  // from those too, while preserving positional values after an explicit --.
  for (const arg of args) {
    if (arg === "--") break;
    assert.ok(!(arg.startsWith("--") && "--detach-retries".startsWith(arg.split("=")[0])),
      "The repository DMG retry policy fixes --detach-retries at 10");
  }
  assert.equal(typeof process.execve, "function", "The DMG launcher requires Node.js 24+ with POSIX execve");
  const vendor = await resolveDmgbuild(options);
  // dmg-builder's customizeDmg already holds the global tmp toolset lock while
  // executing this launcher. Reacquiring that same lock here would deadlock.
  // Replace this process: argv boundaries, stdio, exit codes and signals stay
  // with the original vendor, inside the existing builder command timeout.
  process.execve(vendor, [vendor, "--detach-retries", "10", ...args], process.env);
}

if (process.argv[1] && resolve(process.argv[1]) === launcher) {
  runDmgbuild(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
