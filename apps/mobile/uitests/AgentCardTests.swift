import XCTest

// An agent's mark and name open its card as a small sheet, as the desktop's badge does. The
// sheet closes by swiping down or tapping outside it, and the header has no "Members and details".
final class AgentCardTests: XCTestCase {
  private let scoutCard = "Scout, Connected agent, Claude Code 2.1 · Claude Opus 5.5 (as reported)"
  private let novaCard = "Nova, Owned by Ice"

  private func launch(_ route: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", route]
    app.launch()
    XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 20), "The chat's composer should show")
    return app
  }

  private func card(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.otherElements.matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  // The one button lies over the 36 pt mark and, after a 10 pt gap, the name; it takes touches on those two only.
  private func tapMark(_ button: XCUIElement) {
    button.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 18, dy: 18)).tap()
  }

  private func tapName(_ button: XCUIElement) {
    button.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 56, dy: 9)).tap()
  }

  // A swipe down as a person makes it: from inside the card's 24 pt top padding, just under the grabber, to the screen's
  // bottom. XCUITest's own swipe on a short sheet travels too little to close it.
  private func dragDown(_ sheet: XCUIElement, in app: XCUIApplication) {
    sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 10))
      .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99)))
  }

  private func waitGone(_ element: XCUIElement, _ message: String) {
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
    XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 10), .completed, message)
  }

  @MainActor
  func testAConnectedAgentsMarkOpensItsCardAndASwipeDownClosesIt() {
    let app = launch("chat-agent")
    XCTAssertFalse(app.buttons["Members and details"].exists, "The header should have no Members and details")
    let mark = app.buttons["Scout, connected agent"].firstMatch
    XCTAssertTrue(mark.waitForExistence(timeout: 5), "VoiceOver should hear Scout's mark as a connected agent")
    XCTAssertGreaterThan(mark.frame.width, 56, "The one target should span the mark and the name")
    tapMark(mark)
    let sheet = card(app, scoutCard)
    XCTAssertTrue(sheet.waitForExistence(timeout: 5), "The mark should open Scout's card, its reported line marked once")
    dragDown(sheet, in: app)
    waitGone(sheet, "A swipe down should close the card")
  }

  @MainActor
  func testAnAgentsNameOpensItsCardAndATapOutsideClosesIt() {
    let app = launch("chat-agent")
    let mark = app.buttons["Scout, connected agent"].firstMatch
    XCTAssertTrue(mark.waitForExistence(timeout: 5), "Scout's mark should show")
    // The message's words beside the mark, under the name, aren't the target.
    mark.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 60, dy: 34)).tap()
    XCTAssertFalse(card(app, scoutCard).waitForExistence(timeout: 2), "A tap on the message's words shouldn't open the card")
    tapName(mark)
    let sheet = card(app, scoutCard)
    XCTAssertTrue(sheet.waitForExistence(timeout: 5), "The name should open Scout's card")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
    waitGone(sheet, "A tap outside should close the card")
  }

  @MainActor
  func testYourOwnAgentsShortCardNamesItsOwnerAndASwipeDownClosesIt() {
    let app = launch("chat")
    let mark = app.buttons["Nova, agent"].firstMatch
    XCTAssertTrue(mark.waitForExistence(timeout: 5), "VoiceOver should hear Nova's mark as an agent")
    tapMark(mark)
    let sheet = card(app, novaCard)
    XCTAssertTrue(sheet.waitForExistence(timeout: 5), "Nova's card should name its owner, with no (as reported)")
    // Its card is short, two lines; a swipe down closes it too.
    dragDown(sheet, in: app)
    waitGone(sheet, "A swipe down should close a short card")
  }
}
