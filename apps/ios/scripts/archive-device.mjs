#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getE2EReportContext, writeE2EReport } from "../../../scripts/e2e-report.mjs";

const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(ios, "../..");

export function selectSigningProfile({ team, bundle, profiles, identities, profileUuid, identitySha1, now = Date.now() }) {
  assert.match(team ?? "", /^[A-Z0-9]{10}$/, "Set ARTOO_APPLE_TEAM_ID to the intended Apple developer Team ID");
  if (identitySha1) assert.match(identitySha1, /^[A-Fa-f0-9]{40}$/, "ARTOO_IOS_SIGNING_IDENTITY must be an identity SHA-1 from security find-identity");
  const candidates = [];
  for (const profile of profiles) {
    const pattern = profile.applicationIdentifier.split(".").slice(1).join(".");
    const matchesBundle = pattern === bundle || (pattern.endsWith("*") && bundle.startsWith(pattern.slice(0, -1)));
    if (!matchesBundle || !profile.teams.includes(team) || !profile.platforms.includes("iOS") || !profile.development ||
        !(Date.parse(profile.expires) > now) || !(Date.parse(profile.created) <= now) || (profileUuid && profile.uuid !== profileUuid)) continue;
    for (const identity of identities) {
      if ((identitySha1 && identity.sha1 !== identitySha1.toUpperCase()) || !profile.certificates.includes(identity.sha1)) continue;
      if (!candidates.some((item) => item.profile.uuid === profile.uuid && item.identity.sha1 === identity.sha1)) {
        candidates.push({ profile, identity, match: pattern === bundle ? "exact" : "wildcard" });
      }
    }
  }
  assert.ok(candidates.length, "No existing, valid iOS development profile matches this Team, bundle and available signing identity");
  assert.equal(candidates.length, 1, "Several existing signing choices match; set ARTOO_IOS_PROFILE_UUID and ARTOO_IOS_SIGNING_IDENTITY explicitly");
  return candidates[0];
}

export function signingSettings(team, selected) {
  return [`DEVELOPMENT_TEAM=${team}`, `CODE_SIGN_STYLE=${selected.profile.xcodeManaged ? "Automatic" : "Manual"}`,
    // Automatic signing rejects a certificate hash override. Xcode requires
    // its development selector; the exact selected leaf SHA-1 is verified on
    // the resulting archive before this gate can pass.
    `CODE_SIGN_IDENTITY=${selected.profile.xcodeManaged ? "Apple Development" : selected.identity.sha1}`,
    ...(selected.profile.xcodeManaged ? [] : [`PROVISIONING_PROFILE_SPECIFIER=${selected.profile.uuid}`]),
    "CODE_SIGNING_ALLOWED=YES", "CODE_SIGNING_REQUIRED=YES"];
}

