import Darwin
import Foundation

/// Writes the image (raw, or zstd-compressed as published) to the raw disk. Like Raspberry Pi Imager, it asks macOS's
/// `authopen` for the device: the user authorizes once, and authopen passes back an open file descriptor over a socket.
func writeImage(_ image: URL, to disk: Disk, progress: @escaping (Double) -> Void) throws {
    try run("/usr/sbin/diskutil", ["unmountDisk", "/dev/\(disk.id)"])
    let fd = try authorizedOpen("/dev/r\(disk.id)")
    defer { close(fd) }

    try readImage(image, progress: progress) { try writeAll(fd, $0) }
    guard fsync(fd) == 0 else { throw InstallerError("Flushing the card failed") }
}

private func writeAll(_ fd: Int32, _ buffer: UnsafeRawBufferPointer) throws {
    var offset = 0
    while offset < buffer.count {
        let n = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
        guard n > 0 else { throw InstallerError("Writing to the card failed: \(String(cString: strerror(errno)))") }
        offset += n
    }
}

/// Runs `authopen -stdoutpipe` on one end of a socket pair and receives the descriptor it sends (SCM_RIGHTS).
private func authorizedOpen(_ path: String) throws -> Int32 {
    var sockets: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw InstallerError("socketpair failed") }
    defer { close(sockets[0]) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/libexec/authopen")
    process.arguments = ["-stdoutpipe", "-o", String(O_RDWR), path]
    process.standardOutput = FileHandle(fileDescriptor: sockets[1], closeOnDealloc: true)
    try process.run()

    // One byte of payload, plus a control message carrying one descriptor (Darwin's CMSG_SPACE(4) is 16).
    var byte: UInt8 = 0
    var control = [UInt8](repeating: 0, count: 16)
    let received: Int = withUnsafeMutablePointer(to: &byte) { bytePointer in
        var iov = iovec(iov_base: bytePointer, iov_len: 1)
        return control.withUnsafeMutableBytes { controlBuffer in
            withUnsafeMutablePointer(to: &iov) { iovPointer in
                var message = msghdr(
                    msg_name: nil, msg_namelen: 0, msg_iov: iovPointer, msg_iovlen: 1,
                    msg_control: controlBuffer.baseAddress, msg_controllen: socklen_t(controlBuffer.count), msg_flags: 0)
                return recvmsg(sockets[0], &message, 0)
            }
        }
    }
    process.waitUntilExit()
    guard received > 0, process.terminationStatus == 0 else { throw InstallerError("macOS didn't allow writing to the card") }
    // cmsghdr is 12 bytes (len, level, type); the descriptor follows.
    return control.withUnsafeBytes { $0.load(fromByteOffset: 12, as: Int32.self) }
}
