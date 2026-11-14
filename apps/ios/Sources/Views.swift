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
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(API(host: host) == nil)
        }
        .padding(32)
    }

    private func connect() {
        guard API(host: host) != nil else { return }
        store.editingHost = false
        store.host = host
    }
}

/// First thing on launch, and whenever the gate stops answering: it's only on the tailnet, so turn Tailscale on.
struct TailscaleView: View {
    var store: Store
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Turn on Tailscale").font(.hero).padding(.bottom, 8)
            Text("Your biscotti is only reachable on your tailnet, so connect Tailscale, then come back.")
                .foregroundStyle(.secondary)
            Text(store.host).font(.footnote.monospaced()).foregroundStyle(.tertiary)
            Spacer()
            Button(action: openTailscale) { Text("Open Tailscale").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            Button { store.restart() } label: {
                Group { if store.checking { ProgressView() } else { Text("Retry") } }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered).controlSize(.large).disabled(store.checking)
            Button("Change address") { store.editingHost = true }
                .font(.footnote).frame(maxWidth: .infinity)
        }
        .padding(32)
    }

    /// Its URL scheme, or its App Store page when it isn't installed.
    private func openTailscale() {
        #if os(macOS)
        let appStore = URL(string: "https://apps.apple.com/app/id1475387142")!
        #else
        let appStore = URL(string: "https://apps.apple.com/app/id1470499037")!
        #endif
        openURL(URL(string: "tailscale://")!) { opened in if !opened { openURL(appStore) } }
    }
}

/// The tasks: working, kept for follow-ups, and done. Long-press (or right-click) a task for what you can do with it.
struct TasksView: View {
    @Bindable var store: Store
    @State private var composing = false
    @State private var telling: TaskItem?

    var body: some View {
        NavigationStack {
            List {
                if !store.connected, let error = store.error {
                    Label(error, systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.secondary)
                }
                section("Working", store.live)
                section("Kept", store.kept)
                section("Done", store.finished)
            }
            .overlay {
                if store.tasks.isEmpty && !store.connected && store.error == nil { ProgressView() }
                if store.tasks.isEmpty && store.connected {
                    ContentUnavailableView("No tasks yet", systemImage: "sparkles", description: Text("Start one here, or text your biscotti."))
                }
            }
            .navigationTitle("Tasks")
            .navigationDestination(for: Int.self) { TaskView(store: store, id: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { composing = true } label: { Image(systemName: "plus") }
                }
                ToolbarItem(placement: .status) {
                    Circle().fill(store.connected ? Color.green : Color.secondary.opacity(0.4)).frame(width: 8, height: 8)
                }
            }
            .refreshable { store.restart() }
            .sheet(isPresented: $composing) { NewTaskView(store: store) }
            .sheet(item: $telling) { TellView(store: store, task: $0) }
        }
    }

    @ViewBuilder private func section(_ title: String, _ tasks: [TaskItem]) -> some View {
        if !tasks.isEmpty {
            Section(title) {
                ForEach(tasks) { task in
                    NavigationLink(value: task.id) { TaskRow(task: task) }
                        .contextMenu { actions(task) }
                        .swipeActions {
                            if task.isLive { Button("Stop", role: .destructive) { store.act { try await $0.stop(task.id) } } }
                        }
                }
            }
        }
    }

    @ViewBuilder private func actions(_ task: TaskItem) -> some View {
        if task.canTell { Button { telling = task } label: { Label(task.status == .kept ? "Follow up…" : "Tell…", systemImage: "text.bubble") } }
        if task.canMove { Button { store.act { try await $0.move(task.id) } } label: { Label("Move to cloud", systemImage: "icloud.and.arrow.up") } }
        if task.isLive { Button(role: .destructive) { store.act { try await $0.stop(task.id) } } label: { Label("Stop", systemImage: "stop.circle") } }
    }
}

struct TaskRow: View {
    var task: TaskItem
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("#\(task.id)").font(.label).foregroundStyle(.secondary)
                StatusPill(status: task.status)
                PlaceBadge(place: task.where)
                Spacer()
                Text(ago(task.updated)).font(.caption).foregroundStyle(.tertiary)
            }
            Text(task.goal).lineLimit(2)
            if let step = task.latest, task.isLive {
                Text(step.line).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One task: what it was asked, what it's done step by step, its report and last screenshot.
struct TaskView: View {
    @Bindable var store: Store
    var id: Int
    @State private var telling = false
    @State private var desktop: URL?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let task = store.tasks[id]
        ScrollView {
            if let task {
                VStack(alignment: .leading, spacing: 16) {
                    HStack { StatusPill(status: task.status); PlaceBadge(place: task.where); Spacer() }
                    Text(task.goal).font(.title3.weight(.semibold))
                    if let report = task.report {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Report").font(.label).foregroundStyle(.secondary)
                            Text(report).textSelection(.enabled)
                        }
                    }
                    if task.screenshot, let url = store.api?.screenshotURL(id) {
                        AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    Text("Steps").font(.label).foregroundStyle(.secondary)
                    ForEach(Array((task.steps ?? []).enumerated().reversed()), id: \.offset) { _, step in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: step.tool == nil ? "text.bubble" : "hammer").foregroundStyle(.secondary).frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(step.line).font(.callout).lineLimit(step.tool == nil ? nil : 2)
                                Text(ago(step.at)).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .padding()
            }
        }
        .navigationTitle("#\(id)")
        .task { await store.load(id) }
        .toolbar {
            if let task {
                if task.isLive {
                    Button { Task { if let url = try? await store.api?.watch(id) { openURL(url) } } } label: { Label("Desktop", systemImage: "display") }
                }
                Menu {
                    if task.canTell { Button(task.status == .kept ? "Follow up…" : "Tell…") { telling = true } }
                    if task.canMove { Button("Move to cloud") { store.act { try await $0.move(id) } } }
                    if task.isLive { Button("Stop", role: .destructive) { store.act { try await $0.stop(id) } } }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $telling) { if let task { TellView(store: store, task: task) } }
    }
}

struct NewTaskView: View {
    var store: Store
    @State private var goal = ""
    @State private var mobile = true
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("What should it do?", text: $goal, axis: .vertical).lineLimit(4...10) }
                Section { Toggle("Phone-shaped desktop", isOn: $mobile) } footer: {
                    Text("Sites show their phone layout, and the live desktop fits this screen.")
                }
            }
            .navigationTitle("New task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { let g = goal; store.act { _ = try await $0.start(g, mobile: mobile) }; dismiss() }
                        .disabled(goal.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

/// A message for a running task, or a follow-up for a kept one (which resumes it where it left off).
struct TellView: View {
    var store: Store
    var task: TaskItem
    @State private var message = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(task.goal).foregroundStyle(.secondary).lineLimit(3) }
                Section { TextField(task.status == .kept ? "Follow up" : "Tell it", text: $message, axis: .vertical).lineLimit(3...8) }
            }
            .navigationTitle(task.status == .kept ? "Follow up on #\(task.id)" : "Tell #\(task.id)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { let m = message, id = task.id; store.act { _ = try await $0.tell(id, m) }; dismiss() }
                        .disabled(message.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
