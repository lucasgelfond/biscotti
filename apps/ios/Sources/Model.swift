import Foundation

/// A session of biscotti's ACP agent: a task, or an ssh VM (plugins/api/index.ts, its SessionInfo with the board's
/// Summary in _meta.biscotti).
struct Session: Identifiable, Equatable {
    enum Status: String, Codable {
        case queued, running, moving, kept, done, failed
        init(from decoder: Decoder) throws { self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .running }
    }
    struct SSH: Codable, Equatable { var host: String; var port: Int; var user: String }
    /// _meta.biscotti
    struct Summary: Codable, Equatable {
        var kind: String?
        var status: Status?
        var slot: Int?
        var `where`: String?
        var repo: String?
        var ssh: SSH?
        var hostKey: String?
        var preview: String?
        var report: String?
    }

    var id: String
    var title: String
    var updated: Date
    var summary: Summary

    var number: Int { Int(id) ?? 0 }
    var status: Status { summary.status ?? .queued }
    var isVM: Bool { summary.kind == "vm" }
    var isLive: Bool { status == .queued || status == .running || status == .moving }
    var canTell: Bool { !isVM && (isLive || status == .kept) && status != .moving }
    var canMove: Bool { !isVM && summary.where == "local" && (status == .running || status == .kept) }
    var isCloud: Bool { summary.where == "cloud" }
    /// `ssh -p 2202 cua@host`
    var sshCommand: String? { summary.ssh.map { "ssh -p \($0.port) \($0.user)@\($0.host)" } }

    static func placeholder(_ id: String, title: String = "") -> Session {
        Session(id: id, title: title, updated: .now, summary: Summary(kind: "task", status: .queued))
    }
}

extension Session {
    /// session/list's SessionInfo, or the session_info_update that says it changed.
    struct Info: Decodable {
        struct Meta: Decodable { var biscotti: Summary? }
        var sessionId: String?
        var title: String?
        var updatedAt: String?
        var _meta: Meta?
    }

    /// The session after `info`.
    mutating func apply(_ info: Info) {
        if let t = info.title { title = t }
        if let at = info.updatedAt.flatMap(Session.date) { updated = at }
        if let s = info._meta?.biscotti { summary = s }
    }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// One thing in a session's timeline, from its session/update notifications: what the owner asked (the goal, a
/// follow-up), a tool call, what the task said (a step, its report), or its screenshot.
struct Entry: Identifiable, Equatable {
    enum Kind: Equatable { case user, said, tool, image }
    var id = UUID()
    var kind: Kind
    var text = ""
    var image: Data?
    /// Sent from here, not yet echoed or answered.
    var pending = false
    /// Why sending it failed.
    var failed: String?

    /// A tool call's name, and what it was given, made readable: {"url":"https://example.com"} -> https://example.com.
    var tool: (name: String, detail: String) {
        let parts = text.split(separator: " ", maxSplits: 1)
        let name = parts.first.map(String.init) ?? text
        let raw = parts.count > 1 ? String(parts[1]) : ""
        guard let data = raw.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (name, raw) }
        let values = object.keys.sorted().compactMap { key -> String? in
            switch object[key] {
            case let s as String: s
            case let n as NSNumber: n.stringValue
            default: nil
            }
        }
        return (name, values.isEmpty ? raw : values.joined(separator: " · "))
    }

    /// The timeline entry a session/update makes, if any.
    init?(update: JSON) {
        switch update["sessionUpdate"]?.string {
        case "user_message_chunk", "agent_message_chunk":
            let user = update["sessionUpdate"]?.string == "user_message_chunk"
            guard let content = update["content"] else { return nil }
            switch content["type"]?.string {
            case "text": self.init(kind: user ? .user : .said, text: content["text"]?.string ?? "")
            case "image":
                guard let data = content["data"]?.string.flatMap({ Data(base64Encoded: $0) }) else { return nil }
                self.init(kind: .image, image: data)
            default: return nil
            }
        case "tool_call":
            self.init(kind: .tool, text: update["title"]?.string ?? "")
        default:
            return nil
        }
    }

    init(kind: Kind, text: String = "", image: Data? = nil, pending: Bool = false) {
        self.kind = kind
        self.text = text
        self.image = image
        self.pending = pending
    }
}

/// A timeline as it's shown: entries one by one, except that tool calls in a row fold into one group (as Paseo does).
enum Block: Identifiable {
    case entry(Entry)
    case tools([Entry])
    var id: UUID {
        switch self {
        case .entry(let e): e.id
        case .tools(let t): t[0].id
        }
    }

    static func of(_ entries: [Entry]) -> [Block] {
        var blocks: [Block] = []
        var run: [Entry] = []
        func flush() {
            if run.count == 1 { blocks.append(.entry(run[0])) } else if !run.isEmpty { blocks.append(.tools(run)) }
            run = []
        }
        for e in entries {
            if e.kind == .tool { run.append(e) } else { flush(); blocks.append(.entry(e)) }
        }
        flush()
        return blocks
    }
}

extension [Entry] {
    /// A user message added, or, if it's the echo of one sent from here (a follow-up resuming a kept task), that one
    /// marked as arrived.
    mutating func take(_ e: Entry) {
        if e.kind == .user, let i = firstIndex(where: { $0.kind == .user && $0.pending && $0.text == e.text }) {
            self[i].pending = false
        } else {
            append(e)
        }
    }
}
