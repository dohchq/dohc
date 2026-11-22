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
  // The iOS 27.2 simulator's keyboard drops a doubled letter typed in one call ("https" became "hps"), so text goes
  // in one character at a time.
  private func typeSlowly(_ element: XCUIElement, _ text: String) {
    for character in text { element.typeText(String(character)) }
  }

  private func recordFields(_ app: XCUIApplication) -> XCUIElementQuery {
    app.descendants(matching: .any).matching(identifier: "record-field")
  }

  // A record's field reads "<field>, <value>", as a sibling of its record-field container; only a record's own screen
  // labels its values so.
  private func fieldShowing(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", ", " + text, text)).firstMatch
  }

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
    typeSlowly(field, origin)
    XCTAssertEqual(field.value as? String, origin, "The address field should hold the typed address")
    app.buttons["Connect server"].tap()
    // The approval page opens in the browser's sheet, over the code. Closing it leaves the sign-in waiting.
    let names = ["Done", "Close", "Cancel", "Dismiss"]
    let close = app.buttons.matching(NSPredicate(format: "label IN %@ OR identifier IN %@", names, names)).firstMatch
    // Connect labels the code one character at a time, so VoiceOver spells it.
    let code = app.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", "([A-Za-z0-9-] )+[A-Za-z0-9-]")).firstMatch
    let end = Date().addingTimeInterval(40)
    while Date() < end && !code.exists {
      if close.exists { close.tap() }
      _ = code.waitForExistence(timeout: 1)
    }
    if !code.exists { say("SERVER ROUND SCREEN \(app.debugDescription)") }
    XCTAssertTrue(code.exists, "Connect should show the device code")
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

  // Signing out ends its session with the server, then deletes the token. The round waits for the session count
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
    say("SERVER ROUND SETTINGS OPEN")
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
    // On the right of the page's last line, below the seed's sentence, so the next round still finds it whole. The
    // simulator's software keyboard ignores Command-Down.
    let last = page.staticTexts.allElementsBoundByIndex.last ?? text
    last.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
    typeSlowly(app, sentence)
    let start = Date()
    XCTAssertTrue(mark("Saving").waitForExistence(timeout: 10) || saved.exists, "Typing should show Saving")
    XCTAssertTrue(saved.waitForExistence(timeout: 60), "The server should apply the edit within 60 s")
    say("SERVER ROUND PAGE SAVED \(since(start)) ms")
    app.terminate()
    app.launch()
    openPlan(app)
    XCTAssertTrue(containing(app.webViews.firstMatch, sentence.trimmingCharacters(in: .whitespaces)).waitForExistence(timeout: 60),
                  "After a relaunch, Plan should show the sentence typed on the phone")
    XCTAssertTrue(containing(app.webViews.firstMatch, try need("DOHC_SERVER_SENTENCE")).exists,
                  "The seed's sentence should still be whole after the phone's edit")
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
    XCTAssertTrue(recordFields(app).firstMatch.waitForExistence(timeout: 10), "The record's own screen should open")
    let field = fieldShowing(app, value)
    if !field.waitForExistence(timeout: 10) { say("SERVER ROUND SCREEN \(app.debugDescription)") }
    XCTAssertTrue(field.exists, "The record's fields should show \(value)")
  }

  // Needs a build with EXPO_PUBLIC_DOHC_PHONE_WRITES=1. Planning can mention the author of the seeded post Kickoff, whose
  // name differs by round, so the test takes the first name the menu offers for "@", types its first letters, and taps
  // its row. The tap must make the text exactly "Can @<handle> " and keep the keyboard up. The message must then show
  // with exactly that text as the server's copy, and the round checks the server has the line it prints.
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
    // The handle `handleForName` makes of a plain name (packages/workspace-contracts/src/chatMentions.ts).
    let allowed = CharacterSet.letters.union(.decimalDigits).union(.nonBaseCharacters).union(CharacterSet(charactersIn: "._-"))
    let handle = String(String.UnicodeScalarView(name.unicodeScalars.filter { allowed.contains($0) }))
      .trimmingCharacters(in: CharacterSet(charactersIn: "._-"))
    XCTAssertFalse(handle.isEmpty, "\(name) should have a handle")
    let completed = NSPredicate(format: "value == %@", "Can @\(handle) ")
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: completed, evaluatedWith: field)], timeout: 10), .completed,
                   "The row should make the text \"Can @\(handle) \", not \(String(describing: field.value))")
    XCTAssertTrue(app.keyboards.firstMatch.exists, "The keyboard should stay up after the tap")
    let tail = "join us? \(UUID().uuidString.prefix(8))"
    typeSlowly(field, tail)
    let body = "Can @\(handle) \(tail)"
    XCTAssertEqual(field.value as? String, body, "Typing should go on after the mention")
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Send message", "Post"])).firstMatch.tap()
    let sent = app.staticTexts.matching(NSPredicate(format: "label == %@", body)).firstMatch
    XCTAssertTrue(sent.waitForExistence(timeout: 60), "Planning should show the message exactly as sent: \(body)")
    // Only the server's copy of a message has Add reaction, right under its text; a copy still on the phone, waiting,
    // withheld or refused, has none. The round then checks the server has the line printed below.
    let reactable = NSPredicate { _, _ in
      guard sent.exists, sent.label == body else { return false }
      let text = sent.frame
      return app.buttons.matching(NSPredicate(format: "label == %@", "Add reaction")).allElementsBoundByIndex.contains {
        $0.frame.minY >= text.maxY && $0.frame.minY - text.maxY < 120
      }
    }
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: reactable, evaluatedWith: app)], timeout: 60), .completed,
                   "The server should have the message exactly as sent: \(body)")
    say("DOHC_MENTION_SENT \(body)")
  }

  /// The record of DOHC_SERVER_COLLECTION whose row shows `value`, on its own screen, and its field holding `value`.
  @MainActor
  private func openRecord(_ app: XCUIApplication, _ name: String, _ value: String) -> XCUIElement {
    tab(app, "Home")
    let collection = app.buttons[name]
    XCTAssertTrue(collection.waitForExistence(timeout: 30), "Home should list the Collection \(name)")
    collection.tap()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 30), "\(name) should show a record with \(value)")
    row.tap()
    XCTAssertTrue(recordFields(app).firstMatch.waitForExistence(timeout: 10), "The record's own screen should open")
    let field = fieldShowing(app, value)
    XCTAssertTrue(field.waitForExistence(timeout: 10), "The record's fields should show \(value)")
    return field
  }

  /// Opens the field's editor, types `typed` after its text, or deletes `deleting` characters from its end, and saves.
  @MainActor
  private func edit(_ app: XCUIApplication, _ field: XCUIElement, typing typed: String = "", deleting: Int = 0) {
    field.tap()
    let input = app.textViews.firstMatch
    if !input.waitForExistence(timeout: 10) { say("SERVER ROUND SCREEN \(app.debugDescription)") }
    XCTAssertTrue(input.exists, "The field should open its editor")
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "The editor should raise the keyboard")
    // The editor opens with the cursor after the field's text.
    app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: deleting))
    typeSlowly(app, typed)
    app.navigationBars.buttons["Save"].tap()
  }

  /// Waits for the record's last change to settle: no saving mark, the field taking a change again, and no failure or
  /// refusal, which would offer Discard.
  @MainActor
  private func settled(_ app: XCUIApplication, _ field: XCUIElement, _ what: String) {
    XCTAssertTrue(app.activityIndicators["Saving"].waitForNonExistence(timeout: 60), "\(what) should save within 60 s")
    // A field that takes a change is a button; while it saves, it isn't.
    let editable = NSPredicate(format: "exists == true AND elementType == %d", XCUIElement.ElementType.button.rawValue)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: editable, evaluatedWith: field)], timeout: 10), .completed,
                   "\(what): the field should take a change again")
    XCTAssertFalse(app.buttons["Discard"].exists, "\(what) should save, not fail or be refused")
  }

  /// Reads the open record again from the server: back to its Collection, pull to refresh, and open the record again.
  @MainActor
  private func reread(_ app: XCUIApplication, _ value: String) {
    back(app)
    let shows = NSPredicate(format: "label CONTAINS %@", value)
    let list = app.scrollViews.containing(shows).firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 10), "Back should show the Collection's records")
    list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
      .press(forDuration: 0.1, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
    XCTAssertTrue(app.activityIndicators.firstMatch.waitForNonExistence(timeout: 30), "The Collection should read again within 30 s")
    let row = app.buttons.matching(shows).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 30), "The records read again should show \(value)")
    row.tap()
  }

  // Needs a build with EXPO_PUBLIC_DOHC_PHONE_WRITES=1, and the record test9 reads, with DOHC_SERVER_RECORD in a text
  // field that a reversible edit changes. Adds a word to that field and waits for the change to save, which offers
  // Undo; Undo puts the value back. Each save is checked by reading the record again. The phone keeps Undo in memory
  // only, so Undo comes before the relaunch: the test then makes the change again, reads it back after a relaunch, and
  // leaves the field as the seed had it.
  @MainActor
  func test11_editsACollectionField() throws {
    let name = try need("DOHC_SERVER_COLLECTION")
    let value = try need("DOHC_SERVER_RECORD")
    let added = " \(UUID().uuidString.prefix(8))"
    let changed = value + added
    let app = XCUIApplication()
    app.launch()
    let undo = app.buttons["Undo last edit"]
    let showing = { (text: String) in
      self.fieldShowing(app, text)
    }
    // `value` is a prefix of `changed`, so a field showing `value` must not also show `changed`.
    let only = { (text: String, what: String) in
      XCTAssertTrue(showing(text).waitForExistence(timeout: 10), what)
      if text == value { XCTAssertFalse(showing(changed).exists, what) }
    }

    edit(app, openRecord(app, name, value), typing: added)
    let start = Date()
    XCTAssertTrue(showing(changed).waitForExistence(timeout: 10), "The field should show the change as it saves")
    settled(app, showing(changed), "The change")
    XCTAssertTrue(undo.exists, "A saved change should offer Undo")
    say("SERVER ROUND COLLECTION SAVED \(since(start)) ms")
    reread(app, changed)
    only(changed, "The server should have \(changed)")

    // The record opened again still offers Undo for its last edit.
    XCTAssertTrue(undo.waitForExistence(timeout: 10), "The record should still offer Undo")
    undo.tap()
    settled(app, showing(value), "Undo")
    only(value, "Undo should put \(value) back")
    reread(app, value)
    only(value, "The server should have \(value) back")

    edit(app, showing(value), typing: added)
    settled(app, showing(changed), "The change made again")
    app.terminate()
    app.launch()
    let field = openRecord(app, name, changed)
    // Back as the seed had it, for the next round.
    edit(app, field, deleting: added.count)
    settled(app, showing(value), "The seed's value")
    reread(app, value)
    only(value, "The server should have \(value) again")
  }

  // Needs a build with EXPO_PUBLIC_DOHC_PHONE_WRITES=1, and the Collection test9 reads, whose first table takes a new
  // record with its defaults, as a table made on the desktop does, holds fewer than 50 records, so a new one reads back
  // on the first page, and shows first a text field an edit changes. Adds a record, names it, finds it after a pull to
  // refresh, deletes it, and finds it gone after another.
  @MainActor
  func test12_addsAndDeletesARecord() throws {
    let name = try need("DOHC_SERVER_COLLECTION")
    let value = try need("DOHC_SERVER_RECORD")
    let added = "Added on the phone \(UUID().uuidString.prefix(8))"
    let app = XCUIApplication()
    app.launch()
    tab(app, "Home")
    let collection = app.buttons[name]
    XCTAssertTrue(collection.waitForExistence(timeout: 30), "Home should list the Collection \(name)")
    collection.tap()
    let seeded = NSPredicate(format: "label CONTAINS %@", value)
    XCTAssertTrue(app.buttons.matching(seeded).firstMatch.waitForExistence(timeout: 30), "\(name) should show its records")
    let new = app.navigationBars.buttons["New record"]
    XCTAssertTrue(new.waitForExistence(timeout: 10), "\(name) should offer New record")
    new.tap()

    // The new record opens on its own screen; its first field names it.
    let first = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Name, ")).firstMatch
    XCTAssertTrue(first.waitForExistence(timeout: 60), "The new record should open within 60 s, its Name ready for a change")
    edit(app, first, typing: added)
    let named = fieldShowing(app, added)
    XCTAssertTrue(named.waitForExistence(timeout: 10), "The field should show \(added) as it saves")
    settled(app, named, "Naming the new record")
    reread(app, added)
    XCTAssertTrue(named.waitForExistence(timeout: 10), "The server should have the new record named \(added)")

    let delete = app.navigationBars.buttons["Delete record"]
    XCTAssertTrue(delete.waitForExistence(timeout: 10), "The record should offer Delete")
    delete.tap()
    let sheet = app.sheets.firstMatch
    XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Delete should ask first")
    sheet.buttons["Delete record"].tap()
    // The record's screen leaves once it's deleted, and the list drops its row.
    let list = app.scrollViews.containing(seeded).firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 60), "The deleted record's screen should leave within 60 s")
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", added)).firstMatch
    XCTAssertTrue(row.waitForNonExistence(timeout: 10), "The list should drop the deleted record")
    list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
      .press(forDuration: 0.1, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
    XCTAssertTrue(app.activityIndicators.firstMatch.waitForNonExistence(timeout: 30), "The Collection should read again within 30 s")
    XCTAssertTrue(app.buttons.matching(seeded).firstMatch.waitForExistence(timeout: 30), "The records read again should show \(value)")
    XCTAssertFalse(row.exists, "The server should no longer have the record named \(added)")
  }
}
