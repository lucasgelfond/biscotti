import Foundation
import Testing
@testable import biscotti

struct SSEParserTests {
    private func events(_ text: String) -> [String] {
        var parser = SSEParser()
        return text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { parser.line(Array($0.utf8)) }.map { String(decoding: $0, as: UTF8.self) }
    }

    @Test func eachEventEndsAtItsBlankLine() {
        #expect(events("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n") == ["{\"a\":1}", "{\"b\":2}"])
    }

    @Test func keepAlivesAndOtherFieldsAreSkipped() {
        #expect(events(":\n\nevent: message\nid: 4\ndata:{\"c\":3}\n\n") == ["{\"c\":3}"])
    }

    @Test func dataLinesAreJoined() {
        #expect(events("data: one\ndata: two\n\n") == ["one\ntwo"])
    }
}

struct ModelTests {
    private func json(_ text: String) throws -> JSON { try JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }

    @Test func updatesMakeTimelineEntries() throws {
        let user = try json(#"{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"book a table"}}"#)
        #expect(Entry(update: user)?.kind == .user)
        #expect(Entry(update: user)?.text == "book a table")
        let tool = try #require(Entry(update: try json(#"{"sessionUpdate":"tool_call","toolCallId":"41-1","title":"browser_navigate {\"url\":\"https://example.com\"}","kind":"other","status":"completed"}"#)))
        #expect(tool.kind == .tool)
        #expect(tool.tool.name == "browser_navigate")
        #expect(tool.tool.detail == "https://example.com")
        let png = Data("png".utf8).base64EncodedString()
        let image = try #require(Entry(update: try json(#"{"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"\#(png)","mimeType":"image/png"}}"#)))
        #expect(image.image == Data("png".utf8))
        #expect(Entry(update: try json(#"{"sessionUpdate":"session_info_update","title":"x"}"#)) == nil)
    }

    @Test func sessionInfoCarriesTheBoardsSummary() throws {
        let info = try json(#"{"sessionId":"34","cwd":"/home/cua/repo","title":"VM on a/b","updatedAt":"2026-11-14T14:04:38.820Z","_meta":{"biscotti":{"kind":"vm","status":"running","slot":2,"where":"local","repo":"a/b","ssh":{"host":"h","port":2202,"user":"cua"},"preview":"https://p"}}}"#).decode(Session.Info.self)
        var s = Session.placeholder("34")
        s.apply(info)
        #expect(s.isVM)
        #expect(s.status == .running)
        #expect(s.sshCommand == "ssh -p 2202 cua@h")
        #expect(s.title == "VM on a/b")
        #expect(!s.canTell)
        #expect(Calendar.current.component(.year, from: s.updated) == 2026)
    }

    @Test func toolCallsInARowFold() {
        let t = { Entry(kind: .tool, text: "click {}") }
        let blocks = Block.of([Entry(kind: .user, text: "go"), t(), t(), Entry(kind: .said, text: "hm"), t()])
        #expect(blocks.count == 4)
        if case .tools(let run) = blocks[1] { #expect(run.count == 2) } else { Issue.record("not folded") }
        if case .entry(let e) = blocks[3] { #expect(e.kind == .tool) } else { Issue.record("a lone call folded") }
    }

    @Test func anEchoedFollowUpIsTheOneSentFromHere() {
        var timeline = [Entry(kind: .user, text: "also check Friday", pending: true)]
        timeline.take(Entry(kind: .user, text: "also check Friday"))
        #expect(timeline.count == 1)
        #expect(!timeline[0].pending)
        timeline.take(Entry(kind: .user, text: "also check Friday"))
        #expect(timeline.count == 2)
    }

    @MainActor @Test func theAddressBecomesItsACPEndpoint() {
        #expect(Store.acpURL("biscotti-4.tail396c12.ts.net")?.absoluteString == "https://biscotti-4.tail396c12.ts.net:7443/acp")
        #expect(Store.acpURL("http://127.0.0.1:7999")?.absoluteString == "http://127.0.0.1:7999/acp")
        #expect(Store.acpURL("  ") == nil)
    }

    @Test func aRejectedPromptSaysWhy() throws {
        let error = try JSONDecoder().decode(RPCError.self, from: Data(#"{"code":-32602,"message":"Invalid params","data":"task #9 isn't running or kept"}"#.utf8))
        #expect(error.localizedDescription == "task #9 isn't running or kept")
    }
}

/// The client against a running agent (the stand-in in the scratchpad, or a real biscotti): ACP_URL.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["ACP_URL"] != nil))
struct LiveTests {
    let url = URL(string: ProcessInfo.processInfo.environment["ACP_URL"] ?? "http://127.0.0.1:7999/acp")!

    @Test func startsATaskFollowsItAndItsReportEndsThePrompt() async throws {
        let acp = ACPConnection(url: url)
        let initialized = try await acp.connect()
        #expect(initialized["agentCapabilities"]?["loadSession"] == .bool(true))
        let updates = Task { () -> [JSON] in
            var seen: [JSON] = []
            for await case .notification("session/update", let params) in acp.events { seen.append(params) }
            return seen
        }
        let new = try await acp.request("session/new", ["cwd": "/", "mcpServers": [], "_meta": ["biscotti": ["display": "mobile"]]])
        let id = try #require(new["sessionId"]?.string)
        let answer = try await acp.request("session/prompt", ["sessionId": .string(id), "prompt": [["type": "text", "text": "check the live client"]]])
        #expect(answer["stopReason"] == "end_turn")
        let list = try await acp.request("session/list")
        guard case .array(let sessions) = list["sessions"] else { Issue.record("no sessions"); return }
        #expect(sessions.contains { $0["sessionId"]?.string == id })
        let watch = try await acp.request("_biscotti/watch", ["sessionId": .string(id)])
        #expect(watch["url"]?.string != nil)
        // A follow-up resumes the kept task, and its message is echoed.
        let again = try await acp.request("session/prompt", ["sessionId": .string(id), "prompt": [["type": "text", "text": "and once more"]]])
        #expect(again["stopReason"] == "end_turn")
        // A VM takes no prompts, and says so.
        await #expect(throws: RPCError.self) { _ = try await acp.request("session/prompt", ["sessionId": "34", "prompt": [["type": "text", "text": "hi"]]]) }
        await acp.close()
        let seen = await updates.value.filter { $0["sessionId"]?.string == id }.compactMap { $0["update"]?["sessionUpdate"]?.string }
        #expect(seen.contains("user_message_chunk"))
        #expect(seen.contains("tool_call"))
        #expect(seen.contains("agent_message_chunk"))
        #expect(seen.contains("session_info_update"))
    }

    @Test func loadReplaysAHistory() async throws {
        let acp = ACPConnection(url: url)
        _ = try await acp.connect()
        let replayed = Task { () -> Int in
            var n = 0
            for await case .notification("session/update", let params) in acp.events where params["sessionId"] == "31" { n += 1 }
            return n
        }
        _ = try await acp.request("session/load", ["sessionId": "31", "cwd": "/", "mcpServers": []])
        try await Task.sleep(for: .milliseconds(300))
        await acp.close()
        #expect(await replayed.value >= 3)
    }
}
