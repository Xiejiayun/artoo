import XCTest

/// Snapshot fixtures test the observer only; they are not native UI evidence.
@MainActor
final class NativePairingSnapshotTests: XCTestCase {
    private final class SnapshotFixture: NSObject, XCUIElementSnapshot {
        var elementType: XCUIElement.ElementType
        var identifier: String
        var frame: CGRect
        var value: Any?
        var children: [XCUIElementSnapshot]
        var title = ""
        var label = ""
        var isEnabled = true
        var isSelected = false
        var hasFocus = false
        var horizontalSizeClass = XCUIElement.SizeClass.compact
        var verticalSizeClass = XCUIElement.SizeClass.regular
        var placeholderValue: String?
        var dictionaryRepresentation: [XCUIElement.AttributeName: Any] { [:] }

        init(_ type: XCUIElement.ElementType, identifier: String = "", frame: CGRect,
             value: Any? = nil, children: [XCUIElementSnapshot] = []) {
            elementType = type; self.identifier = identifier; self.frame = frame
            self.value = value; self.children = children
        }
    }

    private struct Fixture {
        let app: SnapshotFixture
        let form: SnapshotFixture
        let field: SnapshotFixture
        let menu: SnapshotFixture
        let controls: SnapshotFixture
        let done: SnapshotFixture
        let keyboard: SnapshotFixture
        let input: SnapshotFixture
    }

    private func fixture(menuFirst: Bool = true) -> Fixture {
        // Dimensions reproduce the hosted Form and editing-menu disagreement.
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        let field = SnapshotFixture(.textField, identifier: "pairingDeviceName",
                                    frame: CGRect(x: 40, y: 258, width: 313, height: 22), value: "My iPhone")
        let form = SnapshotFixture(.collectionView, frame: bounds, children: [field])
        let menu = SnapshotFixture(.collectionView, frame: CGRect(x: 16, y: 204, width: 255, height: 48))
        let done = SnapshotFixture(.button, identifier: "pairing.keyboard.done", frame: CGRect(x: 321, y: 472, width: 56, height: 44))
        let controls = SnapshotFixture(.other, identifier: "pairing.keyboard.controls",
                                       frame: CGRect(x: 0, y: 472, width: 393, height: 44), children: [done])
        let keyboard = SnapshotFixture(.keyboard, frame: CGRect(x: 0, y: 559, width: 393, height: 293))
        let input = SnapshotFixture(.other, identifier: "inputView", frame: CGRect(x: 0, y: 516, width: 393, height: 336))
        let navigation = SnapshotFixture(.navigationBar, frame: CGRect(x: 0, y: 54, width: 393, height: 44))
        let app = SnapshotFixture(.application, frame: bounds,
                                  children: (menuFirst ? [menu, form] : [form, menu]) + [navigation, controls, keyboard, input])
        return Fixture(app: app, form: form, field: field, menu: menu, controls: controls, done: done, keyboard: keyboard, input: input)
    }

    private func measurement(_ f: Fixture) throws -> NativePairingInput.Measurement? {
        var trace: [String: Any] = [:]
        return try NativePairingInput.measurement(f.app, expected: "My iPhone", trace: &trace)
    }

    func testEditingMenuCannotReplaceTheFormRegardlessOfSiblingOrder() throws {
        for menuFirst in [true, false] {
            let f = fixture(menuFirst: menuFirst)
            var trace: [String: Any] = [:]
            let actual = try XCTUnwrap(NativePairingInput.measurement(f.app, expected: "My iPhone", trace: &trace))
            XCTAssertEqual(actual.field, f.field.frame)
            XCTAssertEqual(actual.area, CGRect(x: 6, y: 106, width: 381, height: 358))
            XCTAssertTrue(actual.completeFieldVisible)
            XCTAssertEqual(trace["form_selection"] as? String, "device_name_ancestor")
        }
    }

