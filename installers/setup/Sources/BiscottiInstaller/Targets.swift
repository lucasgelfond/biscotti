import Foundation

/// Where biscotti runs. The installer's steps adapt to it.
enum Target: String, CaseIterable {
    case pi, mac, cloud

    var title: String {
        switch self {
        case .pi: "A Raspberry Pi with a 32GB or larger microSD card"
        case .mac: "An M3+ Mac"
        case .cloud: "A dedicated machine with KVM access on AWS, GCP, Azure, etc."
        }
    }

    var symbol: String {
        switch self {
        case .pi: "cpu"
        case .mac: "laptopcomputer"
        case .cloud: "cloud"
        }
    }

    var steps: [Step] {
        let settings: [Step] = [.you, .photon, .llm, .plugins]
        switch self {
        case .pi: return [.welcome, .tailscale, .wifi] + settings + [.ssh, .review, .card, .write, .done]
        case .mac: return [.welcome, .tailscale] + settings + [.review, .mac, .done]
        case .cloud: return [.welcome, .tailscale] + settings + [.review, .aws, .launch, .done]
        }
    }
}

/// Writes stdin to /var/lib/biscotti/<file>, private, but never over an existing .env: it then holds the generated
/// database key, so later changes are edits on the machine.
func saveCommand(_ file: String) -> String {
    let path = "/var/lib/biscotti/\(file)"
    let guarded = file == ".env" ? "[ ! -s \(path) ] || { echo 'biscotti already has settings; edit \(path) there' >&2; exit 1; }; " : ""
    return "\(guarded)mkdir -p /var/lib/biscotti && umask 077 && cat > \(path)"
}

// MARK: Mac. Thin on purpose: this mirrors installers/local/lima.yaml and boots the published biscotti-mac image.

enum Mac {
    /// Lima's nested virtualization (for Firecracker) needs an M3 or later.
    static var isM3OrLater: Bool {
        let brand = String(decoding: (try? run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"])) ?? Data(), as: UTF8.self)
        return Int(brand.replacingOccurrences(of: "Apple M", with: "").prefix { $0.isNumber }).map { $0 >= 3 } ?? false
    }

    static func tool(_ name: String) -> String? {
        ["/opt/homebrew/bin", "/usr/local/bin"].map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func installLima() throws {
        guard let brew = tool("brew") else { throw InstallerError("Install Homebrew first (brew.sh), or Lima from lima-vm.io") }
        try run(brew, ["install", "lima"])
    }

    /// Unpacks the image, starts the "biscotti" VM from it, and puts the settings where first boot looks for them.
    static func install(image: URL, settings: Settings, status: @escaping (String) -> Void) throws {
        guard let limactl = tool("limactl") else { throw InstallerError("Lima isn't installed") }
        let dir = image.deletingLastPathComponent()
        let disk = dir.appending(path: "biscotti-mac.qcow2")
        status("Unpacking the image…")
        FileManager.default.createFile(atPath: disk.path, contents: nil)
        let out = try FileHandle(forWritingTo: disk)
        try readImage(image, progress: { _ in }) { out.write(Data($0)) }
        try out.close()

        // installers/local/lima.yaml, with the image swapped for the published one.
        let yaml = dir.appending(path: "biscotti.yaml")
        try """
            vmType: vz
            plain: true
            nestedVirtualization: true
            cpus: 4
            memory: 6GiB
            disk: 20GiB
            images:
              - location: \(disk.path)
                arch: aarch64
            mounts: []

            """.write(to: yaml, atomically: true, encoding: .utf8)
        status("Starting the VM (a few minutes)…")
        try run(limactl, ["start", "--name=biscotti", "--tty=false", yaml.path])

        status("Adding your settings…")
        let save = { (file: String, data: Data) in
            try run(limactl, ["shell", "biscotti", "sudo", "sh", "-c", saveCommand(file)], input: data)
        }
        try save(".env", Data(settings.env.utf8))
        try save("biscotti.json", settings.pluginsJSON())
    }
}

// MARK: Cloud (AWS): the app launches a NixOS instance that builds biscotti from the user data (AWS.swift); the settings
// go in over SSH afterwards, never in user data.

enum Cloud {
    /// The release tag of this repo the machine builds.
    static let rev = "v\(Release.version)"

    /// installers/aws/user-data.nix.
    static let userData = """
        # Paste as the instance's user data. No secrets here: user data is readable by anyone with EC2 describe access
        # and by every process on the instance.
        { ... }:
        {
          imports = [ "${builtins.fetchTarball "https://github.com/lucasgelfond/biscotti/archive/\(rev).tar.gz"}/installers/aws" ];
        }

        """

    /// The SSH key biscotti's AWS machine is launched with, made on first use.
    static func sshKey() throws -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "biscotti")
        let key = dir.appending(path: "aws-key")
        if !FileManager.default.fileExists(atPath: key.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "biscotti-aws", "-f", key.path])
        }
        return key
    }

    static func sendSettings(_ settings: Settings, host: String, key: URL) throws {
        let save = { (file: String, data: Data) in
            try run("/usr/bin/ssh", [
                "-i", key.path, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "root@\(host)",
                saveCommand(file),
            ], input: data)
        }
        try save(".env", Data(settings.env.utf8))
        try save("biscotti.json", settings.pluginsJSON())
    }
}
