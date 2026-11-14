import Foundation
import Observation

/// The board and its sessions' timelines, kept current from biscotti's ACP agent (ACPConnection): the list once per
/// connection, then every session's changes as _biscotti/session on the connection's stream, so nothing polls. When the
/// connection drops (the phone slept, Tailscale reconnected) it makes a new one, with a growing pause, and lists again.
///
/// Over HTTP a session's timeline (its session/update) comes only on its own stream, so the store follows the one on
/// screen, and the working ones (their rows show what they're doing).
@MainActor @Observable
final class Store {
    var sessions: [String: Session] = [:]
    var timelines: [String: [Entry]] = [:]
    var connected = false
    /// Why the connection isn't up.
    var error: String?
    /// Why something the owner did didn't work (shown once).
    var problem: String?
    /// The gate didn't answer at all (no such name, no route, timed out): it's only on the tailnet, so Tailscale is off
    /// (or the address is wrong). iOS won't tell one app whether another's VPN is up, and every iPhone has utun
    /// interfaces of its own, so whether the gate answers is the check. Shows the Tailscale prompt (TailscaleView).
    var offTailnet = false
    /// Checking whether the gate answers.
    var checking = false
    /// The address is being changed (SetupView).
    var editingHost = false
    var host: String { didSet { UserDefaults.standard.set(host, forKey: "host"); restart() } }
    /// The session on screen: followed, and its history loaded.
    var viewing: String? { didSet { if viewing != oldValue { follow(); if let viewing { Task { await load(viewing) } } } } }
    /// The phone's push token (and whether it's a sandbox one), given to the gate on each connection.
    var device: (token: String, sandbox: Bool)? { didSet { Task { await register() } } }

    /// The owner's biscotti, used until another address is saved.
    static let defaultHost = "https://biscotti-4.tail396c12.ts.net:7443"

    private var acp: ACPConnection?
    private var loop: Task<Void, Never>?
    private var following: Set<String> = []
    /// Sessions whose whole timeline is here (loaded, or started on this connection).
    private var loaded: Set<String> = []
    /// Connections dropped without being told so, told once the gate answers again.
    private var stale: [String] = []

    var acpURL: URL? { Store.acpURL(host) }

    init() {
        host = UserDefaults.standard.string(forKey: "host") ?? Store.defaultHost
        restart()
    }

