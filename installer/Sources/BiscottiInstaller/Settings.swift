import Foundation
import Security

/// Everything personal that goes on the card (or into the Mac's VM, or the cloud machine). Nothing personal is in the
/// images: the Pi reads these from its boot partition on first boot (Wi-Fi, SSH key) and moves the rest into its
/// private settings.
struct Settings {
    var wifiName = Settings.knownNetworks().first ?? ""
    var wifiPassword = ""
    var wifiCountry = Locale.current.region?.identifier ?? "US"
    var sshKey = Settings.firstSSHKey()
    var tailscaleName = "biscotti"
    var phone = ""
    var llmBaseURL = ""
    var llmKey = ""
    var model = "deepseek/deepseek-v4.1-flash-1017-fast"
    var photonID = ""
    var photonSecret = ""
    var exaKey = ""
    var googleClientID = ""
    var googleClientSecret = ""
    var githubToken = ""
    var plugins = Set(Settings.optionalPlugins.map(\.id))

    /// The plugins biscotti.json can turn on; iMessage (channels/spectrum) is always on.
    static let optionalPlugins = [
        (id: "exa", name: "Web search (Exa)"),
        (id: "google", name: "Gmail and Google Calendar"),
        (id: "github", name: "GitHub"),
        (id: "artifacts", name: "Artifacts"),
        (id: "embedding", name: "Semantic memory"),
    ]

    var hasWifi: Bool { !wifiName.isEmpty && !wifiPassword.isEmpty }
    var hasOwner: Bool { !phone.isEmpty }
    var hasPhoton: Bool { !photonID.isEmpty && !photonSecret.isEmpty }
    var hasAI: Bool { ![llmBaseURL, llmKey, model].contains { $0.isEmpty } }
    func hasKeys(_ plugin: String) -> Bool {
        switch plugin {
        case "exa": !exaKey.isEmpty
        case "google": !googleClientID.isEmpty && !googleClientSecret.isEmpty
        default: true
        }
    }
    var hasPluginKeys: Bool { plugins.allSatisfy(hasKeys) }
    /// Everything but Wi-Fi, which only the Pi needs.
    var isComplete: Bool { hasOwner && hasPhoton && hasAI && hasPluginKeys }

    /// This Mac's saved Wi-Fi networks, most preferred first (readable without Location access).
    static func knownNetworks() -> [String] {
        let out = (try? run("/usr/sbin/networksetup", ["-listpreferredwirelessnetworks", "en0"])) ?? Data()
        return String(decoding: out, as: UTF8.self).split(separator: "\n").dropFirst().map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The network's password from the Keychain; macOS asks the user before handing it over.
    func savedWifiPassword() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "AirPort",
            kSecAttrAccount as String: wifiName, kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static let sshDir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".ssh")

