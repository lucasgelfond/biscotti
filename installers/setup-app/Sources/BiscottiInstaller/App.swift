import Contacts
import SwiftUI
import UniformTypeIdentifiers

@main
struct BiscottiInstaller: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup("biscotti Installer") { InstallerView() }
            .windowResizability(.contentSize)
    }
}

/// A menu bar with just About and Quit. Without an Edit menu, text fields lose ⌘X/⌘C/⌘V/⌘A/⌘Z, so a key monitor
/// sends those to the focused field.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let app = NSMenu()
        app.addItem(withTitle: "About biscotti Installer", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit biscotti Installer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem()
        item.submenu = app
        let bar = NSMenu()
        bar.addItem(item)
        NSApp.mainMenu = bar

        let edits: [String: Selector] = [
            "x": #selector(NSText.cut(_:)), "c": #selector(NSText.copy(_:)), "v": #selector(NSText.paste(_:)),
            "a": #selector(NSText.selectAll(_:)), "z": Selector(("undo:")), "Z": Selector(("redo:")),
        ]
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.shift) == .command,
                  let action = event.charactersIgnoringModifiers.flatMap({ edits[$0] }) else { return event }
            return NSApp.sendAction(action, to: nil, from: nil) ? nil : event
        }
    }
}

enum Step {
    case welcome, tailscale, wifi, you, photon, llm, plugins, ssh, review, card, write, mac, aws, launch, done

    var title: String {
        switch self {
        case .welcome: "biscotti"
        case .tailscale: "Tailscale"
        case .wifi: "Wi-Fi"
        case .you: "You"
        case .photon: "Photon"
        case .llm: "LLM (any OpenAI-compatible API)"
        case .plugins: "Plugins"
        case .ssh: "SSH (optional)"
        case .review: "Review"
        case .card: "Choose the card"
        case .write: "Write the card"
        case .mac: "Install on this Mac"
        case .aws: "AWS account"
        case .launch: "Launch"
        case .done: "All done"
        }
    }
}

/// The files the app can open: an image or a public key.
enum Import { case image, sshKey }

