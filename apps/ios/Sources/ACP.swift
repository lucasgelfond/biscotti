import Foundation

// A small ACP client (agentclientprotocol.com): JSON-RPC 2.0 over ACP's Streamable HTTP transport, as biscotti's api
// plugin serves it at <base URL>/acp (plugins/api/index.ts). How it goes over the wire (the SDK's own client is
// @agentclientprotocol/sdk's dist/transports/http-stream.js):
//
//   POST initialize, no headers       -> 200, the JSON-RPC response in the body, and Acp-Connection-Id
//   GET, Accept: text/event-stream    -> the connection's SSE stream (Acp-Connection-Id): answers to requests that
//                                        aren't about a session, and the agent's own messages that aren't either
//   GET, plus Acp-Session-Id          -> one session's SSE stream: its session/update notifications, and the answers
//                                        to requests about it (session/prompt, _biscotti/watch, ...)
//   POST any other message            -> 202, its answer (if a request) comes on one of the streams above. A message
//                                        whose params name a sessionId carries Acp-Session-Id, and that session's
//                                        stream is opened with it. (Not waited for: the server holds a session's
//                                        messages until its stream is read, and URLSession gives a stream's response
//                                        only with its first bytes, which for a quiet session is the keep-alive, 15
//                                        seconds on.)
//   DELETE                            -> the connection is done
//
// A 404 or 410 means the server forgot the connection, so it's closed, as is one whose connection stream ends; the
// owner (Store) makes a new one, with a growing pause.

/// A JSON value: what goes in params and comes back in results, decoded into a typed model where the app needs one.
enum JSON: Codable, Hashable, Sendable, ExpressibleByStringLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByBooleanLiteral {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

    init(stringLiteral value: String) { self = .string(value) }
    init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(booleanLiteral value: Bool) { self = .bool(value) }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSON? { if case .object(let o) = self { o[key] } else { nil } }
    var string: String? { if case .string(let s) = self { s } else { nil } }

    /// This value as a model of the app's.
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self)) }
    static func from<T: Encodable>(_ value: T) throws -> JSON { try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value)) }
}

/// A JSON-RPC message, as it comes off a stream: a request or notification (method), or a response (result or error).
struct RPCMessage: Codable {
    var jsonrpc = "2.0"
    var id: JSON?
    var method: String?
    var params: JSON?
    var result: JSON?
    var error: RPCError?
}

struct RPCError: Codable, LocalizedError, Equatable {
    var code: Int
    var message: String
    var data: JSON?
    var errorDescription: String? {
        // The agent's own words for a rejected prompt are in data (RequestError.invalidParams(undefined, "...")).
        if let text = data?.string, !text.isEmpty { return text }
        if case .object(let o) = data, let text = o["body"]?.string ?? o["message"]?.string { return text }
        return message
    }
}

/// Server-sent events, line by line: each event's data lines joined, given back at the blank line that ends it.
struct SSEParser {
    private var data: [UInt8] = []
    private var has = false

    /// One line, without its line ending. The event's data, if this line ended one.
    mutating func line(_ line: some Collection<UInt8>) -> Data? {
        if line.isEmpty {
            defer { data.removeAll(keepingCapacity: true); has = false }
            return has ? Data(data) : nil
        }
        guard line.starts(with: Array("data:".utf8)) else { return nil } // comments (keep-alives) and other fields
        var value = line.dropFirst(5)
        if value.first == 0x20 { value = value.dropFirst() }
        if has { data.append(0x0A) }
        data.append(contentsOf: value)
        has = true
        return nil
    }
}

