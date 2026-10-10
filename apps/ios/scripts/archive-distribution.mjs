#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getE2EReportContext, writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { readCommand, readProfile } from "./archive-device.mjs";
import { readReleaseToolchain } from "./release-toolchain.mjs";

const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(ios, "../..");

export function validateDistributionConfig(config) {
  assert.ok(config && typeof config === "object" && !Array.isArray(config), "A distribution configuration is required");
  assert.deepEqual(Object.keys(config).sort(), ["team", "bundle", "version", "build", "identitySha1", "profileUuid",
    "publisherName", "privacyPolicyURL", "supportURL"].sort(),
    "Configuration accepts only public signing and build metadata; do not include credentials");
  assert.match(config.team ?? "", /^[A-Z0-9]{10}$/, "Specify the publisher's Apple Team ID");
  assert.match(config.bundle ?? "", /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, "Specify the registered bundle ID");
  assert.match(config.version ?? "", /^\d+\.\d+\.\d+$/, "Specify a three-part release version");
  assert.match(config.build ?? "", /^[1-9]\d{0,3}(?:\.\d{1,2}){0,2}$/, "Specify a valid CFBundleVersion (one to three numeric components)");
  assert.match(config.identitySha1 ?? "", /^[A-Fa-f0-9]{40}$/, "Specify the distribution identity SHA-1");
  assert.match(config.profileUuid ?? "", /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/, "Specify the App Store provisioning profile UUID");
  assert.ok(typeof config.publisherName === "string" && config.publisherName.trim().length > 0, "Specify the real publisher name");
  for (const key of ["privacyPolicyURL", "supportURL"]) assertPublicPublisherURL(config[key]);
  return config;
}

export function assertPublicPublisherURL(value) {
  assert.ok(typeof value === "string" && value.length > 0, "A published HTTPS policy/support URL is required");
  const url = new URL(value);
  assert.ok(url.protocol === "https:" && url.hostname && !url.username && !url.password
    && url.hostname !== "localhost" && !url.hostname.endsWith(".local"), "Publisher links require HTTPS and no embedded credentials or local hostname");
  return url;
}

async function checkPublisherPage(value) {
  let url = assertPublicPublisherURL(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); assert.ok(location, "Publisher redirect must name its destination");
      url = assertPublicPublisherURL(new URL(location, url).href);
      continue;
    }
    assert.ok(response.status === 200 && /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? ""),
      "Publisher policy/support must be a publicly reachable HTML page");
    return { url: url.href, status: response.status, scope: "HTTPS reachability only; policy content requires publisher review" };
  }
  throw new Error("Publisher link redirects exceed the limit");
}

export function selectDistributionProfile({ config, profiles, identities, now = Date.now() }) {
  validateDistributionConfig(config);
  const identity = identities.filter((i) => i.sha1.toUpperCase() === config.identitySha1.toUpperCase()
    && /^(Apple Distribution|iPhone Distribution):/.test(i.name));
  assert.equal(identity.length, 1, "The selected valid Apple Distribution signing identity must be available locally");
  const profilesByUuid = profiles.filter((p) => p.uuid.toLowerCase() === config.profileUuid.toLowerCase());
  assert.equal(profilesByUuid.length, 1, "The selected App Store profile must be present and unambiguous");
  const profile = profilesByUuid[0];
  assert.ok(profile.teams.includes(config.team) && profile.profileTeam === config.team, "Profile team does not match the publisher");
  assert.ok(profile.platforms.includes("iOS"), "The selected profile must target iOS");
  // Legacy application identifier prefixes can differ from the team ID. Check
  // the profile's team separately; keep the entire app identifier for signing.
  const dot = profile.applicationIdentifier.indexOf(".");
  assert.ok(dot > 0 && profile.applicationIdentifier.slice(dot + 1) === config.bundle,
    "App Store distribution requires the exact registered bundle ID, not a wildcard");
  assert.ok(profile.getTaskAllow === false && profile.development === false && profile.betaReportsActive === true
    && profile.provisionedDevicesPresent === false && profile.provisionsAllDevicesPresent === false,
  "Only an App Store profile is accepted; development, ad hoc and enterprise profiles cannot qualify");
  assert.ok(Date.parse(profile.created) <= now && Date.parse(profile.expires) > now, "Profile must be currently valid");
  assert.ok(profile.certificates.includes(identity[0].sha1), "The profile must contain the selected signing certificate");
  return { profile, identity: identity[0] };
}

export function exportOptions(config) {
  validateDistributionConfig(config);
  return { method: "app-store-connect", destination: "export", teamID: config.team,
    signingStyle: "manual", signingCertificate: config.identitySha1.toUpperCase(),
    provisioningProfiles: { [config.bundle]: config.profileUuid }, manageAppVersionAndBuildNumber: false,
    uploadSymbols: true, stripSwiftSymbols: true };
}

