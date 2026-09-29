import Foundation
import Security

public protocol CredentialStore {
    func load() throws -> StoredConnection?
    func save(_ connection: StoredConnection) throws
    func clear() throws
}

/// Device-bound Keychain entry; no credentials in UserDefaults, files, URLs or logs.
public struct KeychainCredentialStore: CredentialStore {
    private let service: String
    public init(service: String = "dev.artoo.control-session") { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "active", kSecAttrSynchronizable as String: false]
    }
    public func load() throws -> StoredConnection? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw storageError(status) }
        return try JSONDecoder().decode(StoredConnection.self, from: data)
    }
    public func save(_ connection: StoredConnection) throws {
        let data = try JSONEncoder().encode(connection)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw storageError(update) }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary, nil)
        guard status == errSecSuccess else { throw storageError(status) }
    }
    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw storageError(status) }
    }
    private func storageError(_ status: OSStatus) -> ApiError {
        .transport("Secure credential storage is unavailable (\(status)). Unlock the device and try again.")
    }
}
