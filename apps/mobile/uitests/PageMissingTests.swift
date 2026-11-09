import XCTest

// A page that's gone says so and offers no Try again, since trying again can't bring it back.
final class PageMissingTests: XCTestCase {
  @MainActor
  func testAMissingPageOffersNoTryAgain() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page-missing"]
    app.launch()
    XCTAssertTrue(app.staticTexts["This file is no longer available at this path."].waitForExistence(timeout: 20),
                  "A missing page should say it's no longer available")
    XCTAssertFalse(app.buttons["Try again"].exists, "A missing page should offer no Try again")
  }
}
