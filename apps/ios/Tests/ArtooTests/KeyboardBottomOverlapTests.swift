import XCTest
@testable import Artoo

final class KeyboardBottomOverlapTests: XCTestCase {
    private let portraitWindow = CGRect(x: 0, y: 0, width: 393, height: 852)
    private let keyboard = CGRect(x: 0, y: 517, width: 393, height: 335)

    func testCompensatesOnlyTheMeasuredResidual() {
        let outer = CGRect(x: 0, y: 143, width: 393, height: 456) // bottom 599
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: portraitWindow,
                                                  keyboard: keyboard, displayScale: 3), 82)
        let alreadyAvoided = CGRect(x: 0, y: 143, width: 393, height: 374) // bottom 517
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: alreadyAvoided, window: portraitWindow,
                                                  keyboard: keyboard, displayScale: 3), 0)
    }

    func testHiddenOffscreenAndFloatingFramesDoNotInsetTheWholeConversation() {
        let outer = CGRect(x: 0, y: 143, width: 393, height: 456)
        let ignored: [CGRect?] = [
            nil,
            .zero,
            CGRect(x: 0, y: 852, width: 393, height: 335),
            CGRect(x: 110, y: 440, width: 250, height: 260),
            CGRect(x: 110, y: 592, width: 250, height: 260),
            CGRect(x: 0, y: 350, width: 393, height: 253)
        ]
        for frame in ignored {
            XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: portraitWindow,
                                                      keyboard: frame, displayScale: 3), 0)
        }
    }

    func testRecomputesOverlapForRotatedWindowDimensions() {
        let landscape = CGRect(x: 0, y: 0, width: 852, height: 393)
        let outer = CGRect(x: 0, y: 44, width: 852, height: 256) // bottom 300
        let keyboard = CGRect(x: 0, y: 231, width: 852, height: 162)
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: landscape,
                                                  keyboard: keyboard, displayScale: 3), 69)
    }

    func testClipsToWindowAndNeverExceedsAvailableHeight() {
        let outer = CGRect(x: 0, y: 143, width: 393, height: 456)
        let widerScreenKeyboard = CGRect(x: -100, y: 517, width: 1024, height: 335)
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: portraitWindow,
                                                  keyboard: widerScreenKeyboard, displayScale: 3), 82)
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: portraitWindow,
                                                  keyboard: portraitWindow, displayScale: 3), 456)
        XCTAssertEqual(KeyboardBottomOverlap.inset(container: outer, window: portraitWindow,
                                                  keyboard: CGRect(x: 0, y: CGFloat.nan, width: 393, height: 335),
                                                  displayScale: 3), 0)
    }
}