/// One connection to an ACP agent. `events` gives the agent's notifications as they come, and ends when the
/// connection does.
actor ACPConnection {
    enum Event: Sendable {
        case notification(method: String, params: JSON)
        /// A session's stream ended on its own (not unfollowed): follow it again to go on getting its updates.
        case streamEnded(session: String)
    }

    struct Closed: LocalizedError { var reason: String; var errorDescription: String? { reason } }

    nonisolated let url: URL
    nonisolated let events: AsyncStream<Event>
    private let sink: AsyncStream<Event>.Continuation
    private let http: URLSession
    private(set) var connectionId: String?
    private(set) var closed: Error?
    private var nextId = 0
    private var pending: [Int: (session: String?, reply: CheckedContinuation<JSON, Error>)] = [:]
    /// Each followed session's stream (`n` tells a stream from the one that replaced it).
    private var streams: [String: (n: Int, task: Task<Void, Never>)] = [:]
    private var connectionStream: Task<Void, Never>?

    init(url: URL) {
        self.url = url
        let config = URLSessionConfiguration.default
        // Each stream gets a keep-alive every 15 seconds, so one this quiet is gone (the phone slept, the network
        // changed) even if no error says so.
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 60 * 60 * 24 * 7
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        // A long-lived GET per followed session, and POSTs alongside them, over HTTP/1.1 when it isn't HTTP/2.
        config.httpMaximumConnectionsPerHost = 64
        http = URLSession(configuration: config)
        (events, sink) = AsyncStream.makeStream(of: Event.self)
    }

    /// The initialize handshake: a connection, and the agent's answer (its capabilities).
    func connect(client: String = "biscotti-app", version: String = "1") async throws -> JSON {
        let id = takeId()
        let message = RPCMessage(id: .number(Double(id)), method: "initialize", params: [
            "protocolVersion": .number(1),
            "clientCapabilities": [:],
            "clientInfo": ["name": .string(client), "version": .string(version)],
        ])
        // Quick, so a gate that isn't there (off the tailnet) shows in seconds.
        var request = post(message)
        request.timeoutInterval = 8
        let (data, response) = try await http.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let connection = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Acp-Connection-Id") else {
            throw Closed(reason: "The gate said \(status) to initialize: \(String(decoding: data.prefix(300), as: UTF8.self))")
        }
        let answer = try JSONDecoder().decode(RPCMessage.self, from: data)
        if let error = answer.error { throw error }
        connectionId = connection
        connectionStream = Task { await self.read(session: nil, n: 0) }
        return answer.result ?? .null
    }

    /// A request, answered when its response comes on a stream.
    func request(_ method: String, _ params: JSON = [:]) async throws -> JSON {
        if let closed { throw closed }
        let session = params["sessionId"]?.string
        if let session { try follow(session) }
        let id = takeId()
        return try await withCheckedThrowingContinuation { reply in
            pending[id] = (session, reply)
            Task { await self.send(RPCMessage(id: .number(Double(id)), method: method, params: params), session: session, id: id) }
        }
    }

    /// A notification (session/cancel): no answer.
    func notify(_ method: String, _ params: JSON = [:]) async throws {
        if let closed { throw closed }
        let session = params["sessionId"]?.string
        if let session { try follow(session) }
        try await deliver(RPCMessage(method: method, params: params), session: session)
    }

    /// Opens a session's stream, once: its updates and the answers to requests about it come there.
    func follow(_ session: String) throws {
        if let closed { throw closed }
        guard streams[session] == nil else { return }
        let n = takeId()
        streams[session] = (n, Task { await self.read(session: session, n: n) })
    }

    /// Stops following a session (its updates wait on the server until it's followed again).
    func unfollow(_ session: String) {
        streams.removeValue(forKey: session)?.task.cancel()
        failRequests(on: session, Closed(reason: "No longer following session \(session)"))
    }

    var followed: Set<String> { Set(streams.keys) }

    /// Done with it: everything waiting fails, and the server is told. Whether it heard.
    @discardableResult
    func close(_ reason: String = "Closed") async -> Bool {
        fail(Closed(reason: reason))
        guard let connectionId, !told else { return true }
        told = (try? await ACPConnection.delete(connectionId, at: url, using: http)) != nil
        return told
    }
    private var told = false

    /// A connection left behind (by a dropped network), told it's done once the network's back.
    static func delete(_ connectionId: String, at url: URL, using http: URLSession = .shared) async throws {
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "DELETE"
        request.setValue(connectionId, forHTTPHeaderField: "Acp-Connection-Id")
        _ = try await http.data(for: request)
    }

    // MARK: -

    private func takeId() -> Int { nextId += 1; return nextId }

    private func post(_ message: RPCMessage, session: String? = nil) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let connectionId { request.setValue(connectionId, forHTTPHeaderField: "Acp-Connection-Id") }
        if let session { request.setValue(session, forHTTPHeaderField: "Acp-Session-Id") }
        request.httpBody = try? JSONEncoder().encode(message)
        return request
    }

    private func send(_ message: RPCMessage, session: String?, id: Int) async {
        do { try await deliver(message, session: session) }
        catch { pending.removeValue(forKey: id)?.reply.resume(throwing: error) }
    }

    /// POSTs a message. A refusal of the whole connection closes it; any other only fails this message.
    private func deliver(_ message: RPCMessage, session: String?) async throws {
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await http.data(for: post(message, session: session)) }
        catch { fail(error); throw error }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = String(decoding: data.prefix(2000), as: UTF8.self)
            let error = Closed(reason: "The gate said \(status): \(body)")
            if [401, 403, 404, 410].contains(status) { fail(error) }
            throw error
        }
    }

    /// Reads a stream (the connection's, or a session's) until it ends.
    private func read(session: String?, n: Int) async {
        guard let connectionId else { return }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(connectionId, forHTTPHeaderField: "Acp-Connection-Id")
        if let session { request.setValue(session, forHTTPHeaderField: "Acp-Session-Id") }
        var failure: Error?
        do {
            let (bytes, response) = try await http.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else { throw Closed(reason: "The gate said \(status) to a stream") }
            var parser = SSEParser()
            var line: [UInt8] = []
            for try await byte in bytes {
                if byte == 0x0A {
                    if let data = parser.line(line) { take(data, from: session) }
                    line.removeAll(keepingCapacity: true)
                } else if byte != 0x0D {
                    line.append(byte)
                }
            }
            failure = Closed(reason: "The connection dropped")
        } catch {
            failure = error
        }
        if Task.isCancelled || closed != nil { return }
        if let session {
            // A session's stream gone: what was waiting on it fails; following it again opens a new one.
            guard streams[session]?.n == n else { return }
            streams.removeValue(forKey: session)
            failRequests(on: session, failure ?? Closed(reason: "The session's stream ended"))
            sink.yield(.streamEnded(session: session))
        } else {
            fail(failure ?? Closed(reason: "The connection's stream ended"))
        }
    }

    private func take(_ data: Data, from session: String?) {
        guard let message = try? JSONDecoder().decode(RPCMessage.self, from: data) else { return }
        if let method = message.method {
            if message.id == nil { sink.yield(.notification(method: method, params: message.params ?? .null)) }
            else {
                // biscotti asks nothing of its clients; anything it does ask is answered with "no such method".
                let reply = RPCMessage(id: message.id, error: RPCError(code: -32601, message: "Method not found: \(method)"))
                Task { try? await self.deliver(reply, session: session) }
            }
            return
        }
        guard case .number(let n) = message.id, let p = pending.removeValue(forKey: Int(n)) else { return }
        if let error = message.error { p.reply.resume(throwing: error) } else { p.reply.resume(returning: message.result ?? .null) }
    }

    private func failRequests(on session: String, _ error: Error) {
        for (id, p) in pending where p.session == session {
            pending.removeValue(forKey: id)
            p.reply.resume(throwing: error)
        }
    }

    private func fail(_ error: Error) {
        guard closed == nil else { return }
        closed = error
        for (_, p) in pending { p.reply.resume(throwing: error) }
        pending = [:]
        for (_, s) in streams { s.task.cancel() }
        streams = [:]
        connectionStream?.cancel()
        sink.finish()
    }
}
