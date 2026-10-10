import XCTest
@testable import Artoo

final class PublisherInformationTests: XCTestCase {
    private let info: [String: Any] = [
        "ArtooPublisherName": "Example publisher",
        "ArtooPrivacyPolicyURL": "https://publisher.test/privacy",
        "ArtooSupportURL": "https://publisher.test/support"
    ]

    func testReadsBothPublicLinksFromSignedBundleMetadata() throws {
        let publisher = try XCTUnwrap(PublisherInformation(info: info))
        XCTAssertEqual(publisher.name, "Example publisher")
        XCTAssertEqual(publisher.privacyPolicyURL.absoluteString, "https://publisher.test/privacy")
        XCTAssertEqual(publisher.supportURL.absoluteString, "https://publisher.test/support")
    }

    func testAbsentPublisherDoesNotInventPolicyOrSupportInformation() {
        XCTAssertNil(PublisherInformation(info: [:]))
        var blank = info; blank["ArtooPublisherName"] = " \n "
        XCTAssertNil(PublisherInformation(info: blank))
        var missing = info; missing.removeValue(forKey: "ArtooSupportURL")
        XCTAssertNil(PublisherInformation(info: missing))
    }

    func testRejectsCleartextLocalAndCredentialBearingPublisherLinks() {
        for key in ["ArtooPrivacyPolicyURL", "ArtooSupportURL"] {
            for value in ["http://publisher.test/privacy", "https://localhost/privacy", "https://team.local/privacy",
                          "https://name:password@publisher.test/privacy", "file:///privacy", "not a URL"] {
                var invalid = info; invalid[key] = value
                XCTAssertNil(PublisherInformation(info: invalid))
            }
        }
    }
}
