# Native pairing snapshot measurement implementation plan

> **For agentic workers:** Execute these tasks inline, with the checks below. No delegation or additional approval is needed for the existing authorized goal. Steps use checkbox syntax to distinguish source changes from runtime acceptance.

**Goal:** Make the passive native pairing check measure the actual Form containing the device-name field, within the existing ten-second deadline, so the complete Mac/iOS workflows can be qualified.

**Architecture:** Capture one public `XCUIElementSnapshot` tree per observation. Resolve the unique device-name text field and its nearest collection-view ancestor in that same tree; the system Select/Select All/AutoFill menu is a sibling and cannot become the Form. Keep live field/Done hittability checks separate from the snapshot's consistent geometry.

**Tech Stack:** Swift 5.9, public XCTest/XCUIAutomation snapshot APIs, existing XcodeGen unit/UI targets and hosted Preview gates.

## Global constraints

- Base source: main `013c1122dae489ca9cb5c793b04fa3aabb051933`. Main run `37731512802` passed Mac/shared and failed all seven Core cases after the caret tap; later four suites were unstarted. Its verified small ZIPs show every initial field fully visible, followed by a 254.67×48 collection-view frame corresponding to the system editing menu.
- Retain the ten-second phase budget, one-second stable interval, complete-field containment, unchanged input, finite geometry, full prediction/input keyboard region, navigation-bar boundary, and 44×44 Done target.
- The only helper action remains the original one trailing-caret tap. Add no corrective scroll, focus change, gesture or keyboard dismissal. Exact native Delete/replacement and all business assertions remain unchanged.
- Keep the product focus-reveal implementation unchanged. Snapshot fixture tests are measurement unit tests, never native UI acceptance.
- Preserve failed reports. Each real client attempt retains HTML and its actual photos. Main promotion requires honest source/report correlation and current gate results.

### Task 1: Correct and regress snapshot measurement

**Files:** Modify `apps/ios/UITests/NativePairingInput.swift` and `apps/ios/project.yml`; create `apps/ios/Tests/ArtooTests/NativePairingSnapshotTests.swift`.

**Interface:** `NativePairingInput.measurement(_ root: XCUIElementSnapshot, expected: String, trace: inout [String: Any]) throws -> Measurement?`; `Measurement` exposes `field`, `area`, `fieldEnabled` and `completeFieldVisible`. A snapshot index carries each node's nearest collection-view ancestor. Neither values nor a full accessibility tree enter diagnostics.

- [x] Add snapshot fixture regressions reproducing the observed Form/menu geometry and rejecting an unrelated or nested clipping collection, duplicate field/control identities, changed input, clipped/disabled fields, a separate keyboard toolbar, a too-small Done target, invalid bounds and missing/overlapping keyboard regions.

```swift
let menu = SnapshotFixture(.collectionView, frame: CGRect(x: 16, y: 204, width: 255, height: 48))
let field = SnapshotFixture(.textField, identifier: "pairingDeviceName", frame: CGRect(x: 40, y: 258, width: 313, height: 22), value: "My iPhone")
// The full application fixture puts menu before the actual Form containing field.
let measured = try NativePairingInput.measurement(application, expected: "My iPhone", trace: &trace)
XCTAssertTrue(try XCTUnwrap(measured).completeFieldVisible)
XCTAssertEqual(trace["form_selection"] as? String, "device_name_ancestor")
```

- [x] Replace repeated live attribute resolutions with `try app.snapshot()` and the pure measurement function. Retain two live hittability probes per otherwise valid sample, and record snapshot/observation duration without changing deadlines.
- [x] Compile the existing helper into the unit target using the explicit XcodeGen source path, without putting test code into the app target.
- [x] Run Swift syntax, existing 67 report/suite contracts, and generic-simulator Debug unit and Release UI builds, matching test-macos.mjs. Local simulator boot previously failed at launchd_sim; do not repeat the unchanged boot attempt.

### Task 2: Native qualification and delivery

**Files/evidence:** Existing `.github/workflows/preview.yml`, `scripts/ios-ui-suites-e2e.mjs`, and a new timestamped directory under `artifacts/preview-gate/ios-pairing-qualification/`.

- [ ] Commit the isolated candidate on `user/jiaxie/ios-pairing-snapshot`, push normally and dispatch the existing workflow with installed Windows disabled.
- [ ] Verify the added measurement units actually ran. Require all seven Core cases and the remaining assistant, mentions, correction and retention cases; a green geometry unit suite does not qualify the native app.
- [ ] Download current report artifacts with byte/hash/CRC checks. Inspect actual native screenshots and preserve every failure, partial download and unstarted suite distinctly.
- [ ] On qualified completion, integrate the milestone into main and push normally, preserving the six unrelated local files and existing stash. If a gate fails, diagnose its actual evidence and continue toward the same full goal.

## Local compilation record

The 67 report/suite contract checks passed, and the actual Debug unit and Release UI targets both completed generic-simulator build-for-testing. Twelve new snapshot measurement cases are compiled but have not yet executed; hosted XCTest will provide that evidence. The product UI source is unchanged. The earlier process-observer timeout and the incorrectly selected Release unit build are retained as failed attempts; correcting the unit configuration follows the existing repository runner and does not enable testing in the shipping Release app.
