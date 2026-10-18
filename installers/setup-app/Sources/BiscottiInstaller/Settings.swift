import CoreWLAN
import Foundation

/// Everything personal that goes on the card. Nothing personal is in the image itself: the Pi reads these from its
/// boot partition on first boot (Wi-Fi, SSH key) and moves the rest into its private settings.
struct Settings {
    var wifiName = CWWiFiClient.shared().interface()?.ssid() ?? ""
    var wifiPassword = ""
    var wifiCountry = Locale.current.region?.identifier ?? "US"
    var sshKey = Settings.firstSSHKey()
    var phone = ""
    var email = ""
    var gatewayKey = ""
    var photonID = ""
    var photonSecret = ""
    var exaKey = ""
    var tailscaleKey = ""
    var googleClientID = ""
    var googleClientSecret = ""
    var githubToken = ""
    var plugins = Set(Settings.optionalPlugins.map(\.id))

    /// The plugins biscotti.json can turn on; iMessage (channels/spectrum) is always on.
    static let optionalPlugins = [
        (id: "exa", name: "Web search (Exa)"),
        (id: "google", name: "Gmail and Google Calendar"),
        (id: "github", name: "GitHub"),
        (id: "artifacts", name: "Web pages"),
        (id: "embedding", name: "Memory by meaning (on device)"),
    ]

    var isComplete: Bool {
        ![wifiName, wifiPassword, sshKey, phone, email, gatewayKey, photonID, photonSecret].contains { $0.isEmpty }
    }

    /// The first public key in ~/.ssh, so the owner can SSH in.
    static func firstSSHKey() -> String {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".ssh")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        guard let pub = files.sorted().first(where: { $0.hasSuffix(".pub") }) else { return "" }
        return (try? String(contentsOf: dir.appending(path: pub), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// The Wi-Fi password saved in the keychain; macOS asks the user before handing it over.
    func savedWifiPassword() -> String? {
        let data = try? run("/usr/bin/security", ["find-generic-password", "-D", "AirPort network password", "-a", wifiName, "-w"])
        return data.map { String(decoding: $0, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    /// Fills keys from a biscotti `.env`-style file, e.g. one saved from an earlier install.
    mutating func load(envFile: URL) {
        guard let text = try? String(contentsOf: envFile, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") where !line.hasPrefix("#") {
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            switch parts[0] {
            case "OWNER": phone = parts[1]
            case "OWNER_EMAIL": email = parts[1]
            case "AI_GATEWAY_API_KEY": gatewayKey = parts[1]
            case "SPECTRUM_PROJECT_ID": photonID = parts[1]
            case "SPECTRUM_PROJECT_SECRET": photonSecret = parts[1]
            case "EXA_API_KEY": exaKey = parts[1]
            case "TS_AUTHKEY": tailscaleKey = parts[1]
            case "GOOGLE_CLIENT_ID": googleClientID = parts[1]
            case "GOOGLE_CLIENT_SECRET": googleClientSecret = parts[1]
            case "GITHUB_TOKEN": githubToken = parts[1]
            default: break
            }
        }
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
        let env = [
            ("OWNER", phone), ("OWNER_EMAIL", email), ("AI_GATEWAY_API_KEY", gatewayKey),
            ("SPECTRUM_PROJECT_ID", photonID), ("SPECTRUM_PROJECT_SECRET", photonSecret),
            ("EXA_API_KEY", exaKey), ("TS_AUTHKEY", tailscaleKey), ("TZ", TimeZone.current.identifier),
            ("GOOGLE_CLIENT_ID", googleClientID), ("GOOGLE_CLIENT_SECRET", googleClientSecret), ("GITHUB_TOKEN", githubToken),
        ].filter { !$0.1.isEmpty }.map { "\($0.0)=\($0.1)" }.joined(separator: "\n") + "\n"

        try wpa.write(to: boot.appending(path: "wpa_supplicant.conf"), atomically: true, encoding: .utf8)
        try (sshKey + "\n").write(to: boot.appending(path: "authorized_keys"), atomically: true, encoding: .utf8)
        try env.write(to: boot.appending(path: "biscotti.env"), atomically: true, encoding: .utf8)
        let enabled = ["channels/spectrum"] + Settings.optionalPlugins.map(\.id).filter(plugins.contains)
        let config = try JSONSerialization.data(withJSONObject: ["plugins": enabled], options: [.prettyPrinted, .withoutEscapingSlashes])
        try config.write(to: boot.appending(path: "biscotti.json"))
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
