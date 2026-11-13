# The phone app

The phone app (`apps/mobile`) follows the rest of this skill, except for the differences listed here.
The phone does each difference on purpose.
Before you add or change a difference, follow [`apps/mobile/AGENTS.md`](../../../apps/mobile/AGENTS.md#platform-differences).

## Platform

- Touch targets are at least 44 pt.
- Use the system's tab bar, navigation, large titles, sheets, and haptics on iOS, and Material's on Android.
- Body text is 17 pt, with Dynamic Type. The system font is a listed difference.
- Use SF Symbols only where iOS draws the control. Use lucide for dohc's own content.
- A confirmation is an action sheet or a system alert, with the desktop's words. Delete, Forget, Leave, and Remove use the destructive style, including in a long-press menu.
- Every swipe and long-press has a visible control that does the same thing.
- Toasts sit at the bottom, in 16 pt gutters above the tab bar or the composer, on a solid surface, with a visible ×.
- The composer docks to the keyboard.
- There are no tooltips.

## Surfaces

1. **Clamps.** Toast titles take 4 lines and Notices row titles 3, where the desktop takes 2. A tap opens the rest in place, as the desktop's click or Show more does.
2. **Notices rows and VoiceOver.** A row is one element. Its actions are in the rotor in this order: the worded action, Mark read or Mark unread, Copy, Dismiss. The spoken time is in full ("2 minutes ago"); on screen it is the desktop's ("2m ago").
3. **Header.** Mark all read is a system bar button. The header glass is the system's, themed by the navigation theme.
4. **Done** ends editing, and shows only while the keyboard is up.
5. **Properties** are read-only for now, with nothing that looks editable: no field outlines, and a chevron only on a value that opens something.
6. **The state mark** opens its explanation on tap. VoiceOver hears the mark's label with the explanation as its value.
7. **Lossy and large files** have no Open externally. The large-file strip says to open it on a computer. A large file's state mark reads Read-only, as every read-only page's does, and its explanation says the file is too large to edit.
8. **No device-file states.** The phone saves to the server, so it has no Saved to host, Saved locally · Pending share, File in use, Changed outside dohc, Reloaded, or Replaced. Deleted keeps the last text, read-only, and does not mention the trash.
9. **Page and chat buttons.** A page's header has "Chat about <file>", and a file chat's header has "Open <file>".
10. **Computer-only**, with no disabled entry on the phone: Collection delete, Versions, and in Sharing the conflicts banner, skipped changes, Copy code, and the waiting-changes review.
11. **A page that fails to load** (its view, or the editor files it needs) shows "dohc could not open this file." with Try again. If the editor files could not be written for lack of space, a second line says "Not enough storage on this phone. Free up space, then choose Try again." The could-not-open strip is only for text shown read-only because editing could not start. A page that's gone offers no Try again.
12. **End share names the file.** The phone's alert asks "End the share of <file>?", where the desktop asks "End this share?" beside its row. With changes waiting, it asks "End the share of <file> and decline <N> changes <who> sent?".
13. **A failed End share's toast** has a 2-line title, not 4. It cuts the file's name and each person's in the middle to fit. Its Notices row and Copy keep the whole text.
14. **Sign out**, where the desktop says Disconnect. The desktop's Disconnect stops sync and keeps the files on the computer. The phone keeps no work of its own, so it only signs out.
15. **Settings** opens from your mark at the right of the Chats header, as in Slack. It holds the account and its server, Show on phone for each workspace, the account's sessions with End session, and its agents with Sign out, Remove and Restore. The desktop has no session or agent list yet.
16. **Connect, Settings, a chat and a page show their errors in place**, with Try again, and file no toast or Notices row. They sit outside the tabs, where toasts show. A failed refresh keeps what's shown, with the cause and Try again above it.
17. **Notices in a signed-in build** list the account's Notices that the server shows phones, with failures held on this phone, such as a read of Home or Chats, on top.
    - A row stays unread until the person opens it, marks it read, or presses Mark all read. The phone has no pointer or focus to read a row by reaching it, so a Notice from the server shows Mark read or Mark unread under its text, and swiping right does the same.
    - Swiping left, or ×, dismisses it. A dismissed Notice's toast says "Notice dismissed" with Undo, shows on Notices too, and stays until closed, because it holds the only Undo.
    - Open goes to a thread at its message, or a page, in the Notice's workspace when it shows on the phone, and opens that workspace. A row the phone can't open says "Open on your computer" after its time. Opening reads the row and never runs anything.
    - A failed read of the list, or marks that can't be sent, is a toast and a row with Try again. Marks wait on the phone, a relaunch included, and send in order when the server answers.
    A change feed that fails 3 times in a row shows as a failed read does, so content never goes out of date without a sign: a toast and a row on the tabs, and a line above a chat or page. Try again starts the feed at once, and its next answer takes the failure back.
18. **Reading only, in a signed-in build.** The phone sends the server nothing but read marks and Notice marks yet. A chat has no composer, and a page is read-only, with the Read-only mark. Chats lists groups, people and agents, with no file chats: the server gives the phone none yet. Unread follows the account's read marks, as on the desktop: an unread chat's name is bold, and a person or an agent shows its count. While a chat or thread is on screen, its conversation is read up to the newest message shown, and an unread post up to its own message, as on the desktop. Home lists Pages and Other files only; the phone has no Collections or Apps yet.
19. **The workspace switcher** lists every workspace that shows on the phone. One whose sync isn't set up yet is dimmed, says "Not synced yet", and can't be chosen. Its Show on phone switch in Settings stays as it is.
20. **A page the server won't send.** A file over the editor's limit says "This file is too large to open on a phone. Open it on a computer.", because the server sends none of it. A page whose workspace is being restored says "This page is being restored." with Try again.
21. **Scan code** sits beside Connect's server address, because typing an address on a phone is slow. It reads the QR code a computer shows under Connect a phone, which holds only its server's origin. A valid code fills the address and closes the scanner, and the person then chooses Connect server, as after typing it. A scan never opens a sign-in page by itself, so a swapped code can't pick the server for them. Any other code says so in the scanner, which keeps scanning. The phone asks for the camera at the tap, never at launch.

Browser alerts gain the message text after phone push lands.
