import SwiftUI

// The installer's look (installer/Sources/BiscottiInstaller/App.swift): rounded bold titles, the accent color for
// what's happening, quiet secondary text, capsules.
extension Font {
    static let hero = Font.system(size: 40, weight: .bold, design: .rounded)
    static let label = Font.system(.subheadline, design: .rounded).weight(.semibold)
}

/// A task's status as a capsule: the accent color while it works, quieter once it's done.
struct StatusPill: View {
    var status: TaskItem.Status
    var body: some View {
        Text(label).font(.caption.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15))).foregroundStyle(color)
    }
    private var label: String {
        switch status {
        case .queued: "Waiting"
        case .running: "Working"
        case .moving: "Moving"
        case .kept: "Kept"
        case .done: "Done"
        case .failed: "Failed"
        }
    }
    private var color: Color {
        switch status {
        case .queued, .moving: .orange
        case .running: .accentColor
        case .kept: .secondary
        case .done: .green
        case .failed: .red
        }
    }
}

/// Where a task runs: this machine or the cloud.
struct PlaceBadge: View {
    var place: TaskItem.Place?
    var body: some View {
        if let place {
            Label(place == .cloud ? "Cloud" : "Local", systemImage: place == .cloud ? "cloud" : "house")
                .font(.caption).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
        }
    }
}

extension TaskItem.Step {
    var line: String {
        if let tool { return text.map { "\(tool) \($0)" } ?? tool }
        return text ?? ""
    }
}

func ago(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    return date.formatted(.relative(presentation: .named))
}
