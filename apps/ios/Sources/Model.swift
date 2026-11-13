import Foundation

/// A task as the gate's API lists it (core/src/board.ts).
struct TaskItem: Codable, Identifiable, Equatable {
    enum Status: String, Codable { case queued, running, moving, kept, done, failed }
    enum Place: String, Codable { case local, cloud }
    struct Step: Codable, Equatable, Hashable {
        var at: Double
        var text: String?
        var tool: String?
    }

    var id: Int
    var goal: String
    var status: Status
    var slot: Int?
    var `where`: Place?
    var started: Double
    var updated: Double
    var steps: [Step]?
    var last: Step?
    var report: String?
    var screenshot: Bool

    var latest: Step? { steps?.last ?? last }
    var isLive: Bool { status == .queued || status == .running || status == .moving }
    var canMove: Bool { `where` == .local && (status == .running || status == .kept) }
    var canTell: Bool { status == .running || status == .kept || status == .queued }
}

/// One thing that happened to a task, from the event stream (core/src/tasks.ts, TaskEvent).
struct TaskEvent: Codable {
    var id: Int
    var type: String
    var at: Double
    var goal: String?
    var slot: Int?
    var `where`: TaskItem.Place?
    var text: String?
    var tool: String?
    var screenshot: Bool?
}

extension TaskItem {
    /// The task after `event`, as the gate's board does it.
    mutating func apply(_ e: TaskEvent) {
        updated = e.at
        if let g = e.goal { goal = g }
        if let s = e.slot { slot = s; `where` = e.where }
        switch e.type {
        case "queued": status = .queued
        case "started", "resumed", "moved": status = .running
        case "moving": status = .moving
        case "kept": status = .kept
        case "done": status = .done
        case "failed": if status != .moving { status = .failed }
        case "report":
            report = e.text
            if e.screenshot == true { screenshot = true }
        default: break
        }
        if ["step", "resumed", "moving", "failed"].contains(e.type) {
            let step = Step(at: e.at, text: e.text, tool: e.tool)
            if steps != nil { steps!.append(step) }
            last = step
        }
    }

    static func new(from e: TaskEvent) -> TaskItem {
        TaskItem(id: e.id, goal: e.goal ?? "", status: .queued, started: e.at, updated: e.at, steps: [], screenshot: false)
    }
}
