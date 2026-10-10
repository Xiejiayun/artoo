import XCTest
import UIKit

/// Runs only on a fresh simulator owned by the release UI runner. No account,
/// pairing code, fixture server or artificial app state is supplied.
@MainActor
final class ReleaseReadinessUITests: XCTestCase {
    private let app = XCUIApplication()
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

    override func setUpWithError() throws { continueAfterFailure = false }
    override func tearDownWithError() throws { app.terminate(); safari.terminate() }

    func testPublisherPolicyAndSupportBeforePairing() throws {
        app.launch()
        try demand(app.navigationBars["Welcome to Artoo"].waitForExistence(timeout: 20),
                   "A fresh release check must start at real onboarding")
        // A fresh iPad can time out rotating SpringBoard before the app exists.
        // Request rotation only when the foreground app needs it.
        if app.frame.width > app.frame.height { XCUIDevice.shared.orientation = .portrait }
        let privacy = app.buttons["Privacy and data"]
        try reveal(privacy)
        privacy.tap()
        try demand(app.navigationBars["Privacy and data"].waitForExistence(timeout: 10), "Privacy must open before pairing")
        let policy = app.descendants(matching: .any).matching(identifier: "privacy.publisher.policy").firstMatch
        let support = app.descendants(matching: .any).matching(identifier: "privacy.publisher.support").firstMatch
        try demand(app.staticTexts["Jiayun Xie"].waitForExistence(timeout: 10), "The actual publisher must be visible")
        try reveal(policy); try reveal(support)
        try demand(policy.isEnabled && support.isEnabled, "Both publisher links must be available without an account")
        try captureApp("Native release publisher links before pairing", landscape: false)

        policy.tap()
        try verifyWebsite(heading: "Artoo iOS privacy policy", screenshot: "Native release public privacy website")
        app.activate()
        try demand(app.navigationBars["Privacy and data"].waitForExistence(timeout: 10), "Returning from the policy must retain the privacy screen")
        try reveal(support); support.tap()
        try verifyWebsite(heading: "Artoo support", screenshot: "Native release public support website")
        app.activate()
        try demand(app.navigationBars["Privacy and data"].waitForExistence(timeout: 10), "Returning from support must retain the privacy screen")
        XCUIDevice.shared.orientation = .landscapeLeft
        try reveal(policy); try reveal(support)
        try captureApp("Native release publisher links landscape", landscape: true)
    }

