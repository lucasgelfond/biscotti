import XCTest

/// The app against a running agent (ACP_URL, e.g. the stand-in in the scratchpad, whose /control/* routes drop its
/// connections and start tasks as the main agent would): the board loads, a task started here streams its steps and
/// report with its screenshot, telling it works (running, and as a follow-up once kept), and after the connection
/// drops it reconnects and shows a task started elsewhere. Each screen is saved to SHOTS, if set.
final class AppTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var acp: URL { URL(string: env["ACP_URL"] ?? "http://127.0.0.1:7999/acp")! }
    var base: URL { acp.deletingLastPathComponent() }

    override func setUp() { continueAfterFailure = false }

    func testBoardTaskTellScreenshotReconnect() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-host", base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), "-skipPush", "YES"]
        app.launch()

        // The board.
        XCTAssertTrue(app.staticTexts["Find the cheapest flight to Lisbon in March"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["VM on lucasgelfond/biscotti"].exists)
        shot("1-board")

        // An ssh VM: its way in.
        app.staticTexts["VM on lucasgelfond/biscotti"].tap()
        XCTAssertTrue(app.staticTexts["ssh -p 2202 cua@biscotti-4.tail396c12.ts.net"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Open"].exists)
        shot("1b-vm")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // A task, its steps as they come.
        app.buttons["New task"].tap()
        let goal = app.descendants(matching: .any).matching(identifier: "goal").firstMatch
        XCTAssertTrue(goal.waitForExistence(timeout: 5))
        goal.tap()
        goal.typeText("Find a ramen place near Union Square")
        app.buttons["Start"].tap()
        XCTAssertTrue(app.staticTexts["Find a ramen place near Union Square"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["browser_navigate"].waitForExistence(timeout: 15))
        shot("2-working")

        // Telling it while it works.
        let composer = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        composer.tap()
        composer.typeText("Somewhere with a counter")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["Noted: Somewhere with a counter"].waitForExistence(timeout: 15))
        // The agent echoes it; it's shown once.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Somewhere with a counter")).count, 1)

        // Its report and screenshot.
        XCTAssertTrue(app.staticTexts["Report"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.images["Screenshot"].waitForExistence(timeout: 5))
        shot("3-report")

        // A follow-up resumes it, kept.
        composer.tap()
        composer.typeText("Also one open late")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["Working"].waitForExistence(timeout: 10))
        XCTAssertTrue(predicate(app.staticTexts, "Done: Also one open late").waitForExistence(timeout: 40))
        shot("4-follow-up")

        // The screenshot, big.
        app.images["Screenshot"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Screenshot"].waitForExistence(timeout: 5))
        shot("5-screenshot")
        app.buttons["Done"].tap()

        // The connection drops; it reconnects, and a task started elsewhere shows up on the board as it starts.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["Find a ramen place near Union Square"].waitForExistence(timeout: 5))
        try control("drop")
        sleep(1)
        shot("6-dropped")
        try control("task", body: #"{"goal":"Started by the main agent after the drop"}"#)
        XCTAssertTrue(app.staticTexts["Started by the main agent after the drop"].waitForExistence(timeout: 20))
        shot("7-reconnected")
        // And it follows that one live: its steps reach its row.
        XCTAssertTrue(predicate(app.staticTexts, "browser_navigate").waitForExistence(timeout: 20))
        shot("8-live-row")
        // One started elsewhere well after the reconnect (no list since) shows up too, as it starts.
        sleep(3)
        try control("task", body: #"{"goal":"Started by the main agent while connected"}"#)
        XCTAssertTrue(app.staticTexts["Started by the main agent while connected"].waitForExistence(timeout: 10))
        shot("9-discovered")
    }

    private func predicate(_ query: XCUIElementQuery, _ prefix: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func control(_ path: String, body: String = "") throws {
        var request = URLRequest(url: base.appending(path: "control/\(path)"))
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = env["SHOTS"] { try? png.write(to: URL(fileURLWithPath: dir).appending(path: "\(name).png")) }
    }
}
