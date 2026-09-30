import assert from "node:assert/strict";
import { test } from "node:test";
import { profileIsXcodeManaged, selectSigningProfile, signingSettings } from "./archive-device.mjs";

const team = "TESTTEAM12";
const identity = { sha1: "A".repeat(40), name: "Apple Development: Test" };
const profile = { uuid: "test-profile", applicationIdentifier: `${team}.*`, teams: [team], platforms: ["iOS"],
  development: true, created: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z", certificates: [identity.sha1] };
const input = { team, bundle: "dev.artoo.app", profiles: [profile], identities: [identity], now: Date.parse("2026-09-30T00:00:00Z") };

test("selects an existing wildcard development profile only with an explicit matching team and available certificate", () => {
  const selected = selectSigningProfile(input);
  assert.equal(selected.match, "wildcard"); assert.equal(selected.profile.uuid, profile.uuid);
  for (const patch of [{ team: undefined }, { team: "OTHERTEAM1" }, { identities: [] }, { identitySha1: "B".repeat(40) }]) {
    assert.throws(() => selectSigningProfile({ ...input, ...patch }));
  }
});

test("rejects expired, future, other-platform, distribution and nonmatching-bundle profiles", () => {
  for (const patch of [{ expires: "2026-01-01T00:00:00Z" }, { created: "2027-01-01T00:00:00Z" }, { platforms: ["OSX"] },
    { development: false }, { applicationIdentifier: `${team}.dev.other.app` }, { certificates: ["B".repeat(40)] }]) {
    assert.throws(() => selectSigningProfile({ ...input, profiles: [{ ...profile, ...patch }] }), /No existing/);
  }
});

test("fails closed on ambiguous identities/profiles and accepts explicit matching selectors", () => {
  const other = { ...profile, uuid: "second-profile", applicationIdentifier: `${team}.dev.artoo.app` };
  assert.throws(() => selectSigningProfile({ ...input, profiles: [profile, other] }), /Several existing/);
  assert.equal(selectSigningProfile({ ...input, profiles: [profile, other], profileUuid: other.uuid }).match, "exact");
  const secondIdentity = { ...identity, sha1: "B".repeat(40) };
  const multiple = { ...input, profiles: [{ ...profile, certificates: [identity.sha1, secondIdentity.sha1] }], identities: [identity, secondIdentity] };
  assert.throws(() => selectSigningProfile(multiple), /Several existing/);
  assert.equal(selectSigningProfile({ ...multiple, identitySha1: identity.sha1.toLowerCase() }).identity.sha1, identity.sha1);
  assert.equal(selectSigningProfile({ ...input, profiles: [profile, profile] }).profile.uuid, profile.uuid);
});

test("uses Xcode's permitted identity selector for managed profiles and never enables provisioning updates", () => {
  for (const xcodeManaged of [true, false]) {
    const selected = { profile: { ...profile, name: "iOS Team Provisioning Profile: *", xcodeManaged }, identity };
    const settings = signingSettings(team, selected);
    assert.ok(settings.includes(`DEVELOPMENT_TEAM=${team}`));
    assert.ok(settings.includes(`CODE_SIGN_IDENTITY=${xcodeManaged ? "Apple Development" : identity.sha1}`));
    assert.ok(settings.includes(`CODE_SIGN_STYLE=${xcodeManaged ? "Automatic" : "Manual"}`));
    assert.equal(settings.some((value) => value.startsWith("PROVISIONING_PROFILE_SPECIFIER=")), !xcodeManaged);
    assert.equal(settings.some((value) => value.includes("allowProvisioning")), false);
  }
});

test("reads actual plist boolean metadata without JSON scalar conversion", { skip: process.platform !== "darwin" }, () => {
  const plist = (value) => `<?xml version="1.0"?><plist version="1.0"><dict>${value}</dict></plist>`;
  assert.equal(profileIsXcodeManaged(plist("<key>IsXcodeManaged</key><true/>")), true);
  assert.equal(profileIsXcodeManaged(plist("<key>IsXcodeManaged</key><false/>")), false);
  assert.equal(profileIsXcodeManaged(plist("")), false);
});