/// The phone numbers and emails on the macOS "Me" card, once the user allows Contacts access.
func meCard() async -> (phones: [String], emails: [String]) {
    let store = CNContactStore()
    let keys = [CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
    guard (try? await store.requestAccess(for: .contacts)) == true, let me = try? store.unifiedMeContactWithKeys(toFetch: keys) else { return ([], []) }
    return (me.phoneNumbers.map(\.value.stringValue), me.emailAddresses.map { $0.value as String })
}

/// One step per screen: the target, the settings a few at a time, a review, then the target's own install steps.
struct InstallerView: View {
    // For screenshots: `-target mac` and `-step 3` open on a step, `-settings file.env` prefills from that file,
    // `-snapshot out.png` saves the window and quits, and `-noAutofill YES` reads nothing from Contacts, the Keychain or
    // saved keys.
    @State private var target = Target(rawValue: UserDefaults.standard.string(forKey: "target") ?? "") ?? .pi
    @State private var index = UserDefaults.standard.integer(forKey: "step")
    @State private var settings = InstallerView.initialSettings()
    @State private var networks = InstallerView.noAutofill ? [] : Settings.knownNetworks()
    @State private var image: URL?
    @State private var download: Double?
    @State private var downloadError: String?
    @State private var disks = removableDisks()
    @State private var disk: Disk?
    @State private var me: (phones: [String], emails: [String]) = ([], [])
    @State private var importing = false
    @State private var importTarget = Import.image
    @State private var pasting = false
    @State private var pasted = ""
    @State private var copied: String?
    @State private var confirming = false
    @State private var busy = false
    @State private var progress: Double?
    @State private var status = ""
    @State private var awsKey = ""
    @State private var awsSecret = ""
    @State private var awsToken: String?
    @State private var region = AWS.regions[0]
    @State private var log: [String] = []
    @State private var tailscaleOnMac = Tailscale.isInstalled
    // `-tailscalePhone name` stands in for a detected phone in screenshots.
    @State private var phone = UserDefaults.standard.string(forKey: "tailscalePhone")
    @State private var phoneConfirmed = false
    @State private var hasLima = Mac.tool("limactl") != nil

    private var steps: [Step] { target.steps }
    private var step: Step { steps[min(index, steps.count - 1)] }
    private var release: Release? { target == .pi ? .pi : target == .mac ? .mac : nil }

    var body: some View {
        VStack(spacing: 0) {
            if step != .welcome && step != .done { indicator.padding(.top, 20) }
            VStack(alignment: .leading, spacing: 12) {
                Text(step.title).font(.system(size: step == .welcome ? 40 : 26, weight: .bold, design: .rounded)).padding(.bottom, 8)
                page
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 24)
            Divider()
            footer.padding(16)
        }
        .frame(width: 620, height: 600)
        .task {
            guard let path = UserDefaults.standard.string(forKey: "snapshot") else { return }
            try? await Task.sleep(for: .seconds(1))
            // A focused field draws through its field editor, which the snapshot misses.
            NSApp.windows.first?.makeFirstResponder(nil)
            if let view = NSApp.windows.first?.contentView?.superview, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
            NSApp.terminate(nil)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: importTypes) {
            guard let url = try? $0.get() else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            switch importTarget {
            case .image: image = url
            case .sshKey: settings.sshKey = Settings.readKey(url) ?? settings.sshKey
            }
        }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
            if step == .tailscale { checkTailscale() }
            guard step == .card else { return }
            disks = removableDisks()
            if let d = disk, !disks.contains(d) { disk = nil }
        }
        .alert("Erase \(disk?.name ?? "the card") and write biscotti?", isPresented: $confirming) {
            Button("Erase and write", role: .destructive, action: write)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Everything on \(disk?.label ?? "it") will be deleted.")
        }
    }

    private var importTypes: [UTType] {
        switch importTarget {
        case .image: ["img", "zst"].compactMap { UTType(filenameExtension: $0) }
        case .sshKey: [.data]
        }
    }

    private var indicator: some View {
        let shown = steps.filter { $0 != .welcome && $0 != .done }
        return HStack(spacing: 4) {
            ForEach(shown.indices, id: \.self) { i in
                Capsule().fill(i < index ? Color.accentColor : Color.secondary.opacity(0.25)).frame(height: 4)
            }
        }
        .padding(.horizontal, 32)
    }

    @ViewBuilder private var page: some View {
        switch step {
        case .welcome: welcome
        case .tailscale: tailscale
        case .wifi: wifi
        case .you: you
        case .photon: photon
        case .llm: llm
        case .plugins: pluginsPage
        case .ssh: ssh
        case .review: review
        case .card: card
        case .write: statusView
        case .mac: mac
        case .aws: aws
        case .launch: launch
        case .done: done
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Select your deployment target").font(.headline)
            ForEach(Target.allCases, id: \.self) { t in
                Button { target = t } label: {
                    HStack(spacing: 12) {
                        Image(systemName: target == t ? "largecircle.fill.circle" : "circle").foregroundStyle(Color.accentColor)
                        Image(systemName: t.symbol).frame(width: 24)
                        Text(t.title)
                        Spacer()
                    }
                    .padding(14)
                    .background(.quaternary.opacity(target == t ? 1 : 0.5), in: RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// You reach biscotti's pages and forms over Tailscale, from this Mac and your phone.
    private var tailscale: some View {
        Form {
            LabeledContent("On this Mac") {
                if tailscaleOnMac {
                    Label("Installed", systemImage: "checkmark.circle.fill")
                } else {
                    Link("Install Tailscale", destination: Tailscale.downloadMac)
                }
            }
            LabeledContent("On your phone") {
                if let phone {
                    Label(phone, systemImage: "checkmark.circle.fill")
                } else {
                    HStack {
                        Toggle("Tailscale is installed on my phone", isOn: $phoneConfirmed).toggleStyle(.checkbox)
                        Link("Get it", destination: Tailscale.downloadPhone)
                    }
                }
            }
        }
        .settingsForm()
        .onAppear { checkTailscale() }
    }

    private func checkTailscale() {
        tailscaleOnMac = Tailscale.isInstalled
        if phone == nil, !Self.noAutofill, let found = Tailscale.phone() { phone = found }
    }

    private var wifi: some View {
        Form {
            Picker("Network", selection: $settings.wifiName) {
                ForEach(networks, id: \.self) { Text($0) }
                if !networks.contains(settings.wifiName) { Text(settings.wifiName).tag(settings.wifiName) }
            }
            HStack {
                TextField("Password", text: $settings.wifiPassword)
                if settings.wifiPassword.isEmpty {
                    Button("From Keychain") { fillWifiPassword() }.buttonStyle(.link).controlSize(.small)
                }
            }
            TextField("Country code", text: $settings.wifiCountry)
        }
        .settingsForm()
        .onChange(of: settings.wifiName) { settings.wifiPassword = ""; fillWifiPassword() }
        .onAppear { if settings.wifiPassword.isEmpty { fillWifiPassword() } }
    }

    private func fillWifiPassword() {
        guard !Self.noAutofill, UserDefaults.standard.string(forKey: "snapshot") == nil else { return }
        settings.wifiPassword = settings.savedWifiPassword() ?? settings.wifiPassword
    }

    private var you: some View {
        Form {
            if me.phones.count > 1 {
                Picker("Your phone number", selection: $settings.phone) { ForEach(me.phones, id: \.self) { Text($0) } }
            } else {
                TextField("Your phone number", text: $settings.phone)
            }
            TextField("Your email", text: $settings.email)
        }
        .settingsForm()
        .task {
            guard settings.phone.isEmpty, !Self.noAutofill else { return }
            me = await meCard()
            if settings.phone.isEmpty { settings.phone = me.phones.first ?? "" }
            if settings.email.isEmpty { settings.email = me.emails.first ?? "" }
        }
    }

    private var photon: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Because iMessage has no native API, biscotti texts you through Photon. You'll need to set up a Photon Spectrum project and get the keys.")
            serviceButtons("photon")
            Form {
                TextField("Photon project ID", text: $settings.photonID)
                SecureField("Photon project secret", text: $settings.photonSecret)
            }
            .settingsForm()
        }
    }

    private var llm: some View {
        VStack(alignment: .trailing, spacing: 8) {
            Button("Import") { pasting = true }
                .controlSize(.small)
                .popover(isPresented: $pasting) {
                    VStack(alignment: .leading) {
                        Text("Paste JSON or KEY=VALUE lines").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $pasted).font(.body.monospaced()).frame(width: 340, height: 120)
                        Button("Fill") {
                            settings.load(pasted)
                            pasted = ""
                            pasting = false
                        }
                    }
                    .padding()
                }
            Form {
                TextField("Base URL", text: $settings.llmBaseURL, prompt: Text("https://ai-gateway.vercel.sh/v1"))
                SecureField("API key", text: $settings.llmKey)
                TextField("Model", text: $settings.model)
            }
            .settingsForm()
        }
    }

    private var pluginsPage: some View {
        Form {
            ForEach(Settings.optionalPlugins, id: \.id) { plugin in
                Section {
                    Toggle(plugin.name, isOn: Binding(
                        get: { settings.plugins.contains(plugin.id) },
                        set: { if $0 { settings.plugins.insert(plugin.id) } else { settings.plugins.remove(plugin.id) } }
                    ))
                    if settings.plugins.contains(plugin.id) {
                        pluginKeys(plugin.id)
                        if Prompts.sites[plugin.id] != nil { serviceButtons(plugin.id) }
                    }
                }
            }
        }
        .settingsForm()
    }

    @ViewBuilder private func pluginKeys(_ id: String) -> some View {
        switch id {
        case "exa": SecureField("Exa API key", text: $settings.exaKey)
        case "google":
            TextField("Google OAuth client ID", text: $settings.googleClientID)
            SecureField("Google OAuth client secret", text: $settings.googleClientSecret)
        case "github": SecureField("GitHub token (fine-grained)", text: $settings.githubToken)
        default: EmptyView()
        }
    }

    private var ssh: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button("Use my SSH key") { settings.sshKey = Settings.firstSSHKey() }
                Button("Choose a .pub file…") { open(.sshKey) }
                if Settings.firstSSHKey().isEmpty {
                    Button("Generate one") { settings.sshKey = (try? Settings.generateSSHKey()) ?? "" }
                }
            }
            Form {
                TextField("SSH public key", text: $settings.sshKey, axis: .vertical).lineLimit(3...6).font(.body.monospaced())
            }
            .settingsForm()
        }
    }

    private var review: some View {
        Form {
            LabeledContent("Target", value: target.title)
            if target == .pi { row(.wifi, settings.wifiName) }
            row(.you, settings.phone)
            row(.photon, settings.photonID)
            row(.llm, "\(settings.model) via \(URL(string: settings.llmBaseURL)?.host() ?? settings.llmBaseURL)")
            row(.plugins, Settings.optionalPlugins.filter { settings.plugins.contains($0.id) }.map(\.name).joined(separator: ", "))
            if target == .pi { row(.ssh, settings.sshKey.isEmpty ? "None" : "Key added") }
        }
        .settingsForm()
    }

    private func row(_ target: Step, _ value: String) -> some View {
        LabeledContent(target.title) {
            HStack {
                Text(value).lineLimit(1).foregroundStyle(.secondary)
                Button("Edit") { index = steps.firstIndex(of: target) ?? index }.buttonStyle(.link)
            }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            if disks.isEmpty {
                Label("Insert a microSD card", systemImage: "sdcard").foregroundStyle(.secondary).padding(.vertical, 12)
            }
            ForEach(disks) { d in
                Button { disk = d } label: {
                    HStack {
                        Image(systemName: disk == d ? "checkmark.circle.fill" : "circle")
                        Text(d.label)
                        Spacer()
                    }
                    .padding(12)
                    .background(.quaternary.opacity(disk == d ? 1 : 0.5), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
            Divider().padding(.vertical, 8)
            imageStatus
        }
    }

    /// The image to use: the published one, downloaded on request, or one the user chose.
    private var imageStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image {
                Label("Image: \(image.lastPathComponent)", systemImage: "checkmark.circle.fill")
            } else if let download {
                ProgressView(value: download) { Text("Downloading biscotti…") }.frame(width: 300)
            }
            if let downloadError { Text(downloadError).foregroundStyle(.red) }
            if download == nil || image != nil {
                HStack(spacing: 12) {
                    Button("Download biscotti") { Task { await fetchImage() } }
                    Button("Choose your own image") { open(.image) }
                }
            }
        }
        .font(.callout)
    }

    private var mac: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(Mac.isM3OrLater ? "Apple M3 or later" : "This Mac needs an M3 or later", systemImage: Mac.isM3OrLater ? "checkmark.circle.fill" : "xmark.circle")
            HStack {
                Label(hasLima ? "Lima" : "Lima isn't installed", systemImage: hasLima ? "checkmark.circle.fill" : "circle")
                if !hasLima {
                    Button("Install with Homebrew") { perform { try Mac.installLima() } then: { hasLima = true } }.disabled(busy)
                }
            }
            imageStatus
            statusView
        }
    }

    private var aws: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                serviceButtons("aws")
                if !Self.noAutofill, AWS.savedCredentials(region: region) != nil {
                    Button("Use ~/.aws/credentials") {
                        let saved = AWS.savedCredentials(region: region)
                        awsKey = saved?.accessKey ?? ""
                        awsSecret = saved?.secretKey ?? ""
                        awsToken = saved?.sessionToken
                    }
                    .buttonStyle(.link)
                }
            }
            Form {
                TextField("Access key ID", text: $awsKey)
                SecureField("Secret access key", text: $awsSecret)
                Picker("Region", selection: $region) { ForEach(AWS.regions, id: \.self) { Text($0) } }
            }
            .settingsForm()
        }
    }

    /// The instance launch, then the settings sent to it over SSH.
    private var launch: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("An m8i.large in \(region) with nested virtualization, running NixOS, which builds biscotti and waits for your settings.")
                .padding(.bottom, 8)
            ForEach(log.indices, id: \.self) { Text(log[$0]).font(.callout.monospaced()).foregroundStyle(.secondary) }
            statusView
        }
    }

    @ViewBuilder private var statusView: some View {
        if let progress {
            ProgressView(value: progress) { Text(status) }
        } else if busy {
            ProgressView { Text(status) }.progressViewStyle(.linear)
        } else if !status.isEmpty {
            Text(status).foregroundStyle(.red)
        }
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch target {
            case .pi:
                Label("Put the card in your Pi 5", systemImage: "1.circle")
                Label("Plug in power", systemImage: "2.circle")
            case .mac:
                Label("biscotti is starting in a Lima VM on this Mac", systemImage: "1.circle")
                Label("Keep the Mac awake and online", systemImage: "2.circle")
            case .cloud:
                Label("Your settings are on the machine", systemImage: "1.circle")
                Label("It finishes setting itself up", systemImage: "2.circle")
            }
            Label("Wait for a text from biscotti (first boot takes about 20 minutes)", systemImage: "3.circle")
            Label("Open its Tailscale link on your phone to add it to your network", systemImage: "4.circle")
            if target == .cloud {
                Label("You can now deactivate the installer's access key in IAM.", systemImage: "5.circle")
            }
        }
        .font(.title3)
    }

    /// Where a service's keys come from, and a prompt that gets them with a browser agent.
    private func serviceButtons(_ id: String) -> some View {
        HStack(spacing: 16) {
            Link("Visit site", destination: URL(string: Prompts.sites[id]!)!)
            copyPromptButton(id)
        }
        .tint(.accentColor)
    }

    private func copyPromptButton(_ id: String) -> some View {
        Button(copied == id ? "Copied" : "Copy setup prompt") { copy(Prompts.prompts[id] ?? "", as: id) }
            .buttonStyle(.link)
    }

    private func copy(_ text: String, as id: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = id
    }

    private func open(_ target: Import) {
        importTarget = target
        importing = true
    }

    private var footer: some View {
        HStack {
            if index > 0 && step != .done && !busy {
                Button("Back") { index -= 1 }
            }
            Spacer()
            switch step {
            case .welcome: Button("Get started") { index += 1 }.keyboardShortcut(.defaultAction)
            case .write:
                Button("Erase and write") { confirming = true }
                    .keyboardShortcut(.defaultAction)
                    .disabled(image == nil || disk == nil || busy)
            case .mac:
                Button("Install biscotti") {
                    guard let image else { return }
                    let settings = settings
                    perform { try Mac.install(image: image, settings: settings) { s in Task { @MainActor in status = s } } } then: { index += 1 }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!Mac.isM3OrLater || !hasLima || image == nil || busy)
            case .launch:
                Button("Launch") { launchOnAWS() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
            case .done: Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut(.defaultAction)
            default:
                Button("Continue") { index += 1 }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canContinue)
            }
        }
    }

    private var canContinue: Bool {
        switch step {
        case .tailscale: tailscaleOnMac && (phone != nil || phoneConfirmed)
        case .card: disk != nil && image != nil
        case .wifi: settings.hasWifi
        case .you: settings.hasOwner
        case .photon: settings.hasPhoton
        case .llm: settings.hasAI
        case .plugins: settings.hasPluginKeys
        case .review: settings.isComplete && (target != .pi || settings.hasWifi)
        case .aws: !awsKey.isEmpty && !awsSecret.isEmpty
        default: true
        }
    }

    /// Runs slow work off the main thread, showing `status` meanwhile and any error after.
    private func perform(_ work: @escaping () throws -> Void, then: @escaping () -> Void) {
        busy = true
        Task.detached {
            do {
                try work()
                await MainActor.run {
                    busy = false
                    status = ""
                    then()
                }
            } catch {
                await MainActor.run {
                    busy = false
                    status = error.localizedDescription
                }
            }
        }
    }

    private func write() {
        guard let image, let disk else { return }
        let settings = settings
        progress = 0
        busy = true
        status = "Writing \(image.lastPathComponent)…"
        Task.detached {
            do {
                try writeImage(image, to: disk) { p in Task { @MainActor in progress = p } }
                await MainActor.run { status = "Adding your settings…" }
                try settings.write(toBootPartition: try mountBootPartition(of: disk))
                try run("/usr/sbin/diskutil", ["eject", "/dev/\(disk.id)"])
                await MainActor.run {
                    progress = nil
                    busy = false
                    status = ""
                    index += 1
                }
            } catch {
                await MainActor.run {
                    progress = nil
                    busy = false
                    status = error.localizedDescription
                }
            }
        }
    }

    private func launchOnAWS() {
        let aws = AWS(accessKey: awsKey, secretKey: awsSecret, sessionToken: awsToken, region: region)
        let settings = settings
        let say = { (line: String) in Task { @MainActor in log.append(line) } }
        busy = true
        status = ""
        log = []
        Task {
            do {
                let key = try Cloud.sshKey()
                let ip = try await aws.launch(userData: Cloud.userData, key: key) { say($0) }
                say("Sending your settings…")
                try await Task.detached { try Cloud.sendSettings(settings, host: ip, key: key) }.value
                busy = false
                index += 1
            } catch {
                busy = false
                status = error.localizedDescription
            }
        }
    }

    static let noAutofill = UserDefaults.standard.bool(forKey: "noAutofill")

    /// Prefills keys saved from an earlier install, if there are any.
    private static func initialSettings() -> Settings {
        var settings = Settings()
        if noAutofill { (settings.wifiName, settings.sshKey) = ("", "") }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let file = UserDefaults.standard.string(forKey: "settings").map { URL(fileURLWithPath: $0) }
        if let file { settings.load(envFile: file) } else if !noAutofill { settings.load(envFile: home.appending(path: "Desktop/biscotti/creds/keys.env")) }
        return settings
    }

    /// Downloads (or finds in the cache) the target's published image.
    private func fetchImage() async {
        guard let release else { return }
        downloadError = nil
        download = 0
        do {
            image = try await fetch(release) { p in Task { @MainActor in download = p } }
        } catch {
            downloadError = "Couldn't download biscotti: \(error.localizedDescription)"
        }
        download = nil
    }
}

extension View {
    /// Grouped forms inset their sections by 20 points; this lines them up with the headings.
    func settingsForm() -> some View { formStyle(.grouped).padding(.horizontal, -20) }
}
