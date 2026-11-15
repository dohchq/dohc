import XCTest

// The sample chat's composer: a native multiline field, Send, and New post in a Group. It writes to the sample's
// outbox in memory, which reaches no server, so these check the composer and its message states, not delivery.
final class ConversationComposerTests: XCTestCase {
  private func launch(_ route: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", route]
    app.launch()
    return app
  }

  private func field(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    let field = app.textViews[label]
    XCTAssertTrue(field.waitForExistence(timeout: 20), "The composer's field should be named \(label)")
    return field
  }

  private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
  }

  @MainActor
  func testSendClearsOnlyWhatItSentAndTheMessageShows() {
    let app = launch("chat")
    let input = field(app, "Message #planning")
    let send = app.buttons["Send message"]
    XCTAssertFalse(send.isEnabled, "Send should wait for text")
    input.tap()
    input.typeText("Lunch at 1?")
    XCTAssertTrue(send.isEnabled, "Send should take the text")
    send.tap()
    XCTAssertTrue(text(app, "Lunch at 1?").waitForExistence(timeout: 5), "The message should show in the chat")
    XCTAssertEqual(input.value as? String ?? "", "", "The field should clear once the outbox keeps the message")
    XCTAssertTrue(text(app, "Waiting to send").exists || text(app, "Sending").exists, "The message should show where it stands")
  }

  @MainActor
  func testReturnIsANewLineAndSendsNothing() {
    let app = launch("chat")
    let input = field(app, "Message #planning")
    input.tap()
    input.typeText("First line\nSecond line")
    XCTAssertTrue((input.value as? String ?? "").contains("\n"), "Return should add a line")
    XCTAssertFalse(text(app, "First line").exists, "Return should send nothing")
  }

  @MainActor
  func testAGroupWritesANewPostWithATitle() {
    let app = launch("chat")
    let newPost = app.buttons["New post"]
    XCTAssertTrue(newPost.waitForExistence(timeout: 20), "A Group should offer New post")
    newPost.tap()
    let title = app.textFields["Title"]
    XCTAssertTrue(title.waitForExistence(timeout: 5), "New post should add a title")
    title.tap()
    title.typeText("Porto")
    let input = field(app, "Message #planning")
    input.tap()
    input.typeText("Day trip on the 15th")
    app.buttons["Post"].tap()
    XCTAssertTrue(text(app, "Porto").waitForExistence(timeout: 5), "The post should show its title")
    XCTAssertTrue(app.buttons["New post"].waitForExistence(timeout: 5), "After posting, the composer should send messages again")
  }

  @MainActor
  func testAnAgentsChatHasNoNewPost() {
    let app = launch("chat-agent")
    _ = field(app, "Message Scout")
    XCTAssertFalse(app.buttons["New post"].exists, "A chat with an agent should offer no post")
  }
}
