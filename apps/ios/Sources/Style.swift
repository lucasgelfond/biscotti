import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// The installer's look (installer/Sources/BiscottiInstaller/App.swift): rounded bold titles, the accent color for
// what's happening, quiet secondary text, capsules. Status as Paseo draws it: a small dot, a turning ring while it works.
extension Font {
    static let hero = Font.system(size: 40, weight: .bold, design: .rounded)
    static let label = Font.system(.subheadline, design: .rounded).weight(.semibold)
}

extension Session.Status {
    var label: String {
        switch self {
        case .queued: "Waiting"
        case .running: "Working"
        case .moving: "Moving"
        case .kept: "Kept"
        case .done: "Done"
        case .failed: "Failed"
        }
    }
    var color: Color {
        switch self {
        case .queued, .moving: .orange
        case .running: .blue
        case .kept: .green
        case .done: .secondary
        case .failed: .red
        }
    }
}

extension Session {
    /// Its status in words: an ssh VM is open or closed rather than working or kept.
    var statusLabel: String {
        guard isVM else { return status.label }
        switch status {
        case .running: return "Open"
        case .kept: return "Closed"
        case .queued: return "Setting up"
        default: return status.label
        }
    }
}

/// A session's status: a dot, or a ring turning around it while it works.
struct StatusDot: View {
    var status: Session.Status
    @State private var turning = false

    var body: some View {
        ZStack {
            if status == .running || status == .moving {
                Circle().stroke(status.color.opacity(0.3), lineWidth: 1.5)
                Circle().trim(from: 0, to: 0.25).stroke(status.color.opacity(0.9), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .rotationEffect(.degrees(turning ? 360 : 0))
                    .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: turning)
                    .onAppear { turning = true }
            }
            Circle().fill(status.color.opacity(status == .done ? 0.4 : 1)).frame(width: 6, height: 6)
        }
        .frame(width: 12, height: 12)
        .accessibilityLabel(status.label)
    }
}

/// The status, in words, with its dot.
struct StatusLabel: View {
    var session: Session
    var body: some View {
        let status = session.status
        HStack(spacing: 5) {
            StatusDot(status: status)
            Text(session.statusLabel).font(.caption.weight(.semibold)).foregroundStyle(status == .done ? Color.secondary : status.color)
        }
    }
}

/// A round button, as Paseo's composer has: send (the accent), or stop (red) while the task works.
struct DiscButton: View {
    var systemImage: String
    var color: Color
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                .frame(width: 34, height: 34).background(Circle().fill(color))
        }
        .buttonStyle(.plain)
    }
}

/// Text with its markdown (bold, links, code) shown.
func markdown(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
}

func ago(_ date: Date) -> String { date.formatted(.relative(presentation: .named)) }

/// A PNG's image, on either platform.
func picture(_ data: Data) -> Image? {
    #if os(iOS)
    UIImage(data: data).map(Image.init(uiImage:))
    #else
    NSImage(data: data).map(Image.init(nsImage:))
    #endif
}

func copy(_ text: String) {
    #if os(iOS)
    UIPasteboard.general.string = text
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #endif
}
