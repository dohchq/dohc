import XCTest

// What a Notices row's worded action does. A row is one VoiceOver element, so its pills aren't buttons to the test: it
// taps the pill where the row lays it out, on the action line above the row's time.
final class NoticesActionsTests: XCTestCase {
  // The notices-reply demo's mention of Sam's message in the Porto thread, last in the list.
  private let samMention = "From a person, Sam Ortiz mentioned you in #planning"

  @MainActor
  func testMentionReplyOpensItsThreadWithReplyChosen() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", "notices-reply"]
    app.launch()

    let row = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", samMention)).firstMatch
    for _ in 0..<12 where !(row.exists && row.isHittable) {
      app.swipeUp()
    }
    XCTAssertTrue(row.waitForExistence(timeout: 20), "The sample's mention row never showed")
    // Past the end, so the last row rests above the tab bar.
    app.swipeUp()
    XCTAssertTrue(row.isHittable)

    // The pill is first on the action line: 16 pt inset, a 30 pt mark and a 10 pt gap, then the pill. The line's 32 pt
    // pill sits above the time's line (about 16 pt, 2 pt above it) and the row's 12 pt bottom padding.
    let pill = row.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
      .withOffset(CGVector(dx: 56 + 24, dy: row.frame.height - 12 - 18 - 16))
    pill.tap()

    // The thread opens with Sam's message chosen: its reply context names it above the field, with Cancel reply.
    let context = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Reply to Sam Ortiz")).firstMatch
    XCTAssertTrue(context.waitForExistence(timeout: 10), "The thread didn't open with Sam's message chosen")
    XCTAssertTrue(app.buttons["Cancel reply"].exists)
  }
}
