import XCTest

// The sample's agent wakes in #planning (`-dohcDemo talk-wakes`): one line per wake, with the agent's name or "An
// agent", the computer or "a computer", and "No other computer can run this agent." under an ended wake no computer
// could try again. Held and queued wakes show no line. The lines only read: they offer no action. It reaches no server.
final class ConversationWakeTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "chat", "-dohcDemo", "talk-wakes"]
    app.launch()
    XCTAssertTrue(app.textViews["Message #planning"].waitForExistence(timeout: 20), "The chat should open")
    return app
  }

  private func texts(_ app: XCUIApplication, _ value: String) -> XCUIElementQuery {
    app.staticTexts.matching(NSPredicate(format: "label == %@", value))
  }

  private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
    texts(app, value).firstMatch
  }

  /// The places on screen showing `value`. XCUITest shows each React Native text as a paragraph holding a text with the
  /// same label and frame, so a test counts frames, never elements.
  private func places(_ app: XCUIApplication, _ value: String) -> Set<String> {
    Set(texts(app, value).allElementsBoundByIndex.map { String(describing: $0.frame) })
  }

  @MainActor
  func testEachStateShowsItsLine() {
    let app = launch()
    XCTAssertTrue(text(app, "Nova is waiting for a computer").waitForExistence(timeout: 5), "A waiting wake should say so")
    XCTAssertTrue(text(app, "Scout is starting on Ice's Mac").exists, "A claimed wake should name its computer")
    XCTAssertTrue(text(app, "An agent is starting on a computer").exists, "A wake with no name or computer should say so")
    XCTAssertTrue(text(app, "Scout isn't confirmed on Studio Mac. It may have started.").exists, "An unconfirmed wake should say so")
    XCTAssertTrue(
      text(app, "An agent isn't confirmed on a computer. It may have started.").exists,
      "An unconfirmed wake with no name or computer should say so"
    )
    XCTAssertTrue(text(app, "No other computer can run this agent.").exists, "An ended wake no computer can retry should say so")
  }

  @MainActor
  func testTwoWakesWithOneNameKeepTwoLines() {
    let app = launch()
    XCTAssertTrue(text(app, "Nova didn't start").waitForExistence(timeout: 5), "A wake that didn't start should say so")
    let lines = places(app, "Nova didn't start")
    XCTAssertGreaterThanOrEqual(lines.count, 2, "Each wake should keep its own line (at \(lines.sorted()))")
  }

  @MainActor
  func testHeldAndQueuedShowNoLineAndNothingAsksForAMention() {
    let app = launch()
    XCTAssertTrue(text(app, "Nova is waiting for a computer").waitForExistence(timeout: 5), "The wakes should show")
    // The last message wakes Atlas, held, and Echo, queued: no line starts with either name.
    for name in ["Atlas", "Echo"] {
      let line = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
      XCTAssertFalse(line.exists, "\(name)'s wake should show no line")
    }
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Mention the agent")).firstMatch.exists,
      "No line should ask for a mention"
    )
    XCTAssertFalse(app.buttons["Try again"].exists, "The lines should offer no action")
  }
}
