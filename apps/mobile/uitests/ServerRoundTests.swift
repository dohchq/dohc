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
    let app = XCUIApplication()
    app.launch()
    try signIn(app)
  }

  /// Signs in from Connect through the device flow; the round approves the code it prints.
  @MainActor
  private func signIn(_ app: XCUIApplication) throws {
    let origin = try need("DOHC_SERVER_ORIGIN")
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

  // Folding Groups hides every chat in it, unread ones too. Unfolded, Planning opens and Back returns to Chats.
  @MainActor
  func test2b_chatsFoldASectionAndOpenAChat() throws {
    let app = XCUIApplication()
    app.launch()
    tab(app, "Chats")
    let planning = app.buttons["Planning"]
    XCTAssertTrue(planning.waitForExistence(timeout: 30), "Chats should show the group Planning")
    // A folded section with unread chats says so in its label.
    let groups = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Groups")).firstMatch
    groups.tap()
    XCTAssertTrue(planning.waitForNonExistence(timeout: 10), "Folding Groups should hide Planning")
    groups.tap()
    XCTAssertTrue(planning.waitForExistence(timeout: 10), "Unfolding Groups should show Planning again")
    planning.tap()
    let replies = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "replies, last at")).firstMatch
    XCTAssertTrue(replies.waitForExistence(timeout: 30), "Planning should open")
    back(app)
    XCTAssertTrue(planning.waitForExistence(timeout: 30), "Back should return to Chats")
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
  func test7_relaunchAfterSignOutShowsAnEmptyConnect() throws {
    let app = XCUIApplication()
    app.launch()
    let field = app.textFields["Server address"]
    XCTAssertTrue(field.waitForExistence(timeout: 30), "After sign-out the phone should open on Connect")
    // An empty field reports its placeholder as its value.
    let value = try XCTUnwrap(field.value as? String, "The server field should report its text")
    XCTAssertTrue(value.isEmpty || value == field.placeholderValue, "The server field should be empty, not \(value)")
  }

  // Needs a build with EXPO_PUBLIC_DOHC_PHONE_WRITES=1, and a server that opens pages for phones (#4173, #4192). Plan
  // must have been opened live on a computer once. Signs in again after test6, types a sentence into Plan, waits for
  // Saved, which only the server's host applying every edit gives, then reads the sentence back after a relaunch.
  @MainActor
  func test8_editsAPageAndTheServerApplies() throws {
    let sentence = " Typed on the phone \(UUID().uuidString.prefix(8))."
    let app = XCUIApplication()
    app.launch()
    try signIn(app)
    openPlan(app)
    // The title's label is the file's name and its state mark's label.
    let mark = { (label: String) in app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Plan' AND label ENDSWITH %@", ", \(label)")).firstMatch }
    let saved = mark("Saved")
    XCTAssertTrue(saved.waitForExistence(timeout: 60), "Plan should open live and show Saved")
    let page = app.webViews.firstMatch
    let text = containing(page, try need("DOHC_SERVER_SENTENCE"))
    XCTAssertTrue(text.waitForExistence(timeout: 10), "Plan should show its sentence")
    text.tap()
    app.typeText(sentence)
    let start = Date()
    XCTAssertTrue(mark("Saving").waitForExistence(timeout: 10) || saved.exists, "Typing should show Saving")
    XCTAssertTrue(saved.waitForExistence(timeout: 60), "The server should apply the edit within 60 s")
    say("SERVER ROUND PAGE SAVED \(since(start)) ms")
    app.terminate()
    app.launch()
    openPlan(app)
    XCTAssertTrue(containing(app.webViews.firstMatch, sentence.trimmingCharacters(in: .whitespaces)).waitForExistence(timeout: 60),
                  "After a relaunch, Plan should show the sentence typed on the phone")
  }

  // Needs a seeded transactional Collection named in DOHC_SERVER_COLLECTION, whose first table has a record with the
  // value in DOHC_SERVER_RECORD among its first 50, in a field its rows show. Home lists the Collection, the Collection
  // shows the record's row, and the record shows the value.
  @MainActor
  func test9_readsACollection() throws {
    let name = try need("DOHC_SERVER_COLLECTION")
    let value = try need("DOHC_SERVER_RECORD")
    let app = XCUIApplication()
    app.launch()
    tab(app, "Home")
    let collection = app.buttons[name]
    XCTAssertTrue(collection.waitForExistence(timeout: 30), "Home should list the Collection \(name)")
    collection.tap()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 30), "\(name) should show a record with \(value)")
    row.tap()
    // In a field of the record's own screen, not the row it was opened from.
    let field = app.otherElements.matching(identifier: "record-field")
      .containing(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10), "The record's fields should show \(value)")
  }

  // Needs a build with EXPO_PUBLIC_DOHC_PHONE_WRITES=1. Planning can mention the author of the seeded post Kickoff, whose
  // name differs by round, so the test takes the first name the menu offers for "@", types its first letters, and taps
  // its row. The tap completes the text and keeps the keyboard up; the message sent shows the field's text exactly.
  @MainActor
  func test10_mentionsSomeone() throws {
    let app = XCUIApplication()
    app.launch()
    tab(app, "Chats")
    let planning = app.buttons["Planning"]
    XCTAssertTrue(planning.waitForExistence(timeout: 30), "Chats should show the group Planning")
    planning.tap()
    let field = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Message ")).firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 30), "Planning should show the composer")
    field.tap()
    field.typeText("Can @")
    let rows = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@ OR label ENDSWITH %@", ", person", ", agent"))
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "Typing @ should offer who Planning can mention")
    let label = rows.firstMatch.label
    let comma = try XCTUnwrap(label.range(of: ", ", options: .backwards), "A row's label should end in its kind")
    let name = String(label[..<comma.lowerBound])
    field.typeText(String(name.prefix(2)))
    let row = app.buttons[label]
    XCTAssertTrue(row.waitForExistence(timeout: 10), "\(name) should still match its first letters")
    row.tap()
    let completed = NSPredicate(format: "value MATCHES %@", "Can @\\S+ ")
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: completed, evaluatedWith: field)], timeout: 10), .completed,
                   "The row should make the text \"Can @handle \"")
    XCTAssertTrue(app.keyboards.firstMatch.exists, "The keyboard should stay up after the tap")
    let tail = "join us? \(UUID().uuidString.prefix(8))"
    field.typeText(tail)
    let body = try XCTUnwrap(field.value as? String, "The field should report its text")
    XCTAssertTrue(body.hasSuffix(" \(tail)"), "Typing should go on after the mention, not \(body)")
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Send message", "Post"])).firstMatch.tap()
    // The field's label is its placeholder, so only the message's text can match.
    XCTAssertTrue(containing(app, body).waitForExistence(timeout: 60), "Planning should show the message exactly as sent: \(body)")
  }
}
