import Foundation
import Observation

/// The tasks, kept current from the gate's event stream; reconnects with a growing pause when the stream drops (the
/// phone slept, Tailscale reconnected) and fetches the whole list again each time.
@MainActor @Observable
final class Store {
    var tasks: [Int: TaskItem] = [:]
    var connected = false
    var error: String?
    var host: String { didSet { UserDefaults.standard.set(host, forKey: "host"); restart() } }

    private var stream: Task<Void, Never>?
    var api: API? { API(host: host) }

    init() {
        host = UserDefaults.standard.string(forKey: "host") ?? ""
        restart()
    }

    var live: [TaskItem] { sorted.filter(\.isLive) }
    var kept: [TaskItem] { sorted.filter { $0.status == .kept } }
    var finished: [TaskItem] { sorted.filter { $0.status == .done || $0.status == .failed } }
    private var sorted: [TaskItem] { tasks.values.sorted { $0.updated > $1.updated } }

    func restart() {
        stream?.cancel()
        guard let api else { connected = false; return }
        stream = Task { [weak self] in
            var pause: Duration = .seconds(1)
            while !Task.isCancelled {
                do {
                    try await api.events(
                        onList: { list in Task { @MainActor in self?.replace(list); self?.connected = true; self?.error = nil } },
                        onEvent: { event in Task { @MainActor in self?.apply(event) } })
                    pause = .seconds(1)
                } catch {
                    await MainActor.run { self?.connected = false; self?.error = error.localizedDescription }
                }
                try? await Task.sleep(for: pause)
                pause = min(pause * 2, .seconds(30))
            }
        }
    }

    private func replace(_ list: [TaskItem]) {
        var next: [Int: TaskItem] = [:]
        for t in list {
            // Steps already fetched for an open task survive a reconnect.
            var t = t
            if t.steps == nil, let old = tasks[t.id]?.steps { t.steps = old }
            next[t.id] = t
        }
        tasks = next
    }

    private func apply(_ e: TaskEvent) {
        var t = tasks[e.id] ?? .new(from: e)
        t.apply(e)
        tasks[e.id] = t
    }

    /// A task with all its steps, for its page.
    func load(_ id: Int) async {
        guard let api, let full = try? await api.task(id) else { return }
        tasks[id] = full
    }

    /// Runs an action, showing its error if it fails.
    func act(_ f: @escaping (API) async throws -> Void) {
        guard let api else { return }
        Task { do { try await f(api) } catch { self.error = error.localizedDescription } }
    }
}