    /// This Mac's public key (id_ed25519, then id_rsa, then any), so the owner can SSH in.
    static func firstSSHKey() -> String {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: sshDir.path)) ?? []
        let pub = ["id_ed25519.pub", "id_rsa.pub"].first(where: files.contains) ?? files.sorted().first { $0.hasSuffix(".pub") }
        return pub.flatMap { readKey(sshDir.appending(path: $0)) } ?? ""
    }

    static func readKey(_ url: URL) -> String? {
        (try? String(contentsOf: url, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Makes ~/.ssh/id_ed25519 (never over an existing one) and returns its public key.
    static func generateSSHKey() throws -> String {
        let key = sshDir.appending(path: "id_ed25519")
        guard !FileManager.default.fileExists(atPath: key.path) else { return firstSSHKey() }
        try FileManager.default.createDirectory(at: sshDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "biscotti", "-f", key.path])
        return readKey(key.appendingPathExtension("pub")) ?? ""
    }

    /// Fills keys from a biscotti `.env`-style file, e.g. one saved from an earlier install.
    mutating func load(envFile: URL) {
        if let text = try? String(contentsOf: envFile, encoding: .utf8) { load(text) }
    }

    /// Fills keys from KEY=VALUE lines, or from JSON such as {"baseUrl": …, "apiKey": …, "model": …}.
    mutating func load(_ text: String) {
        var pairs: [(String, String)]
        if let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            let aliases = ["baseUrl": "LLM_BASE_URL", "base_url": "LLM_BASE_URL", "apiKey": "LLM_API_KEY", "api_key": "LLM_API_KEY", "model": "MODEL"]
            pairs = json.compactMap { key, value in (value as? String).map { (aliases[key] ?? key, $0) } }
        } else {
            pairs = text.split(separator: "\n").filter { !$0.hasPrefix("#") }.compactMap {
                let parts = $0.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                return parts.count == 2 ? (parts[0], parts[1]) : nil
            }
        }
        for (key, value) in pairs {
            switch key {
            case "OWNER": phone = value
            case "LLM_BASE_URL": llmBaseURL = value
            case "LLM_API_KEY": llmKey = value
            case "MODEL": model = value
            case "WIFI_NAME": wifiName = value
            case "WIFI_PASSWORD": wifiPassword = value
            case "SSH_KEY": sshKey = value
            case "TS_HOSTNAME": tailscaleName = value
            case "SPECTRUM_PROJECT_ID": photonID = value
            case "SPECTRUM_PROJECT_SECRET": photonSecret = value
            case "EXA_API_KEY": exaKey = value
            case "GOOGLE_CLIENT_ID": googleClientID = value
            case "GOOGLE_CLIENT_SECRET": googleClientSecret = value
            case "GITHUB_TOKEN": githubToken = value
            default: break
            }
        }
    }

    /// biscotti's `.env`.
    var env: String {
        [
            ("OWNER", phone), ("LLM_BASE_URL", llmBaseURL), ("LLM_API_KEY", llmKey), ("MODEL", model),
            ("SPECTRUM_PROJECT_ID", photonID), ("SPECTRUM_PROJECT_SECRET", photonSecret),
            ("EXA_API_KEY", exaKey), ("TZ", TimeZone.current.identifier), ("TS_HOSTNAME", tailscaleName),
            ("GOOGLE_CLIENT_ID", googleClientID), ("GOOGLE_CLIENT_SECRET", googleClientSecret), ("GITHUB_TOKEN", githubToken),
        ].filter { !$0.1.isEmpty }.map { "\($0.0)=\($0.1)" }.joined(separator: "\n") + "\n"
    }

    /// biscotti.json: the plugins to load.
    func pluginsJSON() throws -> Data {
        let enabled = ["channels/spectrum"] + Settings.optionalPlugins.map(\.id).filter(plugins.contains)
        return try JSONSerialization.data(withJSONObject: ["plugins": enabled], options: [.prettyPrinted, .withoutEscapingSlashes])
    }

    /// Writes the boot-partition files the image reads on first boot.
    func write(toBootPartition boot: URL) throws {
        let quoted = { (s: String) in "\"" + s.replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
        let wpa = """
            ctrl_interface=/run/wpa_supplicant
            update_config=1
            country=\(wifiCountry)
            network={
              ssid=\(quoted(wifiName))
              psk=\(quoted(wifiPassword))
            }

            """
        try wpa.write(to: boot.appending(path: "wpa_supplicant.conf"), atomically: true, encoding: .utf8)
        try (sshKey + "\n").write(to: boot.appending(path: "authorized_keys"), atomically: true, encoding: .utf8)
        try env.write(to: boot.appending(path: "biscotti.env"), atomically: true, encoding: .utf8)
        try pluginsJSON().write(to: boot.appending(path: "biscotti.json"))
    }
}

/// Mounts the freshly written card and returns its boot (FAT) partition.
func mountBootPartition(of disk: Disk) throws -> URL {
    try run("/usr/sbin/diskutil", ["mountDisk", "/dev/\(disk.id)"])
    let info = try diskutil("info", "\(disk.id)s1")
    guard let mount = info["MountPoint"] as? String, !mount.isEmpty else {
        throw InstallerError("Couldn't mount the card's boot partition")
    }
    return URL(fileURLWithPath: mount)
}
