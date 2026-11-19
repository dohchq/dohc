import XCTest

// An agent's question answered in its Notice's row, in the sample build. A collapsed row is one VoiceOver element, so
// its pills aren't buttons to the test: it taps the Answer pill where the row lays it out, on the action line above the
// row's time. Once the answer opens, the row is a group, and its choices, field, Send and Cancel reply are buttons and
// a text view of their own. The sample's outbox saves an answer 1.6 s after it keeps it, so the test waits for the
// final state, never for the brief one before it.
final class NoticesAnswerTests: XCTestCase {
  // The notices-answer demo's two rows, first in the list: Nova's poll, then Nova's question without choices.
  private let poll = "Nova is waiting for your answer in #planning"
  private let question = "Nova has a question in #planning"

  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", "notices-answer"]
    app.launch()
    return app
  }

  /// The collapsed row whose label holds `title`, and `state` when given, as ", Answered,".
  private func row(_ app: XCUIApplication, _ title: String, _ state: String? = nil) -> XCUIElement {
    let predicate = state.map { NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", title, $0) }
      ?? NSPredicate(format: "label CONTAINS %@", title)
    return app.descendants(matching: .any).matching(predicate).firstMatch
  }

  /// Taps the row's worded pill, first on the action line: 16 pt inset, a 30 pt mark and a 10 pt gap, then the pill.
  /// The line's 32 pt pill sits above the time's line (about 16 pt, 2 pt above it) and the row's 12 pt bottom padding.
  private func tapAnswer(_ app: XCUIApplication, _ title: String) {
    let collapsed = row(app, title, ", Unanswered,")
    XCTAssertTrue(collapsed.waitForExistence(timeout: 20), "The \(title) row never showed its question open")
    XCTAssertTrue(collapsed.isHittable)
    collapsed.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
      .withOffset(CGVector(dx: 56 + 24, dy: collapsed.frame.height - 12 - 18 - 16))
      .tap()
  }

  private func waitGone(_ element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
    return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
  }

  @MainActor
  func testPollAnswersInItsRowAndReachesAnswered() {
    let app = launch()
    tapAnswer(app, poll)

    // The row opens its answer in place: the choices are buttons in Nova's words, with Cancel reply.
    let choice = app.buttons["19:52"]
    XCTAssertTrue(choice.waitForExistence(timeout: 15), "The poll's choices didn't open in the row")
    XCTAssertTrue(app.buttons["Cancel reply"].exists)
    XCTAssertTrue(app.buttons["21:07"].exists)
    choice.tap()

    // The answer closes once the phone keeps it, and the row, still on Notices, comes to say Answered.
    XCTAssertTrue(row(app, poll, ", Answered,").waitForExistence(timeout: 15), "The row never reached Answered")
    XCTAssertTrue(waitGone(app.buttons["21:07"]), "The poll's choices stayed open after the answer was kept")
  }

  @MainActor
  func testFreeAnswerGoesThroughTheFieldAndReachesAnswered() {
    let app = launch()
    tapAnswer(app, question)

    // The field is named for the question's author, with Send.
    let field = app.textViews["Answer Nova"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "The answer's field didn't open in the row")
    field.tap()
    let typed = "Lisbon and Porto, 2026"
    field.typeText(typed)
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 15), "The keyboard didn't show for the field")
    let holds = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", typed), object: field)
    XCTAssertEqual(XCTWaiter().wait(for: [holds], timeout: 15), .completed, "The field doesn't hold the typed answer")

    // The row rises until its field and Send sit above the keyboard, so the tap reaches Send, not the keyboard.
    let send = app.buttons["Send message"]
    let clear = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        guard send.exists, send.isEnabled, send.isHittable, keyboard.exists else { return false }
        let top = keyboard.frame.minY + 0.5
        return send.frame.maxY <= top && field.frame.maxY <= top
      },
      object: nil)
    guard XCTWaiter().wait(for: [clear], timeout: 15) == .completed else {
      XCTFail(
        "Send isn't above the keyboard: field \(field.frame), value \(String(describing: field.value)), Send \(send.frame), "
          + "keyboard \(keyboard.frame)\n\(app.debugDescription)")
      let shot = XCTAttachment(screenshot: app.screenshot())
      shot.lifetime = .keepAlways
      add(shot)
      return
    }
    send.tap()

    XCTAssertTrue(waitGone(field), "The field stayed open after the answer was kept")
    XCTAssertTrue(row(app, question, ", Answered,").waitForExistence(timeout: 15), "The row never reached Answered")
  }

  @MainActor
  func testCancelReturnsToTheRow() {
    let app = launch()
    tapAnswer(app, question)

    let field = app.textViews["Answer Nova"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "The answer's field didn't open in the row")
    app.buttons["Cancel reply"].tap()

    // The field goes, and the row is one element again, its question still open, with nothing sent.
    XCTAssertTrue(waitGone(field), "The field stayed open after Cancel reply")
    XCTAssertTrue(row(app, question, ", Unanswered,").waitForExistence(timeout: 15), "The row didn't come back")
  }

  @MainActor
  func testCancelDropsTheTextAndTheNextAnswerStartsEmpty() {
    let app = launch()
    tapAnswer(app, question)

    let field = app.textViews["Answer Nova"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "The answer's field didn't open in the row")
    field.tap()
    field.typeText("Porto album")
    app.buttons["Cancel reply"].tap()
    XCTAssertTrue(waitGone(field), "The field stayed open after Cancel reply")

    // Cancelling is deliberate, so the text the phone kept for the row goes with it.
    tapAnswer(app, question)
    let again = app.textViews["Answer Nova"]
    XCTAssertTrue(again.waitForExistence(timeout: 15), "The answer's field didn't open again")
    XCTAssertFalse((again.value as? String ?? "").contains("Porto"), "The cancelled text came back")
  }
}