export function verifyDistributionMetadata({ config, selected, info, entitlements }) {
  assert.equal(info.CFBundleIdentifier, config.bundle, "Archive bundle ID changed");
  assert.equal(info.CFBundleShortVersionString, config.version, "Release version changed");
  assert.equal(info.CFBundleVersion, config.build, "Build number changed");
  assert.equal(info.ArtooPublisherName, config.publisherName, "Publisher name must be embedded in the shipping app");
  assert.equal(info.ArtooPrivacyPolicyURL, config.privacyPolicyURL, "Privacy policy link must be embedded in the shipping app");
  assert.equal(info.ArtooSupportURL, config.supportURL, "Support link must be embedded in the shipping app");
  assert.equal(info.ITSAppUsesNonExemptEncryption, false, "The OS-only encryption declaration must be present for this release");
  assert.deepEqual(new Set(info.UIDeviceFamily), new Set([1, 2]), "The release must retain iPhone and iPad support");
  if (info.UIDeviceFamily?.includes(2)) {
    assert.deepEqual(new Set(info["UISupportedInterfaceOrientations~ipad"]), new Set([
      "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"
    ]), "iPad multitasking requires all four supported orientations");
  }
  assert.equal(info.DTPlatformName, "iphoneos", "Distribution must target physical iOS devices");
  assert.match(info.DTSDKName ?? "", /^iphoneos\d+(?:\.\d+)*$/, "Device SDK metadata is missing");
  assert.ok(Number(/^iphoneos(\d+)/.exec(info.DTSDKName)[1]) >= 26, "Archive requires iOS SDK 26 or later");
  assert.equal(entitlements["get-task-allow"], false, "A development-signed app must never be exported as release evidence");
  assert.equal(entitlements["com.apple.developer.team-identifier"], config.team, "Signed app team changed");
  assert.equal(entitlements["application-identifier"], selected.profile.applicationIdentifier, "Signed application identifier changed");
}

