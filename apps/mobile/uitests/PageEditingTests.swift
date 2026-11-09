import UIKit
import XCTest

// Editing a page the way a finger does: a tap brings up iOS's keyboard and the system's Done, typing reaches the
// page, and Done ends editing. Screenshots are kept in the result bundle for the design review.
final class PageEditingTests: XCTestCase {
  @MainActor
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }

  @MainActor
  func testTypingShowsDoneAndDoneEndsEditing() {
    let app = XCUIApplication()
    // A short page: a long one makes every XCUITest query snapshot thousands of elements.
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let body = app.webViews.firstMatch.textViews.firstMatch
    XCTAssertTrue(body.waitForExistence(timeout: 20), "The page's editable body should appear")
    // The caret lands in view, so nothing on the page may move when the keyboard comes up.
    let title = app.webViews.firstMatch.staticTexts["Packing list"]
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    let titleBefore = title.frame
    body.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "A tap should bring up the on-screen keyboard")
    // The header's Done, not a key on the keyboard.
    let done = app.navigationBars.buttons["Done"]
    XCTAssertTrue(done.waitForExistence(timeout: 5), "Done should show while the keyboard is up")
    XCTAssertEqual(title.frame.minY, titleBefore.minY, accuracy: 1, "The page moved when the keyboard came up")
    keep(app, "04-editing-keyboard")
    app.typeText("Typed on the phone. ")
    keep(app, "04-editing-typed")
    done.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "Done should close the keyboard")
    XCTAssertFalse(app.navigationBars.buttons["Done"].exists, "Done shows only while the keyboard is up")
    XCTAssertTrue(app.navigationBars.buttons["Document actions"].exists, "The menu comes back when editing ends")
    XCTAssertEqual(title.frame.minY, titleBefore.minY, accuracy: 1, "The page stayed moved after Done")
    keep(app, "04-editing-done")
  }

  // A tap low on the page puts the caret where the keyboard will be, so the page scrolls just enough to show it.
  @MainActor
  func testTypingNearTheBottomStaysAboveTheKeyboard() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editable body should appear")
    page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "A tap should bring up the on-screen keyboard")
    app.typeText("Typed near the bottom. ")
    let typed = page.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Typed near the bottom.")).firstMatch
    XCTAssertTrue(typed.waitForExistence(timeout: 5), "The typed text should reach the page")
    XCTAssertLessThanOrEqual(typed.frame.maxY, keyboard.frame.minY, "The caret's line should sit above the keyboard")
    keep(app, "04-editing-bottom")
  }

  // A taller keyboard (emoji) covers more of the page; the line being typed stays above it.
  @MainActor
  func testSwitchingToTheEmojiKeyboardKeepsTheLineAboveIt() throws {
    // The RO's ruling (d), round 51: skipped until a round runs with no new report. Not covered, not passed.
    throw XCTSkip("Not covered: the system's emoji keyboard crashes iMessageAppsViewService in this simulator (iMessageAppsViewService-2026-11-06-015440.ips)")
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editable body should appear")
    page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "A tap should bring up the on-screen keyboard")
    app.typeText("Typed before the emoji. ")
    let emoji = keyboard.buttons["Emoji"]
    XCTAssertTrue(emoji.waitForExistence(timeout: 5), "The keyboard should offer its emoji key")
    emoji.tap()
    let typed = page.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Typed before the emoji.")).firstMatch
    XCTAssertTrue(typed.waitForExistence(timeout: 5), "The typed text should reach the page")
    // Let the emoji keyboard finish rising before measuring.
    _ = keyboard.wait(for: \.isHittable, toEqual: true, timeout: 3)
    XCTAssertLessThanOrEqual(typed.frame.maxY, keyboard.frame.minY, "The line should sit above the emoji keyboard")
    keep(app, "04-editing-emoji")
  }

  // Emoji are several text units each: a skin tone, a flag and a family reach the page whole. They're pasted through the
  // text menu, so neither the emoji nor the sticker panel opens.
  @MainActor
  func testPastedEmojiReachThePageWhole() {
    // Known failure: phone paste defect (a long press in a page shows no edit menu, so there's no Paste).
    XCTExpectFailure("Phone paste defect: a long press in a page shows no edit menu, so there's no Paste")
    let emoji = "Pasted 👋🏽 🇵🇹 👨‍👩‍👧 here."
    UIPasteboard.general.string = emoji
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editable body should appear")
    let spot = page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92))
    spot.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "A tap should bring up the on-screen keyboard")
    app.typeText("Before the emoji. ")
    // The long press goes on the typed text once it sits above the keyboard, not on the spot under the keyboard.
    let typed = page.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Before the emoji.")).firstMatch
    XCTAssertTrue(typed.waitForExistence(timeout: 5), "The typed text should reach the page")
    let keyboard = app.keyboards.firstMatch
    let above = NSPredicate { _, _ in typed.frame.maxY <= keyboard.frame.minY }
    XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: above, object: nil)], timeout: 5), .completed,
                   "The typed line should sit above the keyboard")
    typed.press(forDuration: 1.0)
    let paste = app.menuItems["Paste"]
    XCTAssertTrue(paste.waitForExistence(timeout: 5), "A long press should offer Paste")
    paste.tap()
    let pasted = page.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", emoji)).firstMatch
    XCTAssertTrue(pasted.waitForExistence(timeout: 5), "The pasted emoji should reach the page whole")
    keep(app, "04-editing-pasted-emoji")
  }

  // The page scrolls inside its own container, so the status bar's scroll-to-top has nothing to move. Known limit:
  // react-native-webview keeps its own scroll view as a status-bar target, and with a second target on screen iOS
  // ignores the tap, so a stand-in can't take it without native code (round 34). This fails until that changes.
  @MainActor
  func testStatusBarTapScrollsThePageToTheTop() {
    XCTExpectFailure("Known limit: a status bar tap doesn't reach a page's own scroll container")
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editable body should appear")
    let title = page.staticTexts["Packing list"]
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    let top = title.frame.minY
    page.swipeUp()
    XCTAssertLessThan(title.frame.minY, top - 40, "A swipe should scroll the page")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    let back = NSPredicate { _, _ in abs(title.frame.minY - top) <= 1 }
    XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: back, object: nil)], timeout: 3), .completed,
                   "A tap on the status bar should scroll the page back to the top")
  }

  // Dragging a selection handle down onto the keyboard scrolls the page, so a selection can grow past what's in
  // view. The line sits just above the keyboard; its word's end handle is at the bottom of the line.
  @MainActor
  func testDraggingASelectionHandleOntoTheKeyboardScrollsThePage() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editable body should appear")
    let title = page.staticTexts["Packing list"]
    let line = page.staticTexts["Walking shoes, already broken in"]
    XCTAssertTrue(line.waitForExistence(timeout: 5))
    line.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "A tap should bring up the on-screen keyboard")
    line.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).doubleTap()
    keep(app, "04-drag-selected")
    let before = title.frame.minY
    let handle = line.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 1)).withOffset(CGVector(dx: 62, dy: 3))
    let low = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 200, dy: app.frame.maxY - 60))
    handle.press(forDuration: 0.6, thenDragTo: low, withVelocity: .slow, thenHoldForDuration: 2)
    keep(app, "04-drag-onto-keyboard")
    print("DRAG: title \(before) → \(title.frame.minY); keyboard top \(keyboard.frame.minY)")
    XCTAssertLessThan(title.frame.minY, before - 10, "Dragging a selection handle onto the keyboard should scroll the page")
  }
}
