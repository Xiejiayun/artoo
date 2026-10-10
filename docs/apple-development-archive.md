# iOS development archive

`npm run archive:ios:development` creates a Release archive for physical iOS
devices using an existing development signing identity and provisioning
profile. It does not create portal resources, enable provisioning updates,
install an app, export a TestFlight build, or upload anything.

Set `ARTOO_APPLE_TEAM_ID` to the intended existing Apple developer team. The
script selects only an unexpired iOS development profile covering the app's
bundle ID and containing a currently valid local development certificate.
Ambiguous matches fail with a request for these optional selectors:

- `ARTOO_IOS_PROFILE_UUID`: exact existing profile UUID.
- `ARTOO_IOS_SIGNING_IDENTITY`: certificate SHA-1 from
  `security find-identity -v -p codesigning`.

Run read-only preflight before building:

```sh
npm run archive:ios:development -- --preflight
npm run archive:ios:development
```

Every invocation writes HTML and JSON under `artifacts/ios-device/<timestamp>`.
The archive build copies the iOS sources into that directory and uses its own
Xcode project and DerivedData. It does not rewrite the working project's
generated files or share simulator build state.

For an Xcode-managed profile, Xcode requires Automatic signing and the `Apple
Development` identity selector. Other profiles use Manual signing with the
selected UUID and identity. Both paths require the resulting archive to match
the preselected profile UUID and exact signing certificate. A successful build
alone is insufficient: the script independently checks `codesign --verify`,
Team ID, bundle ID, certificate SHA-1, embedded profile and development
entitlements, plus an arm64 executable, compiled assets and privacy manifest.

## Executed evidence

The complete development archive gate passed again on 2026-10-01 after the
native approval and assignment-recovery changes, using the existing matching
local identity and profile. Its report is
`artifacts/ios-device/2026-09-30T18-32-09-609Z/report.html`, and the signed
`Artoo.xcarchive` is in the same directory. This proves a signed device-target
build at the report's recorded source snapshot; it does not prove physical
device UI behavior or App Store distribution. Five selection/signing-settings
regressions passed locally.

TestFlight/App Store export needs an appropriate distribution profile and an
App Store Connect app. Developer ID signing and notarization for a standalone
Mac installer use a different certificate path. See
[Apple release readiness](apple-release-readiness.md) and the separate
[App Store distribution command](ios-app-store-distribution.md).
