import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicPublisherURL, exportOptions, selectDistributionProfile, validateDistributionConfig, verifyDistributionMetadata } from "./archive-distribution.mjs";

const config = { team: "TESTTEAM12", bundle: "dev.artoo.app", version: "1.0.0", build: "2",
  identitySha1: "A".repeat(40), profileUuid: "12345678-1234-1234-1234-123456789ABC",
  publisherName: "Test publisher", privacyPolicyURL: "https://publisher.test/privacy", supportURL: "https://publisher.test/support" };
const identity = { sha1: config.identitySha1, name: "Apple Distribution: Fixture" };
const profile = { uuid: config.profileUuid, teams: [config.team], profileTeam: config.team, platforms: ["iOS"],
  applicationIdentifier: `OLDPREFIX1.${config.bundle}`, getTaskAllow: false, development: false, betaReportsActive: true,
  provisionedDevicesPresent: false, provisionsAllDevicesPresent: false,
  created: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z", certificates: [identity.sha1] };
const input = { config, profiles: [profile], identities: [identity], now: Date.parse("2026-10-10T00:00:00Z") };
const selected = { profile, identity };
const info = { CFBundleIdentifier: config.bundle, CFBundleShortVersionString: config.version,
  CFBundleVersion: config.build, DTPlatformName: "iphoneos", DTSDKName: "iphoneos26.5",
  ArtooPublisherName: config.publisherName, ArtooPrivacyPolicyURL: config.privacyPolicyURL, ArtooSupportURL: config.supportURL,
  ITSAppUsesNonExemptEncryption: false, UIDeviceFamily: [1, 2],
  "UISupportedInterfaceOrientations~ipad": ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"] };
const entitlements = { "get-task-allow": false, "com.apple.developer.team-identifier": config.team,
  "application-identifier": profile.applicationIdentifier };

test("selects an exact App Store profile with the selected valid distribution identity", () => {
  assert.deepEqual(selectDistributionProfile(input), selected);
  assert.doesNotThrow(() => verifyDistributionMetadata({ config, selected, info, entitlements }));
});

test("rejects development, ad hoc, enterprise, wildcard, and incomplete profile classifications", () => {
  for (const patch of [{ getTaskAllow: true, development: true }, { provisionedDevicesPresent: true },
    { provisionsAllDevicesPresent: true }, { betaReportsActive: false }, { getTaskAllow: undefined },
    { applicationIdentifier: `${config.team}.*` }]) {
    assert.throws(() => selectDistributionProfile({ ...input, profiles: [{ ...profile, ...patch }] }));
  }
});

test("rejects wrong team, wrong app, wrong platform, expired or future profiles", () => {
  for (const patch of [{ teams: ["OTHERTEAM1"] }, { profileTeam: "OTHERTEAM1" }, { platforms: ["OSX"] },
    { applicationIdentifier: `${config.team}.dev.other.app` }, { expires: "2026-01-01T00:00:00Z" },
    { created: "2027-01-01T00:00:00Z" }, { expires: "unknown" }]) {
    assert.throws(() => selectDistributionProfile({ ...input, profiles: [{ ...profile, ...patch }] }));
  }
});

test("requires an explicit existing certificate and unambiguous profile", () => {
  for (const patch of [{ identities: [] }, { profiles: [] }, { profiles: [profile, profile] },
    { identities: [{ ...identity, name: "Apple Development: Fixture" }] },
    { profiles: [{ ...profile, certificates: ["B".repeat(40)] }] }]) {
    assert.throws(() => selectDistributionProfile({ ...input, ...patch }));
  }
});

test("requires explicit version/build, signing selectors, and public metadata only", () => {
  for (const patch of [{ version: "" }, { version: "1.0" }, { build: "0" }, { build: "1beta" },
    { build: "10000" }, { build: "1.100" }, { bundle: "*" }, { team: undefined },
    { identitySha1: "auto" }, { profileUuid: "automatic" }, { password: "never-retain-this" }]) {
    assert.throws(() => validateDistributionConfig({ ...config, ...patch }));
  }
});

test("export cannot upload or silently change version or signing identity", () => {
  const options = exportOptions(config);
  assert.equal(options.method, "app-store-connect");
  assert.equal(options.destination, "export");
  assert.equal(options.manageAppVersionAndBuildNumber, false);
  assert.equal(options.signingStyle, "manual");
  assert.equal(options.signingCertificate, config.identitySha1);
  assert.deepEqual(options.provisioningProfiles, { [config.bundle]: config.profileUuid });
});

test("archive and IPA must retain device SDK and exact release metadata", () => {
  for (const patch of [{ DTPlatformName: "iphonesimulator" }, { DTSDKName: "iphoneos18.5" },
    { DTSDKName: "unknown" }, { CFBundleVersion: "1" }, { CFBundleShortVersionString: "0.1.0" },
    { CFBundleIdentifier: "dev.other.app" }, { ArtooPublisherName: undefined }, { ArtooPrivacyPolicyURL: undefined },
    { ArtooSupportURL: "https://another.test/support" }, { ITSAppUsesNonExemptEncryption: undefined },
    { "UISupportedInterfaceOrientations~ipad": ["UIInterfaceOrientationPortrait"] }]) {
    assert.throws(() => verifyDistributionMetadata({ config, selected, info: { ...info, ...patch }, entitlements }));
  }
});

test("release metadata requires real publisher fields and refuses unsafe link schemes", () => {
  for (const patch of [{ publisherName: " " }, { privacyPolicyURL: "" }, { supportURL: undefined }]) {
    assert.throws(() => validateDistributionConfig({ ...config, ...patch }));
  }
  for (const url of ["http://publisher.test", "https://localhost", "https://team.local", "https://user:secret@publisher.test", "file:///tmp/policy"]) {
    assert.throws(() => assertPublicPublisherURL(url));
  }
});

test("a signed development app or changed team/identifier cannot pass export verification", () => {
  for (const patch of [{ "get-task-allow": true }, { "get-task-allow": undefined },
    { "com.apple.developer.team-identifier": "OTHERTEAM1" }, { "application-identifier": `${config.team}.${config.bundle}` }]) {
    assert.throws(() => verifyDistributionMetadata({ config, selected, info, entitlements: { ...entitlements, ...patch } }));
  }
});