function writePlist(path, value) {
  writeFileSync(path, readCommand("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], JSON.stringify(value)));
}

function inspectApp(app, config, selected, output, label) {
  readCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const certPrefix = join(output, `${label}-signer-`);
  readCommand("/usr/bin/codesign", ["-d", `--extract-certificates=${certPrefix}`, app]);
  assert.equal(createHash("sha1").update(readFileSync(`${certPrefix}0`)).digest("hex").toUpperCase(), selected.identity.sha1);
  const profile = readProfile(join(app, "embedded.mobileprovision"));
  selectDistributionProfile({ config, profiles: [profile], identities: [selected.identity] });
  const info = JSON.parse(readCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Info.plist")]));
  const entitlements = JSON.parse(readCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"],
    readCommand("/usr/bin/codesign", ["-d", "--entitlements", ":-", app])));
  verifyDistributionMetadata({ config, selected, info, entitlements });
  const executable = join(app, info.CFBundleExecutable);
  assert.deepEqual(readCommand("/usr/bin/lipo", ["-archs", executable]).trim().split(/\s+/), ["arm64"]);
  assert.ok(statSync(join(app, "Assets.car")).size > 0, "Compiled assets must be present");
  readCommand("/usr/bin/plutil", ["-lint", join(app, "PrivacyInfo.xcprivacy")]);
  return { bundle: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, build: info.CFBundleVersion,
    sdk: info.DTSDKName, executable_sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    profile_uuid: profile.uuid, get_task_allow: entitlements["get-task-allow"] };
}

export async function main(args = process.argv.slice(2)) {
  const started = new Date().toISOString();
  const output = join(root, "artifacts", "ios-device", `distribution-${started.replace(/[:.]/g, "-")}`);
  mkdirSync(output, { recursive: true });
  const preflight = args.includes("--preflight");
  const report = { ...getE2EReportContext(), started_at: started, passed: false, checks: [], screenshots: [],
    scope: preflight ? "App Store signing and SDK preflight only; no archive or upload" :
      "App Store distribution archive and exported IPA verification; no upload, device UI, TestFlight processing or App Review acceptance",
    uploaded: false, device_ui_tested: false };
  const reportPath = join(output, "report.html");
  function save() {
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: reportPath, title: "Artoo · iOS App Store distribution", report });
  }
  function run(name, command, argv, cwd = output, timeout = 1_200_000) {
    const start = Date.now();
    const fd = openSync(join(output, "distribution.log"), "a");
    let result;
    try { result = spawnSync(command, argv, { cwd, stdio: ["ignore", fd, fd], timeout }); }
    finally { closeSync(fd); }
    const passed = !result.error && result.status === 0;
    report.checks.push({ name, passed, exit: result.status, duration_ms: Date.now() - start });
    assert.ok(passed, `${name} failed; inspect distribution.log`);
  }
  save();
  try {
    const configArgs = args.filter((a) => a.startsWith("--config="));
    assert.ok(configArgs.length === 1 && args.every((a) => a === "--preflight" || a.startsWith("--config="))
      && args.filter((a) => a === "--preflight").length <= 1, "Usage: archive-distribution.mjs --config=/absolute/config.json [--preflight]");
    assert.equal(process.platform, "darwin", "Distribution verification requires macOS");
    const config = validateDistributionConfig(JSON.parse(readFileSync(resolve(configArgs[0].slice(9)), "utf8")));
    report.configuration = config;
    report.toolchain = readReleaseToolchain();
    const spec = readFileSync(join(ios, "project.yml"), "utf8");
    assert.equal(/PRODUCT_BUNDLE_IDENTIFIER:\s*([A-Za-z0-9.-]+)/.exec(spec)?.[1], config.bundle,
      "Configure the actual shipping bundle ID in project.yml before archiving");
    const listing = readCommand("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    const identities = [...listing.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"((?:Apple Distribution|iPhone Distribution):[^"\n]+)"/gm)]
      .map((m) => ({ sha1: m[1], name: m[2] }));
    const profiles = [];
    for (const directory of [join(homedir(), "Library/MobileDevice/Provisioning Profiles"), join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")]) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!/\.(mobileprovision|provisionprofile)$/.test(name)) continue;
        try {
          const profile = readProfile(join(directory, name));
          if (!profiles.some((p) => p.uuid === profile.uuid && readFileSync(p.path).equals(readFileSync(profile.path)))) profiles.push(profile);
        } catch { report.unreadable_profiles = (report.unreadable_profiles ?? 0) + 1; }
      }
    }
    const selected = selectDistributionProfile({ config, profiles, identities });
    report.checks.push({ name: "Exact App Store profile, valid distribution identity and release SDK", passed: true });
    report.publisher_pages = { privacy: await checkPublisherPage(config.privacyPolicyURL), support: await checkPublisherPage(config.supportURL) };
    if (!preflight) {
      const snapshot = join(output, "source"); mkdirSync(snapshot);
      for (const name of ["project.yml", "Sources", "Resources", "Configuration", "Tests", "UITests"]) cpSync(join(ios, name), join(snapshot, name), { recursive: true });
      run("Generate isolated project", "xcodegen", ["generate"], snapshot, 60_000);
      const infoPath = join(snapshot, "Resources/Info.plist");
      const sourceInfo = JSON.parse(readCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath]));
      writePlist(infoPath, { ...sourceInfo, CFBundleShortVersionString: config.version, CFBundleVersion: config.build,
        ArtooPublisherName: config.publisherName, ArtooPrivacyPolicyURL: config.privacyPolicyURL, ArtooSupportURL: config.supportURL });
      const archive = join(output, "Artoo.xcarchive");
      run("Archive with App Store distribution signature", "xcodebuild", ["-project", join(snapshot, "Artoo.xcodeproj"), "-scheme", "Artoo",
        "-configuration", "Release", "-jobs", "2", "-destination", "generic/platform=iOS", "-derivedDataPath", join(output, "DerivedData"),
        "-archivePath", archive, "archive", `DEVELOPMENT_TEAM=${config.team}`, "CODE_SIGN_STYLE=Manual",
        `CODE_SIGN_IDENTITY=${selected.identity.sha1}`, `PROVISIONING_PROFILE_SPECIFIER=${selected.profile.uuid}`,
        `MARKETING_VERSION=${config.version}`, `CURRENT_PROJECT_VERSION=${config.build}`, "CODE_SIGNING_ALLOWED=YES", "CODE_SIGNING_REQUIRED=YES"], snapshot);
      report.archive = inspectApp(join(archive, "Products/Applications/Artoo.app"), config, selected, output, "archive");
      const options = join(output, "ExportOptions.plist"); writePlist(options, exportOptions(config));
      const exported = join(output, "export");
      run("Export App Store Connect IPA", "xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exported, "-exportOptionsPlist", options]);
      const ipas = readdirSync(exported).filter((p) => p.endsWith(".ipa"));
      assert.equal(ipas.length, 1, "Exactly one IPA must be exported");
      const ipa = join(exported, ipas[0]);
      const extracted = join(output, "verified-ipa");
      // The ZIP is produced by the owned xcodebuild export above, not an input download.
      run("Extract owned exported IPA", "/usr/bin/ditto", ["-x", "-k", ipa, extracted], output, 120_000);
      const apps = readdirSync(join(extracted, "Payload")).filter((name) => name.endsWith(".app"));
      assert.deepEqual(apps, ["Artoo.app"]);
      report.export = inspectApp(join(extracted, "Payload", apps[0]), config, selected, output, "export");
      report.ipa = { path: ipa, bytes: statSync(ipa).size, sha256: createHash("sha256").update(readFileSync(ipa)).digest("hex") };
      report.checks.push({ name: "Archive and IPA signatures, identity, SDK, metadata, assets and nondevelopment entitlements", passed: true });
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    report.passed = false;
  } finally {
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = JSON.stringify(report.source) === JSON.stringify(report.source_at_finish);
    if (!report.source_stable) { report.passed = false; report.error = "Source changed during distribution verification"; }
    report.finished_at = new Date().toISOString(); save();
    console.log(JSON.stringify({ passed: report.passed, report: reportPath, error: report.error, uploaded: false }));
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
