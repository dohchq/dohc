import XCTest

// Frame times of a Notices drag, measured by XCTest's scroll metric from outside the app, so a build with no probe of
// its own can be measured the same way. The round runs the baseline (app.dohc.mobile.base) and the head in turn.
final class NoticesFrameTests: XCTestCase {
  @MainActor
  private func measureDrags(_ bundle: String, demo: String = "") {
    let app = XCUIApplication(bundleIdentifier: bundle)
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", demo]
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Maya Chen mentioned you in #planning"))
      .firstMatch.waitForExistence(timeout: 20), "Notices should list its rows")
    if !demo.isEmpty {
      let band = app.descendants(matching: .any)["sync-band-area"]
      XCTAssertTrue(band.waitForExistence(timeout: 10) && band.frame.height > 0, "The band should show before its drags are measured")
    }
    let options = XCTMeasureOptions()
    options.iterationCount = 5
    measure(metrics: [XCTOSSignpostMetric.scrollDraggingMetric], options: options) {
      app.swipeUp(velocity: .fast)
      app.swipeDown(velocity: .fast)
    }
  }

  @MainActor
  func testDragFramesOnTheBaseline() { measureDrags("app.dohc.mobile.base") }

  @MainActor
  func testDragFramesOnTheHead() { measureDrags("app.dohc.mobile") }

  // The same drags with the sync band showing, through the title's fold: the band rides on the list each frame, and
  // a script compares this test's dropped frames with the one above.
  @MainActor
  func testDragFramesOnTheHeadWithTheBand() { measureDrags("app.dohc.mobile", demo: "band") }

  // A memory check: a minute of drags through the fold, with the band and without it. A script reads the
  // app's memory footprint at each mark; it runs only when the script asks, so the suite stays short.
  @MainActor
  private func scrollForAMinute(demo: String) throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DOHC_LONG_SCROLL"] == "1", "Runs when the round script reads memory")
    let app = XCUIApplication(bundleIdentifier: "app.dohc.mobile")
    app.launchArguments += ["-dohcTestRoute", "notices", "-dohcDemo", demo]
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Maya Chen mentioned you in #planning"))
      .firstMatch.waitForExistence(timeout: 20), "Notices should list its rows")
    if !demo.isEmpty { XCTAssertTrue(app.descendants(matching: .any)["sync-band-area"].waitForExistence(timeout: 10), "The band should show") }
    // Measurement protocol, not a pass condition: a script reads the footprint at each mark, then the drags go on.
    print("NOTICES LONG SCROLL BEFORE \(demo)")
    Thread.sleep(forTimeInterval: 3)
    let end = Date().addingTimeInterval(60)
    while Date() < end { app.swipeUp(velocity: .fast); app.swipeDown(velocity: .fast) }
    print("NOTICES LONG SCROLL AFTER \(demo)")
    Thread.sleep(forTimeInterval: 3)
  }

  @MainActor
  func testAMinuteOfScrollingWithoutTheBand() throws { try scrollForAMinute(demo: "") }

  @MainActor
  func testAMinuteOfScrollingWithTheBand() throws { try scrollForAMinute(demo: "band") }
}
