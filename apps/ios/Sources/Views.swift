import SwiftUI

/// First run: where the gate is.
struct SetupView: View {
    var store: Store
    @State private var host: String

    init(store: Store) {
        self.store = store
        _host = State(initialValue: store.host)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("biscotti").font(.hero).padding(.bottom, 8)
            Text("Your tasks, from your biscotti. Connect this device to your tailnet with the Tailscale app, then enter your biscotti's Tailscale name.")
                .foregroundStyle(.secondary)
            TextField("biscotti.tail1234.ts.net", text: $host)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textInputAutocapitalization(.never).keyboardType(.URL)
                #endif
                .autocorrectionDisabled()
                .onSubmit(connect)
            Spacer()
            Button(action: connect) { Text("Connect").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(Store.acpURL(host) == nil)
        }
        .padding(32)
    }

    private func connect() {
        guard Store.acpURL(host) != nil else { return }
        store.editingHost = false
        store.host = host
    }
}

/// First thing on launch, and whenever the gate stops answering: it's only on the tailnet, so turn Tailscale on.
/// There's no link that opens Tailscale: its app registers no scheme for other apps (it reads `tailscale://` as its
/// own Tailnet Lock and widget links, and says "Unable to verify deeplink" to anything else), so this only says so,
/// with the App Store for getting it.
struct TailscaleView: View {
    var store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Turn on Tailscale").font(.hero).padding(.bottom, 8)
            Text("Your biscotti is only reachable on your tailnet. Open the Tailscale app and turn it on, then come back.")
                .foregroundStyle(.secondary)
            Text(store.host).font(.footnote.monospaced()).foregroundStyle(.tertiary)
            Spacer()
            Button { store.restart() } label: {
                Group { if store.checking { ProgressView() } else { Text("Retry") } }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large).disabled(store.checking)
            Link(destination: appStore) { Text("Get Tailscale").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
            Button("Change address") { store.editingHost = true }
                .font(.footnote).frame(maxWidth: .infinity)
        }
        .padding(32)
    }

    private var appStore: URL {
        #if os(macOS)
        URL(string: "https://apps.apple.com/app/id1475387142")!
        #else
        URL(string: "https://apps.apple.com/app/id1470499037")!
        #endif
    }
}

/// The board: what's working, open VMs, what's kept for follow-ups, and what's done. Tap one for its timeline;
/// long-press (or right-click) for what you can do with it.
struct BoardView: View {
    @Bindable var store: Store
    @State private var path: [String] = []
    @State private var composing = false
    @State private var openingVM = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if !store.connected, let error = store.error {
                    Label { Text("Reconnecting… ").bold() + Text(error) } icon: { Image(systemName: "wifi.exclamationmark") }
                        .font(.footnote).foregroundStyle(.secondary)
                }
                section("Working", store.live)
                section("VMs", store.vms)
                section("Kept", store.kept)
                section("Done", store.finished)
            }
            .overlay {
                if store.sessions.isEmpty && !store.connected && store.error == nil { ProgressView() }
                if store.sessions.isEmpty && store.connected {
                    ContentUnavailableView("No tasks yet", systemImage: "sparkles", description: Text("Start one here, or text your biscotti."))
                }
            }
            .navigationTitle("Tasks")
            .navigationDestination(for: String.self) { SessionView(store: store, id: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { openingVM = true } label: { Label("New ssh VM", systemImage: "terminal") }
                    } label: {
                        Image(systemName: "plus")
                    } primaryAction: {
                        composing = true
                    }
                    .accessibilityLabel("New task")
                }
            }
            .refreshable { if store.connected { try? await store.list() } else { store.restart() } }
            .sheet(isPresented: $composing) { NewTaskView(store: store) { path.append($0) } }
            .sheet(isPresented: $openingVM) { NewVMView(store: store) { path.append($0) } }
        }
    }

    @ViewBuilder private func section(_ title: String, _ sessions: [Session]) -> some View {
        if !sessions.isEmpty {
            Section(title) {
                ForEach(sessions) { s in
                    NavigationLink(value: s.id) { SessionRow(session: s, latest: s.isLive ? store.latest(s.id) : nil) }
                        .contextMenu { actions(s) }
                        .swipeActions {
                            if s.isLive && !s.isVM { Button("Stop", role: .destructive) { store.stop(s.id) } }
                            else if !s.isLive { Button("Delete", role: .destructive) { store.delete(s.id) } }
                        }
                }
            }
        }
    }

    @ViewBuilder private func actions(_ s: Session) -> some View {
        if s.canMove { Button { store.move(s.id) } label: { Label("Move to cloud", systemImage: "icloud.and.arrow.up") } }
        if let ssh = s.sshCommand { Button { copy(ssh) } label: { Label("Copy ssh command", systemImage: "doc.on.doc") } }
        if s.isVM && s.status == .running { Button { store.closeVM(s.id) } label: { Label("Close (keep it)", systemImage: "pause.circle") } }
        if s.isLive && !s.isVM { Button(role: .destructive) { store.stop(s.id) } label: { Label("Stop", systemImage: "stop.circle") } }
        if !s.isLive { Button(role: .destructive) { store.delete(s.id) } label: { Label("Delete", systemImage: "trash") } }
    }
}

