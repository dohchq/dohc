import XCTest

// The sample's agent wakes in #planning (`-dohcDemo talk-wakes`): one line per wake, with the agent's name or "An
// agent", the computer or "a computer", and "No other computer can run this agent." under an ended wake no computer
// could try again. Held and queued wakes show no line. A line that didn't start offers Try again, and one not confirmed
// Try on another computer, which asks first; each ends with the agent waiting. It reaches no server.
final class ConversationWakeTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "chat", "-dohcDemo", "talk-wakes"]
    app.launch()
    XCTAssertTrue(app.textViews["Message #planning"].waitForExistence(timeout: 45), "The chat should open")
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

  /// The button labelled `label` nearest below the line `value`: each line's pill sits under its words, and other lines
  /// may offer a pill with the same label. A pill's 44 pt touch area reaches 6 pt above the pill, over the words' last
  /// line, so the button's centre, not its top, is what lies below them.
  private func pill(_ app: XCUIApplication, _ label: String, under value: String) -> XCUIElement? {
    let line = text(app, value).frame
    return app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
      .filter { $0.frame.midY > line.maxY }
      .min { $0.frame.midY < $1.frame.midY }
  }

  @MainActor
  func testEachStateShowsItsLine() {
    let app = launch()
    XCTAssertTrue(text(app, "Nova is waiting for a computer").waitForExistence(timeout: 15), "A waiting wake should say so")
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
    XCTAssertTrue(text(app, "Nova didn't start").waitForExistence(timeout: 15), "A wake that didn't start should say so")
    let lines = places(app, "Nova didn't start")
    XCTAssertGreaterThanOrEqual(lines.count, 2, "Each wake should keep its own line (at \(lines.sorted()))")
  }

  @MainActor
  func testHeldAndQueuedShowNoLineAndNothingAsksForAMention() {
    let app = launch()
    XCTAssertTrue(text(app, "Nova is waiting for a computer").waitForExistence(timeout: 15), "The wakes should show")
    // The last message wakes Atlas, held, and Echo, queued: no line starts with either name.
    for name in ["Atlas", "Echo"] {
      let line = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
      XCTAssertFalse(line.exists, "\(name)'s wake should show no line")
    }
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Mention the agent")).firstMatch.exists,
      "No line should ask for a mention"
    )
  }

  @MainActor
  func testTryAgainOnALineThatDidNotStartEndsWithTheAgentWaiting() {
    let app = launch()
    let line = "Scout didn't start"
    XCTAssertTrue(text(app, line).waitForExistence(timeout: 15), "Scout's wake should say it didn't start")
    guard let button = pill(app, "Try again", under: line) else {
      return XCTFail("Scout's line should offer Try again")
    }
    button.tap()
    XCTAssertTrue(
      text(app, "Scout is waiting for a computer").waitForExistence(timeout: 15),
      "Try again should end with Scout waiting for a computer"
    )
    XCTAssertFalse(text(app, line).exists, "The line that didn't start should be replaced")
  }

  @MainActor
  func testTryOnAnotherComputerAsksFirstAndCancelChangesNothing() {
    let app = launch()
    let line = "Iris isn't confirmed on Ice's Mac. It may have started."
    let waiting = "Iris is waiting for a computer"
    XCTAssertTrue(text(app, line).waitForExistence(timeout: 15), "Iris's wake should say it isn't confirmed")
    guard let button = pill(app, "Try on another computer", under: line) else {
      return XCTFail("Iris's line should offer Try on another computer")
    }
    button.tap()
    let sheet = app.sheets.firstMatch
    XCTAssertTrue(sheet.waitForExistence(timeout: 15), "Try on another computer should ask first")
    XCTAssertTrue(
      sheet.staticTexts["If Ice's Mac already started Iris, it may run twice."].exists,
      "The alert should name the computer and the agent"
    )
    sheet.buttons["Cancel"].tap()
    XCTAssertTrue(text(app, line).exists, "Cancel should leave the line as it was")
    XCTAssertFalse(text(app, waiting).exists, "Cancel should try nothing")

    guard let again = pill(app, "Try on another computer", under: line) else {
      return XCTFail("The line should still offer Try on another computer after Cancel")
    }
    again.tap()
    XCTAssertTrue(sheet.waitForExistence(timeout: 15), "Try on another computer should ask again")
    sheet.buttons["Try on another computer"].tap()
    XCTAssertTrue(
      text(app, waiting).waitForExistence(timeout: 15),
      "Confirming should end with Iris waiting for a computer"
    )
  }
}
