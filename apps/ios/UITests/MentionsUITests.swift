import XCTest
import CryptoKit

/// The recipient pairs, navigates and retries only through native UI. Separate
/// authenticated GETs verify the production server; private publication lets
/// the independent Web sender act only after native readiness.
final class MentionsUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixture: MentionsFixture!

    override func setUpWithError() throws {
        continueAfterFailure = false
        fixture = try MentionsFixture(ProcessInfo.processInfo.environment)
    }
    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testCrossProjectHistoricalMentionReadRetryAndDraftIsolation() async throws {
        try await pair()
        let native = try await nativeDevice()
        let before: MentionsBootstrap = try await get("api/v1/bootstrap")
        try demand(before.projects.contains { $0.id == fixture.projectAId }, "Project A must be authorized before publication")
        let unpublished = try await observations()
        try demand(unpublished.publication == nil && unpublished.readAttempts.isEmpty, "Project B and read faults must wait for recipient readiness")
        try selectProject(id: fixture.projectAId, name: fixture.projectAName)
        try openAThread()
        try replace(field("messageComposer"), fixture.draftA, unobscuredList: true)
        try dismissKeyboard()
        try assertDraft(fixture.draftA)
        try waitForLiveConnection()
        try assertDraft(fixture.draftA)
        try screenshot("Native mentions project A draft before publication")

        let publication: MentionsPublication = try await request(fixture.controlURL.appendingPathComponent("publish"),
                                                               token: fixture.controlToken, body: [:], timeout: 120)
        try demand(publication.recipientDeviceId == native.id, "The read fault must bind this actual native device")
        try demand(!before.projects.contains { $0.id == publication.projectB.id }, "Project B must be absent from the bootstrap read before publication")
        try demand(publication.projectB.id != fixture.projectAId && publication.channelB.id != fixture.channelAId,
                   "Same-named channels must have distinct real project and room identities")
        try demand(publication.channelB.name == fixture.channelAName, "The fixture must exercise channel identity rather than a unique channel label")
        try demand(publication.first.body == fixture.firstMentionBody && publication.second.body == fixture.secondMentionBody,
                   "Both Web sender bodies must equal the agreed scenario text")
        try demand(publication.first.messageId != publication.second.messageId
                   && publication.first.notificationId != publication.second.notificationId, "Both historical mentions must have separate persisted identities")
        try demand(publication.publishedUnreadCount == publication.baselineUnreadCount + 3, "Two B mentions and the A sentinel must add exactly three unread notices")
        try await verifyHistoricalDestination(publication.first, publication: publication)
        try await verifyHistoricalDestination(publication.second, publication: publication)
        let latest: MentionsMessagePage = try await get("api/v1/rooms/\(publication.channelB.id)/messages?thread_root_id=\(publication.rootB.id)&limit=50")
        try demand(latest.messages.count == 50 && latest.hasMore && latest.nextBefore?.isEmpty == false,
                   "The real latest thread page must contain exactly 50 replies and an earlier cursor")
        try demand(publication.history.laterMessageIds.count == 55 && Set(publication.history.laterMessageIds).count == 55
                   && publication.history.latestMessageIds.count == 50 && publication.history.hasMore,
                   "The fixture must retain all 55 ordinary later reply identities")
        try demand(Set(latest.messages.map(\.id)) == Set(publication.history.latestMessageIds)
                   && Set(latest.messages.map(\.id)).isSubset(of: Set(publication.history.laterMessageIds)),
                   "The latest page must match actual later replies, not either historical target")
        try demand(!latest.messages.contains { [publication.first.messageId, publication.second.messageId].contains($0.id) }
                   && latest.messages.allSatisfy { $0.roomId == publication.channelB.id && $0.threadRootId == publication.rootB.id },
                   "Neither target may be available through the latest 50 replies")
        let original = try await notices()
        try verifyNotices(original, publication: publication, firstRead: false, secondRead: false)
        let firstNotice = try notice(publication.first.notificationId, in: original)
        try demand(publication.first.body.count > firstNotice.bodyPreview.count && publication.first.body.hasPrefix(firstNotice.bodyPreview),
                   "The notification preview must omit a suffix of the historical target")

        try openMentions()
        try count(publication.publishedUnreadCount)
        try row(publication.first.notificationId, value: "Unread")
        try row(publication.second.notificationId, value: "Unread")
        try row(publication.sentinel.notificationId, value: "Unread")
        try reveal(field("mentions.unreadSummary"))
        try screenshot("Native mentions global unread across projects")
        try openNotice(publication.first.notificationId)
        try await waitForInitialMention(publication.first)
        try assertDestination(publication.first, publication: publication)
        let failure = field("mention.readError"), retry = app.buttons["retryMentionRead"]
        try require(failure.waitForExistence(timeout: 20) && failure.label.contains("503"), "A real read 503 must remain visible with the loaded historical target")
        try require(retry.waitForExistence(timeout: 10) && retry.isEnabled && retry.isHittable, "The failed read must offer the real explicit Retry action")
        try revealText(app.staticTexts["message.\(publication.first.messageId)"])
        try screenshot("Native mentions historical reply with read failure")
        try replace(field("messageComposer"), fixture.draftB, unobscuredList: true)
        try dismissKeyboard()
        try assertDraft(fixture.draftB)
        let failureObservedMs = try await stableFailure(publication, duration: 3.1)
        try require(failure.exists && retry.isEnabled && retry.isHittable, "Read failure must persist until this exact Retry is tapped")
        retry.tap()
        let afterRetry = try await waitForReadBoundary(publication, firstRead: true, secondRead: false, firstAttempts: 2)
        let firstReadAt = try XCTUnwrap(try notice(publication.first.notificationId, in: afterRetry).readAt)
        try waitForAbsence(failure, "Successful explicit Retry must remove its error")
        try waitForAbsence(retry, "Successful explicit Retry must remove its retry action")
        try assertDraft(fixture.draftB)
        try screenshot("Native mentions draft preserved after read retry")

        try backToMentions()
        try count(publication.baselineUnreadCount + 2)
        try row(publication.first.notificationId, value: "Read")
        try openNotice(publication.second.notificationId)
        try assertDestination(publication.second, publication: publication)
        let afterSecond = try await waitForReadBoundary(publication, firstRead: true, secondRead: true)
        let secondReadAt = try XCTUnwrap(try notice(publication.second.notificationId, in: afterSecond).readAt)
        try demand(try notice(publication.first.notificationId, in: afterSecond).readAt == firstReadAt, "Reading the second mention must not rewrite the first read timestamp")
        try require(!failure.exists && !retry.exists, "The second historical mention must open through a normal read response")
        try revealText(app.staticTexts["message.\(publication.second.messageId)"])
        try screenshot("Native mentions second historical reply")
        try assertDraft(fixture.draftB)
        try backToMentions()
        try openNotice(publication.first.notificationId)
        try assertDestination(publication.first, publication: publication)
        try assertDraft(fixture.draftB)

        // Check global project selection only after explicit Retry. Leaving the
        // failed destination earlier could legitimately trigger a read on reentry.
        app.tabBars.buttons["More"].tap()
        try assertSelectedProject(publication.projectB.name)
        try screenshot("Native mentions selected project B")
        app.tabBars.buttons["Inbox"].tap()
        try require(app.navigationBars["Thread"].waitForExistence(timeout: 15), "Returning to Inbox must retain the exact mention destination")
        try assertDestination(publication.first, publication: publication)
        try assertDraft(fixture.draftB)
        try backToMentions()
        try count(publication.baselineUnreadCount + 1)
        try row(publication.first.notificationId, value: "Read")
        try row(publication.second.notificationId, value: "Read")
        try row(publication.sentinel.notificationId, value: "Unread")
        try reveal(field("mentions.unreadSummary"))
        try screenshot("Native mentions one unread sentinel remains")

        try selectProject(id: fixture.projectAId, name: fixture.projectAName)
        try openAThread()
        try assertDraft(fixture.draftA)
        try screenshot("Native mentions project A draft restored")
        app.terminate(); app.launch()
        try require(app.tabBars.buttons["Inbox"].waitForExistence(timeout: 25), "Relaunch must restore the actual authenticated phone")
        try openMentions()
        try openNotice(publication.first.notificationId)
        try assertDestination(publication.first, publication: publication)
        try assertDraft(fixture.draftB)
        try screenshot("Native mentions project B draft restored after relaunch")
        let final = try await waitForReadBoundary(publication, firstRead: true, secondRead: true)
        try demand(try notice(publication.first.notificationId, in: final).readAt == firstReadAt
                   && notice(publication.second.notificationId, in: final).readAt == secondReadAt,
                   "Reopening read mentions must preserve read timestamps and global unread count")
        app.tabBars.buttons["More"].tap()
        try assertSelectedProject(publication.projectB.name)
        let aMessages: MentionsMessagePage = try await get("api/v1/rooms/\(fixture.channelAId)/messages?thread_root_id=\(fixture.rootAId)&limit=100")
        let bMessages: MentionsMessagePage = try await get("api/v1/rooms/\(publication.channelB.id)/messages?thread_root_id=\(publication.rootB.id)&limit=100")
        try demand(!aMessages.hasMore && !bMessages.hasMore, "The complete two fixture threads must fit the read-only verification page")
        try demand(!(aMessages.messages + bMessages.messages).contains { [fixture.draftA, fixture.draftB].contains($0.body) }, "Neither native draft may have been sent")
        try demand(Set(bMessages.messages.map(\.id)) == Set(publication.history.laterMessageIds + [publication.first.messageId, publication.second.messageId]),
                   "Native navigation and read retry must not create any B thread message")
        let observed = try await observations()
        try verifyAttempts(observed, publication: publication)
        let receipt = XCTAttachment(data: try JSONSerialization.data(withJSONObject: [
            "recipient_device_id": native.id, "recipient_user_id": fixture.recipientUserId, "sender_user_id": fixture.senderUserId,
            "project_a_id": fixture.projectAId, "project_b_id": publication.projectB.id,
            "room_a_id": fixture.channelAId, "room_b_id": publication.channelB.id, "root_b_id": publication.rootB.id,
            "first_message_id": publication.first.messageId, "second_message_id": publication.second.messageId,
            "first_notification_id": publication.first.notificationId, "second_notification_id": publication.second.notificationId,
            "sentinel_notification_id": publication.sentinel.notificationId, "first_body_sha256": hash(publication.first.body),
            "second_body_sha256": hash(publication.second.body), "first_read_at": firstReadAt, "second_read_at": secondReadAt,
            "baseline_unread_count": publication.baselineUnreadCount, "final_unread_count": final.unreadCount,
            "failed_observed_ms": failureObservedMs, "first_target_read_attempts": observed.readAttempts.filter { $0.notificationId == publication.first.notificationId }.count,
            "drafts_preserved_and_unsent": true
        ], options: .sortedKeys), uniformTypeIdentifier: "public.json")
        receipt.name = "Native mentions exact identities and read recovery boundaries"; receipt.lifetime = .keepAlways; add(receipt)
    }

    @MainActor
    private func pair() async throws {
        app.launch()
        let readyOrigin = app.textFields.matching(identifier: "serverURL").matching(NSPredicate(format: "enabled == true")).firstMatch
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline && !app.tabBars.buttons["More"].exists && !readyOrigin.exists { try await Task.sleep(nanoseconds: 100_000_000) }
        if app.tabBars.buttons["More"].exists {
            app.tabBars.buttons["More"].tap()
            let signOut = app.buttons["signOut"]; try reveal(signOut); signOut.tap()
        }
        try require(readyOrigin.waitForExistence(timeout: 30), "Pairing must be ready before entering disposable credentials")
        let code: MentionsPairingCode = try await request(fixture.serverURL.appendingPathComponent("api/v1/devices/pairings"), body: ["intended_platform": "ios"])
        if fixture.serverURL.scheme == "http" {
            let toggle = app.switches["allowLocalHTTP"]
            for _ in 0..<3 {
                try reveal(toggle)
                if toggle.value as? String == "1" { break }
                try require(toggle.value as? String == "0", "The real local HTTP switch must expose its current state")
                let nested = toggle.switches.firstMatch; (nested.exists ? nested : toggle).tap()
                _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: toggle)], timeout: 3)
            }
            try require(toggle.value as? String == "1", "Local HTTP must be enabled through onboarding")
        }
        try replace(readyOrigin, fixture.serverURL.absoluteString)
        try replace(app.textFields["pairingDeviceName"], fixture.nativeDeviceName)
        try replace(app.textFields["pairingCode"], code.code)
        let connect = app.buttons["pairDevice"]; try reveal(connect)
        try require(connect.isEnabled, "The completed native pairing form must allow connection"); connect.tap()
        try require(app.tabBars.buttons["More"].waitForExistence(timeout: 25), "Native pairing must authenticate and load the shared server")
        app.tabBars.buttons["More"].tap()
        let account = app.staticTexts["workspace.account.name"]
        try require(account.waitForExistence(timeout: 15) && account.label == fixture.recipientName, "The native account must be the intended recipient")
    }
    @MainActor
    private func selectProject(id: String, name: String) throws {
        app.tabBars.buttons["More"].tap()
        let picker = field("workspace.project"); try reveal(picker); picker.tap()
        let identified = app.buttons.matching(identifier: "workspace.project.option.\(id)")
        let exact = app.buttons.matching(NSPredicate(format: "label == %@", name))
        // A native menu option can enter the accessibility tree before its
        // activation geometry is ready. It is not a row in the underlying
        // form: querying hittability or scrolling that form can fail or leave
        // the popup open. Wait for the actual option, then let tap dispatch it.
        let menuReady = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in
            let matches = identified.count
            let option = matches == 1 ? identified.firstMatch
                : matches == 0 && exact.count == 1 ? exact.firstMatch : nil
            guard let option, option.exists, option.isEnabled, app.windows.firstMatch.exists else { return false }
            let frame = option.frame, bounds = app.windows.firstMatch.frame
            return [frame.minX, frame.minY, frame.width, frame.height,
                    bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy { $0.isFinite }
                && !frame.isEmpty && !bounds.isEmpty && bounds.contains(frame)
        }, object: app)
        try require(XCTWaiter.wait(for: [menuReady], timeout: 15) == .completed,
                    "The native project menu must expose one complete option for the exact project ID or unique fixture name")
        let option = identified.count == 1 ? identified.firstMatch : exact.firstMatch
        option.tap()
        try waitForAbsence(option, "Choosing the exact project must dismiss its native menu before checking the underlying picker")
        try assertSelectedProject(name)
    }
    @MainActor
    private func assertSelectedProject(_ name: String) throws {
        let picker = field("workspace.project"); try reveal(picker)
        let selectedLabel = "Project, \(name)"
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ OR label == %@", name, selectedLabel), object: picker)
        try require(XCTWaiter.wait(for: [expected], timeout: 15) == .completed, "The global native project selection must be exactly \(name)")
        try require(picker.isHittable && ((picker.value as? String) == name || picker.label == selectedLabel), "The selected project must be visible in the real native picker")
    }
    @MainActor
    private func openAThread() throws {
        app.tabBars.buttons["Channels"].tap()
        // An inactive tab can retain A's existing navigation stack while the
        // inbox selects B and then A. Its exact thread is a valid restoration.
        let destination = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in
            app.navigationBars["Channels"].exists || app.navigationBars["Thread"].exists
        }, object: app)
        try require(XCTWaiter.wait(for: [destination], timeout: 15) == .completed, "Selecting A must expose its channel inventory or retained thread")
        if !app.navigationBars["Thread"].exists {
            let channel = app.buttons["channel.\(fixture.channelAId)"]; try reveal(channel); channel.tap()
            let thread = app.buttons["thread.\(fixture.rootAId)"]; try reveal(thread); thread.tap()
        }
        try require(app.navigationBars["Thread"].waitForExistence(timeout: 15), "The exact A thread must open")
        let root = app.staticTexts["message.\(fixture.rootAId)"]; try revealText(root)
        try require(root.label == fixture.rootABody, "Project A must keep its actual distinct root")
    }
    @MainActor
    private func openMentions() throws {
        app.tabBars.buttons["Inbox"].tap()
        if app.navigationBars["Thread"].exists { try backToMentions(); return }
        if app.navigationBars["Mentions"].exists { return }
        let entry = app.buttons["inbox.mentions"]
        try require(entry.waitForExistence(timeout: 15) && entry.isHittable, "Inbox must expose its actual Mentions entry")
        entry.tap()
        try require(app.navigationBars["Mentions"].waitForExistence(timeout: 15), "Inbox must open the global mentions list")
    }
    @MainActor
    private func openNotice(_ id: String) throws {
        let target = app.buttons["mention.\(id)"]; try reveal(target)
        try require(target.isHittable, "The exact notification row must be actionable"); target.tap()
        try require(app.navigationBars["Thread"].waitForExistence(timeout: 20), "A mention must resolve to its real native thread")
    }
    @MainActor
    private func backToMentions() throws {
        try require(app.navigationBars["Thread"].exists, "Back must leave the actual thread destination")
        app.navigationBars["Thread"].buttons.firstMatch.tap()
        try require(app.navigationBars["Mentions"].waitForExistence(timeout: 15), "Back must retain the global mentions list")
    }
    @MainActor
    private func row(_ id: String, value: String) throws {
        let row = app.buttons["mention.\(id)"]; try reveal(row)
        try require(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: row)], timeout: 15) == .completed,
                    "The exact notification row must display \(value)")
    }
    @MainActor
    private func count(_ value: Int) throws {
        let summary = field("mentions.unreadSummary"); try reveal(summary)
        try require(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "\(value) unread across all projects"), object: summary)], timeout: 15) == .completed,
                    "Native Mentions must show the exact global unread count")
    }
    @MainActor
    private func waitForInitialMention(_ target: MentionsTarget) async throws {
        let message = app.staticTexts["message.\(target.messageId)"]
        let deadline = Date().addingTimeInterval(15)
        repeat {
            if message.exists && app.collectionViews.firstMatch.exists && !app.keyboards.firstMatch.exists {
                let view = try viewport(), rect = message.frame
                if !rect.isEmpty && !rect.isNull && !rect.isInfinite {
                    let visible = rect.intersection(view)
                    if !visible.isNull && visible.width >= rect.width - 1 && visible.height >= rect.height - 1 { return }
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        } while Date() < deadline
        // Observe the product's initial landing before any test gesture can
        // reveal the root or move the selected historical reply into view.
        try require(false, "Opening a mention must show its complete historical reply before any scrolling")
    }
    @MainActor
    private func assertDestination(_ target: MentionsTarget, publication: MentionsPublication) throws {
        let root = app.staticTexts["message.\(publication.rootB.id)"]; try revealText(root)
        try require(root.label == publication.rootB.body, "The mention must render the exact B root")
        let message = app.staticTexts["message.\(target.messageId)"]; try revealText(message)
        try require(message.label == target.body, "The selected historical reply must render its entire persisted body, including its non-preview suffix")
        let author = field("messageAuthor.\(target.messageId)"); try revealText(author)
        try require(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", fixture.senderName), object: author)], timeout: 15) == .completed,
                    "The historical target must show the actual separate sender")
        let mentions = field("mentions.\(target.messageId)"); try revealText(mentions)
        try require(mentions.value as? String == "@\(fixture.recipientName)", "The target must retain its structured mention of the current recipient")
    }
    @MainActor
    private func assertDraft(_ text: String) throws {
        let composer = field("messageComposer"); try revealText(composer)
        try require(composer.isEnabled && composer.value as? String == text, "This exact thread must retain its own unsent draft")
    }
    @MainActor private func field(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    @MainActor
    private func replace(_ input: XCUIElement, _ text: String, unobscuredList: Bool = false) throws {
        // XCTest can call an input hittable even while the read-error inset
        // covers its tap point. Reveal the entire composer before focusing it.
        if unobscuredList { try revealText(input) }
        else { try reveal(input) }
        try require(input.isHittable && input.isEnabled, "The exact native input must be reachable"); input.tap()
        try require(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Tapping the visible input must establish keyboard focus before typing")
        if let value = input.value as? String, !value.isEmpty && value != input.placeholderValue { input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count)) }
        input.typeText(text)
        let enteredInput = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: input)
        try require(XCTWaiter.wait(for: [enteredInput], timeout: 45) == .completed, "The original native typing operation must finish with the exact intended text")
        try require(input.value as? String == text, "The native input must exactly match the replacement text")
    }
    @MainActor
    private func dismissKeyboard() throws {
        let done = app.buttons["conversation.keyboard.done"]
        try require(done.waitForExistence(timeout: 10) && done.isHittable, "The actual multiline composer must expose Done"); done.tap()
        try waitForAbsence(app.keyboards.firstMatch, "Done must dismiss the keyboard before screenshots and navigation")
    }
    @MainActor
    private func waitForAbsence(_ element: XCUIElement, _ reason: String) throws {
        try require(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)], timeout: 15) == .completed, reason)
    }
    @MainActor
    private func waitForLiveConnection() throws {
        let status = field("realtimeStatus"); try reveal(status)
        try require(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "connected"), object: status)], timeout: 20) == .completed,
                    "Recipient readiness must include its real authenticated socket")
    }
    @MainActor
    private func reveal(_ element: XCUIElement) throws {
        for attempt in 0..<70 {
            if element.exists && element.isHittable { return }
            // App-wide swipes can begin on the keyboard after a form grows.
            // Keep both drag points in the visible native content instead.
            let bounds = app.frame
            let list = app.collectionViews.firstMatch
            let rect = list.exists ? list.frame.intersection(bounds) : bounds
            let navigation = app.navigationBars.firstMatch
            let tabs = app.tabBars.firstMatch
            let keyboard = app.keyboards.firstMatch
            let top = navigation.exists ? max(rect.minY, navigation.frame.maxY) : rect.minY
            var bottom = tabs.exists ? min(rect.maxY, tabs.frame.minY) : rect.maxY
            if keyboard.exists { bottom = min(bottom, keyboard.frame.minY) }
            let viewport = CGRect(x: rect.minX + 6, y: top + 8,
                                  width: rect.width - 12, height: bottom - top - 16)
            try require([viewport.minX, viewport.minY, viewport.width, viewport.height].allSatisfy { $0.isFinite }
                        && !viewport.isEmpty && bounds.contains(viewport),
                        "Control scrolling must stay inside finite content bounds above the keyboard")
            let frame = element.exists ? element.frame : .zero
            let known = !frame.isEmpty && [frame.minX, frame.minY, frame.width, frame.height].allSatisfy { $0.isFinite }
            let upward = known ? frame.midY > viewport.midY : attempt < 35
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.minY + viewport.height * (upward ? 0.7 : 0.3)))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.minY + viewport.height * (upward ? 0.3 : 0.7))))
        }
        try require(element.exists && element.isHittable, "The exact native control must be reachable through the real list")
    }

    @MainActor
    private func viewport(includeComposer: Bool = false) throws -> CGRect {
        let list = app.collectionViews.firstMatch
        try require(list.exists && !app.keyboards.firstMatch.exists, "Message screenshots require an unobscured native List")
        // The composer is now fixed below the timeline. Verify it against the
        // screen's usable bounds; historical text must fit above that inset.
        let rect = includeComposer ? app.frame : list.frame.intersection(app.frame)
        let nav = app.navigationBars.firstMatch, tabs = app.tabBars.firstMatch
        var top = nav.exists ? max(rect.minY, nav.frame.maxY) : rect.minY
        var bottom = tabs.exists ? min(rect.maxY, tabs.frame.minY) : rect.maxY
        let connection = field("realtimeStatus")
        if connection.exists && !connection.frame.isEmpty { top = max(top, connection.frame.maxY + 4) }
        let composer = field("conversation.composer")
        if !includeComposer && composer.exists && !composer.frame.isEmpty { bottom = min(bottom, composer.frame.minY - 4) }
        let error = field("mention.readError")
        if error.exists && !error.frame.isEmpty { bottom = min(bottom, error.frame.minY - 12) }
        let visible = CGRect(x: rect.minX + 2, y: top + 2, width: rect.width - 4, height: bottom - top - 4)
        try require(!visible.isEmpty && !visible.isNull && !visible.isInfinite, "The mention viewport must exclude the read-error inset")
        return visible
    }
    @MainActor
    private func revealText(_ element: XCUIElement) throws {
        for attempt in 0..<70 {
            let view = try viewport(includeComposer: element.identifier == "messageComposer"); var upward = attempt < 35
            if element.exists {
                let rect = element.frame
                if !rect.isEmpty && !rect.isNull && !rect.isInfinite {
                    let visible = rect.intersection(view)
                    if !visible.isNull && visible.width >= rect.width - 1 && visible.height >= rect.height - 1 { return }
                    let above = max(0, view.minY - rect.minY), below = max(0, rect.maxY - view.maxY)
                    try require(above > 0 || below > 0, "Vertical scrolling cannot resolve horizontal historical text clipping")
                    upward = below > 0
                    // Align the measured overflow instead of flinging a nearly
                    // visible reply past the opposite edge of the viewport.
                    let distance = min(view.height * 0.3, max(24, (upward ? below : above) + 12))
                    let start = CGPoint(x: view.midX, y: view.midY + (upward ? distance : -distance) / 2)
                    let end = CGPoint(x: view.midX, y: view.midY - (upward ? distance : -distance) / 2)
                    try require(distance.isFinite && distance > 0 && view.contains(start) && view.contains(end),
                                "Historical text alignment must stay inside the unobscured viewport")
                    let origin = app.coordinate(withNormalizedOffset: .zero)
                    origin.withOffset(CGVector(dx: start.x, dy: start.y))
                        .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: end.x, dy: end.y)),
                               withVelocity: .slow, thenHoldForDuration: 0.2)
                    continue
                }
            }
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: view.midX, dy: view.minY + view.height * (upward ? 0.75 : 0.25)))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: view.midX, dy: view.minY + view.height * (upward ? 0.25 : 0.75))))
        }
        try require(false, "The exact historical text must be fully visible outside navigation and the read-error inset")
    }
    @MainActor
    private func screenshot(_ name: String) throws {
        for id in ["serverURL", "pairingDeviceName", "pairingCode", "device.pairing.code"] {
            try require(!field(id).exists, "Approved screenshots must exclude all pairing inputs and generated codes")
        }
        try require(!app.keyboards.firstMatch.exists, "Approved workflow screenshots must not obscure content with the keyboard")
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
    }
    @MainActor
    private func require(_ condition: Bool, _ reason: String) throws {
        if !condition {
            let credentialsVisible = ["serverURL", "pairingDeviceName", "pairingCode", "device.pairing.code"].contains { field($0).exists }
            if !credentialsVisible {
                let image = XCTAttachment(screenshot: app.screenshot()); image.name = "Native mentions guarded failure diagnostics"; image.lifetime = .keepAlways; add(image)
                let tree = XCTAttachment(string: app.debugDescription); tree.name = "Native mentions failure accessibility hierarchy"; tree.lifetime = .keepAlways; add(tree)
            }
        }
        try demand(condition, reason)
    }

    private func nativeDevice() async throws -> MentionsDevice {
        let identity: MentionsIdentity = try await get("auth/session")
        try demand(identity.user.id == fixture.recipientUserId && identity.user.name == fixture.recipientName, "Independent observations must use the intended recipient")
        let page: MentionsDevicePage = try await get("api/v1/devices")
        let matches = page.devices.filter { $0.displayName == fixture.nativeDeviceName }
        try demand(matches.count == 1, "Pairing must create exactly one uniquely named native device")
        let device = try XCTUnwrap(matches.first)
        try demand(device.platform == "ios" && device.enrolledByUserId == fixture.recipientUserId, "The native device must belong to the recipient")
        return device
    }
    private func verifyHistoricalDestination(_ target: MentionsTarget, publication: MentionsPublication) async throws {
        let selected: MentionsMessageEnvelope = try await get("api/v1/rooms/\(publication.channelB.id)/messages/\(target.messageId)")
        let root: MentionsMessageEnvelope = try await get("api/v1/rooms/\(publication.channelB.id)/messages/\(publication.rootB.id)")
        try demand(selected.message.id == target.messageId && selected.message.roomId == publication.channelB.id
                   && selected.message.threadRootId == publication.rootB.id && selected.message.body == target.body
                   && selected.message.actorType == "user" && selected.message.actorId == fixture.senderUserId,
                   "Exact message lookup must bind the historical reply to its room, root, body and separate sender")
        try demand(selected.message.payload?.mentions == [MentionsActorRef(actorType: "user", actorId: fixture.recipientUserId)],
                   "Each target must contain the real structured recipient mention")
        try demand(root.message.id == publication.rootB.id && root.message.roomId == publication.channelB.id
                   && root.message.threadRootId == nil && root.message.body == publication.rootB.body, "Exact root lookup must bind the real B thread")
    }
    private func notices() async throws -> MentionsNoticePage { try await get("api/v1/notifications?limit=100") }
    private func observations() async throws -> MentionsObservations {
        try await request(fixture.controlURL.appendingPathComponent("observations"), token: fixture.controlToken)
    }
    private func notice(_ id: String, in page: MentionsNoticePage) throws -> MentionsNotice {
        let found = page.notifications.filter { $0.id == id }
        try demand(found.count == 1, "The observed notification ID must identify exactly one real record")
        return try XCTUnwrap(found.first)
    }
    private func verifyNotices(_ page: MentionsNoticePage, publication: MentionsPublication, firstRead: Bool, secondRead: Bool) throws {
        let first = try notice(publication.first.notificationId, in: page), second = try notice(publication.second.notificationId, in: page)
        let sentinel = try notice(publication.sentinel.notificationId, in: page)
        for (row, target) in [(first, publication.first), (second, publication.second)] {
            try demand(row.projectId == publication.projectB.id && row.roomId == publication.channelB.id
                       && row.messageId == target.messageId && row.threadRootId == publication.rootB.id && row.actorId == fixture.senderUserId,
                       "Read state must remain attached to the exact B project/room/message/thread/sender")
        }
        try demand(sentinel.projectId == fixture.projectAId && sentinel.roomId == fixture.channelAId
                   && sentinel.messageId == publication.sentinel.messageId && sentinel.readAt == nil, "Project A's independent sentinel must remain unread")
        try demand((first.readAt != nil) == firstRead && (second.readAt != nil) == secondRead,
                   "Each target must retain its individually expected read state")
        try demand(page.unreadCount == publication.publishedUnreadCount - (firstRead ? 1 : 0) - (secondRead ? 1 : 0), "Global unread count must change only for the selected notices")
    }
    private func verifyAttempts(_ observed: MentionsObservations, publication: MentionsPublication) throws {
        let attempts = observed.readAttempts.filter { $0.notificationId == publication.first.notificationId }
        try demand(!attempts.isEmpty && attempts.filter(\.injected).count == 1, "The exact first target must receive only one injected failure")
        for attempt in attempts {
            try demand(attempt.deviceId == publication.recipientDeviceId && attempt.userId == fixture.recipientUserId
                       && attempt.method == "POST" && attempt.path == "/api/v1/notifications/\(publication.first.notificationId)/read"
                       && attempt.responseFinished && attempt.injected != attempt.forwarded,
                       "Read observations must bind complete real responses to this exact native device and notification")
            try demand(attempt.status == (attempt.injected ? 503 : 200), "Each observed attempt must retain its actual injected or production status")
        }
        try demand(attempts.first?.injected == true && attempts.map(\.sequence) == attempts.map(\.sequence).sorted(), "The injected 503 must precede all forwarded receipts")
    }
    private func stableFailure(_ publication: MentionsPublication, duration: TimeInterval) async throws -> Int {
        let started = Date()
        repeat {
            try verifyNotices(try await notices(), publication: publication, firstRead: false, secondRead: false)
            let observed = try await observations()
            try verifyAttempts(observed, publication: publication)
            try demand(observed.unreadCount == publication.publishedUnreadCount
                       && observed.readAttempts.filter { $0.notificationId == publication.first.notificationId }.count == 1,
                       "No background retry may earn success before the explicit native Retry tap")
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date().timeIntervalSince(started) < duration
        return Int(Date().timeIntervalSince(started) * 1000)
    }
    private func waitForReadBoundary(_ publication: MentionsPublication, firstRead: Bool, secondRead: Bool, firstAttempts: Int? = nil) async throws -> MentionsNoticePage {
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let page = try await notices(), observed = try await observations()
            let first = try notice(publication.first.notificationId, in: page), second = try notice(publication.second.notificationId, in: page)
            let attempts = observed.readAttempts.filter { $0.notificationId == publication.first.notificationId }
            if (first.readAt != nil) == firstRead && (second.readAt != nil) == secondRead && attempts.allSatisfy(\.responseFinished) {
                try verifyNotices(page, publication: publication, firstRead: firstRead, secondRead: secondRead)
                try verifyAttempts(observed, publication: publication)
                if let firstAttempts { try demand(attempts.count == firstAttempts, "Explicit Retry must produce exactly the expected two attempts before leaving the destination") }
                for baseline in observed.baselineNotifications {
                    try demand(try notice(baseline.id, in: page).readAt == baseline.readAt, "The original notification baseline must remain unchanged")
                }
                return page
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        } while Date() < deadline
        throw mentionsError("The exact production read boundary did not settle")
    }
    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(try XCTUnwrap(URL(string: path, relativeTo: fixture.serverURL.appendingPathComponent("/"))).absoluteURL)
    }
    private func request<T: Decodable>(_ url: URL, token: String? = nil, body: [String: String]? = nil, timeout: TimeInterval = 20) async throws -> T {
        var request = URLRequest(url: url); request.timeoutInterval = timeout
        request.setValue("Bearer \(token ?? fixture.peerToken)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key"); request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request), http = try XCTUnwrap(response as? HTTPURLResponse)
        try demand((200..<300).contains(http.statusCode), "Authenticated mentions observation failed with HTTP \(http.statusCode)")
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }
    private func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
}