/// A session on the board: its status, what it was asked, what it's doing now (while it works), and when.
struct SessionRow: View {
    var session: Session
    var latest: Entry?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusDot(status: session.status).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title.isEmpty ? "#\(session.id)" : session.title).lineLimit(2)
                if let latest {
                    Text(latest.kind == .tool ? "\(latest.tool.name) \(latest.tool.detail)" : latest.text)
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(meta).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var meta: String {
        var parts = ["#\(session.id)", session.statusLabel]
        if session.isVM { parts.append(session.summary.repo ?? "VM") }
        if let w = session.summary.where { parts.append(w == "cloud" ? "Cloud" : "Local") }
        parts.append(ago(session.updated))
        return parts.joined(separator: " · ")
    }
}

/// One session: its live timeline (what it was asked, each tool call, what it said, its report and screenshot), and
/// the composer for telling it something, or following up once it's kept.
struct SessionView: View {
    @Bindable var store: Store
    var id: String
    @State private var message = ""
    @State private var detail: Entry?
    @State private var zoomed: Entry?
    @State private var atBottom = true
    @State private var confirmDelete = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        let s = store.sessions[id] ?? .placeholder(id)
        // A VM's goal is only its name; what's worth seeing is its setup.
        let entries = (store.timelines[id] ?? []).filter { !(s.isVM && $0.kind == .user) }
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if !store.connected {
                        Label("Reconnecting…", systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.secondary)
                    }
                    if s.isVM { VMCard(session: s) }
                    if entries.isEmpty && store.connected && !s.isLive {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(Block.of(entries)) { block in
                        switch block {
                        case .entry(let e): EntryView(entry: e, report: s.summary.report, detail: $detail, zoomed: $zoomed)
                        case .tools(let run): ToolGroup(tools: run, detail: $detail)
                        }
                    }
                    if s.isLive && !(s.isVM && s.status == .running) {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(s.isVM ? "Setting it up…" : s.status == .queued ? "Waiting for a VM…" : s.status == .moving ? "Moving to the cloud…" : "Working…")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            // A chat's end first, as Paseo and Messages do; a VM's way in first.
            .defaultScrollAnchor(s.isVM ? .top : .bottom)
            .modifier(BottomTracking(atBottom: $atBottom, proxy: proxy, count: entries.count))
            .overlay(alignment: .bottom) {
                if !atBottom {
                    Button { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } label: {
                        Image(systemName: "chevron.down").font(.system(size: 15, weight: .semibold)).frame(width: 40, height: 40)
                            .background(Circle().fill(.regularMaterial)).shadow(radius: 2, y: 1)
                    }
                    .buttonStyle(.plain).padding(.bottom, 8).transition(.opacity)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { if s.canTell { composer(s) } }
        .navigationTitle("#\(id)")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(s.title.isEmpty ? "#\(id)" : s.title).font(.headline).lineLimit(1)
                    StatusLabel(session: s)
                }
            }
            ToolbarItem(placement: .primaryAction) { menu(s) }
        }
        .confirmationDialog("Delete #\(id)?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.delete(id) }
        } message: { Text("Its kept VM goes too.") }
        .sheet(item: $detail) { ToolSheet(entry: $0) }
        .sheet(item: $zoomed) { ScreenshotSheet(entry: $0) }
        .onAppear { store.viewing = id }
        .onDisappear { if store.viewing == id { store.viewing = nil } }
    }

