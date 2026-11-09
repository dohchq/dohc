import UIKit
import XCTest

// Notices with the sync band, which reports the whole workspace and belongs to the bar region: it never scrolls, sits
// directly under the bar whether the title is large or folded, and no row starts behind it, at any text size. One list
// holds the rows whether or not the band shows, so nothing remounts. When the band arrives or leaves, at the start or
// mid-list, the row at the top of the view stays the top row and moves once by exactly the band's height; under
// Reduce Motion it moves at once. VoiceOver reads the title, then the band, then the rows. With the band,
// the list still ends at the tab bar, and Mark all read stays in the bar. Frames are kept for review.
final class NoticesBandTests: XCTestCase {
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func launch(demo: String, _ more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", demo] + more
    app.launch()
    return app
  }

  private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
  }

  /// The band's box as drawn: at the largest text sizes its content is taller and scrolls inside it.
  private func band(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["sync-band-area"] }

  /// The list's vertical scroll indicator, as the accessibility tree exposes it: its frame is the indicator's track.
  /// The band has one of its own; the list's is the taller.
  private func indicator(_ app: XCUIApplication) -> XCUIElement {
    let bars = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Vertical scroll bar"))
    let tallest = (0..<bars.count).max { bars.element(boundBy: $0).frame.height < bars.element(boundBy: $1).frame.height }
    return tallest.map { bars.element(boundBy: $0) } ?? bars.firstMatch
  }

  /// Polls as fast as the accessibility snapshot allows, so the band is caught as soon as it shows.
  private func arrives(_ app: XCUIApplication, within timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline { if band(app).exists { return true } }
    return false
  }

  /// The band's frame and a row's frame from one snapshot, so both describe the same instant. Nil when the band
  /// isn't showing.
  private func bandAndRow(_ app: XCUIApplication, _ title: String) -> (band: CGRect, row: CGRect?)? {
    guard let root = try? app.snapshot() else { return nil }
    var band: CGRect?, row: CGRect?
    var stack = [root]
    while let next = stack.popLast() {
      if next.identifier == "sync-band-area" { band = next.frame }
      if row == nil, next.label.contains(title), !next.frame.isEmpty { row = next.frame }
      stack += next.children
    }
    return band.map { ($0, row) }
  }

  /// Watches for `seconds`, or until the band leaves: in every snapshot that shows the band, the row starts at or
  /// below the band's bottom.
  private func assertNeverUnderTheBand(_ app: XCUIApplication, _ title: String, _ state: String, for seconds: TimeInterval,
                                       file: StaticString = #filePath, line: UInt = #line) {
    let end = Date().addingTimeInterval(seconds)
    var readings = 0
    while Date() < end, let now = bandAndRow(app, title) {
      readings += 1
      guard let row = now.row else { return XCTFail("\(state): snapshot \(readings) has the band but not the row", file: file, line: line) }
      if row.minY < now.band.maxY - 1 {
        return XCTFail("\(state): snapshot \(readings), the row at \(row.minY) is under the band, which ends at \(now.band.maxY)", file: file, line: line)
      }
    }
    XCTAssertGreaterThan(readings, 0, "\(state): no snapshot showed the band", file: file, line: line)
    print("NOTICES BAND MOVE: \(state), \(readings) snapshots with the band, the row never under it")
  }

  /// What the band draws: its own box, which clips the band while it keeps an old height. Falls back to the band.
  private func drawn(_ snapshot: XCUIElementSnapshot) -> CGRect? {
    var area: CGRect?, band: CGRect?
    var stack = [snapshot]
    while let next = stack.popLast() {
      if next.identifier == "sync-band-area" { area = next.frame }
      if next.identifier == "sync-band" { band = next.frame }
      stack += next.children
    }
    return area ?? band
  }

  /// The band's drawn box and the first row, from one snapshot. Nil when either can't be read.
  private func boxAndFirstRow(_ app: XCUIApplication) -> (box: CGRect, row: CGRect)? {
    guard let root = try? app.snapshot(), let box = drawn(root) else { return nil }
    var stack = [root]
    while let next = stack.popLast() {
      if next.label.contains(titles[0]), !next.frame.isEmpty { return (box, next.frame) }
      stack += next.children
    }
    return nil
  }

  /// Waits until the first row rests right under the band: the band's box and the row read from one snapshot, the row's
  /// top within 1 pt of the box's bottom, and neither more than 0.5 pt from where they were at the window's first aligned
  /// reading for half a second; a misaligned or missing reading, or a larger move, starts the half second again. Gives the resting reading and the highest the box went while watching, or nil on timeout.
  private func restingRightUnderTheBand(_ app: XCUIApplication, within timeout: TimeInterval) -> (rest: (box: CGRect, row: CGRect)?, highest: CGFloat) {
    let deadline = Date().addingTimeInterval(timeout)
    var base: (box: CGRect, row: CGRect)?, since = Date(), highest = CGFloat.greatestFiniteMagnitude
    while Date() < deadline {
      guard let now = boxAndFirstRow(app) else { base = nil; continue }
      highest = min(highest, now.box.minY)
      guard abs(now.row.minY - now.box.maxY) <= 1 else { base = nil; continue }
      // Measured from the first aligned reading of the window, so a slow drift can't pass as rest.
      if let base, abs(base.box.maxY - now.box.maxY) <= 0.5 && abs(base.row.minY - now.row.minY) <= 0.5 {
        if Date().timeIntervalSince(since) >= 0.5 { return (now, highest) }
      } else {
        base = now
        since = Date()
      }
    }
    return (nil, highest)
  }

  /// Drags the list itself down, from just under the band to just above the tab bar. An app-wide swipe starts mid-screen,
  /// which at AX5 is on the capped band, and scrolls the band instead.
  private func dragListDown(_ app: XCUIApplication) {
    let from = band(app).frame.maxY + 16, to = app.tabBars.firstMatch.frame.minY - 16
    guard to - from > 40 else { return }
    let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.midX, dy: from))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: to - from)), withVelocity: .fast, thenHoldForDuration: 0)
  }

  /// Watches a change while the band shows, from a reading taken before it, until `done` holds and a second more has
  /// passed. At every reading the band's drawn bottom is at or above the first row's top. Across the change the first
  /// row moves once against the band: the bar's edge may move both together first, which isn't a move of the rows.
  private func assertOneMoveAndNothingDrawnOverTheRow(_ app: XCUIApplication, _ state: String, from before: (box: CGRect, row: CGRect),
                                                      timeout: TimeInterval, until done: @escaping () -> Bool,
                                                      file: StaticString = #filePath, line: UInt = #line) {
    let deadline = Date().addingTimeInterval(timeout)
    var settledAt: Date?, gaps = [before.row.minY - before.box.minY], readings = 0, afterwards = 0
    while Date() < deadline {
      if settledAt == nil, done() { settledAt = Date() }
      if let settledAt, Date().timeIntervalSince(settledAt) > 1 { break }
      guard let now = boxAndFirstRow(app) else {
        return XCTFail("\(state): a reading couldn't find the band or the first row", file: file, line: line)
      }
      readings += 1
      if settledAt != nil { afterwards += 1 }
      if now.box.maxY > now.row.minY + 1 {
        return XCTFail("\(state): reading \(readings), the band draws to \(now.box.maxY), over the first row at \(now.row.minY)", file: file, line: line)
      }
      let gap = now.row.minY - now.box.minY
      if abs(gaps.last! - gap) > 1 { gaps.append(gap) }
    }
    XCTAssertNotNil(settledAt, "\(state): the change never happened", file: file, line: line)
    XCTAssertGreaterThan(afterwards, 0, "\(state): no reading after the change", file: file, line: line)
    XCTAssertLessThanOrEqual(gaps.count, 2, "\(state): the first row should move once against the band; its distance from the band's top went \(gaps)",
                             file: file, line: line)
    print("NOTICES BAND CHANGE: \(state), \(readings) readings, first row's distance from the band's top \(gaps)")
  }

  /// Every "Notices" title the bar exposes. The bar can hold the large and the small title at once.
  private func barTitles(_ app: XCUIApplication) -> [CGRect] {
    app.navigationBars.firstMatch.staticTexts.matching(NSPredicate(format: "label == %@", "Notices")).allElementsBoundByIndex
      .map(\.frame).filter { !$0.isEmpty }
  }

  /// Folded: no title is the large one any more, and one sits in the bar above where the large one was.
  private func folded(_ app: XCUIApplication, from open: CGRect) -> Bool {
    let now = barTitles(app)
    return !now.isEmpty && now.allSatisfy { $0.height < open.height * 0.75 } && now.contains { $0.maxY < open.minY }
  }

  private func waitUntil(_ timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: timeout) == .completed
  }

  /// The rows in order, by title, as the sample lists them.
  private let titles = ["Maya Chen mentioned you in #planning", "Nova finished updating the itinerary app", "Automation “Budget sync” failed",
                        "Your agent has work waiting", "Sam Ortiz shared Budget with you", "Nova drafted the Porto day plan",
                        "Maya Chen replied in #planning", "Sam Ortiz commented on itinerary/days.md", "Nova finished updating the packing list"]

  /// The bar's real edge: the bottom of the navigation bar's frame, below its bottom margin. 168 pt at rest and 116 pt
  /// folded on the test phone.
  private func barEdge(_ app: XCUIApplication) -> CGFloat { app.navigationBars.firstMatch.frame.maxY }

  /// Where the bar's content ends: below its titles and Mark all read.
  private func barContent(_ app: XCUIApplication) -> CGFloat {
    let bar = app.navigationBars.firstMatch
    let parts = bar.staticTexts.matching(NSPredicate(format: "label == %@", "Notices")).allElementsBoundByIndex.map(\.frame)
      + bar.buttons.allElementsBoundByIndex.map(\.frame)
    return parts.filter { !$0.isEmpty }.map(\.maxY).max() ?? barEdge(app)
  }

  /// The band starts at the bar's real edge, within 1 pt, so none of it is under the bar, and never above the bar's
  /// lowest title or button.
  private func assertUnderTheBar(_ app: XCUIApplication, _ state: String, file: StaticString = #filePath, line: UInt = #line) {
    let top = band(app).frame.minY, edge = barEdge(app), content = barContent(app)
    XCTAssertTrue(abs(top - edge) <= 1 && top >= content - 0.5,
                  "\(state): the band should start at the bar's edge (band at \(top), bar edge \(edge), bar content ends \(content))",
                  file: file, line: line)
  }

  /// The first row starts at the band's bottom, within 1 pt: nothing behind the band and no gap.
  private func assertRightUnderTheBand(_ app: XCUIApplication, _ row: XCUIElement, _ state: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(row.frame.minY, band(app).frame.maxY, accuracy: 1,
                   "\(state): the first row should start at the band's bottom (row at \(row.frame.minY), band ends \(band(app).frame.maxY))",
                   file: file, line: line)
  }

  /// The first row whose top is at or below `edge`: with the band showing, pass the band's bottom.
  private func topTitle(_ app: XCUIApplication, below edge: CGFloat) -> String? {
    titles.first { let r = row(app, $0); return r.exists && r.frame.minY >= edge - 1 }
  }

  /// The first row whose top is below the bar: the row at the top of the view.
  private func topRow(_ app: XCUIApplication) -> XCUIElement? {
    topTitle(app, below: barEdge(app)).map { row(app, $0) }
  }

  @MainActor
  func testTheBandArrivingAndLeavingKeepsTheTopRowInView() {
    let app = launch(demo: "band-toggle")
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    let markAllRead = app.navigationBars.firstMatch.buttons["Mark all read"]
    let button = markAllRead.frame
    app.swipeUp(velocity: .slow)
    guard let topName = topTitle(app, below: barEdge(app)) else { return XCTFail("A row should be at the top of the view") }
    let top = row(app, topName)
    let before = top.frame.minY
    keep(app, "07-notices-band-before")

    XCTAssertFalse(band(app).exists, "The band should not show yet")
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    assertNeverUnderTheBand(app, topName, "Arriving mid-list", for: 1)
    let height = band(app).frame.height
    XCTAssertTrue(waitUntil(3) { abs(top.frame.minY - before - height) <= 1 },
                  "When the band arrives, the top row should move down by the band's height (\(before) → \(top.frame.minY), band \(height))")
    assertUnderTheBar(app, "After arriving mid-scroll")
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(top.frame.minY >= band(app).frame.maxY - 1 && top.frame.maxY <= tabBar.frame.minY,
                  "The top row should stay in view, below the band, when the band arrives")
    XCTAssertEqual(topTitle(app, below: band(app).frame.maxY), topName, "The top row should stay the top row when the band arrives")
    XCTAssertEqual(markAllRead.frame.midX, button.midX, accuracy: 1, "Mark all read should stay in the bar")
    keep(app, "07-notices-band-arrived")
    print("NOTICES BAND: top row \(before) → \(top.frame.minY) on arrival; band \(height) pt")

    assertNeverUnderTheBand(app, topName, "Leaving mid-list", for: 15)
    XCTAssertFalse(band(app).exists, "The band should leave")
    XCTAssertTrue(waitUntil(3) { abs(top.frame.minY - before) <= 1 }, "When the band leaves, the top row should return to where it was")
    XCTAssertEqual(topTitle(app, below: barEdge(app)), topName, "The top row should stay the top row when the band leaves")
    XCTAssertEqual(markAllRead.frame.midX, button.midX, accuracy: 1, "Mark all read should stay in the bar")
    keep(app, "07-notices-band-left")
  }

  @MainActor
  func testWithTheBandTheListEndsAtTheTabBar() {
    let app = launch(demo: "band")
    let last = row(app, titles[8])
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertTrue(band(app).exists, "The band should show")
    assertUnderTheBar(app, "At rest")
    let first = row(app, titles[0])
    assertRightUnderTheBand(app, first, "At rest")
    let markAllRead = app.navigationBars.firstMatch.buttons["Mark all read"]
    let button = markAllRead.frame
    keep(app, "07-notices-band-top")
    guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("Notices should show its large title") }
    // The element tree with the band at rest, for the record of where the band sits in the reading order.
    print("NOTICES BAND TREE BEGIN\n\(app.debugDescription)\nNOTICES BAND TREE END")
    for _ in 0..<6 { app.swipeUp() }
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 },
                  "With the band, the last row should end at the tab bar")
    XCTAssertTrue(band(app).exists, "The band should still show")
    XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "Scrolling should fold the large title into the bar, with the band showing")
    assertUnderTheBar(app, "Folded")
    XCTAssertTrue(indicator(app).waitForExistence(timeout: 2), "The list should expose its scroll indicator")
    XCTAssertGreaterThanOrEqual(indicator(app).frame.minY, band(app).frame.maxY - 1, "Folded, the scroll indicator should start below the band")
    XCTAssertEqual(markAllRead.frame.midX, button.midX, accuracy: 1, "Mark all read should stay in the bar")
    keep(app, "07-notices-band-end")
    for _ in 0..<6 { app.swipeDown() }
    XCTAssertTrue(waitUntil(5) { abs(self.row(app, self.titles[0]).frame.minY - self.band(app).frame.maxY) <= 1 },
                  "Back at the top, the first row should start at the band's bottom")
    assertUnderTheBar(app, "Back at the top")
    XCTAssertTrue(indicator(app).waitForExistence(timeout: 2), "The list should expose its scroll indicator")
    XCTAssertEqual(indicator(app).frame.minY, band(app).frame.maxY, accuracy: 2,
                   "At rest, the scroll indicator should start where the content does, at the band's bottom")
    keep(app, "07-notices-band-back-to-top")
    print("NOTICES BAND END: last row ends \(last.frame.maxY); tab bar starts \(tabBar.frame.minY); band at \(band(app).frame)")
  }

  // Partway through the fold the band rides on the list: it moves up with the title and the first row by exactly the
  // scroll, at a quarter, half and three quarters of the fold, and down with the list on a pull-down. Try again stays
  // tappable where it's drawn, and the list's indicator starts below the band. At the default text size, the largest
  // default one and AX5. If iOS stopped reporting the list's offset to the host, the band would stay at rest and this
  // fails.
  @MainActor
  func testPartwayThroughTheFoldTheBandRidesOnTheList() {
    for (name, extra) in [("default text size", [String]()),
                          ("largest default text size", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]),
                          ("AX5", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])] {
      var app = launch(demo: "band", extra)
      XCTAssertTrue(band(app).waitForExistence(timeout: 20))
      guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("\(name): Notices should show its large title") }
      let rest = barEdge(app)
      for _ in 0..<3 { app.swipeUp() }
      XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "\(name): swipes should fold the title")
      let fold = rest - barEdge(app)
      XCTAssertGreaterThan(fold, 20, "\(name): the title should fold by more than 20 pt (rest \(rest), folded \(barEdge(app)))")
      app.terminate()
      for (step, by) in [("quarter", fold * 0.25), ("half", fold * 0.5), ("three-quarters", fold * 0.75), ("pull-down", CGFloat(-20))] {
        // A negative value would read as a new launch flag, so a pull-down goes by its own setting.
        app = launch(demo: "band-half-fold", extra + (by < 0 ? ["-dohcBandPull", "\(-by)"] : ["-dohcBandScroll", "\(by)"]))
        let first = row(app, titles[0])
        XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(5) { abs(self.band(app).frame.minY - (rest - by)) <= 1 },
                      "\(name), \(step): the band should move by the scroll, to \(rest - by) (band at \(band(app).frame.minY))")
        assertRightUnderTheBand(app, first, "\(name), \(step)")
        if by > 0 { XCTAssertFalse(folded(app, from: open), "\(name), \(step): the title should be partway, not folded") }
        let tryAgain = app.buttons["Try again"]
        // Capped at AX5, Try again sits below the words' region, in view without scrolling the band.
        XCTAssertTrue(band(app).frame.contains(tryAgain.frame.insetBy(dx: 1, dy: 1)), "\(name), \(step): Try again should be wholly in the band at rest (Try again at \(tryAgain.frame), band \(band(app).frame))")
        let middle = CGPoint(x: tryAgain.frame.midX, y: tryAgain.frame.midY)
        XCTAssertTrue(tryAgain.isHittable && band(app).frame.contains(middle), "\(name), \(step): Try again should be tappable where it's drawn (Try again at \(tryAgain.frame), band \(band(app).frame))")
        if !indicator(app).waitForExistence(timeout: 2) {
          XCTFail("\(name), \(step): the list should expose its scroll indicator")
        } else if by > 0 {
          XCTAssertGreaterThanOrEqual(indicator(app).frame.minY, band(app).frame.maxY - 1, "\(name), \(step): the indicator should start below the band")
        } else {
          // Overscrolled past its start, the band follows the pull and iOS keeps the indicator at the
          // covered strip's bottom. Released, the list goes back to its start and the indicator to the band's bottom.
          let strip = rest + band(app).frame.height
          XCTAssertGreaterThanOrEqual(indicator(app).frame.minY, strip - 1, "\(name), \(step): overscrolled, the indicator should start at the covered strip's bottom (\(strip))")
        }
        keep(app, "07-notices-band-partway-\(name.replacingOccurrences(of: " ", with: "-"))-\(step)")
        if by < 0 {
          let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
          start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 30)), withVelocity: .slow, thenHoldForDuration: 0)
          XCTAssertTrue(waitUntil(5) { abs(self.band(app).frame.minY - rest) <= 1 && self.indicator(app).exists && self.indicator(app).frame.minY >= self.band(app).frame.maxY - 1 },
                        "\(name), released: the band should be back at rest and the indicator at its bottom (band at \(band(app).frame.minY), indicator at \(indicator(app).frame.minY))")
        }
        print("NOTICES BAND PARTWAY: \(name), \(step) (\(by) of \(fold) pt): band at \(band(app).frame.minY), first row at \(first.frame.minY)")
        app.terminate()
      }
    }
  }

  // Checks the resting edge the host computes (the bar frame's top plus its sizeThatFits height): at rest, with
  // the title open, it must equal the bar's measured edge within 1 pt. The test prints the edge and the tab bar's top;
  // a script reads the last space the host sent (band-space.json) and checks tab bar top − space against the edge.
  @MainActor
  private func printRestingEdge(_ size: String?) {
    let app = launch(demo: "band", size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
    XCTAssertTrue(band(app).waitForExistence(timeout: 20))
    // Measurement protocol, not a pass condition: let the host send its space for the laid-out screen.
    Thread.sleep(forTimeInterval: 2)
    print("NOTICES RESTING EDGE \(barEdge(app)) TAB BAR \(app.tabBars.firstMatch.frame.minY)")
  }
  @MainActor func testRestingEdgeAtTheDefaultTextSize() { printRestingEdge(nil) }
  @MainActor func testRestingEdgeAtTheLargestDefaultTextSize() { printRestingEdge("UICTContentSizeCategoryXXXL") }
  @MainActor func testRestingEdgeAtAX5() { printRestingEdge("UICTContentSizeCategoryAccessibilityXXXL") }

  // An ordinary scroll through the fold sends no space, since the space between the bar's resting edge and
  // the tab bar doesn't change with a fold. The test prints when its scrolling starts; a script counts the sends in
  // band-space.json after that time and requires none.
  @MainActor
  func testAScrollThroughTheFoldSendsNoSpace() {
    let app = launch(demo: "band")
    XCTAssertTrue(band(app).waitForExistence(timeout: 20))
    guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("Notices should show its large title") }
    // Measurement protocol, not a pass condition: let the first spaces arrive before the mark.
    Thread.sleep(forTimeInterval: 2)
    print("NOTICES SPACE SCROLL FROM \(Int(Date().timeIntervalSince1970 * 1000))")
    for _ in 0..<3 { app.swipeUp() }
    XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "Swipes should fold the title")
    for _ in 0..<4 { app.swipeDown() }
    XCTAssertTrue(waitUntil(5) { !self.folded(app, from: open) }, "Swipes back should open the title")
    print("NOTICES SPACE SCROLL TO \(Int(Date().timeIntervalSince1970 * 1000))")
  }

  // Text Size grows to AX5 while the title is folded. Back at the top, the band is within half the space at
  // the new size, so the resting edge the cap uses wasn't left at the old size, and folded the band stays at the bar.
  @MainActor
  func testChangingTextSizeWhileFoldedKeepsTheCapAndTheFloor() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DOHC_TEXT_SIZE_CHANGE"] == "1", "Runs when the round script changes Text Size")
    let app = launch(demo: "band")
    XCTAssertTrue(band(app).waitForExistence(timeout: 20))
    guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("Notices should show its large title") }
    for _ in 0..<3 { app.swipeUp() }
    guard waitUntil(5, { self.folded(app, from: open) }) else { return XCTFail("Swipes should fold the title before the change") }
    let usual = band(app).frame.height
    print("NOTICES TEXT SIZE READY")
    XCTAssertTrue(waitUntil(60) { self.band(app).frame.height > usual * 1.5 }, "The band should grow with Text Size")
    assertUnderTheBar(app, "Folded, after Text Size changed")
    // At AX5 the list is several thousand points tall: drag the list itself until the first row reaches the
    // band's bottom.
    let first = row(app, titles[0])
    for _ in 0..<30 where !(first.exists && first.frame.minY >= band(app).frame.maxY - 1) { dragListDown(app) }
    XCTAssertNotNil(restingRightUnderTheBand(app, within: 5).rest, "Back at the top, the first row should start at the band's bottom (row at \(first.frame.minY), band at \(band(app).frame.minY) to \(band(app).frame.maxY), bar edge \(barEdge(app)))")
    let cap = (app.tabBars.firstMatch.frame.minY - barEdge(app)) / 2
    XCTAssertTrue(waitUntil(3) { self.band(app).frame.height <= cap + 1 },
                  "Back at the top after the change, the band should be within half the new space, \(cap) pt (band \(band(app).frame.height))")
    keep(app, "07-notices-band-text-size-folded")
  }

  // A Text Size change halfway through the fold: once the screen settles, the band rides on the list again, with the
  // first row right under it, and stays put. The round makes the change when the test says it's ready.
  @MainActor
  func testChangingTextSizeHalfwayThroughTheFoldKeepsTheBandOnTheList() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DOHC_TEXT_SIZE_CHANGE"] == "1", "Runs when the round script changes Text Size")
    let app = launch(demo: "band-half-fold", ["-dohcBandScroll", "20"])
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
    let usual = band(app).frame.height
    // On iOS 27 the bar's frame stays at rest partway through the fold, so the band 20 pt above it means the list moved.
    // A failed precondition ends the test before it signals, so the script never changes Text Size at rest.
    guard waitUntil(5, { abs(self.band(app).frame.minY - (self.barEdge(app) - 20)) <= 1 }) else {
      return XCTFail("Before the change, the band should be 20 pt into the fold (band at \(band(app).frame.minY), bar edge \(barEdge(app)))")
    }
    guard abs(first.frame.minY - band(app).frame.maxY) <= 1 else {
      return XCTFail("Before the change, the first row should be right under the band")
    }
    keep(app, "07-notices-band-text-size-mid-fold-before")
    print("NOTICES TEXT SIZE READY")
    XCTAssertTrue(waitUntil(60) { self.band(app).frame.height > usual * 1.5 }, "The band should grow with Text Size")
    var settled = band(app).frame.minY
    XCTAssertTrue(waitUntil(5) {
      let now = self.band(app).frame.minY
      defer { settled = now }
      return abs(now - settled) <= 0.5 && abs(first.frame.minY - self.band(app).frame.maxY) <= 1
    }, "After the change, the band should settle with the first row right under it (row at \(first.frame.minY), band ends \(band(app).frame.maxY))")
    let place = band(app).frame.minY
    XCTAssertFalse(waitUntil(1) { abs(self.band(app).frame.minY - place) > 1 }, "Once settled, the band shouldn't move by more than 1 pt")
    keep(app, "07-notices-band-text-size-mid-fold-after")
  }

  // At the start of the list, the first row stays first: down by exactly the band's height when it arrives, back up
  // by the same when it leaves.
  @MainActor
  func testTheBandArrivingAtTheStartMovesTheFirstRowDownByItsHeight() {
    let app = launch(demo: "band-toggle")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    let before = first.frame.minY
    keep(app, "07-notices-band-start-before")
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    assertNeverUnderTheBand(app, titles[0], "Arriving at the start", for: 1)
    let height = band(app).frame.height
    XCTAssertTrue(waitUntil(3) { abs(first.frame.minY - before - height) <= 1 },
                  "At the start, the first row should move down by exactly the band's height (\(before) → \(first.frame.minY), band \(height))")
    assertUnderTheBar(app, "Arrived at the start")
    XCTAssertEqual(topTitle(app, below: band(app).frame.maxY), titles[0], "The first row should stay the top row, below the band")
    assertRightUnderTheBand(app, first, "Arrived at the start")
    keep(app, "07-notices-band-start-arrived")
    assertNeverUnderTheBand(app, titles[0], "Leaving at the start", for: 15)
    XCTAssertFalse(band(app).exists, "The band should leave")
    XCTAssertTrue(waitUntil(3) { abs(first.frame.minY - before) <= 1 }, "When the band leaves, the first row should move back up")
    keep(app, "07-notices-band-start-left")
  }

  // The band's arrival waits while a finger holds the list, so content never jumps under a finger. The drag holds across
  // the moment the band would arrive; the band shows only after the finger lifts. The app records, on its own clock,
  // when the last finger lifted and when the band first applied, in band-hold.json; a script compares the two.
  @MainActor
  func testTheBandWaitsWhileAFingerHoldsTheList() {
    let app = launch(demo: "band-toggle")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    XCTAssertFalse(band(app).exists, "The band should not show yet")
    let start = first.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    let end = start.withOffset(CGVector(dx: 0, dy: -60))
    // Held for longer than the band takes to arrive, so it arrives while the finger is down.
    start.press(forDuration: 0.2, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 9)
    let released = Date().timeIntervalSince1970 * 1000
    print("NOTICES DRAG RELEASED \(Int(released))")
    XCTAssertTrue(arrives(app, within: 3), "The band should arrive once the finger lifts")
    keep(app, "07-notices-band-after-drag")
  }

  // Scrolled to the end with the band showing, the band leaves: the list stays at its end, with no gap above the tab
  // bar.
  @MainActor
  func testTheBandLeavingAtTheEndLeavesNoGap() {
    let app = launch(demo: "band-toggle")
    let last = row(app, titles[8])
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    for _ in 0..<6 { app.swipeUp() }
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 }, "The list should reach its end")
    XCTAssertTrue(waitUntil(15) { !self.band(app).exists }, "The band should leave")
    XCTAssertTrue(waitUntil(3) { abs(tabBar.frame.minY - last.frame.maxY) <= 2 },
                  "After the band leaves at the end, the last row should still end at the tab bar (row ends \(last.frame.maxY), tab bar at \(tabBar.frame.minY))")
    keep(app, "07-notices-band-left-at-end")
  }

  // With no band, Notices left at its end and opened again keeps its last row at the tab bar.
  @MainActor
  func testReturningToNoticesAtTheEndKeepsTheLastRowAtTheTabBar() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", ""]
    app.launch()
    let last = row(app, titles[8])
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    for _ in 0..<6 { app.swipeUp() }
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 }, "The list should reach its end")
    tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chats")).firstMatch.tap()
    let notices = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    XCTAssertTrue(notices.waitForExistence(timeout: 5))
    notices.tap()
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 },
                  "Back on Notices, the last row should still end at the tab bar (row ends \(last.frame.maxY), tab bar at \(tabBar.frame.minY))")
  }

  // Scrolled to the end with the band showing, Notices is left and opened again twice: once while the band still
  // shows, once after it left while Notices was away. Both times the last row ends at the tab bar.
  @MainActor
  func testReturningAtTheEndWithTheBandKeepsTheLastRowAtTheTabBar() {
    let app = launch(demo: "band-long")
    let last = row(app, titles[8])
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    let arrived = Date()
    for _ in 0..<6 { app.swipeUp() }
    let tabBar = app.tabBars.firstMatch
    let atTheEnd = { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 }
    XCTAssertTrue(waitUntil(5, atTheEnd), "The list should reach its end")
    let chats = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chats")).firstMatch
    let notices = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    chats.tap()
    notices.tap()
    XCTAssertTrue(band(app).waitForExistence(timeout: 3), "The band should still show")
    XCTAssertTrue(waitUntil(5, atTheEnd), "Back with the band still showing, the last row should end at the tab bar (row ends \(last.frame.maxY))")
    assertUnderTheBar(app, "Back with the band still showing")
    chats.tap()
    // The demo clears the band 32 s after it arrived; Notices is away meanwhile.
    XCTAssertTrue(waitUntil(45) { Date().timeIntervalSince(arrived) > 33 }, "The band's time should pass")
    notices.tap()
    // No frame after the return shows the list past its end. Every snapshot for 2 s, as fast as the
    // accessibility snapshot allows, has the last row at the tab bar, never above it.
    var readings = 0, gaps: [CGFloat] = [], largest: CGFloat = 0
    let watchUntil = Date().addingTimeInterval(2)
    while Date() < watchUntil {
      guard let root = try? app.snapshot() else { continue }
      var stack = [root], lastRow: CGRect?, bar: CGRect?
      while let next = stack.popLast() {
        if next.label.contains(titles[8]), !next.frame.isEmpty { lastRow = next.frame }
        if next.elementType == .tabBar { bar = next.frame }
        stack += next.children
      }
      guard let lastRow, let bar else { continue }
      readings += 1
      largest = max(largest, bar.minY - lastRow.maxY)
      if bar.minY - lastRow.maxY > 2 { gaps.append(bar.minY - lastRow.maxY) }
    }
    print("NOTICES BAND RETURN: \(readings) snapshots after the return; largest gap above the tab bar \(largest) pt; over 2 pt: \(gaps)")
    XCTAssertGreaterThan(readings, 0, "No snapshot after the return showed the last row")
    XCTAssertTrue(gaps.isEmpty, "After the return, the list sat past its end in \(gaps.count) of \(readings) snapshots (gaps \(gaps))")
    XCTAssertTrue(waitUntil(3) { !self.band(app).exists }, "The band should have left while Notices was away")
    XCTAssertTrue(waitUntil(5, atTheEnd),
                  "Back after the band left while away, the last row should end at the tab bar (row ends \(last.frame.maxY), tab bar at \(tabBar.frame.minY))")
    keep(app, "07-notices-band-left-while-away")
  }

  // The clear that matters most: a scroll that isn't iOS's inset correction, while the host still settles a return to the
  // end. The band-return-scroll demo sends the list to its top the moment Notices regains focus, with no finger on it,
  // within the host's settling. The host must end its settling at that scroll, not pull it back to the end when the
  // title's unfolding changes the inset. The jump unfolds the title, and iOS adds the inset the title gains to the
  // offset (measured: the offset at -220 with the inset at 168), so the first row comes to rest between the bar
  // and the bar plus the unfolding, and stays there.
  @MainActor
  func testAScrollDuringTheReturnHoldIsNotPulledBack() {
    let app = launch(demo: "band-return-scroll")
    let last = row(app, titles[8])
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    let arrived = Date()
    let openEdge = barEdge(app)
    for _ in 0..<6 { app.swipeUp() }
    let tabBar = app.tabBars.firstMatch
    XCTAssertTrue(waitUntil(5) { !last.frame.isEmpty && abs(tabBar.frame.minY - last.frame.maxY) <= 2 }, "The list should reach its end")
    let unfolding = openEdge - barEdge(app)
    XCTAssertGreaterThan(unfolding, 20, "At the end, the title should be folded (open edge \(openEdge), now \(barEdge(app)))")
    let chats = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chats")).firstMatch
    let notices = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    chats.tap()
    XCTAssertTrue(waitUntil(45) { Date().timeIntervalSince(arrived) > 33 }, "The band's time should pass")
    notices.tap()
    let first = row(app, titles[0])
    // A missing first row counts as not at the top, so a pull back to the end fails these assertions, not a lookup.
    let atTop = { first.exists && first.frame.minY >= self.barEdge(app) - 1 && first.frame.minY <= self.barEdge(app) + unfolding + 1 }
    XCTAssertTrue(waitUntil(3, atTop), "The scroll to top during settling should bring the first row to the bar, or past it by at most the title's unfolding, \(unfolding) (row \(first.exists ? "at \(first.frame.minY)" : "not shown"), bar at \(barEdge(app)))")
    print("NOTICES BAND JUMP: first row at \(first.frame.minY), bar at \(barEdge(app)), unfolding \(unfolding)")
    XCTAssertFalse(waitUntil(1) { !atTop() }, "The list should stay at its top, not be pulled back to its end (row \(first.exists ? "at \(first.frame.minY)" : "not shown"))")
  }

  // In the middle of the list, the band leaves while Notices is away. Back on Notices, the list has moved up once by the
  // band's height, into the space the band left, as it does when the band leaves on screen: the row that
  // was first below the band is the first row at the top, and it never moves twice. At
  // the default text size, the largest default one and AX5.
  @MainActor
  func testReturningMidListAfterTheBandLeftKeepsTheFirstVisibleRow() {
    for (name, extra) in [("default text size", [String]()),
                          ("largest default text size", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]),
                          ("AX5", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])] {
      let app = launch(demo: "band-long", extra)
      defer { app.terminate() }
      XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
      XCTAssertTrue(arrives(app, within: 15), "\(name): the band should arrive")
      let arrived = Date()
      // A held drag, so no momentum carries the list to its end.
      let start = row(app, titles[1]).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -150)), withVelocity: .slow, thenHoldForDuration: 0.5)
      let height = band(app).frame.height
      guard let topName = topTitle(app, below: band(app).frame.maxY) else { return XCTFail("\(name): a row should be first below the band") }
      let top = row(app, topName)
      let before = top.frame.minY, once = before - height
      let tabBar = app.tabBars.firstMatch
      let chats = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chats")).firstMatch
      let notices = tabBar.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
      chats.tap()
      // The demo clears the band 32 s after it arrived; Notices is away meanwhile.
      XCTAssertTrue(waitUntil(45) { Date().timeIntervalSince(arrived) > 33 }, "\(name): the band's time should pass")
      notices.tap()
      XCTAssertTrue(waitUntil(3) { !self.band(app).exists }, "\(name): the band should have left while Notices was away")
      // Every reading for 3 s, each from one snapshot: the row is always there and never goes past one move.
      var lowest = CGFloat.greatestFiniteMagnitude, readings = 0, missing = 0
      let until = Date().addingTimeInterval(3)
      while Date() < until {
        if let shot = try? top.snapshot() { lowest = min(lowest, shot.frame.minY); readings += 1 } else { missing += 1 }
      }
      XCTAssertTrue(readings > 0 && missing == 0, "\(name): \(topName) should be there at every reading (\(readings) found, \(missing) missing)")
      XCTAssertGreaterThanOrEqual(lowest, once - 1, "\(name): \(topName) should move once, by the band's height \(height), never twice (\(before) → lowest \(lowest))")
      XCTAssertTrue(waitUntil(3) { top.exists && abs(top.frame.minY - once) <= 1 },
                    "\(name): back mid-list, \(topName) should have moved up once by the band's height (\(before) → \(top.exists ? "\(top.frame.minY)" : "not shown"), expected \(once))")
      XCTAssertEqual(topTitle(app, below: barEdge(app)), topName, "\(name): \(topName) should be the first row at the top")
      keep(app, "07-notices-band-left-while-away-mid-\(name.replacingOccurrences(of: " ", with: "-"))")
    }
  }

  // The same with a finger resting on the list without moving: the band waits for it to lift too.
  @MainActor
  func testTheBandWaitsWhileAFingerRestsOnTheList() {
    let app = launch(demo: "band-toggle")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    XCTAssertFalse(band(app).exists, "The band should not show yet")
    // Near the row's leading edge, which has no action of its own.
    first.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5)).press(forDuration: 9)
    let released = Date().timeIntervalSince1970 * 1000
    print("NOTICES DRAG RELEASED \(Int(released))")
    XCTAssertTrue(arrives(app, within: 3), "The band should arrive once the finger lifts")
    keep(app, "07-notices-band-after-rest")
  }

  // Under Reduce Motion the rows move at once. The round turns Reduce Motion on in the simulator for this test only;
  // otherwise it's skipped.
  @MainActor
  func testUnderReduceMotionTheRowsMoveAtOnce() throws {
    try XCTSkipUnless(UIAccessibility.isReduceMotionEnabled, "Reduce Motion is off")
    let app = launch(demo: "band-toggle")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    let before = first.frame.minY
    keep(app, "07-notices-band-reduced-before")
    XCTAssertTrue(arrives(app, within: 15), "The band should arrive")
    // The first reading after the band appears: no animation, so the row is already in its place.
    let now = first.frame.minY, height = band(app).frame.height
    keep(app, "07-notices-band-reduced-after")
    XCTAssertEqual(now, before + height, accuracy: 2, "Under Reduce Motion the first row should be in its place as soon as the band shows")
  }

  // At the largest default text size and the largest accessibility size, the band wraps and grows, sits under the
  // bar, and the rows start below its real height.
  @MainActor
  func testAtTheLargestTextSizesTheBandGrowsAndNoRowSitsUnderIt() {
    var app = launch(demo: "band")
    XCTAssertTrue(band(app).waitForExistence(timeout: 20))
    let usual = band(app).frame.height
    for (size, name, growth) in [("UICTContentSizeCategoryXXXL", "largest-default-text", 1.0),
                                 ("UICTContentSizeCategoryAccessibilityXXXL", "largest-text", 1.5)] {
      app.terminate()
      app = launch(demo: "band", ["-UIPreferredContentSizeCategoryName", size])
      let first = row(app, titles[0])
      XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
      XCTAssertGreaterThan(band(app).frame.height, usual * growth, "At \(name) the band should wrap and grow")
      assertUnderTheBar(app, "At \(name)")
      XCTAssertTrue(waitUntil(3) { abs(first.frame.minY - self.band(app).frame.maxY) <= 1 },
                    "At \(name) the first row should start at the band's bottom (row at \(first.frame.minY), band ends \(band(app).frame.maxY))")
      keep(app, "07-notices-band-\(name)")
      print("NOTICES BAND TEXT SIZE: \(name), band \(usual) → \(band(app).frame.height) pt; bar edge \(barEdge(app)); band at \(band(app).frame.minY); first row at \(first.frame.minY)")
    }
  }

  // Folded, the band is at the bar's edge; scrolled back to the list's start, the first row rests right under the band,
  // so no rest state hides it. The list is scrolled by exactly the fold, so the title has just folded. At the default
  // text size, the largest default one and AX5.
  @MainActor
  func testFoldedAtTheStartTheFirstRowIsRightUnderTheBand() {
    for (name, extra) in [("default text size", [String]()),
                          ("largest default text size", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]),
                          ("AX5", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])] {
      // The fold's length: the bar's edge at rest less its edge folded.
      var app = launch(demo: "band", extra)
      XCTAssertTrue(band(app).waitForExistence(timeout: 20))
      guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("\(name): Notices should show its large title") }
      let rest = barEdge(app)
      for _ in 0..<3 { app.swipeUp() }
      XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "\(name): swipes should fold the title")
      let fold = rest - barEdge(app)
      app.terminate()
      // Scrolled by the fold, the title folds. iOS then adds the inset the fold removed to the offset, so the list rests
      // that far past its start, under the band at its floor.
      app = launch(demo: "band-half-fold", extra + ["-dohcBandScroll", "\(fold)"])
      defer { app.terminate() }
      let first = row(app, titles[0])
      XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
      XCTAssertTrue(waitUntil(5) { self.folded(app, from: open) }, "\(name): scrolled by the fold (\(fold) pt), the title should be folded")
      assertUnderTheBar(app, "Folded, \(name)")
      keep(app, "07-notices-band-folded-\(name.replacingOccurrences(of: " ", with: "-"))")
      // No rest state may hide part of the first row where scrolling can't reveal it. A slow drag back past
      // the hidden part, released, must leave the first row whole, right under the band, however the title then rests.
      let hidden = max(0, band(app).frame.maxY - first.frame.minY)
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
      start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: hidden + 30)), withVelocity: .slow, thenHoldForDuration: 0)
      let (settled, highest) = restingRightUnderTheBand(app, within: 5)
      XCTAssertNotNil(settled, "\(name), folded at the start: scrolled back, the first row should rest right under the band (row at \(first.frame.minY), band ends \(band(app).frame.maxY), \(hidden) pt was hidden, bar edge \(barEdge(app)))")
      XCTAssertGreaterThanOrEqual(highest, rest - fold - 1, "\(name): while it settled, the band should never go above the folded bar (highest \(highest), folded edge \(rest - fold))")
      keep(app, "07-notices-band-folded-\(name.replacingOccurrences(of: " ", with: "-"))-revealed")
    }
  }

  // At AX5, Notices opened for the first time from the tab bar with a problem already
  // active. Notices is built off screen, so the band shows uncapped and shrinks once when the host reports the space.
  // Records the band's height and the first row's top from the first snapshot on, frames before and after, and
  // requires the move to be one shrink with the row never under the band.
  @MainActor
  func testAtAX5OpeningNoticesFirstShrinksTheBandOnce() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "", "-dohcDemo", "band", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    app.launch()
    let tab = app.tabBars.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 20))
    tab.tap()
    var readings: [(box: CGRect, row: CGRect)] = []
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline { if let now = boxAndFirstRow(app) { readings.append(now); if readings.count == 1 { keep(app, "07-notices-band-ax5-first-visit-before") } } }
    keep(app, "07-notices-band-ax5-first-visit-after")
    print("NOTICES BAND AX5 FIRST VISIT: " + readings.map { "band \($0.box.height), row \($0.row.minY)" }.joined(separator: "; "))
    guard let first = readings.first, let last = readings.last else { return XCTFail("No snapshot showed the band and the first row") }
    print("NOTICES BAND AX5 FIRST VISIT: band \(first.box.height) → \(last.box.height); first row \(first.row.minY) → \(last.row.minY), moved \(first.row.minY - last.row.minY) pt")
    XCTAssertTrue(readings.allSatisfy { $0.row.minY >= $0.box.maxY - 1 }, "The first row should never be under the band while it shrinks")
    let heights = readings.map(\.box.height)
    let shrinks = zip(heights, heights.dropFirst()).filter { abs($0 - $1) > 0.5 }
    XCTAssertLessThanOrEqual(shrinks.count, 1, "The band's height should change at most once: \(heights)")
  }

  // The same first visit with VoiceOver on: the shrink doesn't move VoiceOver's focus, and nothing is announced, since
  // the band was there when Notices opened. The round reads band-announcements.json for the announcement.
  @MainActor
  func testAtAX5TheShrinkKeepsVoiceOverWhereItIs() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "", "-dohcDemo", "band", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    app.launch()
    let tab = app.tabBars.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notices")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 20))
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    // With VoiceOver on, a tap only selects; a double tap opens the tab.
    tab.doubleTap()
    XCTAssertTrue(band(app).waitForExistence(timeout: 5), "The band should show on the first visit")
    let focusedFirst = try await voiceOver.currentSpeech().utterance
    let heightFirst = band(app).frame.height
    // Settled once the band is within its cap, half the space between the bar's resting edge and the tab bar.
    let cap = (app.tabBars.firstMatch.frame.minY - barEdge(app)) / 2
    XCTAssertTrue(waitUntil(5) { self.band(app).frame.height <= cap + 1 }, "The band should settle within its cap, \(cap) pt (now \(band(app).frame.height))")
    // Focus is read by moving away and back: if the shrink had moved it, coming back lands elsewhere. Current speech alone
    // can report an announcement instead of the focused element.
    _ = try await voiceOver.moveForward()
    let focusedAfter = try await voiceOver.moveBackward().utterance
    print("VOICEOVER AX5 FIRST VISIT: band \(heightFirst) → \(band(app).frame.height); focus \(focusedFirst) → \(focusedAfter)")
    XCTAssertEqual(focusedAfter, focusedFirst, "The band's shrink shouldn't move VoiceOver's focus")
  }

  // At AX5 the band is at most half the space between the bar's resting edge and the tab bar. What doesn't fit
  // scrolls inside the band, so a row still shows above the tab bar, and Try again stays reachable by scrolling and by
  // VoiceOver.
  @MainActor
  func testAtTheLargestTextSizeTheBandIsCappedAndScrolls() async throws {
    let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    var app = launch(demo: "band", ax5)
    var first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
    let tabBar = app.tabBars.firstMatch
    let cap = (tabBar.frame.minY - barEdge(app)) / 2
    // The words scroll in a region of whole lines, and Try again stays below them, always in view.
    let words = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Server unreachable.")).firstMatch
    let tryAgain = app.buttons["Try again"]
    XCTAssertTrue(words.waitForExistence(timeout: 5), "The band's words should be one element")
    let box = band(app).frame
    print("NOTICES BAND CAP: space \(cap * 2), cap \(cap), band \(box.height), words \(words.frame)")
    XCTAssertGreaterThan(words.frame.height, box.height, "At AX5 the band's words should be taller than the band, or this test checks nothing")
    XCTAssertLessThanOrEqual(box.height, cap + 1, "At AX5 the band should be no taller than half the space between the bar and the tab bar")
    assertUnderTheBar(app, "Capped at AX5")
    assertRightUnderTheBand(app, first, "Capped at AX5")
    XCTAssertLessThanOrEqual(first.frame.minY + 44, tabBar.frame.minY, "At AX5 a row should show above the tab bar")
    XCTAssertTrue(tryAgain.isHittable && box.contains(tryAgain.frame.insetBy(dx: 1, dy: 1)), "At rest, Try again should be in the band and tappable (Try again at \(tryAgain.frame), band \(box))")
    keep(app, "07-notices-band-capped")
    // The region's identifier carries its line height. Every rest, from the start to the end, is on a line, so no line
    // is cut at rest, and the last rest shows the words' last line at the region's bottom.
    let region = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "sync-band-words:")).firstMatch
    XCTAssertTrue(region.waitForExistence(timeout: 5), "Capped, the band should draw its words in a region")
    let line = CGFloat(Double(region.identifier.split(separator: ":").last ?? "") ?? 0)
    XCTAssertGreaterThan(line, 0, "The region should give its line height (\(region.identifier))")
    let area = region.frame
    func onALine(_ length: CGFloat) -> Bool { abs(length - (length / line).rounded() * line) <= 0.5 }
    XCTAssertTrue(onALine(area.height), "The region should be a whole number of lines (\(area.height) at \(line) a line)")
    // A rest: the words stay within 0.5 pt of one reading for 0.5 s, measured from that reading, as
    // restingRightUnderTheBand reads one, so a pause mid-scroll or a slow drift can't pass as rest.
    func restingWordsTop(within timeout: TimeInterval) -> CGFloat? {
      let deadline = Date().addingTimeInterval(timeout)
      var base = words.frame.minY, since = Date()
      while Date() < deadline {
        let now = words.frame.minY
        if abs(now - base) > 0.5 { base = now; since = Date() } else if Date().timeIntervalSince(since) >= 0.5 { return base }
      }
      return nil
    }
    guard let startTop = restingWordsTop(within: 4) else { return XCTFail("At AX5 the band's words should be at rest after launch") }
    XCTAssertEqual(startTop, area.minY, accuracy: 0.5, "At rest the words should start at the region's top")
    let wordsTop = startTop, tryAgainAt = tryAgain.frame
    var rests: [CGFloat] = [], restedTop = startTop
    for _ in 0..<12 {
      // On the words' region: only the words scroll, and a swipe that starts on Try again or the band's edge begins no
      // drag there.
      region.swipeUp(velocity: .slow)
      guard let top = restingWordsTop(within: 4) else { XCTFail("After a swipe the band's words should come to rest (now \(words.frame.minY))"); break }
      let offset = area.minY - top
      rests.append(offset)
      XCTAssertTrue(onALine(offset), "Each rest should be on a line (offset \(offset) at \(line) a line)")
      if abs(top - restedTop) < 0.5 { break }
      restedTop = top
    }
    print("NOTICES BAND CAP RESTS: line \(line), region \(area.height), rests \(rests)")
    XCTAssertTrue(waitUntil(3) { words.frame.minY < wordsTop - 1 }, "Swiping the band should scroll its words (from \(wordsTop), now \(words.frame.minY))")
    XCTAssertEqual(restedTop + words.frame.height, area.maxY, accuracy: 0.5, "Swiped to the end, the words' last line should rest at the region's bottom (words \(words.frame), region \(area))")
    XCTAssertEqual(tryAgain.frame.minY, tryAgainAt.minY, accuracy: 1, "Try again should stay where it is while the words scroll")
    XCTAssertEqual(band(app).frame.minY, box.minY, accuracy: 1, "Scrolling inside the band shouldn't move the band")
    XCTAssertEqual(first.frame.minY, box.maxY, accuracy: 1, "Scrolling inside the band shouldn't move the list")
    keep(app, "07-notices-band-capped-scrolled")

    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    app.terminate()
    app = launch(demo: "band", ax5)
    first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    var spoken: [String] = [try await voiceOver.currentSpeech().utterance]
    for _ in 0..<30 where !(spoken.last ?? "").contains("Try again") && !(spoken.last ?? "").contains(titles[0]) {
      spoken.append(try await voiceOver.moveForward().utterance)
    }
    print("VOICEOVER CAPPED BAND:\n" + spoken.joined(separator: "\n"))
    XCTAssertTrue((spoken.last ?? "").contains("Try again"), "VoiceOver should reach Try again before the rows")
    // The words whole and once, never only the lines in view: one reading has the title and the body's last sentence.
    let readings = spoken.filter { $0.contains("Server unreachable") || $0.contains("read-only until then") }
    XCTAssertEqual(readings.count, 1, "VoiceOver should read the band's words in one element, once (read \(readings))")
    XCTAssertTrue(readings.first.map { $0.contains("Server unreachable") && $0.contains("read-only until then") } ?? false,
                  "VoiceOver should read the band's words whole")
    XCTAssertTrue(band(app).frame.contains(app.buttons["Try again"].frame.insetBy(dx: 1, dy: 1)), "Try again should stay in the band under VoiceOver")
    keep(app, "07-notices-band-capped-voiceover")
  }

  // With nothing wrong and no notices, the empty list says All clear. Under a problem band it says "No other notices."
  // instead, without the all-clear check, and sits below the band, moved down by exactly the band's
  // height: the band's space adds no gap of its own.
  @MainActor
  func testWithTheBandAndNoNoticesTheEmptyListMovesDownByTheBandOnly() {
    var app = launch(demo: "empty")
    XCTAssertTrue(app.staticTexts["All clear"].firstMatch.waitForExistence(timeout: 20), "With nothing wrong, the empty list should say All clear")
    var empty = app.descendants(matching: .any)["notices-empty"]
    XCTAssertTrue(empty.waitForExistence(timeout: 5), "The empty list should show")
    let plain = empty.frame.minY
    guard let open = barTitles(app).max(by: { $0.height < $1.height }) else { return XCTFail("Notices should show its large title") }
    app.terminate()
    app = launch(demo: "band-empty")
    XCTAssertTrue(app.staticTexts["No other notices."].firstMatch.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5),
                  "Under a problem band, the empty list should say No other notices.")
    XCTAssertFalse(app.staticTexts["All clear"].exists, "Under a problem band, the empty list shouldn't say All clear")
    empty = app.descendants(matching: .any)["notices-empty"]
    assertUnderTheBar(app, "With no notices")
    let height = band(app).frame.height
    XCTAssertTrue(empty.frame.minY >= band(app).frame.maxY - 1, "The empty list should be below the band")
    XCTAssertEqual(empty.frame.minY - plain, height, accuracy: 2,
                   "The empty list should move down by exactly the band's height (\(plain) → \(empty.frame.minY), band \(height))")
    let title = barTitles(app).max(by: { $0.height < $1.height })
    XCTAssertEqual(title?.height ?? 0, open.height, accuracy: 1, "With no notices, the large title should be fully open, as without the band")
    XCTAssertEqual(title?.minY ?? 0, open.minY, accuracy: 1, "With no notices, the large title should stay where it is without the band")
    keep(app, "07-notices-band-empty")
  }

  // A row VoiceOver moves to is scrolled into view by iOS. It must land below the band, never under it. The test picks
  // a row the band covers, moves VoiceOver to it, and checks every row it passes on the way.
  @MainActor
  func testARowVoiceOverMovesToIsNeverUnderTheBand() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = launch(demo: "band-scrolled")
    XCTAssertTrue(band(app).waitForExistence(timeout: 20))
    XCTAssertTrue(waitUntil(5) { self.row(app, self.titles[0]).frame.maxY < self.band(app).frame.minY }, "The demo should scroll the first rows away")
    let cover = band(app).frame
    let target = try XCTUnwrap(titles.first { let r = row(app, $0).frame; return r.minY < cover.maxY - 1 && r.maxY > cover.minY },
                               "The demo should leave a row under the band")
    let targetBefore = row(app, target).frame.minY
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    var under: [String] = [], visited: [String] = []
    var utterance = try await voiceOver.currentSpeech().utterance
    for _ in 0..<30 {
      if let title = titles.first(where: { utterance.contains($0) }) {
        let focused = row(app, title)
        // iOS scrolls the focused row into view; wait for it to land below the band.
        let below = waitUntil(2) { focused.frame.minY >= self.band(app).frame.maxY - 1 }
        visited.append("\(title) at \(focused.frame.minY)")
        if !below { under.append("\(title) at \(focused.frame.minY), band ends \(band(app).frame.maxY)") }
        if title == target { break }
      }
      utterance = try await voiceOver.moveForward().utterance
    }
    print("VOICEOVER FOCUS (target \(target), under the band at \(targetBefore) before):\n" + visited.joined(separator: "\n"))
    XCTAssertTrue(visited.contains { $0.hasPrefix(target) }, "VoiceOver should reach the row the band covered, \(target)")
    XCTAssertTrue(under.isEmpty, "Rows VoiceOver moved to sat under the band:\n" + under.joined(separator: "\n"))
    // VoiceOver's scroll is one jump, not a drag: the band must still end up at the bar's edge, not behind the bar.
    assertUnderTheBar(app, "After VoiceOver's scroll")
  }

  // A tap on the status bar scrolls the list to its top, which brings the first row back directly below the band.
  @MainActor
  func testScrollToTopBringsTheFirstRowBackBelowTheBand() {
    let app = launch(demo: "band")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).exists)
    for _ in 0..<3 { app.swipeUp() }
    XCTAssertTrue(waitUntil(5) { first.frame.maxY < self.band(app).frame.minY }, "Swipes should scroll the first row away")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    XCTAssertTrue(waitUntil(3) { abs(first.frame.minY - self.band(app).frame.maxY) <= 1 },
                  "After scroll to top, the first row should start at the band's bottom (row at \(first.frame.minY), band ends \(band(app).frame.maxY))")
    assertUnderTheBar(app, "After scroll to top")
    keep(app, "07-notices-band-scrolled-to-top")
  }

  // The problem changes while the band shows, to one with other words and no Try again. The band keeps its box until
  // the new height is measured, then the band and the rows change together: the rows move once, and the band never
  // draws over the first row.
  @MainActor
  func testChangingTheProblemMovesTheRowsOnce() throws {
    let app = launch(demo: "band-problem-change")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
    let before = try XCTUnwrap(boxAndFirstRow(app), "The band and the first row should be readable before the change")
    XCTAssertTrue(app.staticTexts["Server unreachable"].firstMatch.exists, "The first problem should still show before the change")
    keep(app, "07-notices-band-problem-before")
    let next = app.staticTexts["Update dohc to sync"].firstMatch
    assertOneMoveAndNothingDrawnOverTheRow(app, "Changing the problem", from: before, timeout: 20) { next.exists }
    assertUnderTheBar(app, "After the problem changed")
    assertRightUnderTheBand(app, first, "After the problem changed")
    keep(app, "07-notices-band-problem-after")
  }

  // Text Size goes from the default to the largest accessibility size while the band shows. The round script makes the
  // change when this test prints that it's ready, so the test runs only when the script sets DOHC_TEXT_SIZE_CHANGE.
  @MainActor
  func testChangingTextSizeWhileTheBandShowsMovesTheRowsOnce() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DOHC_TEXT_SIZE_CHANGE"] == "1", "Runs when the round script changes Text Size")
    let app = launch(demo: "band")
    let first = row(app, titles[0])
    XCTAssertTrue(first.waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
    let usual = band(app).frame.height
    let before = try XCTUnwrap(boxAndFirstRow(app), "The band and the first row should be readable before the change")
    keep(app, "07-notices-band-text-size-before")
    print("NOTICES TEXT SIZE READY")
    assertOneMoveAndNothingDrawnOverTheRow(app, "Changing Text Size", from: before, timeout: 60) { self.band(app).frame.height > usual * 1.5 }
    // The host re-reads the space after the change: the band is capped by half the space at the new size, not the old.
    let cap = (app.tabBars.firstMatch.frame.minY - barEdge(app)) / 2
    XCTAssertTrue(waitUntil(3) { self.band(app).frame.height <= cap + 1 },
                  "After Text Size changed, the band should be within half the new space, \(cap) pt (band \(band(app).frame.height))")
    assertUnderTheBar(app, "After Text Size changed")
    assertRightUnderTheBand(app, first, "After Text Size changed")
    keep(app, "07-notices-band-text-size-after")
  }

  // With no band, VoiceOver reads as it did before the reading-order container: the title, then the rows. The frame is
  // kept to compare the screen with and without the container.
  @MainActor
  func testWithNoBandVoiceOverReadsTheTitleThenTheRows() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", ""]
    app.launch()
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertFalse(band(app).exists, "No band should show")
    keep(app, "07-notices-band-none")
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    var spoken: [String] = [try await voiceOver.currentSpeech().utterance]
    for _ in 0..<30 {
      let utterance = try await voiceOver.moveForward().utterance
      spoken.append(utterance)
      if utterance.contains(titles[1]) { break }
    }
    print("VOICEOVER NO BAND:\n" + spoken.joined(separator: "\n"))
    let first = try XCTUnwrap(spoken.firstIndex { $0.contains(titles[0]) }, "VoiceOver never reached the first row")
    guard first + 1 < spoken.count else { return XCTFail("VoiceOver stopped after the first row") }
    XCTAssertTrue(spoken[first + 1].contains(titles[1]), "With no band, the second row should follow the first; VoiceOver spoke: \(spoken[first + 1])")
    if let title = spoken.firstIndex(where: { $0.contains("Notices Heading") }) {
      XCTAssertLessThan(title, first, "VoiceOver should read the title before the rows")
    }
  }

  // The band arrives while VoiceOver is on. VoiceOver must pick up the new order, not keep the one it had: from the
  // title, the band comes before the rows. The order before and after the arrival is printed for the report. The band
  // arrives a minute in, after VoiceOver's reading of the screen without it.
  @MainActor
  func testVoiceOverPicksUpTheBandWhenItArrives() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = launch(demo: "band-late")
    XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20))
    XCTAssertFalse(band(app).exists, "The band should not show yet")
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    /// From wherever VoiceOver is, back to the bar's title (or the start), then forward until the first row.
    func readFromTheTop() async throws -> [String] {
      for _ in 0..<15 {
        let here = try await voiceOver.currentSpeech().utterance
        if here.contains("Notices Heading") { break }
        _ = try await voiceOver.moveBackward()
      }
      var spoken: [String] = [try await voiceOver.currentSpeech().utterance]
      for _ in 0..<10 {
        let utterance = try await voiceOver.moveForward().utterance
        spoken.append(utterance)
        if utterance.contains(titles[0]) { break }
      }
      return spoken
    }
    let before = try await readFromTheTop()
    print("VOICEOVER BEFORE THE BAND:\n" + before.joined(separator: "\n"))
    // Reading from the top ends on the first row, where VoiceOver stays while the band arrives.
    let focusedBefore = try await voiceOver.currentSpeech().utterance
    XCTAssertTrue(arrives(app, within: 70), "The band should arrive")
    // Focus is read by its neighbour: from the first row, the next stop is the second row. Current speech alone can
    // report the arrival announcement instead of the focused element.
    let nextAfter = try await voiceOver.moveForward().utterance
    print("VOICEOVER FOCUS: before the band \(focusedBefore); next stop after it \(nextAfter)")
    XCTAssertTrue(focusedBefore.contains(titles[0]), "Before the band, VoiceOver should rest on the first row: \(focusedBefore)")
    XCTAssertTrue(nextAfter.contains(titles[1]), "The band arriving shouldn't move VoiceOver's focus off the first row; the next stop was: \(nextAfter)")
    /// Reads from the top until `done` holds or 10 s pass: VoiceOver takes a moment to act on a layout change, as it
    /// would for a person swiping on.
    func readUntil(_ done: ([String]) -> Bool) async throws -> [String] {
      let deadline = Date().addingTimeInterval(10)
      var spoken = try await readFromTheTop()
      while !done(spoken), Date() < deadline { spoken = try await readFromTheTop() }
      return spoken
    }
    let after = try await readUntil { $0.contains { $0.contains("Server unreachable") } }
    print("VOICEOVER AFTER THE BAND:\n" + after.joined(separator: "\n"))
    let theBand = try XCTUnwrap(after.firstIndex { $0.contains("Server unreachable") }, "With VoiceOver on, it should read the band once it arrives")
    let firstRow = try XCTUnwrap(after.firstIndex { $0.contains(titles[0]) }, "VoiceOver should reach the first row")
    XCTAssertLessThan(theBand, firstRow, "VoiceOver should read the band before the rows after it arrives")
    // The band leaves again, still with VoiceOver on: the order drops back to the title, then the rows.
    XCTAssertTrue(waitUntil(90) { !self.band(app).exists }, "The band should leave")
    let gone = try await readUntil { !$0.contains { $0.contains("Server unreachable") } }
    print("VOICEOVER AFTER THE BAND LEFT:\n" + gone.joined(separator: "\n"))
    XCTAssertFalse(gone.contains { $0.contains("Server unreachable") }, "Once the band leaves, VoiceOver shouldn't read it")
    let heading = try XCTUnwrap(gone.firstIndex { $0.contains("Notices Heading") }, "VoiceOver should read the title once the band leaves")
    let row = try XCTUnwrap(gone.firstIndex { $0.contains(titles[0]) }, "VoiceOver should still reach the first row")
    XCTAssertLessThan(heading, row, "Once the band leaves, VoiceOver should read the title, then the rows")
  }

  // VoiceOver reads the bar's title, then the band, then the rows.
  @MainActor
  func testVoiceOverReadsTheTitleThenTheBandThenTheRows() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    for (name, extra) in [("default text size", [String]()),
                          ("AX5", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])] {
      let app = launch(demo: "band", extra)
      XCTAssertTrue(row(app, titles[0]).waitForExistence(timeout: 20) && band(app).waitForExistence(timeout: 5))
      let voiceOver = XCUIDevice.shared.voiceOverService
      try voiceOver.enable()
      // Where VoiceOver starts counts too, so the title isn't lost if it starts there.
      var spoken: [String] = [try await voiceOver.currentSpeech().utterance]
      for _ in 0..<30 {
        let utterance = try await voiceOver.moveForward().utterance
        spoken.append(utterance)
        if utterance.contains(titles[0]) { break }
      }
      try voiceOver.disable()
      print("VOICEOVER BAND, \(name):\n" + spoken.joined(separator: "\n"))
      let theBand = spoken.firstIndex { $0.contains("Server unreachable") }
      let firstRow = spoken.firstIndex { $0.contains(titles[0]) }
      XCTAssertNotNil(theBand, "\(name): VoiceOver never spoke the band before the first row; it read:\n" + spoken.joined(separator: "\n"))
      XCTAssertNotNil(firstRow, "\(name): VoiceOver never reached the first row")
      if let theBand, let firstRow { XCTAssertLessThan(theBand, firstRow, "\(name): VoiceOver should read the band before the rows") }
      // The bar's title, not the tab of the same name. VoiceOver may start past it, so it's checked when spoken.
      if let title = spoken.firstIndex(where: { $0.contains("Notices Heading") }), let theBand {
        XCTAssertLessThan(title, theBand, "\(name): VoiceOver should read the title before the band")
      } else {
        print("VOICEOVER BAND, \(name): the title wasn't among the stops")
      }
      app.terminate()
    }
  }
}