    func testNearestOwningCollectionCannotBeReplacedByALargerOuterForm() throws {
        let f = fixture()
        let inner = SnapshotFixture(.collectionView, frame: CGRect(x: 30, y: 250, width: 333, height: 25), children: [f.field])
        f.form.children = [inner]
        XCTAssertFalse(try XCTUnwrap(measurement(f)).completeFieldVisible)
    }

    func testUnrelatedCollectionCannotStandInForAMissingFieldAncestor() throws {
        let f = fixture()
        f.form.children = []
        f.app.children.append(f.field)
        XCTAssertNil(try measurement(f))
    }

    func testDuplicateDeviceNameIsRejected() {
        let f = fixture()
        f.menu.children = [SnapshotFixture(.textField, identifier: "pairingDeviceName", frame: f.field.frame, value: "My iPhone")]
        XCTAssertThrowsError(try measurement(f))
    }

    func testChangedInputIsRejectedWithoutRecordingItsValue() throws {
        let f = fixture()
        f.field.value = "private fixture value"
        var trace: [String: Any] = [:]
        XCTAssertThrowsError(try NativePairingInput.measurement(f.app, expected: "My iPhone", trace: &trace))
        XCTAssertEqual(trace["value_unchanged"] as? Bool, false)
        let data = try JSONSerialization.data(withJSONObject: trace)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private fixture value"))
    }

    func testOriginalDoneBarOverlapStillFailsFullFieldContainment() throws {
        let f = fixture()
        f.field.frame.origin.y = 463 // Ends at 485, thirteen points into Done.
        XCTAssertFalse(try XCTUnwrap(measurement(f)).completeFieldVisible)
    }

    func testKeyboardPredictionRegionStillLimitsTheDoneBar() throws {
        let f = fixture()
        f.input.frame.origin.y = 500
        XCTAssertNil(try measurement(f))
    }

    func testMissingInputRegionCannotUseKeycapsAsFullKeyboardProof() throws {
        let f = fixture()
        f.input.identifier = "unrecognized-region"
        XCTAssertNil(try measurement(f))
    }

    func testDuplicateDoneButtonOrControlsAreRejected() {
        for duplicateButton in [true, false] {
            let f = fixture()
            f.app.children.append(SnapshotFixture(duplicateButton ? .button : .other,
                identifier: duplicateButton ? "pairing.keyboard.done" : "pairing.keyboard.controls", frame: f.done.frame))
            XCTAssertThrowsError(try measurement(f))
        }
    }

    func testSeparateKeyboardToolbarCannotQualifyAsInLayoutControls() {
        let f = fixture()
        f.controls.children = [SnapshotFixture(.toolbar, frame: f.controls.frame, children: [f.done])]
        XCTAssertThrowsError(try measurement(f))
    }

    func testNonfiniteAndOffscreenGeometryCannotQualify() throws {
        let badApp = fixture()
        badApp.app.frame = .null
        XCTAssertThrowsError(try measurement(badApp))
        let badForm = fixture()
        badForm.form.frame = CGRect(x: 500, y: 0, width: 100, height: 100)
        XCTAssertNil(try measurement(badForm))
        let badKeyboard = fixture()
        badKeyboard.keyboard.frame.origin.y = 900
        XCTAssertNil(try measurement(badKeyboard))
    }

    func testDisabledOrPartiallyClippedControlsCannotQualify() throws {
        let disabledField = fixture(); disabledField.field.isEnabled = false
        XCTAssertFalse(try XCTUnwrap(measurement(disabledField)).completeFieldVisible)
        let clippedField = fixture(); clippedField.field.frame.origin.x = 0
        XCTAssertFalse(try XCTUnwrap(measurement(clippedField)).completeFieldVisible)
        let disabledDone = fixture(); disabledDone.done.isEnabled = false
        XCTAssertNil(try measurement(disabledDone))
        let smallDone = fixture(); smallDone.done.frame.size.width = 43
        XCTAssertNil(try measurement(smallDone))
    }
}