    /// <base URL>/acp, the port 7443 unless the address has one.
    static func acpURL(_ host: String) -> URL? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard var parts = URLComponents(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)"), parts.host?.isEmpty == false else { return nil }
        if parts.port == nil { parts.port = 7443 }
        parts.path = "/acp"
        return parts.url
    }

    /// The error says the gate couldn't be reached at all (rather than that it answered with an error).
    static func unreachable(_ error: Error) -> Bool {
        let codes: [URLError.Code] = [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .timedOut, .notConnectedToInternet, .networkConnectionLost]
        return (error as? URLError).map { codes.contains($0.code) } ?? false
    }

    // MARK: The board

    var live: [Session] { tasks.filter(\.isLive) }
    var kept: [Session] { tasks.filter { $0.status == .kept } }
    var finished: [Session] { sorted.filter { $0.status == .done || $0.status == .failed } }
    var vms: [Session] { sorted.filter { $0.isVM && $0.status != .done && $0.status != .failed } }
    private var tasks: [Session] { sorted.filter { !$0.isVM } }
    private var sorted: [Session] { sessions.values.sorted { $0.updated > $1.updated } }

    /// What a working session did last, for its row.
    func latest(_ id: String) -> Entry? { timelines[id]?.last { $0.kind == .tool || $0.kind == .said } }

    // MARK: The connection

    func restart() {
        loop?.cancel()
        if let acp { drop(acp) }
        acp = nil
        connected = false
        following = []
        guard let url = acpURL else { return }
        checking = true
        loop = Task { [weak self] in
            var pause: Duration = .seconds(1)
            while !Task.isCancelled {
                guard let self else { return }
                if await self.run(url) { pause = .seconds(1) }
                if Task.isCancelled { return }
                try? await Task.sleep(for: pause)
                pause = min(pause * 2, .seconds(30))
            }
        }
    }

    /// One connection, until it ends. Whether it got as far as the board.
    private func run(_ url: URL) async -> Bool {
        let acp = ACPConnection(url: url)
        var reached = false
        do {
            _ = try await acp.connect()
            offTailnet = false
            checking = false
            guard !Task.isCancelled else { drop(acp); return false }
            self.acp = acp
            following = []
            loaded = []
            for id in stale { Task { try? await ACPConnection.delete(id, at: url) } }
            stale = []
            try await list()
            reached = true
            connected = true
            error = nil
            follow()
            await register()
            if let viewing { Task { await load(viewing) } }
            for await event in acp.events { handle(event) }
            if Task.isCancelled { return reached }
            error = await acp.closed?.localizedDescription ?? "Disconnected"
        } catch {
            offTailnet = Store.unreachable(error)
            checking = false
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
        if self.acp === acp { self.acp = nil; connected = false }
        drop(acp)
        return reached
    }

    /// Done with a connection: the gate's told now, or once it answers again.
    private func drop(_ acp: ACPConnection) {
        Task {
            let id = await acp.connectionId
            if !(await acp.close()), let id { stale.append(id) }
        }
    }

    /// session/list: the board, all of it.
    func list() async throws {
        guard let acp else { return }
        struct List: Decodable { var sessions: [Session.Info] }
        let list = try await acp.request("session/list").decode(List.self)
        var next: [String: Session] = [:]
        for info in list.sessions {
            guard let id = info.sessionId else { continue }
            var s = sessions[id] ?? .placeholder(id)
            s.apply(info)
            next[id] = s
        }
        sessions = next
    }

    private func handle(_ event: ACPConnection.Event) {
        switch event {
        case .notification("_biscotti/session", let params):
            guard let info = try? params["session"]?.decode(Session.Info.self), let id = info.sessionId else { return }
            var s = sessions[id] ?? .placeholder(id)
            s.apply(info)
            sessions[id] = s
            follow()
        case .notification("session/update", let params):
            guard let id = params["sessionId"]?.string, let update = params["update"] else { return }
            var s = sessions[id] ?? .placeholder(id)
            if update["sessionUpdate"]?.string == "session_info_update", let info = try? update.decode(Session.Info.self) {
                s.apply(info)
            }
            sessions[id] = s
            if let entry = Entry(update: update) { timelines[id, default: []].take(entry) }
            follow()
        case .streamEnded(let session):
            following.remove(session)
            // Followed again in a moment (if it still should be).
            Task { try? await Task.sleep(for: .seconds(1)); follow() }
        case .notification:
            break
        }
    }

    /// Follows the timelines on show (the session on screen, the working ones' rows), and stops following the rest.
    private func follow() {
        guard let acp else { return }
        var wanted = Set(sessions.values.filter(\.isLive).map(\.id))
        if let viewing { wanted.insert(viewing) }
        for id in wanted.subtracting(following) {
            following.insert(id)
            Task { do { try await acp.follow(id) } catch { if self.acp === acp { following.remove(id) } } }
        }
        for id in following.subtracting(wanted) {
            following.remove(id)
            Task { await acp.unfollow(id) }
        }
    }

    /// A session's history, replayed by the agent (session/load) into a fresh timeline.
    func load(_ id: String) async {
        guard let acp, connected, !loaded.contains(id), sessions[id] != nil else { return }
        loaded.insert(id)
        do {
            try await acp.follow(id)
            timelines[id] = []
            _ = try await acp.request("session/load", ["sessionId": .string(id), "cwd": "/", "mcpServers": []])
        } catch {
            if self.acp === acp { loaded.remove(id) }
        }
    }

    // MARK: What the owner does

    /// The desktop's shape follows the device: phone-shaped on iPhone and iPad, a desktop on a Mac.
    static var display: String {
        #if os(macOS)
        "desktop"
        #else
        ProcessInfo.processInfo.isiOSAppOnMac ? "desktop" : "mobile"
        #endif
    }

    /// A new task: session/new, then its goal as the first prompt. Its number, as soon as it has one.
    func start(_ goal: String) async throws -> String {
        guard let acp else { throw ACPConnection.Closed(reason: "Not connected") }
        let new = try await acp.request("session/new", ["cwd": "/", "mcpServers": [], "_meta": ["biscotti": ["display": .string(Store.display)]]])
        guard let id = new["sessionId"]?.string else { throw ACPConnection.Closed(reason: "No session number came back") }
        if sessions[id] == nil { sessions[id] = .placeholder(id, title: String(goal.split(separator: "\n").first ?? "")) }
        loaded.insert(id)
        prompt(id, goal, echo: false)
        follow()
        return id
    }

    /// A message for a running task, or a follow-up for a kept one (which resumes it). Shown at once, and marked as
    /// arrived when the agent echoes it.
    func tell(_ id: String, _ message: String) { prompt(id, message, echo: true) }

    private func prompt(_ id: String, _ text: String, echo: Bool) {
        guard let acp else { problem = "Not connected"; return }
        let entry = Entry(kind: .user, text: text, pending: echo)
        if echo { timelines[id, default: []].append(entry) }
        Task {
            do {
                // Answered when the task reports, which can take a while; what it does meanwhile comes as updates.
                _ = try await acp.request("session/prompt", ["sessionId": .string(id), "prompt": [["type": "text", "text": .string(text)]]])
                mark(entry.id, in: id) { $0.pending = false }
            } catch let failure {
                // A dropped connection says nothing about the task, which goes on; anything else is the agent's no.
                guard await acp.closed == nil else { return }
                if echo { mark(entry.id, in: id) { $0.failed = failure.localizedDescription } }
                problem = failure.localizedDescription
            }
        }
    }

    private func mark(_ entry: UUID, in id: String, _ change: (inout Entry) -> Void) {
        guard let i = timelines[id]?.firstIndex(where: { $0.id == entry }) else { return }
        change(&timelines[id]![i])
    }

    func stop(_ id: String) { act { try await $0.notify("session/cancel", ["sessionId": .string(id)]) } }
    func move(_ id: String) { act { _ = try await $0.request("_biscotti/tasks/move", ["sessionId": .string(id)]) } }
    func delete(_ id: String) {
        act { acp in
            _ = try await acp.request("session/delete", ["sessionId": .string(id)])
            self.sessions[id] = nil
            self.timelines[id] = nil
        }
    }

    /// The live desktop of a working task or an open VM.
    func watch(_ id: String) async throws -> URL? {
        guard let acp else { return nil }
        return try await acp.request("_biscotti/watch", ["sessionId": .string(id)])["url"]?.string.flatMap(URL.init(string:))
    }

    /// An ssh VM (ssh-vms), with this public key let in. Its number.
    func openVM(key: String, repo: String?) async throws -> String? {
        guard let acp else { throw ACPConnection.Closed(reason: "Not connected") }
        var params: JSON = ["key": .string(key)]
        if let repo, case .object(var o) = params { o["repo"] = .string(repo); params = .object(o) }
        let vm = try await acp.request("_biscotti/vms/open", params)
        try? await list()
        follow()
        if case .number(let n) = vm["id"] { return String(Int(n)) }
        return nil
    }
    func reopenVM(_ id: String, key: String) { act { _ = try await $0.request("_biscotti/vms/reopen", ["sessionId": .string(id), "key": .string(key)]) } }
    func closeVM(_ id: String, discard: Bool = false) {
        act { _ = try await $0.request("_biscotti/vms/close", ["sessionId": .string(id), "discard": .bool(discard)]) }
    }

    private func register() async {
        guard let acp, connected, let device else { return }
        _ = try? await acp.request("_biscotti/devices/register", ["token": .string(device.token), "sandbox": .bool(device.sandbox)])
    }

    /// Runs an action, showing its error if it fails.
    func act(_ f: @escaping (ACPConnection) async throws -> Void) {
        guard let acp else { problem = "Not connected"; return }
        Task { do { try await f(acp) } catch { self.problem = error.localizedDescription } }
    }
}
