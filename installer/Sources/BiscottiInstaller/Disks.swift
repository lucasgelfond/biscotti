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

func diskutil(_ verb: String, _ args: String...) throws -> [String: Any] {
    let out = try run("/usr/sbin/diskutil", [verb, "-plist"] + args)
    return try PropertyListSerialization.propertyList(from: out, format: nil) as? [String: Any] ?? [:]
}

@discardableResult
func run(_ tool: String, _ args: [String], input: Data? = nil) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = args
    let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    if input != nil { process.standardInput = stdin }
    try process.run()
    if let input {
        stdin.fileHandleForWriting.write(input)
        try stdin.fileHandleForWriting.close()
    }
    // Both pipes drain at once, so a chatty stderr (limactl's) can't fill up and stall the process.
    var errorData = Data()
    let drained = DispatchGroup()
    drained.enter()
    DispatchQueue.global().async { errorData = stderr.fileHandleForReading.readDataToEndOfFile(); drained.leave() }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    drained.wait()
    let errors = String(decoding: errorData, as: UTF8.self)
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        let last = errors.split(separator: "\n").last.map { ": \($0)" } ?? ""
        throw InstallerError("\(URL(fileURLWithPath: tool).lastPathComponent) \(args.first ?? "") failed\(last)")
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
