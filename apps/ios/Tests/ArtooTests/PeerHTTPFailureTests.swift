import Foundation
import XCTest

final class PeerHTTPFailureTests: XCTestCase {
    private func describe(_ path: String, _ body: String, method: String = "GET") -> String {
        var request = URLRequest(url: URL(string: "https://private-user:private-password@example.test\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer private-token", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("private-request-body".utf8)
        return PeerHTTPFailure.description(request: request, status: 500, data: Data(body.utf8))
    }

    func testFixtureFailureIdentifiesRouteAndPhaseWithoutRawError() {
        let body = #"{"error":"private error text","diagnostic":{"version":1,"action":"stop","phase":"node_stop","kind":"type_error","code":"ECONNRESET","extra":"private"},"secret":"private"}"#
        XCTAssertEqual(describe("/node/stop?token=private-query", body, method: "POST"),
            "Authenticated peer request failed: POST /node/stop HTTP 500; fixture action=stop phase=node_stop kind=type_error code=ECONNRESET")
    }

    func testProductionFailureUsesTemplateAndAllowedCodeOnly() {
        let body = #"{"error":{"code":"internal_error","message":"private stack","details":{"token":"private"}}}"#
        XCTAssertEqual(describe("/api/v1/tasks/private-task?token=private-query", body),
            "Authenticated peer request failed: GET /api/v1/tasks/:id HTTP 500; api=internal_error")
        XCTAssertEqual(describe("/api/v1/daemons", body),
            "Authenticated peer request failed: GET /api/v1/daemons HTTP 500; api=internal_error")
    }

    func testUnknownEndpointsAndMethodsNeverEchoInput() {
        XCTAssertEqual(describe("/private-path/private-id", #"{"error":{"code":"private-code","message":"private"}}"#, method: "PRIVATE"),
            "Authenticated peer request failed: OTHER [unrecognized endpoint] HTTP 500")
    }

    func testMalformedOversizedAndUnsupportedDiagnosticsRemainStatusOnly() {
        let base = "Authenticated peer request failed: GET /node/stop HTTP 500"
        for body in ["not-json-private", "[\"private\"]", String(repeating: "private", count: 3000),
            #"{"diagnostic":{"version":true,"action":"stop","phase":"node_stop","kind":"error","code":"unknown"}}"#,
            #"{"diagnostic":{"version":2,"action":"stop","phase":"node_stop","kind":"error","code":"unknown"}}"#,
            #"{"diagnostic":{"version":1,"action":"stop","phase":"private","kind":"error","code":"unknown"}}"#,
            #"{"diagnostic":{"version":1,"action":"stop","phase":"node_stop","kind":"error","code":"private"}}"#,
            #"{"diagnostic":{"version":1,"action":"stop","phase":"node_stop","kind":"error","code":"daemon_http_error","upstream_status":999}}"#] {
            XCTAssertEqual(describe("/node/stop", body), base)
        }
    }

    func testKnownUpstreamFailureRetainsOnlyNumericStatus() {
        let body = #"{"error":"private","diagnostic":{"version":1,"action":"stop","phase":"presence_read","kind":"assertion","code":"daemon_http_error","upstream_status":503}}"#
        XCTAssertEqual(describe("/node/stop", body, method: "POST"),
            "Authenticated peer request failed: POST /node/stop HTTP 500; fixture action=stop phase=presence_read kind=assertion code=daemon_http_error upstream_status=503")
    }
}
