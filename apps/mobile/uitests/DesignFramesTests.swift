import XCTest

// FRAMES ONLY (never merged): the DL's frame sets, all from one head, kept in the result bundle. Round 5's Notices set
// adds the toast at rest and after Copy, and the copied row; the comparison set has Documents (a page reading, opening
// and editing with typed text) and Chats (the list, a conversation with a person's and an agent's messages, and the
// composer with typed text). Each test only shoots; it asserts what it needs to find. Runs when the round asks.
final class DesignFramesTests: XCTestCase {
  @MainActor
  private func keep(_ app: XCUIApplication, _ name: String) {
    let theme = XCUIDevice.shared.appearance == .dark ? "dark" : "light"
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "\(name)-\(theme)"
    shot.lifetime = .keepAlways
    add(shot)
  }
  private func launch(_ arguments: [String]) throws -> XCUIApplication {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DOHC_FRAMES"] == "1", "Runs when the round asks for frames")
    let app = XCUIApplication()
    app.launchArguments += arguments
    app.launch()
    return app
  }
  /// Frame-capture protocol, not a pass condition: lets a demo's timed step (a copy at 1.2 s) show before the shot.
  private func settle(_ seconds: TimeInterval) { _ = XCTWaiter().wait(for: [XCTestExpectation(description: "settle")], timeout: seconds) }
  private func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", words)).firstMatch
  }
  /// Drags the list until the row's end (its action line and time) sits just above the tab bar, in held drags no longer
  /// than the distance left, so the list never carries on past it. True once the row ends between 200 and 8 pt above it.
  @MainActor
  private func showRowEnd(_ app: XCUIApplication, _ row: XCUIElement) -> Bool {
    let tabTop = app.tabBars.firstMatch.frame.minY
    for _ in 0..<20 {
      guard row.exists, !row.frame.isEmpty else { app.swipeUp(velocity: .slow); continue }
      let end = row.frame.maxY
      if end <= tabTop - 8 && end >= tabTop - 200 { return true }
      let by = max(-250, min(250, (tabTop - 40) - end))
      let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
      from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: by)), withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    return false
  }

  @MainActor func testFramesToastAtRest() throws {
    let app = try launch(["-dohcTestRoute", "", "-dohcDemo", "toast"])
    XCTAssertTrue(text(app, "Budget sync").waitForExistence(timeout: 20), "The toast should show")
    settle(1)
    keep(app, "07-toast")
  }

  // The DL's 17:39Z request: every screen with a Copy confirmation, before and after the neutral check (the round runs
  // this at the commit before the change too). Each demo copies 1.2 s in and holds the check.
  @MainActor func testFramesCopyConfirmations() throws {
    for (route, demo, wait, name) in [("", "toast-copied", "Budget sync", "07-toast-copied"),
                                      ("notices", "notice-copied", "Maya Chen mentioned you", "07-notices-row-copied"),
                                      ("sharing", "share-copied", "packing", "05-chat-sharing-copied")] {
      let app = try launch(["-dohcTestRoute", route, "-dohcDemo", demo])
      XCTAssertTrue(text(app, wait).waitForExistence(timeout: 20), "\(demo) should show its screen")
      settle(2.5)
      keep(app, name)
      app.terminate()
    }
  }

  @MainActor func testFramesNoticesStates() throws {
    for (demo, name) in [("empty", "07-notices-empty"), ("notice-clipped", "07-notices-clipped"),
                         ("notice-clipped-open", "07-notices-clipped-open"), ("notice-end-failed", "07-notices-end-failed")] {
      let app = try launch(["-dohcTestRoute", "notices", "-dohcDemo", demo])
      XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 20), "Notices should show (\(demo))")
      settle(2.5)
      keep(app, name)
      app.terminate()
    }
  }

  // The DL's AX5 rulings: a2's band at AX5 and XXXL, at rest and scrolled to the end, plus the longest body; b1's rows at
  // AX5 with Open, with Try again and with no worded action, and XXXL unchanged.
  @MainActor func testFramesLargestTextSizes() throws {
    let sizes = [("ax5", "UICTContentSizeCategoryAccessibilityXXXL"), ("xxxl", "UICTContentSizeCategoryXXXL")]
    for (size, category) in sizes {
      for (demo, name) in [("band", "band"), ("band-sync-failed", "band-long-body")] where size == "ax5" || demo == "band" {
        let app = try launch(["-dohcTestRoute", "notices", "-dohcDemo", demo, "-UIPreferredContentSizeCategoryName", category])
        let band = app.descendants(matching: .any)["sync-band-area"]
        XCTAssertTrue(band.waitForExistence(timeout: 20), "\(demo) at \(size): the band should show")
        settle(1.5)
        keep(app, "07-notices-\(name)-\(size)-rest")
        // Capped at AX5, the words scroll in their own region (round 61's probe), so the swipes go there. At XXXL the band
        // isn't capped and has no region: nothing scrolls, and its end shot is its rest.
        if size == "ax5" {
          let words = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "sync-band-words:")).firstMatch
          XCTAssertTrue(words.waitForExistence(timeout: 5), "\(demo) at AX5: the capped band should draw its words in a region")
          for _ in 0..<8 { words.swipeUp(velocity: .slow) }
        }
        settle(1)
        keep(app, "07-notices-\(name)-\(size)-end")
        app.terminate()
      }
      // Rows without the band: Open (the first), Try again (the failed automation) and no worded action.
      let app = try launch(["-dohcTestRoute", "notices", "-UIPreferredContentSizeCategoryName", category])
      let open = text(app, "Maya Chen mentioned you")
      XCTAssertTrue(open.waitForExistence(timeout: 20), "Notices at \(size) should list its rows")
      settle(1)
      if size == "ax5" {
        // Each row's whole action line above the tab bar (Sol's check of round 62): Open, Try again, and Copy alone on a
        // row with no worded action and no ×.
        for (title, name) in [("Maya Chen mentioned you", "open"), ("Budget sync", "try-again"), ("Your agent has work waiting", "no-action")] {
          let row = text(app, title)
          XCTAssertTrue(showRowEnd(app, row), "At AX5 the \(name) row's end should come above the tab bar (row \(row.frame))")
          settle(1)
          keep(app, "07-notices-rows-\(size)-\(name)")
        }
      } else {
        keep(app, "07-notices-rows-\(size)-open")
      }
      app.terminate()
    }
  }

  @MainActor func testFramesDocuments() throws {
    var app = try launch(["-dohcTestRoute", "page"])
    let body = app.webViews.firstMatch.textViews.firstMatch
    XCTAssertTrue(body.waitForExistence(timeout: 20), "The page should show")
    keep(app, "04-page-reading")
    body.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "A tap should bring up the keyboard")
    app.typeText("Typed on the phone. ")
    keep(app, "04-page-editing-typed")
    app.terminate()
    // The DL, Nov 7: one state in both themes, the page shown with "Opening…" still under its title.
    app = try launch(["-dohcTestRoute", "page", "-dohcDemo", "page-opening"])
    XCTAssertTrue(text(app, "Opening").waitForExistence(timeout: 20), "The page should say it's opening")
    // The editor mounts under the loading lines, so wait for them to go: the page is painted, still opening.
    let loading = text(app, "Loading")
    XCTAssertTrue(app.webViews.firstMatch.textViews.firstMatch.waitForExistence(timeout: 20), "The page's editor should mount")
    XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: loading)], timeout: 20) == .completed
                  && text(app, "Opening").exists, "The page should show, painted, with \"Opening…\" still under its title")
    keep(app, "04-page-opening")
  }

  @MainActor func testFramesChats() throws {
    var app = try launch(["-dohcTestRoute", ""])
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20), "Chats should show")
    settle(1)
    keep(app, "05-chats-list")
    // The DL's 21:40Z check: whether the last rows sit under the floating tab bar.
    for _ in 0..<6 { app.swipeUp() }
    settle(1)
    keep(app, "05-chats-list-end")
    app.terminate()
    // A file chat's title (the DL's 21:40Z check).
    app = try launch(["-dohcTestRoute", "chat-file"])
    XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 20), "The file chat's composer should show")
    keep(app, "05-chat-file")
    app.terminate()
    // A connected agent's chat: its name, "Connected agent" under it, and the plug (the DL's ruling A, Nov 7).
    app = try launch(["-dohcTestRoute", "chat-agent"])
    XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 20), "The agent chat's composer should show")
    XCTAssertTrue(app.staticTexts["Connected agent"].waitForExistence(timeout: 5), "A connected agent's chat should say so under its name")
    keep(app, "05-chat-agent")
    // Its card, from its mark (the DL's ruling C, Nov 8): the reported line marked once.
    app.buttons["Scout, connected agent"].firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 18, dy: 18)).tap()
    XCTAssertTrue(app.otherElements.matching(NSPredicate(format: "label == %@",
      "Scout, Connected agent, Claude Code 2.1 · Claude Opus 5.5 (as reported)")).firstMatch.waitForExistence(timeout: 5),
      "Scout's mark should open its card")
    settle(1)
    keep(app, "05-chat-agent-card")
    app.terminate()
    app = try launch(["-dohcTestRoute", "chat"])
    let composer = app.textViews.firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 20), "The conversation's composer should show")
    keep(app, "05-chat-conversation")
    // Your own agent's card names its owner.
    app.buttons["Nova, agent"].firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 18, dy: 18)).tap()
    let nova = app.otherElements.matching(NSPredicate(format: "label == %@", "Nova, Owned by Ice")).firstMatch
    XCTAssertTrue(nova.waitForExistence(timeout: 5), "Nova's mark should open its card")
    settle(1)
    keep(app, "05-chat-own-agent-card")
    // A swipe down as a person makes it, from inside the card's top padding to the screen's bottom.
    nova.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 10))
      .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99)))
    XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: nova)], timeout: 10) == .completed,
                  "A swipe down should close Nova's card")
    composer.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "A tap should bring up the keyboard")
    app.typeText("Typed in the composer.")
    keep(app, "05-chat-composer-typed")
  }

  // Round 3's phone items (the DL, Nov 5): each share's second line, End share in the destructive role, the alert
  // that names the file (and the waiting changes), the failed End share's toast, Leave in the danger style, and Forget
  // with messages waiting.
  @MainActor func testFramesSharing() throws {
    var app = try launch(["-dohcTestRoute", "sharing"])
    XCTAssertTrue(text(app, "sam@example.com can edit").waitForExistence(timeout: 20), "A share's second line should say who can do what")
    settle(1)
    keep(app, "09-sharing")
    app.terminate()
    for (demo, wait, name) in [("sheet-share-actions", "End share", "09-sharing-sheet"),
                               ("sheet-end-share", "End the share of days.md", "09-sharing-end"),
                               ("sheet-end-share-waiting", "decline 2 changes", "09-sharing-end-waiting"),
                               ("toast-end-failed", "dohc could not end", "09-sharing-end-failed"),
                               ("toast-end-failed-many", "dohc could not end", "09-sharing-end-failed-many")] {
      app = try launch(["-dohcTestRoute", "sharing", "-dohcDemo", demo])
      XCTAssertTrue(text(app, wait).waitForExistence(timeout: 20), "\(demo) should show \(wait)")
      settle(1)
      keep(app, name)
      app.terminate()
    }
    app = try launch(["-dohcTestRoute", "", "-dohcDemo", "sheet-leave"])
    XCTAssertTrue(text(app, "Leave your conversation with").waitForExistence(timeout: 20), "Leave should ask first")
    settle(1)
    keep(app, "08-leave")
    app.terminate()
    app = try launch(["-dohcTestRoute", "", "-dohcDemo", "sheet-forget-waiting"])
    XCTAssertTrue(text(app, "not the messages").waitForExistence(timeout: 20), "Forget should say what Undo can't restore")
    settle(1)
    keep(app, "08-forget-waiting")
  }
}
