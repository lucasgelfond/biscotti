import SwiftUI
import UniformTypeIdentifiers

@main
struct BiscottiInstaller: App {
    var body: some Scene {
        WindowGroup("biscotti Installer") { InstallerView() }
            .windowResizability(.contentSize)
    }
}

/// Choose image → Choose card → Personalize → Write, like Raspberry Pi Imager.
struct InstallerView: View {
    @State private var image: URL?
    @State private var disks = removableDisks()
    @State private var disk: Disk?
    @State private var settings = InstallerView.initialSettings()
    @State private var personalizing = false
    @State private var confirming = false
    @State private var progress: Double?
    @State private var status = ""
    @State private var choosingImage = false

    var body: some View {
        VStack(spacing: 24) {
            Text("biscotti").font(.system(size: 34, weight: .bold, design: .rounded))
            Text("Set up a Raspberry Pi 5 as your biscotti.").foregroundStyle(.secondary)

            HStack(spacing: 16) {
                step("Image", image?.lastPathComponent ?? "Choose image…") { choosingImage = true }
                Menu {
                    ForEach(disks) { d in Button(d.label) { disk = d } }
                    Divider()
                    Button("Refresh") { disks = removableDisks() }
                } label: {
                    stepLabel("Card", disk?.label ?? (disks.isEmpty ? "Insert an SD card" : "Choose card…"))
                }
                .menuStyle(.borderlessButton)
                .frame(width: 220)
                step("Settings", settings.isComplete ? "Ready" : "Personalize…") { personalizing = true }
            }

            if let progress {
                ProgressView(value: progress) { Text(status) }.frame(width: 640)
            } else {
                Text(status).foregroundStyle(.secondary)
            }

            Button("Write") { confirming = true }
                .keyboardShortcut(.defaultAction)
                .disabled(image == nil || disk == nil || !settings.isComplete || progress != nil)
        }
        .padding(32)
        .fileImporter(isPresented: $choosingImage, allowedContentTypes: [UTType(filenameExtension: "img") ?? .data]) {
            image = try? $0.get()
        }
        .sheet(isPresented: $personalizing) { SettingsView(settings: $settings) }
        .alert("Erase \(disk?.name ?? "the card") and write biscotti?", isPresented: $confirming) {
            Button("Erase and write", role: .destructive, action: write)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Everything on \(disk?.label ?? "it") will be deleted.")
        }
    }

    private func step(_ title: String, _ value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { stepLabel(title, value) }.buttonStyle(.plain).frame(width: 220)
    }

    private func stepLabel(_ title: String, _ value: String) -> some View {
        VStack(spacing: 6) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).lineLimit(2).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 72)
        .padding(.horizontal, 12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }

    private func write() {
        guard let image, let disk else { return }
        let settings = settings
        progress = 0
        status = "Writing \(image.lastPathComponent)…"
        Task.detached {
            do {
                try writeImage(image, to: disk) { p in Task { @MainActor in progress = p } }
                await MainActor.run { status = "Adding your settings…" }
                try settings.write(toBootPartition: try mountBootPartition(of: disk))
                try run("/usr/sbin/diskutil", ["eject", "/dev/\(disk.id)"])
                await MainActor.run {
                    progress = nil
                    status = "Done. Put the card in your Pi and power it on; biscotti will text you."
                }
            } catch {
                await MainActor.run {
                    progress = nil
                    status = error.localizedDescription
                }
            }
        }
    }

    /// Prefills keys saved from an earlier install, if there are any.
    private static func initialSettings() -> Settings {
        var settings = Settings()
        settings.load(envFile: FileManager.default.homeDirectoryForCurrentUser.appending(path: "Desktop/biscotti/creds/keys.env"))
        return settings
    }
}

struct SettingsView: View {
    @Binding var settings: Settings
    @Environment(\.dismiss) private var dismiss
    @State private var loadingKeys = false

    var body: some View {
        Form {
            Section("Wi-Fi") {
                TextField("Network name", text: $settings.wifiName)
                HStack {
                    SecureField("Password", text: $settings.wifiPassword)
                    Button("Use saved password") { settings.wifiPassword = settings.savedWifiPassword() ?? settings.wifiPassword }
                }
                TextField("Country code", text: $settings.wifiCountry)
            }
            Section("You") {
                TextField("Your phone number (the only one biscotti answers)", text: $settings.phone)
                TextField("Your email", text: $settings.email)
                TextField("SSH public key", text: $settings.sshKey, axis: .vertical).lineLimit(2...4).font(.body.monospaced())
            }
            Section("Keys") {
                SecureField("Vercel AI Gateway key", text: $settings.gatewayKey)
                TextField("Photon project ID", text: $settings.photonID)
                SecureField("Photon project secret", text: $settings.photonSecret)
                SecureField("Exa API key (optional)", text: $settings.exaKey)
                SecureField("Tailscale auth key (optional: otherwise biscotti texts you a sign-in link)", text: $settings.tailscaleKey)
                Button("Load keys from a file…") { loadingKeys = true }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 620)
        .toolbar { Button("Done") { dismiss() } }
        .fileImporter(isPresented: $loadingKeys, allowedContentTypes: [.data]) {
            if let url = try? $0.get(), url.startAccessingSecurityScopedResource() {
                settings.load(envFile: url)
                url.stopAccessingSecurityScopedResource()
            }
        }
    }
}