    private func verifyWebsite(heading: String, screenshot: String) throws {
        try demand(safari.wait(for: .runningForeground, timeout: 20), "A publisher link must open the actual browser")
        // A fresh Safari install can show its own first-use introduction.
        let introduction = safari.buttons["Continue"]
        if introduction.waitForExistence(timeout: 2) { introduction.tap() }
        let title = safari.webViews.staticTexts[heading].firstMatch
        try demand(title.waitForExistence(timeout: 35), "The public publisher webpage must load its expected heading")
        let attachment = XCTAttachment(image: try renderedImage(of: safari, elements: [title], landscape: false))
        attachment.name = screenshot; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func reveal(_ element: XCUIElement) throws {
        _ = element.waitForExistence(timeout: 10)
        for _ in 0..<8 {
            if element.exists && element.isHittable { return }
            let list = app.collectionViews.firstMatch
            try demand(list.exists && !app.keyboards.firstMatch.exists, "Publisher navigation requires an unobscured native Form")
            list.swipeUp(velocity: .slow)
        }
        try demand(element.exists && element.isHittable, "Publisher control must be reachable")
    }

    private func captureApp(_ name: String, landscape: Bool) throws {
        try demand(!app.keyboards.firstMatch.exists, "Publisher evidence must not be covered by a keyboard")
        for id in ["serverURL", "pairingDeviceName", "pairingCode", "device.pairing.code"] {
            try demand(!app.descendants(matching: .any).matching(identifier: id).firstMatch.exists, "Publisher screenshots must exclude pairing inputs")
        }
        let elements = ["privacy.publisher.policy", "privacy.publisher.support"].map {
            app.descendants(matching: .any).matching(identifier: $0).firstMatch
        }
        let attachment = XCTAttachment(image: try renderedImage(of: app, elements: elements, landscape: landscape))
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func renderedImage(of application: XCUIApplication, elements: [XCUIElement], landscape: Bool) throws -> UIImage {
        let started = ProcessInfo.processInfo.systemUptime
        var stable: (frame: CGRect, targets: [CGRect], since: TimeInterval)?
        var observations: [[String: Any]] = []
        defer {
            let data = try? JSONSerialization.data(withJSONObject: observations, options: [.sortedKeys])
            let attachment = XCTAttachment(string: data.map { String(decoding: $0, as: UTF8.self) } ?? "[]")
            attachment.name = "Release screenshot rendering observations"; attachment.lifetime = .keepAlways; add(attachment)
        }
        while ProcessInfo.processInfo.systemUptime - started < 15 {
            let frame = application.frame
            let elementFrames = elements.map { $0.frame }
            let screenshot = XCUIScreen.main.screenshot()
            // XCUIScreen keeps the sensor raster in portrait and carries its
            // display rotation in UIImage orientation. Render that orientation
            // once; otherwise both pixel checks and HTML can rotate it twice.
            let displayed = uprightImage(screenshot.image)
            if let pixels = displayed.cgImage, !frame.isEmpty, !frame.isInfinite, !frame.isNull {
                let ratioMatches = abs(CGFloat(pixels.width) / CGFloat(pixels.height) - frame.width / frame.height) < 0.02
                let directionMatches = landscape ? pixels.width > pixels.height : pixels.height > pixels.width
                let drawn = elementFrames.allSatisfy { region in
                    guard !region.isEmpty, frame.contains(region) else { return false }
                    let rectangle = CGRect(x: (region.minX - frame.minX) * CGFloat(pixels.width) / frame.width,
                        y: (region.minY - frame.minY) * CGFloat(pixels.height) / frame.height,
                        width: region.width * CGFloat(pixels.width) / frame.width,
                        height: region.height * CGFloat(pixels.height) / frame.height).integral
                    guard let crop = pixels.cropping(to: rectangle) else { return false }
                    return hasRenderedContrast(crop)
                }
                observations.append(["width": pixels.width, "height": pixels.height, "frame_width": Double(frame.width),
                                     "frame_height": Double(frame.height), "orientation_matches": directionMatches,
                                     "aspect_matches": ratioMatches, "target_pixels_drawn": drawn,
                                     "source_image_orientation": screenshot.image.imageOrientation.rawValue,
                                     "orientation_normalized": screenshot.image.imageOrientation != .up])
                if application.state == .runningForeground && ratioMatches && directionMatches && drawn {
                    let now = ProcessInfo.processInfo.systemUptime
                    if let previous = stable, previous.frame == frame && previous.targets == elementFrames {
                        if now - previous.since >= 1 {
                            let raw = XCTAttachment(data: screenshot.pngRepresentation, uniformTypeIdentifier: "public.png")
                            raw.name = "Raw release screen before orientation normalization"; raw.lifetime = .keepAlways; add(raw)
                            return displayed
                        }
                    } else { stable = (frame, elementFrames, now) }
                } else { stable = nil }
            } else { stable = nil }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        throw NSError(domain: "ArtooReleaseUI", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Screenshot must show rendered target text and a stable screen orientation"])
    }

    private func uprightImage(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up, let pixels = image.cgImage else { return image }
        let swapped = [.left, .right, .leftMirrored, .rightMirrored].contains(image.imageOrientation)
        let size = CGSize(width: CGFloat(swapped ? pixels.height : pixels.width) / image.scale,
                          height: CGFloat(swapped ? pixels.width : pixels.height) / image.scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = image.scale; format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    private func hasRenderedContrast(_ image: CGImage) -> Bool {
        let width = image.width, height = image.height
        guard width > 0, height > 0,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var minimum = 255, maximum = 0
        var luminances: [Int] = []
        for offset in stride(from: 0, to: width * height * 4, by: 16) {
            let value = (Int(bytes[offset]) * 77 + Int(bytes[offset + 1]) * 150 + Int(bytes[offset + 2]) * 29) / 256
            minimum = min(minimum, value); maximum = max(maximum, value); luminances.append(value)
        }
        guard maximum - minimum >= 40 else { return false }
        let middle = (minimum + maximum) / 2
        return luminances.filter { $0 < middle }.count >= 10 && luminances.filter { $0 > middle }.count >= 10
    }

    private func demand(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "ArtooReleaseUI", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
}
