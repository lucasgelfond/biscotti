import Foundation

/// The gate's task API (core/src/api.ts), at https://<your biscotti's Tailscale name>:7443. Tailscale says who's asking,
/// so there's no sign-in: the phone has to be on the tailnet (the Tailscale app, connected).
struct API {
    var base: URL

    init?(host: String) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var parts = URLComponents(string: withScheme) else { return nil }
        if parts.port == nil { parts.port = 7443 }
        parts.path = "/api"
        guard let url = parts.url else { return nil }
        base = url
    }

    private func url(_ path: String) -> URL { base.appending(path: path) }

    private func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let (data, response) = try await URLSession.shared.data(from: url(path))
        try check(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    private func post(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode >= 300 else { return }
        let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        throw APIError(message: message ?? "The gate said \(http.statusCode)")
    }

    struct APIError: LocalizedError { var message: String; var errorDescription: String? { message } }
    private struct List: Decodable { var tasks: [TaskItem] }

    func tasks() async throws -> [TaskItem] { try await get("tasks", as: List.self).tasks }
    func task(_ id: Int) async throws -> TaskItem { try await get("tasks/\(id)", as: TaskItem.self) }
    func screenshotURL(_ id: Int) -> URL { url("tasks/\(id)/screenshot") }
    func watch(_ id: Int) async throws -> URL? {
        struct Watch: Decodable { var url: String? }
        return try await get("tasks/\(id)/watch", as: Watch.self).url.flatMap(URL.init(string:))
    }

    func start(_ goal: String, mobile: Bool) async throws -> Int {
        try await post("tasks", ["goal": goal, "display": mobile ? "mobile" : "desktop"])["id"] as? Int ?? 0
    }
    func tell(_ id: Int, _ message: String) async throws -> String {
        try await post("tasks/\(id)/tell", ["message": message])["result"] as? String ?? ""
    }
    func stop(_ id: Int) async throws { try await post("tasks/\(id)/stop") }
    func move(_ id: Int) async throws { try await post("tasks/\(id)/move") }
    func register(device token: String, sandbox: Bool) async throws {
        try await post("devices", ["token": token, "sandbox": sandbox])
    }

    /// The event stream: the list, then each event, until the connection drops (the caller reconnects).
    func events(onList: @escaping ([TaskItem]) -> Void, onEvent: @escaping (TaskEvent) -> Void) async throws {
        var request = URLRequest(url: url("events"))
        request.timeoutInterval = 60 * 60
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        try check(response, Data())
        var name = "", data = ""
        for try await line in bytes.lines {
            if line.hasPrefix("event: ") { name = String(line.dropFirst(7)) }
            else if line.hasPrefix("data: ") { data += line.dropFirst(6) }
            else if line.isEmpty || line.hasPrefix(":") {
                // `lines` skips blank lines, so an event ends at its data line (the gate sends one per event).
            }
            if !data.isEmpty, let json = data.data(using: .utf8) {
                if name == "tasks", let list = try? JSONDecoder().decode([TaskItem].self, from: json) { onList(list) }
                if name == "task", let event = try? JSONDecoder().decode(TaskEvent.self, from: json) { onEvent(event) }
                name = ""; data = ""
            }
        }
    }
}
