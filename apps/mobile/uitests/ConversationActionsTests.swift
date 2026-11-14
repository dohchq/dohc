import XCTest

// Replies and reactions in the sample's Porto thread (`-dohcTestRoute chat-thread`) and #planning. They write to the
// sample's outbox in memory, which reaches no server, so these check the controls and their states, not delivery.
final class ConversationActionsTests: XCTestCase {
  private func launch(_ route: String, demo: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", route]
    if let demo { app.launchArguments += ["-dohcDemo", demo] }
    app.launch()
    return app
  }

  private func field(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    let field = app.textViews[label]
    XCTAssertTrue(field.waitForExistence(timeout: 20), "The composer's field should be named \(label)")
    return field
  }

  private func labelled(_ app: XCUIApplication, _ value: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
  }

  private func gone(_ element: XCUIElement, _ message: String) {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
    XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 5), .completed, message)
  }

  private func enabled(_ element: XCUIElement, _ message: String) {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: element)
    XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 5), .completed, message)
  }

  @MainActor
  func testAThreadRepliesUnderTheMessageChosen() {
    let app = launch("chat-thread")
    let input = field(app, "Reply")
    // Sam's reply, the third message: the Porto ask, then Nova's, then Sam's.
    app.buttons.matching(NSPredicate(format: "label == %@", "Reply")).element(boundBy: 2).tap()
    XCTAssertTrue(labelled(app, "Reply to Sam Ortiz").waitForExistence(timeout: 5), "Reply should name the message")
    XCTAssertTrue(app.textViews["Reply to Sam Ortiz"].exists, "The field should say whom it replies to")
    app.textViews["Reply to Sam Ortiz"].tap()
    app.textViews["Reply to Sam Ortiz"].typeText("9:09 is fine")
    app.buttons["Send message"].tap()
    XCTAssertTrue(labelled(app, "9:09 is fine").waitForExistence(timeout: 5), "The reply should show in the thread")
    gone(app.buttons["Cancel reply"], "The reply's message should no longer be named once it's kept")
    XCTAssertEqual(input.value as? String ?? "", "", "The field should clear once the outbox keeps the reply")
  }

  @MainActor
  func testCancelReplyGoesBackToTheThread() {
    let app = launch("chat-thread")
    _ = field(app, "Reply")
    app.buttons.matching(NSPredicate(format: "label == %@", "Reply")).element(boundBy: 1).tap()
    let cancel = app.buttons["Cancel reply"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 5), "A chosen message should offer Cancel reply")
    cancel.tap()
    gone(cancel, "Cancel reply should take the message away")
    XCTAssertTrue(app.textViews["Reply"].exists, "The field should reply to the thread again")
  }

  @MainActor
  func testAReactionAddsAndRemovesAsAState() {
    let app = launch("chat-thread")
    _ = field(app, "Reply")
    let theirs = app.buttons["👀, 1 reaction"]
    XCTAssertTrue(theirs.waitForExistence(timeout: 5), "Nova's reply should show its reaction")
    theirs.tap()
    let mine = app.buttons["Remove 👀 reaction, 2 reactions"]
    XCTAssertTrue(mine.waitForExistence(timeout: 5), "A tap should add the account's reaction")
    XCTAssertTrue(mine.isSelected, "The account's reaction should show as selected")
    enabled(mine, "The reaction should take a tap again once the outbox settles it")
    mine.tap()
    XCTAssertTrue(app.buttons["👀, 1 reaction"].waitForExistence(timeout: 5), "A second tap should remove it")
  }

  @MainActor
  func testAddReactionOffersTheChoicesAndClosesThem() {
    let app = launch("chat-thread")
    _ = field(app, "Reply")
    let add = app.buttons.matching(NSPredicate(format: "label == %@", "Add reaction")).firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5), "A message should offer Add reaction")
    add.tap()
    let rocket = app.buttons["🚀"]
    XCTAssertTrue(rocket.waitForExistence(timeout: 5), "Add reaction should offer the choices")
    rocket.tap()
    XCTAssertTrue(app.buttons["Remove 🚀 reaction, 1 reaction"].waitForExistence(timeout: 5), "The choice should add a reaction")
    gone(app.buttons["🚀"], "The choices should close")
  }

  @MainActor
  func testWithheldAndRefusedReactionsSayWhatCanBeDone() {
    let app = launch("chat-thread", demo: "talk-thread")
    _ = field(app, "Reply")
    XCTAssertTrue(labelled(app, "Your 🙌 reaction has not been sent.").waitForExistence(timeout: 5), "A withheld reaction should say so")
    XCTAssertTrue(app.buttons["Send"].exists, "A withheld reaction should offer Send")
    XCTAssertTrue(labelled(app, "dohc could not change your ✅ reaction.").exists, "A refused reaction should say so")
    XCTAssertTrue(labelled(app, "Sending").exists, "The reply on its way should say Sending")
  }

  @MainActor
  func testReplyOnAMessageStillOnThePhoneRepliesInPlace() {
    let app = launch("chat", demo: "talk-outbox")
    _ = field(app, "Message #planning")
    // "On my way." never sends in the sample, so its reply waits for it: the last Reply in the chat.
    let replies = app.buttons.matching(NSPredicate(format: "label == %@", "Reply"))
    XCTAssertTrue(replies.firstMatch.waitForExistence(timeout: 5), "Messages should offer Reply")
    replies.element(boundBy: replies.count - 1).tap()
    let input = field(app, "Reply to You")
    XCTAssertTrue(labelled(app, "On my way.").exists, "Reply should name the message")
    input.tap()
    input.typeText("Ten minutes")
    app.buttons["Send message"].tap()
    XCTAssertTrue(labelled(app, "Ten minutes").waitForExistence(timeout: 5), "The reply should wait in the chat under its message")
    XCTAssertTrue(app.textViews["Message #planning"].waitForExistence(timeout: 5), "The composer should send messages again")
  }
}