    private func composer(_ s: Session) -> some View {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(s.status == .kept ? "Follow up" : "Tell it something", text: $message, axis: .vertical)
                .lineLimit(1...6).textFieldStyle(.plain).padding(.vertical, 8)
                .onSubmit(send).accessibilityIdentifier("composer")
            if !text.isEmpty {
                DiscButton(systemImage: "arrow.up", color: .accentColor, action: send).accessibilityLabel("Send")
            } else if s.isLive {
                DiscButton(systemImage: "stop.fill", color: .red) { store.stop(id) }.accessibilityLabel("Stop")
            } else {
                DiscButton(systemImage: "arrow.up", color: .secondary.opacity(0.35)) {}.disabled(true)
            }
        }
        .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.secondary.opacity(0.25)))
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .background(.bar)
        .disabled(!store.connected).opacity(store.connected ? 1 : 0.6)
    }

    private func send() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.tell(id, text)
        message = ""
        atBottom = true
    }

    private func menu(_ s: Session) -> some View {
        Menu {
            if s.isLive || (s.isVM && s.status == .running) {
                Button { Task { if let url = try? await store.watch(id) { openURL(url) } } } label: { Label("Live desktop", systemImage: "display") }
            }
            if s.canMove { Button { store.move(id) } label: { Label("Move to cloud", systemImage: "icloud.and.arrow.up") } }
            if let ssh = s.sshCommand { Button { copy(ssh) } label: { Label("Copy ssh command", systemImage: "doc.on.doc") } }
            if s.isVM && s.status == .running { Button { store.closeVM(id) } label: { Label("Close (keep it)", systemImage: "pause.circle") } }
            if s.isVM && s.status == .kept {
                Button {
                    if let key = UserDefaults.standard.string(forKey: "sshKey"), !key.isEmpty { store.reopenVM(id, key: key) }
                    else { store.problem = "Open a VM with your public key first, so it's saved here." }
                } label: { Label("Reopen", systemImage: "play.circle") }
            }
            if s.isLive && !s.isVM { Button(role: .destructive) { store.stop(id) } label: { Label("Stop", systemImage: "stop.circle") } }
            if !s.isLive { Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") } }
        } label: { Image(systemName: "ellipsis.circle") }
    }
}

/// Whether the timeline is kept at its end: it is until the owner scrolls up (then a button brings it back), and while
/// it is, what's added (a step, a screenshot as it lays out) scrolls it along.
private struct BottomTracking: ViewModifier {
    @Binding var atBottom: Bool
    var proxy: ScrollViewProxy
    var count: Int

    func body(content: Content) -> some View {
        if #available(iOS 18, macOS 15, *) {
            content
                .onScrollPhaseChange { old, phase, context in
                    guard phase == .idle, old == .interacting || old == .decelerating else { return }
                    let g = context.geometry
                    withAnimation(.easeOut(duration: 0.2)) {
                        atBottom = g.contentSize.height <= g.containerSize.height || g.visibleRect.maxY >= g.contentSize.height - 60
                    }
                }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                    if atBottom { proxy.scrollTo("end", anchor: .bottom) }
                }
        } else {
            content.onChange(of: count) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}

/// One timeline entry: the owner's words on the right, the task's in full width, its report in a card.
struct EntryView: View {
    var entry: Entry
    var report: String?
    @Binding var detail: Entry?
    @Binding var zoomed: Entry?

    var body: some View {
        switch entry.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 4) {
                Text(markdown(entry.text)).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4, style: .continuous)
                        .fill(Color.secondary.opacity(0.15)))
                if let failed = entry.failed { Label(failed, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 40).padding(.vertical, 4)
        case .said where entry.text == report:
            VStack(alignment: .leading, spacing: 6) {
                Label("Report", systemImage: "checkmark.seal").font(.label).foregroundStyle(.green)
                Text(markdown(entry.text)).textSelection(.enabled)
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.green.opacity(0.08)))
        case .said:
            Text(markdown(entry.text)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
        case .tool:
            ToolRow(entry: entry).onTapGesture { detail = entry }
        case .image:
            if let data = entry.image, let image = picture(data) {
                image.resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.secondary.opacity(0.2)))
                    .frame(maxWidth: .infinity, maxHeight: 420, alignment: .leading)
                    .onTapGesture { zoomed = entry }
                    .accessibilityLabel("Screenshot")
            }
        }
    }
}

/// A tool call in one line: its icon, its name, and what it was given.
struct ToolRow: View {
    var entry: Entry
    var body: some View {
        let tool = entry.tool
        HStack(spacing: 6) {
            Image(systemName: ToolRow.icon(tool.name)).font(.caption).foregroundStyle(.secondary).frame(width: 16)
            Text(tool.name).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
            Text(tool.detail).font(.footnote).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
        }
        .padding(.vertical, 3).contentShape(Rectangle())
    }

