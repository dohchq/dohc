import UIKit
import XCTest

// On iPhone a page opens in an editor that loaded before the tap (modules/editor-pool). The sample's page-pool demo
// shows "Editor ready" while a spare editor has loaded, and names how each page got its editor and when it drew.
final class PageOpenSpeedTests: XCTestCase {
  // iPad keeps its own web view per page, with no spare editor.
  override func setUpWithError() throws {
    try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "The editor pool is iPhone only")
  }

  @MainActor
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "", "-dohcDemo", "page-pool"]
    app.launch()
    return app
  }

  @MainActor
  private func openChat(_ app: XCUIApplication, _ file: String) {
    let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", file)).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 45), "Chats should list \(file)")
    for _ in 0..<4 where !row.isHittable { app.swipeUp() }
    row.tap()
  }

  /// Opens the file's page from its chat once a spare editor is ready, and returns how it opened.
  @MainActor
  private func openPage(_ app: XCUIApplication, _ file: String) -> (claim: String, afterMount: Int, afterTap: Int)? {
    XCTAssertTrue(app.staticTexts["Editor ready"].waitForExistence(timeout: 30), "A spare editor should load")
    let open = app.buttons["Open \(file)"]
    XCTAssertTrue(open.waitForExistence(timeout: 15))
    open.tap()
    let opened = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Opened ")).firstMatch
    XCTAssertTrue(opened.waitForExistence(timeout: 15), "The page should draw")
    let parts = opened.label.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    guard parts.count >= 7, let afterMount = Int(parts[2]), let afterTap = Int(parts[6]) else {
      XCTFail("Unreadable: \(opened.label)")
      return nil
    }
    print("PAGE OPEN: \(opened.label)")
    return (parts[1], afterMount, afterTap)
  }

  @MainActor
  private func back(_ app: XCUIApplication) {
    app.navigationBars.buttons.element(boundBy: 0).tap()
  }

  // The loading lines show 150 ms after the page mounts, so a page that draws sooner never shows them.
  @MainActor
  func testAPageOpensInAReadyEditorBeforeTheLoadingLines() {
    let app = launch()
    openChat(app, "packing-list.md")
    for _ in 0..<5 {
      guard let open = openPage(app, "packing-list.md") else { return }
      XCTAssertEqual(open.claim, "ready", "The page should take the spare editor once it has loaded")
      XCTAssertLessThan(open.afterMount, 150, "The page should draw before the loading lines show")
      XCTAssertLessThan(open.afterTap, 300, "The page should draw within 300 ms of the tap")
      XCTAssertTrue(app.webViews.firstMatch.staticTexts["Packing list"].exists)
      back(app)
    }
  }

  @MainActor
  func testEachPageShowsOnlyItsOwnText() {
    let app = launch()
    let pages = [("packing-list.md", "Packing list", "Budget"), ("budget.md", "Budget", "Packing list"),
                 ("packing-list.md", "Packing list", "Budget")]
    for (file, title, other) in pages {
      openChat(app, file)
      guard let open = openPage(app, file) else { return }
      XCTAssertEqual(open.claim, "ready")
      let page = app.webViews.firstMatch
      XCTAssertTrue(page.staticTexts[title].waitForExistence(timeout: 15), "\(file) should show \(title)")
      XCTAssertFalse(page.staticTexts[other].exists, "\(file) should not show \(other)")
      back(app)
      back(app)
    }
  }
}
