import XCTest

// Notices with its native large title. Scrolling folds the title into the bar, following the finger; scrolling back
// expands it; the last row ends at the tab bar with the same gap as
// between rows; Mark all read stays put. The bar's own frame doesn't follow a collapse on iOS 27, so these read the
// title's frame instead. Frames are kept for the design lead.
final class NoticesScrollTests: XCTestCase {
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func launch(demo: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices"]
    if let demo { app.launchArguments += ["-dohcDemo", demo] }
    app.launch()
    return app
  }

  private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
  }

  private func waitUntil(_ timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: timeout) == .completed
  }

  /// Every "Notices" title the bar exposes, by frame. The bar can hold the large and the small title at once.
  private func titles(_ app: XCUIApplication) -> [CGRect] {
    app.navigationBars.firstMatch.staticTexts.matching(NSPredicate(format: "label == %@", "Notices")).allElementsBoundByIndex
      .map(\.frame).filter { !$0.isEmpty }
  }

  /// The large title at rest: the tallest "Notices" title.
  private func largeTitle(_ app: XCUIApplication) -> CGRect? { titles(app).max { $0.height < $1.height } }

  /// Folded: no title is the large one any more, and one sits in the bar above where the large one was.
  private func folded(_ app: XCUIApplication, from open: CGRect) -> Bool {
    let now = titles(app)
    return !now.isEmpty && now.allSatisfy { $0.height < open.height * 0.75 } && now.contains { $0.maxY < open.minY }
  }

  /// Expanded: a title at the large title's frame again.
  private func expanded(_ app: XCUIApplication, like open: CGRect) -> Bool {
    titles(app).contains { abs($0.height - open.height) <= 1 && abs($0.minY - open.minY) <= 1 }
  }

  @MainActor
  func testDraggingFoldsTheTitleAndScrollingBackExpandsIt() {
    let app = launch(demo: "notices-frames")
    let last = row(app, "Nova finished updating the packing list")
    let previous = row(app, "Sam Ortiz commented on itinerary/days.md")
    let markAllRead = app.navigationBars.firstMatch.buttons["Mark all read"]
    XCTAssertTrue(last.waitForExistence(timeout: 20), "Notices should list its rows")
    guard let open = largeTitle(app) else { return XCTFail("Notices should show its large title") }
    let button = markAllRead.frame
    keep(app, "07-notices-top")

    for _ in 0..<5 { app.swipeUp() }
    XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "Scrolling should fold the large title into the bar")
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && last.frame.maxY <= tabBar.frame.minY + 2 }, "The last row should end at the tab bar")
    let rowGap = last.frame.minY - previous.frame.maxY
    let endGap = tabBar.frame.minY - last.frame.maxY
    XCTAssertEqual(endGap, rowGap, accuracy: 2, "The last row's gap to the tab bar should equal the gap between rows")
    XCTAssertEqual(markAllRead.frame.midX, button.midX, accuracy: 1, "Mark all read should stay at the bar's trailing edge")
    keep(app, "07-notices-end-dragged")
    // The element tree after the drag, with every frame, for the record if the title didn't fold.
    print("NOTICES TREE BEGIN\n\(app.debugDescription)\nNOTICES TREE END")
    print("NOTICES END: title \(open) → \(titles(app)); last row ends \(last.frame.maxY); tab bar starts \(tabBar.frame.minY); row gap \(rowGap), end gap \(endGap)")

    for _ in 0..<5 { app.swipeDown() }
    XCTAssertTrue(waitUntil(5) { self.expanded(app, like: open) }, "Scrolling back to the top should expand the large title again")
    keep(app, "07-notices-back-to-top")
  }

  // Opened from the tab bar after launch has settled, so its list may have mounted after the screen: the title must
  // still fold on a drag.
  @MainActor
  func testOpeningTheTabLaterStillFoldsTheTitle() {
    let app = XCUIApplication()
    // No route and no demo, whatever an earlier run left in the settings, so the app opens on Chats.
    app.launchArguments += ["-dohcTestRoute", "", "-dohcDemo", ""]
    app.launch()
    let chats = app.tabBars.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chats")).firstMatch
    let tab = app.tabBars.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 20))
    XCTAssertTrue(chats.isSelected, "The app should open on Chats")
    // Measurement protocol, not a pass condition: let launch settle before the tap.
    Thread.sleep(forTimeInterval: 4)
    tab.tap()
    XCTAssertTrue(row(app, "Maya Chen mentioned you in #planning").waitForExistence(timeout: 10))
    guard let open = largeTitle(app) else { return XCTFail("Notices should show its large title") }
    for _ in 0..<5 { app.swipeUp() }
    XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "The title should fold after opening the tab later")
  }
}
