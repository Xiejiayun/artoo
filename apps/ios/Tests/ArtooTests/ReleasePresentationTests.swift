import XCTest
@testable import Artoo

final class ReleasePresentationTests: XCTestCase {
    func testStaticSiteLinksRequireConfirmedPublicationAndRemoteSafeURL() {
        func publication(endpoint: String, status: String = "published", health: String = "healthy") -> JSONValue {
            .object(["status": .string(status), "receipt": .object(["outcome": .string("published"), "endpoint": .string(endpoint)]), "health": .object(["state": .string(health)])])
        }
        XCTAssertEqual(ReleasePresentation.staticEndpoint(publication(endpoint: "https://product.example.com/"), syncFailed: false)?.host, "product.example.com")
        XCTAssertNil(ReleasePresentation.staticEndpoint(publication(endpoint: "https://product.example.com/"), syncFailed: true))
        XCTAssertNil(ReleasePresentation.staticEndpoint(publication(endpoint: "https://product.example.com/", status: "failed"), syncFailed: false))
        XCTAssertNil(ReleasePresentation.staticEndpoint(publication(endpoint: "https://product.example.com/", health: "unknown"), syncFailed: false))
        for endpoint in ["javascript:alert(1)", "https://user:secret@example.com", "http://127.0.0.1:8080/", "http://localhost:8080/", "http://[::1]:8080/"] {
            XCTAssertNil(ReleasePresentation.staticEndpoint(publication(endpoint: endpoint), syncFailed: false), endpoint)
        }
    }

    func testLocalAvailabilityExpiresAndOldSamplesCannotSurviveStopAttempt() throws {
        let publication = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"current_state":"healthy","receipt":{"lease":{"deadline_at":"2026-11-14T01:00:00Z"}},"request":{"capabilities":{"contract":{"limits":{"health_freshness_ms":30000}}}},"latest_observation":{"observed_at":"2026-11-14T00:00:00Z","health":{"checked_at":"2026-11-14T00:00:00Z"}}}"#.utf8))
        let time = try XCTUnwrap(ReleasePresentation.date(.string("2026-11-14T00:00:00Z")))
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time, syncFailed: false, stoppedAt: nil), "healthy")
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time.addingTimeInterval(30), syncFailed: false, stoppedAt: nil), "unknown")
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time.addingTimeInterval(3600), syncFailed: false, stoppedAt: nil), "expired")
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time, syncFailed: true, stoppedAt: nil), "unknown")
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time, syncFailed: false, stoppedAt: time), "unknown")
        XCTAssertEqual(ReleasePresentation.applicationState(publication, now: time.addingTimeInterval(-1), syncFailed: false, stoppedAt: nil), "unknown")
        XCTAssertEqual(ReleasePresentation.applicationState(.object(["current_state": .string("healthy")]), now: time, syncFailed: false, stoppedAt: nil), "unknown")
    }

    func testUnconfirmedCleanupNeverCountsAsStopped() throws {
        for (state, closed) in [("unconfirmed", false), ("not-started", true), ("closed-confirmed", true), ("future", false)] {
            let value: JSONValue = .object(["receipt": .object(["outcome": .string("failed"), "cleanup": .object(["state": .string(state)])])])
            XCTAssertEqual(ReleasePresentation.isClosed(value), closed)
        }
    }
}
