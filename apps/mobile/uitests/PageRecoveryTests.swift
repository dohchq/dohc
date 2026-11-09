import XCTest

// If iOS clears the cache while the app runs, or a page's fonts can't load, a page that can no longer open says so and
// offers Try again, and Try again opens it. The demos delete the editor's files after the first paint, or its font files
// before the first open.
final class PageRecoveryTests: XCTestCase {
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }

  @MainActor
  func testTryAgainOpensThePageAfterTheCacheIsCleared() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page", "-dohcDemo", "page-cache-cleared"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Couldn't open this file."].waitForExistence(timeout: 30),
                  "With the editor files gone, the page should say it couldn't open")
    keep(app, "04-cache-cleared-failed")
    app.buttons["Try again"].firstMatch.tap()
    // The loading state while the files are written again; it may already be gone, since the write takes milliseconds.
    keep(app, "04-cache-cleared-retrying")
    XCTAssertTrue(app.webViews.firstMatch.staticTexts["Packing list"].waitForExistence(timeout: 20), "Try again should open the page")
    keep(app, "04-cache-cleared-recovered")
  }

  // The page's Inter files gone when it opens: the page never draws in another font. It says it couldn't open, and Try
  // again writes the files again and opens it.
  @MainActor
  func testAPageWhoseFontsCantLoadSaysItCouldntOpen() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page", "-dohcDemo", "page-fonts-missing"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Couldn't open this file."].waitForExistence(timeout: 30),
                  "With its font files gone, the page should say it couldn't open")
    XCTAssertFalse(app.webViews.firstMatch.staticTexts["Packing list"].exists, "Without its fonts the page shouldn't draw")
    keep(app, "04-fonts-missing-failed")
    app.buttons["Try again"].firstMatch.tap()
    XCTAssertTrue(app.webViews.firstMatch.staticTexts["Packing list"].waitForExistence(timeout: 20), "Try again should open the page")
    keep(app, "04-fonts-missing-recovered")
  }
}
