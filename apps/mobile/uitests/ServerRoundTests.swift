import XCTest

// The phone against a development server, run by the server round. Every test is skipped unless the round sets
// DOHC_SERVER_ORIGIN (xcodebuild passes TEST_RUNNER_DOHC_SERVER_ORIGIN to the tests as DOHC_SERVER_ORIGIN). The round
// runs them one at a time, in name order, and acts on the lines they print: it approves the code, writes the change,
// and checks the cache folder. It stops the server's gateway before test5 and starts it again after, and checks the
// account's sessions between test6 and test7.
//
// The seeded workspace has a page Plan at its root with the sentence in DOHC_SERVER_SENTENCE, and a group Planning
// whose post Kickoff has at least one reply, so the stream offers its thread. The round's change is a reply in Kickoff
// and an edit to Plan, each holding DOHC_SERVER_NONCE, and the edit keeps the sentence.
final class ServerRoundTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment

  override func setUpWithError() throws {
    try XCTSkipUnless(env["DOHC_SERVER_ORIGIN"]?.isEmpty == false, "Runs in the server round, which sets DOHC_SERVER_ORIGIN")
    continueAfterFailure = false
  }

  /// One line for the round's script, sent at once.
  private func say(_ line: String) {
    print(line)
    fflush(stdout)
  }

  private func need(_ name: String) throws -> String {
    try XCTUnwrap(env[name].flatMap { $0.isEmpty ? nil : $0 }, "The round sets \(name)")
  }

  private func since(_ start: Date) -> Int { Int(Date().timeIntervalSince(start) * 1000) }

  private func tab(_ app: XCUIApplication, _ name: String) {
    // A tab's label gains its badge's count.
    let button = app.tabBars.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 30), "The tab bar should show \(name)")
    button.tap()
  }

  private func containing(_ root: XCUIElement, _ text: String) -> XCUIElement {
    root.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  private func back(_ app: XCUIApplication) {
    app.navigationBars.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "BackButton", "Back")).firstMatch.tap()
  }

  private func openPlan(_ app: XCUIApplication) {
    tab(app, "Home")
    let plan = app.buttons["Plan"]
    XCTAssertTrue(plan.waitForExistence(timeout: 30), "Home should list the page Plan")
    plan.tap()
  }

  /// Chats, the group Planning, then the replies under its post, which open the thread Kickoff.
  private func openKickoff(_ app: XCUIApplication) {
    tab(app, "Chats")
    let planning = app.buttons["Planning"]
    XCTAssertTrue(planning.waitForExistence(timeout: 30), "Chats should show the group Planning")
    planning.tap()
    let replies = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "replies, last at")).firstMatch
    XCTAssertTrue(replies.waitForExistence(timeout: 30), "Planning should offer the Kickoff post's replies")
    replies.tap()
    XCTAssertTrue(app.navigationBars.staticTexts["Kickoff"].waitForExistence(timeout: 30), "The replies should open the thread Kickoff")
  }

  @MainActor
  func test1_deviceFlowSignIn() throws {
    let origin = try need("DOHC_SERVER_ORIGIN")
    let app = XCUIApplication()
    app.launch()
    let field = app.textFields["Server address"]
    XCTAssertTrue(field.waitForExistence(timeout: 30), "A fresh install should open on Connect")
    field.tap()
    field.typeText(origin)
    app.buttons["Connect server"].tap()
    // The approval page opens in the browser's sheet, over the code. Closing it leaves the sign-in waiting.
    let close = app.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "Close"])).firstMatch
    if close.waitForExistence(timeout: 30) { close.tap() }
    // Connect labels the code one character at a time, so VoiceOver spells it.
    let code = app.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", "([A-Za-z0-9-] )+[A-Za-z0-9-]")).firstMatch
    XCTAssertTrue(code.waitForExistence(timeout: 10), "Connect should show the device code")
    say("SERVER ROUND CODE \(code.label.replacingOccurrences(of: " ", with: ""))")
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 120), "Once the code is approved, the phone should show its tabs")
  }

  @MainActor
  func test2_readsHomeChatsAndThePage() throws {
    let sentence = try need("DOHC_SERVER_SENTENCE")
    let app = XCUIApplication()
    app.launch()
    openPlan(app)
    XCTAssertTrue(containing(app.webViews.firstMatch, sentence).waitForExistence(timeout: 30), "Plan should show its sentence")
    back(app)
    openKickoff(app)
  }

  // The thread is open when the change arrives, so the feed brings the reply. Plan opens afterwards and reads the edit.
  @MainActor
  func test3_feedShowsTheChange() throws {
    let nonce = try need("DOHC_SERVER_NONCE")
    let app = XCUIApplication()
    app.launch()
    openKickoff(app)
    say("SERVER ROUND READY FOR CHANGE")
    let start = Date()
    XCTAssertTrue(containing(app, nonce).waitForExistence(timeout: 90), "The reply should reach the open thread within 90 s")
    say("SERVER ROUND CHANGE SEEN thread \(since(start)) ms")
    back(app)
    back(app)
    openPlan(app)
    XCTAssertTrue(containing(app.webViews.firstMatch, nonce).waitForExistence(timeout: max(1, 90 - Date().timeIntervalSince(start))),
                  "Plan should show the edit within 90 s of the change")
    say("SERVER ROUND CHANGE SEEN page \(since(start)) ms")
  }

  // Reads everything test5 shows offline, Plan with the edit and Chats, then goes to the background.
  @MainActor
  func test4_backgroundSavesTheCache() throws {
    let nonce = try need("DOHC_SERVER_NONCE")
    let app = XCUIApplication()
    app.launch()
    openPlan(app)
    XCTAssertTrue(containing(app.webViews.firstMatch, nonce).waitForExistence(timeout: 30), "Plan should show the edit before the save")
    back(app)
    tab(app, "Chats")
    XCTAssertTrue(app.buttons["Planning"].waitForExistence(timeout: 30), "Chats should show Planning before the save")
    XCUIDevice.shared.press(.home)
    // Going to the background writes the cache. The test can't see the write, so the round waits for the files.
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10) || app.wait(for: .runningBackgroundSuspended, timeout: 1), "The app should go to the background")
    say("SERVER ROUND BACKGROUNDED")
  }

  // With the server's gateway stopped, every read comes from the cache test4 saved.
  @MainActor
  func test5_offlineRelaunchReadsTheCache() throws {
    let sentence = try need("DOHC_SERVER_SENTENCE")
    let app = XCUIApplication()
    app.launch()
    openPlan(app)
    let page = app.webViews.firstMatch
    XCTAssertTrue(containing(page, sentence).waitForExistence(timeout: 30), "Offline, Plan should show its sentence from the cache")
    XCTAssertTrue(containing(page, try need("DOHC_SERVER_NONCE")).exists, "Offline, Plan should show the edit the background save kept")
    back(app)
    tab(app, "Chats")
    XCTAssertTrue(app.buttons["Planning"].waitForExistence(timeout: 30), "Offline, Chats should show Planning from the cache")
    // Home's header has the same button; only the open tab's can be tapped.
    let switchers = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Workspace: "))
    XCTAssertTrue(switchers.firstMatch.waitForExistence(timeout: 10), "Chats should show the workspace switcher")
    let switcher = try XCTUnwrap(switchers.allElementsBoundByIndex.first { $0.isHittable }, "The Chats header's switcher should be tappable")
    let name = String(switcher.label.dropFirst("Workspace: ".count).dropLast(". Switch workspace".count))
    switcher.tap()
    XCTAssertTrue(app.staticTexts["Workspaces"].waitForExistence(timeout: 10), "The switcher should open")
    XCTAssertTrue(app.buttons[name].waitForExistence(timeout: 10), "Offline, the switcher should list \(name) from the cache")
  }

  // Signing out deletes the token, then ends its session with the server. The round waits for the session count
  // before it runs test7, which relaunches the app.
  @MainActor
  func test6_signOut() {
    let app = XCUIApplication()
    app.launch()
    tab(app, "Chats")
    let settings = app.buttons["Settings"]
    XCTAssertTrue(settings.waitForExistence(timeout: 30), "Chats should show Settings")
    settings.tap()
    // An agent's row has its own Sign out; the account's is the last button.
    let buttons = app.buttons.matching(NSPredicate(format: "label == %@", "Sign out"))
    XCTAssertTrue(buttons.firstMatch.waitForExistence(timeout: 30), "Settings should show Sign out")
    let signOut = buttons.element(boundBy: buttons.count - 1)
    for _ in 0..<5 where !signOut.isHittable { app.swipeUp() }
    signOut.tap()
    let sheet = app.sheets.firstMatch
    XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Sign out should ask first")
    sheet.buttons["Sign out"].tap()
    XCTAssertTrue(app.textFields["Server address"].waitForExistence(timeout: 30), "After sign-out the phone should show Connect")
    say("SERVER ROUND SIGNED OUT")
  }

  // Connect keeps the last address while the app runs. A relaunch forgets it.
  @MainActor
  func test7_relaunchAfterSignOutShowsAnEmptyConnect() {
    let app = XCUIApplication()
    app.launch()
    let field = app.textFields["Server address"]
    XCTAssertTrue(field.waitForExistence(timeout: 30), "After sign-out the phone should open on Connect")
    // An empty field reports its placeholder as its value.
    let value = field.value as? String ?? ""
    XCTAssertTrue(value.isEmpty || value == field.placeholderValue, "The server field should be empty, not \(value)")
  }
}
