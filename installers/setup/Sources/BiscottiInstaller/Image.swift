import CryptoKit
import Foundation
import libzstd

/// A published, zstd-compressed image with its sha256 next to it. AWS has none: its machine builds itself from user data.
struct Release {
    let url: URL
    var sha256: URL { url.appendingPathExtension("sha256") }
    var cache: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "biscotti/\(url.lastPathComponent)")
    }

    /// From the root package.json, by way of build.sh and Info.plist.
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    static let downloads = URL(string: "https://dl.biscotti.lucasgelfond.online/v\(version)")!
    static let pi = Release(url: downloads.appending(path: "biscotti-pi5-v\(version).img.zst"))
    static let mac = Release(url: downloads.appending(path: "biscotti-mac-v\(version).qcow2.zst"))
}

/// The image in the cache, downloaded first unless the cached copy already matches the published sha256.
func fetch(_ release: Release, progress: @escaping (Double) -> Void) async throws -> URL {
    let (data, _) = try await URLSession.shared.data(from: release.sha256)
    let expected = String(decoding: data, as: UTF8.self).split(separator: " ").first.map(String.init) ?? ""
    if FileManager.default.fileExists(atPath: release.cache.path), try sha256(of: release.cache) == expected { return release.cache }

    let downloaded = try await Download(progress: progress).run(release.url)
    guard try sha256(of: downloaded) == expected else { throw InstallerError("The downloaded image is damaged; try again") }
    try FileManager.default.createDirectory(at: release.cache.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: release.cache)
    try FileManager.default.moveItem(at: downloaded, to: release.cache)
    return release.cache
}

/// Reads a file in chunks, zstd-decompressing it if it ends in .zst, and hands each piece to `write`.
func readImage(_ file: URL, progress: (Double) -> Void, write: (UnsafeRawBufferPointer) throws -> Void) throws {
    let input = try FileHandle(forReadingFrom: file)
    defer { try? input.close() }
    let total = Double((try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 1)
    let compressed = file.pathExtension == "zst"
    let stream = ZSTD_createDStream()
    defer { ZSTD_freeDStream(stream) }
    var output = [UInt8](repeating: 0, count: 4 << 20)
    var read = 0.0
    while let chunk = try input.read(upToCount: 4 << 20), !chunk.isEmpty {
        if compressed {
            try chunk.withUnsafeBytes { source in
                var inBuffer = ZSTD_inBuffer(src: source.baseAddress, size: source.count, pos: 0)
                // Until this chunk is used up and zstd has nothing more buffered (a full output buffer may leave some).
                var full = false
                while inBuffer.pos < inBuffer.size || full {
                    try output.withUnsafeMutableBytes { target in
                        var outBuffer = ZSTD_outBuffer(dst: target.baseAddress, size: target.count, pos: 0)
                        let result = ZSTD_decompressStream(stream, &outBuffer, &inBuffer)
                        guard ZSTD_isError(result) == 0 else { throw InstallerError("The image is damaged") }
                        try write(UnsafeRawBufferPointer(rebasing: target[..<outBuffer.pos]))
                        full = outBuffer.pos == outBuffer.size
                    }
                }
            }
        } else {
            try chunk.withUnsafeBytes(write)
        }
        read += Double(chunk.count)
        progress(read / total)
    }
}

func sha256(of file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

/// A download with progress; URLSession's async API doesn't report any.
private final class Download: NSObject, URLSessionDownloadDelegate {
    let progress: (Double) -> Void
    private var continuation: CheckedContinuation<URL, Error>?

    init(progress: @escaping (Double) -> Void) { self.progress = progress }

    func run(_ url: URL) async throws -> URL {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { continuation = $0; session.downloadTask(with: url).resume() }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten written: Int64, totalBytesExpectedToWrite total: Int64) {
        if total > 0 { progress(Double(written) / Double(total)) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file is deleted when this returns, so keep it.
        let kept = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        do {
            if let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, status != 200 {
                throw InstallerError("Downloading the image failed (HTTP \(status))")
            }
            try FileManager.default.moveItem(at: location, to: kept)
            continuation?.resume(returning: kept)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { continuation?.resume(throwing: error) }
        continuation = nil
    }
}