    static func icon(_ name: String) -> String {
        let n = name.lowercased()
        if n.contains("navigate") || n.contains("open") { return "globe" }
        if n.contains("click") { return "cursorarrow.click" }
        if n.contains("type") || n.contains("fill") || n.contains("key") { return "keyboard" }
        if n.contains("screenshot") || n.contains("snapshot") { return "camera" }
        if n.contains("bash") || n.contains("shell") || n.contains("exec") { return "terminal" }
        if n.contains("setup") { return "gearshape" }
        if n.contains("read") || n.contains("search") || n.contains("find") { return "magnifyingglass" }
        if n.contains("write") || n.contains("edit") { return "pencil" }
        return "hammer"
    }
}

/// Tool calls in a row, folded into one line ("4 tool calls"), opened to show each.
struct ToolGroup: View {
    var tools: [Entry]
    @Binding var detail: Entry?
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { withAnimation(.easeOut(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver").font(.caption).foregroundStyle(.secondary).frame(width: 16)
                    Text("\(tools.count) tool calls").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    Text(Array(Set(tools.map(\.tool.name))).sorted().joined(separator: ", ")).font(.footnote).foregroundStyle(.tertiary).lineLimit(1)
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary).rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 3).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(tools) { t in ToolRow(entry: t).onTapGesture { detail = t } }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 1).padding(.leading, 7) }
            }
        }
    }
}

/// A tool call in full: its name, and what it was given.
struct ToolSheet: View {
    var entry: Entry
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                Text(entry.text).font(.callout.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle(entry.tool.name)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The task's screenshot, as big as it goes.
struct ScreenshotSheet: View {
    var entry: Entry
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { if let data = entry.image, let image = picture(data) { image.resizable().scaledToFit().padding() } }
                .navigationTitle("Screenshot")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// An ssh VM's way in: its ssh command, its host key for known_hosts, and its Preview.
struct VMCard: View {
    var session: Session
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let repo = session.summary.repo { Label(repo, systemImage: "shippingbox").font(.footnote).foregroundStyle(.secondary) }
            if let ssh = session.sshCommand {
                HStack {
                    Text(ssh).font(.footnote.monospaced()).textSelection(.enabled).lineLimit(3).minimumScaleFactor(0.8)
                    Spacer()
                    Button { copy(ssh) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).accessibilityLabel("Copy ssh command")
                }
            }
            if let key = session.summary.hostKey, let s = session.summary.ssh {
                Button { copy("[\(s.host)]:\(s.port) \(key)") } label: { Label("Copy known_hosts line", systemImage: "key") }.font(.footnote)
            }
            if let preview = session.summary.preview.flatMap(URL.init(string:)) {
                Link(destination: preview) { Label("Preview", systemImage: "safari") }.font(.footnote)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.secondary.opacity(0.1)))
    }
}

/// A new task: what it should do. Its timeline opens once it has a number.
struct NewTaskView: View {
    var store: Store
    var started: (String) -> Void
    @State private var goal = ""
    @State private var starting = false
    @State private var failed: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should it do?", text: $goal, axis: .vertical).lineLimit(4...10).accessibilityIdentifier("goal")
                } footer: {
                    if let failed { Text(failed).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if starting { ProgressView() } else {
                        Button("Start", action: start).disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected)
                    }
                }
            }
        }
    }

    private func start() {
        let g = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        starting = true
        Task {
            do {
                let id = try await store.start(g)
                dismiss()
                started(id)
            } catch {
                failed = error.localizedDescription
                starting = false
            }
        }
    }
}

/// A VM to ssh into (ssh-vms): your public key (remembered), and a repo to check out, if any.
struct NewVMView: View {
    var store: Store
    var opened: (String) -> Void
    @AppStorage("sshKey") private var key = ""
    @State private var repo = ""
    @State private var opening = false
    @State private var failed: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Your public key") {
                    TextField("ssh-ed25519 AAAA…", text: $key, axis: .vertical).lineLimit(2...5).font(.footnote.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                Section {
                    TextField("owner/repo (optional)", text: $repo).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                } footer: {
                    if let failed { Text(failed).foregroundStyle(.red) }
                    else if opening { Text("Setting it up; with a repo this can take a few minutes.") }
                }
            }
            .navigationTitle("New ssh VM")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if opening { ProgressView() } else {
                        Button("Open", action: open).disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected)
                    }
                }
            }
        }
    }

    private func open() {
        let r = repo.trimmingCharacters(in: .whitespaces)
        opening = true
        failed = nil
        Task {
            do {
                let id = try await store.openVM(key: key.trimmingCharacters(in: .whitespacesAndNewlines), repo: r.isEmpty ? nil : r)
                dismiss()
                if let id { opened(id) }
            } catch {
                failed = error.localizedDescription
                opening = false
            }
        }
    }
}
