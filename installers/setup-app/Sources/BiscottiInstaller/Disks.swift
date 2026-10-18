import Foundation

/// A removable disk the image can be written to, as `diskutil` reports it.
struct Disk: Identifiable, Hashable {
    let id: String  // e.g. "disk4"
    let name: String
    let size: Int64

    var label: String {
        "\(name) — \(ByteCountFormatter.string(fromByteCount: size, countStyle: .file)) (/dev/\(id))"
    }
}

func diskutil(_ args: String...) throws -> [String: Any] {
    let out = try run("/usr/sbin/diskutil", args + ["-plist"])
    return try PropertyListSerialization.propertyList(from: out, format: nil) as? [String: Any] ?? [:]
}

@discardableResult
func run(_ tool: String, _ args: [String]) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw InstallerError("\(URL(fileURLWithPath: tool).lastPathComponent) \(args.joined(separator: " ")) failed")
    }
    return data
}

struct InstallerError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// External, physical disks only (SD cards and USB drives), never the Mac's own.
func removableDisks() -> [Disk] {
    guard let list = try? diskutil("list", "external", "physical"),
          let ids = list["WholeDisks"] as? [String] else { return [] }
    return ids.compactMap { id in
        guard let info = try? diskutil("info", id) else { return nil }
        return Disk(
            id: id,
            name: info["MediaName"] as? String ?? "Disk",
            size: (info["TotalSize"] as? NSNumber)?.int64Value ?? 0
        )
    }
}
