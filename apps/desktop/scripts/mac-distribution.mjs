import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getE2EReportContext, redact } from "../../../scripts/e2e-report.mjs";
import { configureDmgbuild } from "./mac-dmgbuild.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const require = createRequire(import.meta.url);
export const fileSha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function runMacCommand(command, args, options = {}) {
  const { logFile, ...spawnOptions } = options;
  const env = spawnOptions.env ?? process.env;
  const result = spawnSync(command, args, { cwd: desktop, env, encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024, ...spawnOptions });
  const diagnostic = [["error", result.error?.message], ["stdout", result.stdout], ["stderr", result.stderr]]
    .filter(([, value]) => value?.trim()).map(([stream, value]) => {
      let safe = redact(value);
      // Replace known sensitive values if a child echoes them. Never serialize
      // the environment or command arguments, and redact before taking tails.
      for (const [key, secret] of Object.entries(env)) {
        if (secret && /token|secret|password|private.?key|api.?key|authorization|cookie|^CSC_LINK$/i.test(key)) safe = safe.replaceAll(secret, "[redacted]");
      }
      return `${stream} (last 4096 characters):\n${safe.slice(-4096)}`;
    }).join("\n");
  if (logFile) appendFileSync(logFile, `\n${new Date().toISOString()} ${basename(command)} exit=${result.status ?? result.signal ?? "unknown"}\n${diagnostic}\n`, { mode: 0o600 });
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} failed (${result.status ?? result.signal ?? "unknown"}): ${diagnostic || "command produced no diagnostic output"}`);
  return result;
}

export function releaseSettings(mode, submitNotarization, env = process.env) {
  assert.ok(["preview", "release"].includes(mode), "Choose preview or release explicitly");
  if (mode === "preview") {
    assert.equal(submitNotarization, false, "Unsigned preview never submits to Apple");
    return { mode, identity: null };
  }
  const identity = env.ARTOO_MAC_SIGN_IDENTITY?.trim();
  const team = env.ARTOO_APPLE_TEAM_ID?.trim();
  const profile = env.ARTOO_NOTARY_KEYCHAIN_PROFILE?.trim();
  assert.ok(identity && /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity), "Release requires ARTOO_MAC_SIGN_IDENTITY with a Developer ID Application identity");
  assert.ok(team && /^[A-Z0-9]{10}$/.test(team) && identity.endsWith(`(${team})`), "ARTOO_APPLE_TEAM_ID must match the Developer ID identity");
  assert.ok(profile, "Release requires ARTOO_NOTARY_KEYCHAIN_PROFILE; store notarization credentials with notarytool first");
  assert.equal(submitNotarization, true, "Release requires explicit --submit-notarization to authorize uploads to Apple. Nothing is published automatically");
  return { mode, identity, team, profile };
}

export function distributionConfig(base, { mode, identity }, output, architecture, version) {
  assert.ok(["x64", "arm64"].includes(architecture), "Mac distribution architecture must be x64 or arm64");
  return { ...base, publish: null, forceCodeSigning: mode === "release", electronDist: join(root, "node_modules/electron/dist"),
    directories: { ...base.directories, output }, artifactName: `Artoo-${version}-${architecture}-${mode}.\${ext}`,
    // electron-builder chooses the certificate type itself and rejects an
    // identity qualifier with the Developer ID Application prefix included.
    mac: { ...base.mac, target: ["dmg", "zip"], identity: identity?.replace(/^Developer ID Application: /, "") ?? null, hardenedRuntime: true, notarize: false },
    dmg: { ...base.dmg, sign: false },
  };
}

/** A new directory and exact filenames prevent an older installer being tested.
 * Release uploads require an explicit flag; electron-builder publishing and
 * implicit notarization stay disabled in both modes.
 */
export function buildMacDistribution({ mode = "preview", submitNotarization = false, architecture = process.arch, env = process.env, execute = runMacCommand } = {}) {
  const settings = releaseSettings(mode, submitNotarization, env);
  assert.equal(process.platform, "darwin", "Mac distribution requires macOS");
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const output = join(desktop, "release", "mac-distribution", `${mode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const manifestPath = join(output, "distribution.json");
  const logFile = join(output, "build.log");
  const run = (command, args, options = {}) => execute(command, args, { ...options, logFile });
  const report = { ...getE2EReportContext(), mode, architecture, version: pkg.version, started_at: new Date().toISOString(), passed: false,
    distribution: mode === "preview" ? "Unsigned preview: no Developer ID trust, notarization or Gatekeeper acceptance claim" : "Developer ID signed and Apple-notarized local artifacts; no release-host upload", build_log: logFile, files: [] };
  try {
    if (mode === "release") {
      const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout;
      assert.ok(identities.includes(`"${settings.identity}"`), "Configured Developer ID identity and private key are unavailable");
      run("xcrun", ["notarytool", "history", "--keychain-profile", settings.profile, "--output-format", "json"]);
    }
    const npm = env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    assert.ok(existsSync(npm), "Run this command through npm, or use a Node installation with npm");
    const buildEnv = { ...env, VITE_AUTH_ENABLED: "true", npm_config_arch: architecture, ELECTRON_INSTALL_ARCH: architecture };
    // Do not import an unrelated signing certificate from inherited CI settings.
    for (const key of Object.keys(buildEnv)) if (key.startsWith("CSC_") || key.startsWith("APPLE_")) delete buildEnv[key];
    if (mode === "preview") buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    const dmgbuild = configureDmgbuild(buildEnv, desktop);
    report.dmgbuild = { ...dmgbuild.policy, sha256: fileSha256(dmgbuild.env.CUSTOM_DMGBUILD_PATH) };
    for (const script of ["prepare-renderer", "bundle-daemon"]) {
      console.log(`[mac-distribution] ${script}`);
      run(process.execPath, [npm, "run", script, "--workspace", "@artoo/desktop"], { cwd: root, env: buildEnv });
    }
    run(process.execPath, [npm, "exec", "--no", "--", "install-electron"], { cwd: desktop, env: buildEnv });
    const electronArchitectures = run("lipo", ["-archs", join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")]).stdout.trim().split(/\s+/);
    assert.ok(electronArchitectures.includes(architecture === "x64" ? "x86_64" : architecture), "Installed Electron architecture differs from the requested package; reinstall Electron for this architecture before building");
    const config = distributionConfig(pkg.build, settings, output, architecture, pkg.version);
    const configPath = join(output, "builder-config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const builder = require.resolve("electron-builder/out/cli/cli.js");
    const build = (args) => run(process.execPath, [builder, "--config", configPath, `--${architecture}`, "--publish", "never", ...args], { cwd: desktop, env: dmgbuild.env });
    const app = join(output, architecture === "arm64" ? "mac-arm64" : "mac", "Artoo.app");
    if (mode === "release") {
      build(["--mac", "dir"]);
      run("codesign", ["--verify", "--deep", "--strict", app]);
      const signature = run("codesign", ["--display", "--verbose=4", app]).stderr;
      assert.ok(signature.includes(`Authority=${settings.identity}`) && signature.includes(`TeamIdentifier=${settings.team}`), "Built app does not have the configured Developer ID signature");
      const notarize = (path) => {
        const result = JSON.parse(run("xcrun", ["notarytool", "submit", path, "--keychain-profile", settings.profile, "--wait", "--output-format", "json"], { timeout: 1_200_000 }).stdout);
        assert.equal(result.status, "Accepted", "Apple did not accept the notarization submission");
        return result.id;
      };
      const submission = join(output, "app-notarization.zip");
      run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, submission]);
      report.app_notarization_id = notarize(submission);
      run("xcrun", ["stapler", "staple", app]); run("xcrun", ["stapler", "validate", app]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
      build(["--prepackaged", app, "--mac", "dmg", "zip"]);
      const dmg = join(output, `Artoo-${pkg.version}-${architecture}-${mode}.dmg`);
      run("codesign", ["--force", "--timestamp", "--sign", settings.identity, dmg]);
      run("codesign", ["--verify", "--strict", dmg]);
      report.dmg_notarization_id = notarize(dmg);
      run("xcrun", ["stapler", "staple", dmg]); run("xcrun", ["stapler", "validate", dmg]);
      run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
    } else build(["--mac", "dmg", "zip"]);
    for (const extension of ["dmg", "zip"]) {
      const path = join(output, `Artoo-${pkg.version}-${architecture}-${mode}.${extension}`);
      assert.ok(existsSync(path), `Builder did not produce this invocation's ${extension.toUpperCase()}`);
      report.files.push({ kind: extension, path, sha256: fileSha256(path) });
    }
    report.passed = true;
    return { ...report, output, manifestPath };
  } catch (error) { report.error = error.message; throw error; }
  finally { report.finished_at = new Date().toISOString(); writeFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`); console.log(`[mac-distribution] Manifest: ${manifestPath}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length > 0 && args.every((arg) => ["--preview", "--release", "--submit-notarization"].includes(arg)) && args.includes("--preview") !== args.includes("--release"), "Usage: mac-distribution.mjs --preview | --release --submit-notarization");
    buildMacDistribution({ mode: args.includes("--release") ? "release" : "preview", submitNotarization: args.includes("--submit-notarization") });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