function readCommand(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} could not read the requested public metadata`);
  return result.stdout;
}
function plistField(plist, key, format = "raw") {
  const value = readCommand("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], plist).trim();
  return format === "json" ? JSON.parse(value) : value;
}
export function profileIsXcodeManaged(plist) {
  // plutil's JSON format does not support a standalone boolean. Read the raw
  // value so an actual true flag cannot silently become a manual profile.
  try { return plistField(plist, "IsXcodeManaged") === "true"; } catch { return false; }
}
function readProfile(path) {
  const plist = readCommand("/usr/bin/security", ["cms", "-D", "-i", path]);
  const entitlements = plistField(plist, "Entitlements", "json");
  const certificates = [...plistField(plist, "DeveloperCertificates", "xml1").matchAll(/<data>([\s\S]*?)<\/data>/g)]
    .map((match) => createHash("sha1").update(Buffer.from(match[1].replace(/\s/g, ""), "base64")).digest("hex").toUpperCase());
  return { path, uuid: plistField(plist, "UUID"), teams: plistField(plist, "TeamIdentifier", "json"),
    platforms: plistField(plist, "Platform", "json"), expires: plistField(plist, "ExpirationDate"), created: plistField(plist, "CreationDate"),
    applicationIdentifier: entitlements["application-identifier"] ?? "", development: entitlements["get-task-allow"] === true, certificates, xcodeManaged: profileIsXcodeManaged(plist) };
}

async function main() {
  const args = process.argv.slice(2);
  const preflight = args.includes("--preflight");
  const started = new Date().toISOString();
  const output = join(root, "artifacts", "ios-device", started.replace(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  const report = { ...getE2EReportContext(), started_at: started, passed: false, checks: [],
    scope: preflight ? "Read-only signing preflight; no archive, device installation, UI execution or upload" : "Release development-signed device archive; build artifact only, no physical-device UI, TestFlight or App Store claim" };
  const htmlPath = join(output, "report.html");
  const save = () => {
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: htmlPath, title: "Artoo · iOS device development archive", report });
  };
  save();
  const check = (name) => { report.checks.push(name); console.log(`[archive] PASS ${name}`); };
  function buildStep(name, command, commandArgs, cwd) {
    const began = Date.now();
    const log = join(output, "archive.log");
    console.log(`[archive] ${name}; log: ${log}`);
    const fd = openSync(log, "a");
    let result;
    try { result = spawnSync(command, commandArgs, { cwd, stdio: ["ignore", fd, fd], timeout: 1_200_000 }); }
    finally { closeSync(fd); }
    const passed = !result.error && result.status === 0;
    report.checks.push({ name, passed, duration_ms: Date.now() - began });
    assert.ok(passed, `${name} failed (${result.status ?? result.error?.message}); inspect the local archive.log`);
  }
  try {
    assert.ok(args.every((arg) => arg === "--preflight"), "Usage: archive-device.mjs [--preflight]");
    assert.equal(process.platform, "darwin", "Device signing preflight requires macOS");
    const team = process.env.ARTOO_APPLE_TEAM_ID;
    assert.match(team ?? "", /^[A-Z0-9]{10}$/, "Set ARTOO_APPLE_TEAM_ID explicitly; the script never chooses an Apple team");
    const spec = readFileSync(join(ios, "project.yml"), "utf8");
    const bundle = /PRODUCT_BUNDLE_IDENTIFIER:\s*([A-Za-z0-9.-]+)/.exec(spec)?.[1];
    assert.ok(bundle, "The app bundle ID is missing from project.yml");
    const identityList = readCommand("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    const identities = [...identityList.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"((?:Apple Development|iPhone Developer):[^"\n]+)"/gm)]
      .map((match) => ({ sha1: match[1], name: match[2] }));
    const profiles = [];
    for (const directory of [join(homedir(), "Library/MobileDevice/Provisioning Profiles"), join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")]) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(mobileprovision|provisionprofile)$/.test(entry.name)) continue;
        try { profiles.push(readProfile(join(directory, entry.name))); }
        catch { report.unreadable_profile_count = (report.unreadable_profile_count ?? 0) + 1; }
      }
    }
    if (report.unreadable_profile_count && !process.env.ARTOO_IOS_PROFILE_UUID) throw new Error("Some local profiles could not be read; explicitly select a readable matching ARTOO_IOS_PROFILE_UUID");
    const selected = selectSigningProfile({ team, bundle, profiles, identities,
      profileUuid: process.env.ARTOO_IOS_PROFILE_UUID, identitySha1: process.env.ARTOO_IOS_SIGNING_IDENTITY });
    report.signing = { team_id: team, bundle_id: bundle, profile_uuid: selected.profile.uuid, profile_match: selected.match,
      profile_expires_at: selected.profile.expires, identity_sha1: selected.identity.sha1, mode: "existing-development-profile",
      profile_xcode_managed: selected.profile.xcodeManaged, style: selected.profile.xcodeManaged ? "Automatic" : "Manual",
      build_identity_selector: selected.profile.xcodeManaged ? "Apple Development" : selected.identity.sha1 };
    check("Existing development profile covers the bundle, matches the explicit Team and contains an available development identity");
    report.environment.xcode = readCommand("/usr/bin/xcodebuild", ["-version"]).trim().replaceAll("\n", " · ");
    if (!preflight) {
      const snapshot = join(output, "source"); mkdirSync(snapshot);
      for (const path of ["project.yml", "Sources", "Resources", "Configuration", "Tests", "UITests"]) cpSync(join(ios, path), join(snapshot, path), { recursive: true });
      buildStep("Generate an isolated Xcode project from the source snapshot", "xcodegen", ["generate"], snapshot);
      const archive = join(output, "Artoo.xcarchive");
      // Xcode-managed profiles require Automatic signing. Without
      // -allowProvisioningUpdates Xcode must use its existing local resources;
      // below we still verify the exact preselected profile and certificate.
      // No exportArchive, portal resource creation or upload is requested.
      buildStep("Archive a signed Release build for generic iOS devices", "/usr/bin/xcodebuild", ["-project", join(snapshot, "Artoo.xcodeproj"), "-scheme", "Artoo", "-configuration", "Release",
        "-destination", "generic/platform=iOS", "-derivedDataPath", join(output, "DerivedData"), "-archivePath", archive, "archive",
        ...signingSettings(team, selected)], snapshot);
      const app = join(archive, "Products/Applications/Artoo.app");
      readCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      const signatureResult = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], { encoding: "utf8", timeout: 30_000 });
      assert.equal(signatureResult.status, 0, "Cannot inspect the archived app signature");
      assert.ok(signatureResult.stderr.split("\n").includes(`TeamIdentifier=${team}`), "Archived signature Team does not match the selected Team");
      assert.ok(signatureResult.stderr.split("\n").includes(`Authority=${selected.identity.name}`), "Archived app was not signed by the selected development identity");
      const certificatePrefix = join(output, "signer-");
      readCommand("/usr/bin/codesign", ["-d", `--extract-certificates=${certificatePrefix}`, app]);
      assert.equal(createHash("sha1").update(readFileSync(`${certificatePrefix}0`)).digest("hex").toUpperCase(), selected.identity.sha1, "Archive signer certificate does not match the selected identity");
      const info = readFileSync(join(app, "Info.plist"));
      assert.equal(plistField(info, "CFBundleIdentifier"), bundle, "Archived bundle identifier changed");
      const embedded = readProfile(join(app, "embedded.mobileprovision"));
      assert.equal(embedded.uuid, selected.profile.uuid, "Archive embedded a different provisioning profile");
      assert.equal(selectSigningProfile({ team, bundle, profiles: [embedded], identities: [selected.identity] }).profile.uuid, selected.profile.uuid);
      const entitlements = JSON.parse(readCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], readCommand("/usr/bin/codesign", ["-d", "--entitlements", ":-", app])));
      assert.equal(entitlements["com.apple.developer.team-identifier"], team);
      assert.equal(entitlements["application-identifier"].split(".").slice(1).join("."), bundle);
      assert.equal(entitlements["get-task-allow"], true, "This gate must produce a development build");
      check("Archive code signature, Team, app identifier and embedded development profile verified");
      readCommand("/usr/bin/plutil", ["-lint", join(app, "PrivacyInfo.xcprivacy")]);
      assert.ok(statSync(join(app, "Assets.car")).size > 0, "Compiled asset catalog is missing");
      const executable = plistField(info, "CFBundleExecutable");
      assert.ok(readCommand("/usr/bin/lipo", ["-archs", join(app, executable)]).trim().split(/\s+/).includes("arm64"), "Archive is not built for physical iOS devices");
      report.artifact = { archive, app, version: plistField(info, "CFBundleShortVersionString"), build: plistField(info, "CFBundleVersion"), device_ui_tested: false, uploaded: false };
      check("Device arm64 executable, compiled assets and privacy manifest are present in the archive");
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    report.finished_at = new Date().toISOString(); save();
    console.log(JSON.stringify(report, null, 2));
    console.log(`[archive] HTML report: ${htmlPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
