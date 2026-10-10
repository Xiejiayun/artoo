# iOS App Store distribution

The distribution command creates and verifies a release archive and exports an
App Store Connect IPA. It does not upload, install on a physical device, qualify
TestFlight processing or submit for App Review. A successful development archive
is a separate result and cannot satisfy this gate.

## Required existing signing resources

Use Xcode 26 or later with the device and simulator SDKs at version 26 or later.
The exact app bundle ID in `apps/ios/project.yml` must be registered to the
publisher. The selected Apple Distribution certificate/private key must be
available in the signing host's Keychain. Install the matching App Store
provisioning profile in a standard Xcode profile directory.

Prepare a local JSON file containing only the following public signing and
build metadata. The values below are illustrative, not usable credentials or
a claim that an App Store record exists:

```json
{
  "team": "YOURTEAM12",
  "bundle": "dev.artoo.app",
  "version": "1.0.0",
  "build": "2",
  "identitySha1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "profileUuid": "12345678-1234-1234-1234-123456789ABC",
  "publisherName": "Your actual publisher name",
  "privacyPolicyURL": "https://your-publisher.example/privacy",
  "supportURL": "https://your-publisher.example/support"
}
```

Use the actual identity SHA-1 reported by `security find-identity -v -p codesigning`
and the UUID of the matching profile. Do not include passwords, API keys or
App Store Connect credentials in this file. Build numbers must be acceptable
for the actual App Store Connect app/version; the local command cannot verify
the remote build inventory.

```sh
npm run archive:ios:distribution -- --config=/absolute/path/distribution.json --preflight
npm run archive:ios:distribution -- --config=/absolute/path/distribution.json
```

Preflight requires an explicit profile and signing identity. It never falls
back to a development certificate or selects another developer team. The
command does not enable provisioning updates or create portal resources.
An absent profile must be provisioned for the actual app before export.

## Verification and evidence

Every attempt writes HTML, JSON and command logs to
`artifacts/ios-device/distribution-<timestamp>/`. Failed attempts remain failed
and retain their evidence. There are no UI photographs for a signing/build
attempt; it is not a client E2E run.

The build uses an isolated source copy and DerivedData. It verifies the source
fingerprint at completion and checks both the archive and the extracted IPA:

- Exact bundle, team, full application identifier, version and build.
- Matching certificate and embedded profile; currently valid App Store profile
  with no provisioned-device list, enterprise entitlement or debugging permission.
- Strict code-signature verification, arm64 executable and iOS SDK 26+.
- Compiled asset catalog and syntactically valid privacy manifest.
- Export with `method=app-store-connect`, `destination=export` and automatic
  version/build changes disabled; the IPA's byte count and SHA-256 are retained.

The signed bundle embeds the configured publisher name and links. The privacy
screen exposes those links before pairing and from settings. Preflight checks
that both URLs resolve over HTTPS to an accessible HTML page, including redirect
destinations; it does not establish the accuracy or adequacy of the page content.

The SDK and signature checks do not validate the publisher's legal policy,
privacy-label answers, actual provider traffic, support URLs, account deletion,
reviewer access or compliance declarations. Resolve these against the deployed
service and the chosen public/private and free/paid distribution model.

## Remaining release sequence

The independent publisher UI gate runs on a fresh iPhone and iPad simulator:

```sh
npm run verify:ios:release
```

It opens the native privacy page before pairing, follows both real public
links into Safari, returns to the app and checks landscape. Screenshots must
contain rendered text at the expected element frames and stable display
geometry. UIImage orientation is applied once for display, with raw screen
PNG attachments retained separately. Each attempt produces HTML and JSON under
`artifacts/ios/release-ui-<timestamp>/`, including failures; only the exact
simulator UUIDs created by that attempt are shut down and removed. This gate
supplements the eleven business cases and does not qualify physical devices.

1. Complete all native E2E suites on the intended source and current toolchain.
2. Supply the real publisher policy/support metadata and review environment.
3. Create the verified distribution archive/IPA and validate/upload it through
   the intended App Store Connect account.
4. Wait for Apple's build processing, complete internal TestFlight testing on
   supported iPhone/iPad hardware, and retain actual client HTML/photo evidence.
5. Complete store screenshots, metadata, privacy and compliance answers, then
   submit the reviewed build for App Review. Apple's approval is a separate
   external result; a local build or upload must not be reported as approval.
