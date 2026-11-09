import XCTest

// Sharing with the sync band, drawn as on Notices (the DL's round 3 item 9): it sits directly under the bar, open or
// folded, and the first lane starts below it, at any text size. When it arrives on an open screen, the lanes move down
// once by its height. Frames are kept for review.
final class SharingBandTests: XCTestCase {
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func launch(demo: String, _ more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "sharing", "-dohcDemo", demo] + more
    app.launch()
    return app
  }

  private func band(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["sync-band-area"] }
  /// The first lane's heading, "Shared by me, 3".
  private func lane(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Shared by me")).firstMatch
  }
  private func barEdge(_ app: XCUIApplication) -> CGFloat { app.navigationBars.firstMatch.frame.maxY }
  private func waitUntil(_ timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return condition()
  }

  /// The band starts at the bar's edge, within 1 pt, and the first lane's heading starts at or below the band's bottom.
  private func assertPlaced(_ app: XCUIApplication, _ state: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(waitUntil(5) { abs(self.band(app).frame.minY - self.barEdge(app)) <= 1 },
                  "\(state): the band should start at the bar's edge (band at \(band(app).frame.minY), bar edge \(barEdge(app)))",
                  file: file, line: line)
    let heading = lane(app).frame.minY, bottom = band(app).frame.maxY
    XCTAssertTrue(heading >= bottom - 1 && heading <= bottom + 16,
                  "\(state): the first lane should start just below the band (heading at \(heading), band ends \(bottom))",
                  file: file, line: line)
    print("SHARING BAND \(state): bar edge \(barEdge(app)); band \(band(app).frame.minY)–\(bottom); first lane at \(heading)")
  }

  @MainActor
  func testTheBandSitsUnderTheBarAndStaysThereWhileTheLanesScroll() {
    let app = launch(demo: "band")
    XCTAssertTrue(band(app).waitForExistence(timeout: 20) && lane(app).waitForExistence(timeout: 5), "Sharing should show the band")
    assertPlaced(app, "At rest")
    keep(app, "09-sharing-band")
    // Up by a little more than the title's fold, held so it doesn't carry on: the band stays at the folded bar.
    let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -160)), withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertTrue(waitUntil(5) { abs(self.band(app).frame.minY - self.barEdge(app)) <= 1 },
                  "Scrolled: the band should stay at the bar's edge (band at \(band(app).frame.minY), bar edge \(barEdge(app)))")
    keep(app, "09-sharing-band-scrolled")
    // Back to the top: the first lane rests below the band again.
    let back = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
    back.press(forDuration: 0.05, thenDragTo: back.withOffset(CGVector(dx: 0, dy: 400)), withVelocity: .slow, thenHoldForDuration: 0.3)
    assertPlaced(app, "Back at the top")
  }

  @MainActor
  func testTheBandArrivingMovesTheLanesDownOnceByItsHeight() {
    // Where the first lane rests with no band, from a launch without one, so the reading doesn't race the arrival.
    var app = launch(demo: "none")
    XCTAssertTrue(lane(app).waitForExistence(timeout: 20), "Sharing should show its lanes")
    XCTAssertFalse(band(app).exists, "Without a problem there should be no band")
    let before = lane(app).frame.minY
    app.terminate()
    // band-toggle shows the band 8 s after the screen mounts and clears it 16 s after.
    app = launch(demo: "band-toggle")
    XCTAssertTrue(band(app).waitForExistence(timeout: 30), "The band should arrive")
    XCTAssertTrue(waitUntil(3) { abs(self.lane(app).frame.minY - (before + self.band(app).frame.height)) <= 1 },
                  "The first lane should move down by the band's height (was \(before), now \(lane(app).frame.minY), band \(band(app).frame.height))")
    assertPlaced(app, "Arrived")
    print("SHARING BAND ARRIVAL: lane \(before) → \(lane(app).frame.minY); band \(band(app).frame.height) pt")
  }

  @MainActor
  func testAtTheLargestTextSizesTheBandStaysUnderTheBarAndALaneShows() {
    for (size, name) in [("UICTContentSizeCategoryXXXL", "largest-default-text"), ("UICTContentSizeCategoryAccessibilityXXXL", "largest-text")] {
      let app = launch(demo: "band", ["-UIPreferredContentSizeCategoryName", size])
      XCTAssertTrue(band(app).waitForExistence(timeout: 20) && lane(app).waitForExistence(timeout: 5), "At \(name) Sharing should show the band")
      assertPlaced(app, "At \(name)")
      // The band is capped at half the space between the bar's resting edge and the tab bar.
      let half = (app.tabBars.firstMatch.frame.minY - barEdge(app)) / 2
      XCTAssertLessThanOrEqual(band(app).frame.height, half + 1,
                               "At \(name) the band should be at most half the space (band \(band(app).frame.height), half \(half))")
      // So the first lane's heading shows above the tab bar.
      XCTAssertLessThan(lane(app).frame.maxY, app.tabBars.firstMatch.frame.minY,
                        "At \(name) the first lane's heading should show above the tab bar")
      keep(app, "09-sharing-band-\(name)")
      app.terminate()
    }
  }
}
