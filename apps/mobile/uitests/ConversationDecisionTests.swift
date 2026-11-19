import XCTest

// Questions and polls in the sample's #planning (`-dohcTestRoute chat`). `-dohcDemo talk-decisions` adds Maya's open
// poll and Nova's open question beside Nova's answered one. Answers go to the sample's outbox in memory, which reaches
// no server, so these check the card, its controls and their states, not delivery.
final class ConversationDecisionTests: XCTestCase {
  private func launch(demo: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "chat"]
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
    XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 15), .completed, message)
  }

  @MainActor
  func testAnOpenPollOffersItsChoicesAsButtons() {
    let app = launch(demo: "talk-decisions")
    _ = field(app, "Message #planning")
    XCTAssertTrue(labelled(app, "Unanswered").waitForExistence(timeout: 15), "An open poll should say it's unanswered")
    for option in ["Time Out Market", "Taberna da Rua das Flores", "Cook on the terrace"] {
      let button = app.buttons[option]
      XCTAssertTrue(button.exists, "\(option) should be a button named by its own text")
      XCTAssertTrue(button.isEnabled, "\(option) should take a tap while the poll is open")
      XCTAssertFalse(button.isSelected, "\(option) shouldn't show as chosen before a tap")
    }
  }

  // The sample's outbox saves a choice in memory almost at once, so Answering can pass before a slow simulator looks.
  // This checks where the choice ends: the poll says Answered, the choice stays chosen, and no choice takes a tap.
  @MainActor
  func testAChoiceEndsAnswered() {
    let app = launch(demo: "talk-decisions")
    _ = field(app, "Message #planning")
    let choice = app.buttons["Taberna da Rua das Flores"]
    XCTAssertTrue(choice.waitForExistence(timeout: 15), "The poll should offer its choices")
    let answered = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Answered"))
    let answeredBeforeTheChoice = answered.count
    choice.tap()
    let saved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in answered.count > answeredBeforeTheChoice }, object: nil)
    XCTAssertEqual(XCTWaiter().wait(for: [saved], timeout: 15), .completed, "The poll should say Answered once the outbox saves the choice")
    gone(labelled(app, "Answering"), "The choice should stop showing as on its way once the outbox saves it")
    XCTAssertTrue(choice.isSelected, "The saved choice should stay chosen")
    XCTAssertFalse(choice.isEnabled, "An answered poll should take no other choice")
    XCTAssertFalse(app.buttons["Time Out Market"].isEnabled, "An answered poll should take no other choice")
  }

  @MainActor
  func testAFreeAnswerGoesThroughTheComposer() {
    let app = launch(demo: "talk-decisions")
    _ = field(app, "Message #planning")
    let answer = app.buttons["Answer"]
    XCTAssertTrue(answer.waitForExistence(timeout: 15), "A question without choices should offer Answer")
    answer.tap()
    let input = field(app, "Answer Nova")
    XCTAssertTrue(labelled(app, "What should I call the shared photo album?").exists, "Answer should name the question")
    input.tap()
    input.typeText("Lisbon days")
    app.buttons["Send message"].tap()
    XCTAssertTrue(labelled(app, "Lisbon days").waitForExistence(timeout: 15), "The answer should show in the thread")
    XCTAssertTrue(field(app, "Reply").exists, "The composer should reply to the thread again")
    gone(app.buttons["Answer"], "An answered question should no longer offer Answer")
  }

  @MainActor
  func testAResolvedPollOffersNoAnswer() {
    let app = launch()
    _ = field(app, "Message #planning")
    let chosen = app.buttons["19:52"]
    XCTAssertTrue(chosen.waitForExistence(timeout: 15), "The answered poll should show its choices")
    XCTAssertTrue(labelled(app, "Answered").exists, "The answered poll should say so")
    XCTAssertTrue(chosen.isSelected, "The server's choice should show as chosen")
    for option in ["17:52", "19:52", "21:07"] {
      XCTAssertFalse(app.buttons[option].isEnabled, "\(option) should take no tap on an answered poll")
    }
    XCTAssertFalse(app.buttons["Answer"].exists, "An answered poll should offer no Answer")
  }
}
