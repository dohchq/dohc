import XCTest

// The sample's outbox at each state that needs the person (`-dohcDemo talk-outbox`): a withheld message with Send and
// Discard, one still sending with Copy message and Discard, and a refused one. It reaches no server.
final class ConversationOutboxTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "chat", "-dohcDemo", "talk-outbox"]
    app.launch()
    XCTAssertTrue(app.textViews["Message #planning"].waitForExistence(timeout: 45), "The chat should open")
    return app
  }

  private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
  }

  @MainActor
  func testEachStateShowsWhatCanBeDone() {
    let app = launch()
    XCTAssertTrue(text(app, "This message has not been sent.").waitForExistence(timeout: 15), "A withheld message should say so")
    XCTAssertTrue(app.buttons["Send"].exists, "A withheld message should offer Send")
    XCTAssertTrue(text(app, "Still sending").exists, "A message pending for long should say Still sending")
    XCTAssertTrue(app.buttons["Copy message"].exists, "A message still sending, or refused, should offer Copy message")
    XCTAssertTrue(text(app, "dohc could not send this message.").exists, "A refused message should say why")
    XCTAssertTrue(text(app, "Waiting to send").exists, "A message never sent should say Waiting to send")
  }

  @MainActor
  func testSendOnAWithheldMessageSendsItOnce() {
    let app = launch()
    let notSent = text(app, "This message has not been sent.")
    XCTAssertTrue(notSent.waitForExistence(timeout: 15), "A withheld message should show")
    app.buttons["Send"].tap()
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: notSent)
    XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 15), .completed, "Send should take the message out of withheld")
    // XCUITest shows each React Native text as a paragraph holding a text with the same label and frame, so the test
    // counts places on screen, not elements: a second row would sit elsewhere.
    let copies = app.staticTexts.matching(NSPredicate(format: "label == %@", "Can we push dinner to 8?"))
    let places = Set(copies.allElementsBoundByIndex.map { String(describing: $0.frame) })
    XCTAssertEqual(places.count, 1, "The message should show once (at \(places.sorted()))")
  }

  @MainActor
  func testDiscardWarnsThatAMessageMayStillSend() {
    let app = launch()
    let stalled = text(app, "Booked the 19:52 back from Porto.")
    XCTAssertTrue(stalled.waitForExistence(timeout: 15), "The message still sending should show")
    // The stalled message's Discard: the second, after the withheld message's.
    app.buttons.matching(NSPredicate(format: "label == %@", "Discard")).element(boundBy: 1).tap()
    XCTAssertTrue(text(app, "It may still send.").waitForExistence(timeout: 15), "Discard should warn first")
    app.sheets.firstMatch.buttons["Discard"].tap()
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: stalled)
    XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 15), .completed, "Discard should take the message off this phone")
  }
}
