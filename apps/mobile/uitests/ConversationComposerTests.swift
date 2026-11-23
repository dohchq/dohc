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
    XCTAssertTrue(field.waitForExistence(timeout: 45), "The composer's field should be named \(label)")
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
    XCTAssertTrue(text(app, "Lunch at 1?").waitForExistence(timeout: 15), "The message should show in the chat")
    XCTAssertEqual(input.value as? String ?? "", "", "The field should clear once the outbox keeps the message")
    // The sample's outbox moves the message on by itself, to Sending at 0.7 s and to saved at 1.6 s, when its state words
    // go, so which of those words shows here depends on timing. ConversationOutboxTests checks each state on seeded
    // messages that stay put. Here the row must still show, waiting, sending or saved: never withheld, refused or lost.
    XCTAssertTrue(text(app, "Lunch at 1?").exists, "The message should still show")
    for words in ["could not keep this message", "has not been sent", "could not send this message", "wasn't sent"] {
      XCTAssertFalse(text(app, words).exists, "The message should be waiting, sending or saved, not \"\(words)\"")
    }
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
    XCTAssertTrue(newPost.waitForExistence(timeout: 45), "A Group should offer New post")
    newPost.tap()
    let title = app.textFields["Title"]
    XCTAssertTrue(title.waitForExistence(timeout: 15), "New post should add a title")
    title.tap()
    title.typeText("Porto")
    let input = field(app, "Message #planning")
    input.tap()
    input.typeText("Day trip on the 15th")
    app.buttons["Post"].tap()
    XCTAssertTrue(text(app, "Porto").waitForExistence(timeout: 15), "The post should show its title")
    XCTAssertTrue(app.buttons["New post"].waitForExistence(timeout: 15), "After posting, the composer should send messages again")
  }

  @MainActor
  func testAnAgentsChatHasNoNewPost() {
    let app = launch("chat-agent")
    _ = field(app, "Message Scout")
    XCTAssertFalse(app.buttons["New post"].exists, "A chat with an agent should offer no post")
  }
}
