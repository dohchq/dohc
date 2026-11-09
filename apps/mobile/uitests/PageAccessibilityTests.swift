import XCTest

// VoiceOver on a page: the header first, then the page in reading order (icon, title, properties, body).
final class PageAccessibilityTests: XCTestCase {
  @MainActor
  func testVoiceOverReadsThePageInOrder() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "page"]
    app.launch()
    XCTAssertTrue(app.webViews.firstMatch.staticTexts["Packing list"].waitForExistence(timeout: 20))
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    var spoken: [String] = []
    for _ in 0..<16 {
      let utterance = try await voiceOver.moveForward().utterance
      spoken.append(utterance)
      if utterance.contains("Pack light") { break }
    }
    print("VOICEOVER PAGE:\n" + spoken.joined(separator: "\n"))
    let title = try XCTUnwrap(spoken.firstIndex { $0.contains("Packing list") }, "VoiceOver never spoke the title")
    let body = try XCTUnwrap(spoken.firstIndex { $0.contains("Pack light") }, "VoiceOver never reached the body")
    XCTAssertLessThan(title, body, "The title comes before the body")
  }
}
