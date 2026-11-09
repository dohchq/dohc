import XCTest

// Each Notices row is one VoiceOver element: one label, its actions in the rotor, and no tap of its own.
// A later change that splits a row into separate elements fails here.
final class NoticesAccessibilityTests: XCTestCase {
  private let maya = "Unread, From a person, Maya Chen mentioned you in #planning, Can you check the train times for the 15th?, 2 minutes ago"
  private let nova = "Unread, From an agent, Nova finished updating the itinerary app, Added the Porto day trip with the 8:09 out and 19:52 back., 6 minutes ago"

  @MainActor
  private func launchNotices() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-dohcTestRoute", "notices"]
    app.launch()
    return app
  }

  @MainActor
  func testRowIsOneElementWithItsActions() {
    let app = launchNotices()
    let rows = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", maya))
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 20))
    XCTAssertEqual(rows.count, 1)
    // The row's own texts, pill and controls are inside the one element, not beside it.
    XCTAssertFalse(app.staticTexts["Maya Chen mentioned you in #planning"].exists)
    XCTAssertFalse(app.buttons["Open"].exists)
    XCTAssertFalse(app.buttons["Copy notice details"].exists)
    // A row has no tap of its own, so it isn't a button.
    XCTAssertNotEqual(rows.firstMatch.elementType, .button)
    print("ROW SNAPSHOT:\n\(rows.firstMatch.debugDescription)")
  }

  @MainActor
  func testVoiceOverSpeaksEachRowOnce() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver testing needs iOS 27") }
    let app = launchNotices()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", maya)).firstMatch.waitForExistence(timeout: 20))
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    defer { try? voiceOver.disable() }
    var spoken: [String] = []
    for _ in 0..<30 {
      let utterance = try await voiceOver.moveForward().utterance
      spoken.append(utterance)
      if utterance.contains("Nova finished") { break }
    }
    print("VOICEOVER:\n" + spoken.joined(separator: "\n"))
    let mayaIndex = try XCTUnwrap(spoken.firstIndex { $0.hasPrefix(maya) }, "VoiceOver never spoke Maya's row")
    // The next stop after a row is the next row, never a piece of it.
    XCTAssertLessThan(mayaIndex + 1, spoken.count)
    XCTAssertTrue(spoken[mayaIndex + 1].hasPrefix(nova), "After Maya's row VoiceOver spoke: \(spoken[mayaIndex + 1])")
    XCTAssertTrue(spoken[mayaIndex].contains("Actions available"), "Maya's row should offer its actions: \(spoken[mayaIndex])")
  }
}
