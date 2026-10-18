import Foundation

/// Tailscale on this Mac, and the owner's phone as one of its peers.
enum Tailscale {
    static let downloadMac = URL(string: "https://tailscale.com/download/mac")!
    static let downloadPhone = URL(string: "https://tailscale.com/download/ios")!

    static var cli: String? {
        (["/Applications/Tailscale.app/Contents/MacOS/Tailscale"] + ["/opt/homebrew/bin", "/usr/local/bin"].map { "\($0)/tailscale" })
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static var isInstalled: Bool { cli != nil || FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") }

    private static func status() -> [String: Any]? {
        guard let cli, let data = try? run(cli, ["status", "--json"]) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func peers(_ status: [String: Any]) -> [[String: Any]] {
        (status["Peer"] as? [String: [String: Any]]).map { Array($0.values) } ?? []
    }

    /// The name of a phone on this Mac's tailnet, if the Mac is signed in and one is there.
    static func phone() -> String? {
        guard let status = status() else { return nil }
        // iOS reports its HostName as "localhost"; the MagicDNS name is the one people see.
        let peer = peers(status).first { ["iOS", "android"].contains($0["OS"] as? String ?? "") }
        return (peer?["DNSName"] as? String)?.split(separator: ".").first.map(String.init) ?? peer?["HostName"] as? String
    }

    /// This Mac's tailnet (e.g. tail0000.ts.net) and a name no machine on it uses yet: biscotti, else biscotti-2, ….
    static func tailnet() -> (suffix: String, hostname: String)? {
        guard let status = status(), status["BackendState"] as? String == "Running",
              let suffix = status["MagicDNSSuffix"] as? String, !suffix.isEmpty else { return nil }
        let taken = Set(peers(status).compactMap { ($0["DNSName"] as? String)?.split(separator: ".").first.map { $0.lowercased() } })
        let name = (["biscotti"] + (2...99).map { "biscotti-\($0)" }).first { !taken.contains($0) } ?? "biscotti"
        return (suffix, name)
    }
}
