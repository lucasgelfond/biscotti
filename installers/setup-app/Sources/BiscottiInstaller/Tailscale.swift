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

    /// The name of a phone on this Mac's tailnet, if the Mac is signed in and one is there.
    static func phone() -> String? {
        guard let cli, let data = try? run(cli, ["status", "--json"]),
              let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let peers = status["Peer"] as? [String: [String: Any]] else { return nil }
        return peers.values.first { ["iOS", "android"].contains($0["OS"] as? String ?? "") }?["HostName"] as? String
    }
}