private func mentionsError(_ reason: String) -> NSError { NSError(domain: "ArtooMentionsUITest", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
private func demand(_ condition: Bool, _ reason: String) throws { if !condition { throw mentionsError(reason) } }
private struct MentionsPairingCode: Decodable { let code: String }
private struct MentionsScope: Decodable { let id: String; let name: String }
private struct MentionsRoot: Decodable { let id: String; let body: String }
private struct MentionsTarget: Decodable { let messageId: String; let notificationId: String; let body: String }
private struct MentionsHistory: Decodable { let laterMessageIds: [String]; let latestMessageIds: [String]; let hasMore: Bool }
private struct MentionsPublication: Decodable {
    let projectB: MentionsScope; let channelB: MentionsScope; let rootB: MentionsRoot
    let first: MentionsTarget; let second: MentionsTarget; let sentinel: MentionsTarget
    let baselineUnreadCount: Int; let publishedUnreadCount: Int; let recipientDeviceId: String; let history: MentionsHistory
}
private struct MentionsObservations: Decodable {
    let publication: MentionsPublication?; let notifications: [MentionsNotice]; let unreadCount: Int
    let baselineNotifications: [MentionsNotice]; let readAttempts: [MentionsReadAttempt]
}
private struct MentionsReadAttempt: Decodable {
    let sequence: Int; let method: String; let path: String; let status: Int?; let injected: Bool; let forwarded: Bool
    let deviceId: String; let userId: String; let notificationId: String; let responseFinished: Bool
}
private struct MentionsBootstrap: Decodable { let projects: [MentionsScope] }
private struct MentionsIdentity: Decodable { struct User: Decodable { let id: String; let name: String }; let user: User }
private struct MentionsDevicePage: Decodable { let devices: [MentionsDevice] }
private struct MentionsDevice: Decodable { let id: String; let displayName: String; let platform: String; let enrolledByUserId: String }
private struct MentionsNoticePage: Decodable { let notifications: [MentionsNotice]; let unreadCount: Int }
private struct MentionsNotice: Decodable {
    let id: String; let projectId: String; let roomId: String; let messageId: String; let threadRootId: String?
    let actorId: String; let bodyPreview: String; let readAt: String?
}
private struct MentionsMessagePage: Decodable { let messages: [MentionsMessage]; let hasMore: Bool; let nextBefore: String? }
private struct MentionsMessageEnvelope: Decodable { let message: MentionsMessage }
private struct MentionsMessage: Decodable {
    let id: String; let roomId: String; let actorType: String; let actorId: String; let body: String; let threadRootId: String?; let payload: MentionsPayload?
}
private struct MentionsPayload: Decodable { let mentions: [MentionsActorRef]? }
private struct MentionsActorRef: Decodable, Equatable { let actorType: String; let actorId: String }
private struct MentionsFixture {
    let serverURL: URL; let controlURL: URL; let peerToken: String; let controlToken: String
    let projectAId: String; let projectAName: String; let channelAId: String; let channelAName: String; let rootAId: String; let rootABody: String
    let recipientUserId: String; let recipientName: String; let senderUserId: String; let senderName: String; let nativeDeviceName: String
    let draftA: String; let draftB: String; let firstMentionBody: String; let secondMentionBody: String
    init(_ environment: [String: String]) throws {
        func read(_ key: String) throws -> String {
            guard let value = environment["ARTOO_UI_\(key)"], !value.isEmpty else { throw mentionsError("Missing native mentions fixture field \(key)") }
            return value
        }
        serverURL = try XCTUnwrap(URL(string: read("SERVER_URL"))); controlURL = try XCTUnwrap(URL(string: read("FIXTURE_CONTROL_URL")))
        for url in [serverURL, controlURL] {
            try demand(["http", "https"].contains(url.scheme ?? "") && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "")
                       && url.user == nil && url.password == nil, "Native mentions controls must use isolated loopback origins")
        }
        peerToken = try read("PEER_CONTROL_TOKEN"); controlToken = try read("FIXTURE_CONTROL_TOKEN")
        projectAId = try read("PROJECT_A_ID"); projectAName = try read("PROJECT_A_NAME")
        channelAId = try read("CHANNEL_A_ID"); channelAName = try read("CHANNEL_A_NAME")
        rootAId = try read("ROOT_A_ID"); rootABody = try read("ROOT_A_BODY")
        recipientUserId = try read("RECIPIENT_USER_ID"); recipientName = try read("RECIPIENT_NAME")
        senderUserId = try read("SENDER_USER_ID"); senderName = try read("SENDER_NAME"); nativeDeviceName = try read("NATIVE_DEVICE_NAME")
        draftA = try read("DRAFT_A"); draftB = try read("DRAFT_B")
        firstMentionBody = try read("FIRST_MENTION_BODY"); secondMentionBody = try read("SECOND_MENTION_BODY")
    }
}
