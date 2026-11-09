import XCTest

// When the editor files can't be written for lack of space, the page says so under "Couldn't open this file." and
// keeps Try again, which helps once space is freed. The demo fails the first write with the system's message.
final class PageStorageTests: XCTestCase {
  @MainActor
  func testOutOfSpaceSaysSoAndKeepsTryAgain() {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page", "-dohcDemo", "page-no-space"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Couldn't open this file."].waitForExistence(timeout: 30), "The page should say it couldn't open")
    XCTAssertTrue(app.staticTexts["Not enough storage. Free up space, then try again."].exists, "The page should say storage is full")
    XCTAssertTrue(app.buttons["Try again"].exists, "Try again should stay")
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "04-no-space-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
