import Foundation

/// Simulator infrastructure observes bytes after the actual native Copy tap.
/// It never supplies the expected result or reads through the runner's pasteboard.
enum NativeClipboardProbe {
    @MainActor
    static func verify(expected: String, simulatorUDID: String, controlURL: URL, token: String,
                       tap: () throws -> Void) async throws {
        guard UUID(uuidString: simulatorUDID) != nil,
              ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == simulatorUDID,
              controlURL.scheme == "http", let host = controlURL.host,
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host),
              controlURL.user == nil, controlURL.password == nil, controlURL.query == nil,
              controlURL.fragment == nil, controlURL.path.isEmpty || controlURL.path == "/" else {
            throw failure("Clipboard observer must target this exact fixture simulator and loopback control")
        }
        let seed: Seed = try await request("seed", body: ["simulator_udid": simulatorUDID], controlURL: controlURL, token: token)
        guard seed.simulatorUDID == simulatorUDID, UUID(uuidString: seed.probeID) != nil else {
            throw failure("Clipboard seed must bind the exact simulator and a unique probe")
        }
        let body = ["simulator_udid": simulatorUDID, "probe_id": seed.probeID]
        do {
            guard let sentinel = Data(base64Encoded: seed.sentinelUTF8Base64), !sentinel.isEmpty,
                  String(data: sentinel, encoding: .utf8) != nil, sentinel != Data(expected.utf8) else {
                throw failure("A unique stale-clipboard sentinel must differ from the expected Copy bytes")
            }
            try tap()
            let deadline = Date().addingTimeInterval(10)
            var matched = false
            repeat {
                let observed: Observation = try await request("read", body: body, controlURL: controlURL, token: token)
                guard observed.simulatorUDID == simulatorUDID, observed.probeID == seed.probeID,
                      let bytes = Data(base64Encoded: observed.utf8Base64), String(data: bytes, encoding: .utf8) != nil else {
                    throw failure("Clipboard observation must contain exact UTF-8 bytes for this simulator and probe")
                }
                if bytes != sentinel && bytes.elementsEqual(expected.utf8) { matched = true; break }
                try await Task.sleep(nanoseconds: 100_000_000)
            } while Date() < deadline
            guard matched else { throw failure("The actual native Copy action must replace the sentinel with the exact original UTF-8 bytes") }
            let cleared: Cleared = try await request("clear", body: body, controlURL: controlURL, token: token)
            guard cleared.simulatorUDID == simulatorUDID, cleared.probeID == seed.probeID, cleared.cleared else {
                throw failure("Clipboard probe cleanup must confirm the exact owned simulator and probe")
            }
        } catch {
            let _: Cleared? = try? await request("clear", body: body, controlURL: controlURL, token: token)
            throw error
        }
    }

    private static func request<T: Decodable>(_ operation: String, body: [String: String], controlURL: URL, token: String) async throws -> T {
        var request = URLRequest(url: controlURL.appendingPathComponent("clipboard").appendingPathComponent(operation))
        // Seed/clear run at most two 10-second commands; allow 5 seconds for transport overhead.
        request.httpMethod = "POST"; request.timeoutInterval = 25
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 25; configuration.timeoutIntervalForResource = 25
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count <= 100_000 else {
            throw failure("Bounded fixture clipboard operation failed")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "ArtooNativeClipboardProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private struct Seed: Decodable {
        let simulatorUDID: String; let probeID: String; let sentinelUTF8Base64: String
        enum CodingKeys: String, CodingKey { case simulatorUDID = "simulator_udid", probeID = "probe_id", sentinelUTF8Base64 = "sentinel_utf8_base64" }
    }
    private struct Observation: Decodable {
        let simulatorUDID: String; let probeID: String; let utf8Base64: String
        enum CodingKeys: String, CodingKey { case simulatorUDID = "simulator_udid", probeID = "probe_id", utf8Base64 = "utf8_base64" }
    }
    private struct Cleared: Decodable {
        let simulatorUDID: String; let probeID: String; let cleared: Bool
        enum CodingKeys: String, CodingKey { case simulatorUDID = "simulator_udid", probeID = "probe_id", cleared }
    }
}
