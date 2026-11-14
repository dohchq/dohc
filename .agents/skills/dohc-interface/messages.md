# Where messages go

The table in [`SKILL.md`](SKILL.md#where-messages-go) says which place takes each message. This part says how each place behaves.

## When to report

- Report each cause once. If the title bar names the server as the problem, a feature that needs the server, such as live editing, adds no indicator, toast or row of its own.
- A state dohc is still fixing by itself shows at once where it lives, as a ring. Add its toast and row only once the ring has shown for 15 s.
- A dialog shows the failure of an action it started in place, above the button that retries it, and files no toast or row while it is open. If the dialog closed before the answer, the failure takes a toast and a row.
- Keep the toast and its row when it holds the only Undo for the change.
- Keep the workbench still when a message arrives. No bar slides in across the top.
- Toasts and Notices sit above every dialog. The bell does not: it dims with the rest of the window. Opening a dialog closes Notices.
- Let a repeat of the same message, or the same kind, replace its earlier row.
- A later success for the same thing takes back its failure's toast and row, whichever control started it.
- Where Restricted Mode holds something back, show its band at the top of the pane or card it holds back. Disable the controls that would start it, with the band's words as their reason.
- Restarting or closing the app asks once, in one dialog.
- Report errors through the shell's `reportError` callback instead of rendering them yourself, except a dialog's own action, as above.

## Try again and worded actions

- Give a message about something the person can retry a **Try again** control on the toast and the row.
- A message beside **Try again** does not end with its own `Try again.` sentence. An ending that says more stays: `Try again later.`, `…then choose Try again.`
- A toast's worded actions sit in a row under its text, as on its Notices row. This keeps the text wide. Keep the toast's close × at the top right.
- F6 moves focus to the first worded action, such as **Try again**, on the toast that appeared last. With no worded action, it lands on **Details**, and with neither, on the toast.

## Copy and Details

- Put a copy control beside text a person might need to report. Copy what the person reads, one line per fact, never a log. A success has nothing to report, so it has no copy control.
- If the copy text is exactly what the message shows, such as a command, use a Copy icon beside it.
- If it holds anything more, even the dohc version or the time, give the message a **Details** action instead, so a person sees what they copy. It comes last on the actions line, on the toast and the row.
- **Details** is for text that reports something. A control that copies the person's own work, or something made to paste elsewhere, such as set-aside edits or an invitation, needs no Details. Its tooltip and accessible name say what it copies: `Copy edits`, `Copy invitation`.
- **Details** opens the copy text under the message, selectable, scrolling past 240px. A Copy icon at its top right copies exactly that text.
- While open, the action reads **Hide details** and holds the toast. It also lifts the clamp, so a message never offers both **Details** and **Show more**.
- **Details** is a button with `aria-expanded` and `aria-controls`. Focus stays on it, and Tab next reaches the block's **Copy details**.
- The block opens without animating its height. Only the chevron turns.
- A full-height state uses the same **Details**, in place of **Technical details**.
- A crash notice keeps **Send report** when the build has a report server. It comes before **Details**, on the toast and the row. Both show the same report text.

## Notices rows

Reading and dismissing:

- Closing a toast keeps its row. Dismissing the row removes it.
- A row in Notices stays unread until the pointer or keyboard focus reaches it, the person presses **Mark all read**, or the person opens what the row is about. Taking its toast's step, such as Open note, also reads it. Reading a row closes its toast and keeps the row.
- A held change or refused save whose row is still unread shows its toast again each time dohc starts. Reading its row stops that.
- A row has a dismiss × only when dismissing it acknowledges something that is over. A row about something still wrong, such as **History paused** or **Couldn't confirm this workspace's account**, has no × and stays until it ends.
- **Clear**, beside **Mark all read**, dismisses every row that has a ×, under **On this computer** and **Sent to you**, and shows only while such a row exists. Two kinds stay: a row that holds the only Undo for a change, and set-aside edits, whose Dismiss deletes the text for good.
- Clear leaves one line at the top of the list, `Cleared 7 notices`, with **Undo**, and moves focus to Undo. The line stays until Notices closes. dohc dismisses the rows only then, so Undo brings back exactly what was cleared. Opening a dialog closes Notices too, which commits them. If dohc quits first, the cleared rows come back at the next start, because their Undo was still open. A dismissal that fails brings its row back.

Opening:

- A Notices row opens what it is about. A click, Enter or Space on the row goes where its toast's Open or Review action goes, and reads the row.
- A row that opens shows no Open of its own. Its corner says Opening… while it waits.
- A row whose actions only change state, such as **Try again**, opens where the problem is, or nowhere.
- Opening a row never retries, sends, installs or deletes.
- A row with nowhere to go has no pointer, hover fill, role or Tab stop. Arrow keys still reach it, so the keyboard can read and dismiss it.
- A row's own actions and icon controls do only what they name, and never also open the row.
- When what a row is about is gone, its text becomes `dohc could not find this chat.` or `dohc could not find this file.`, and the row stops opening, with no toast and no navigation.
- On a row that opens, **Show more** expands clipped text, and a click on the text opens the row.

What a row shows:

- A row keeps its title line for the icon controls, copy, its time and dismiss. The time sits in the corner as `now`, `5m`, `6h` or the date. The dismiss × takes its place while the pointer or focus is on the row. Its worded actions, such as **Try again**, sit on a line under its text.
- A row about a message says what the message said: an agent's reply shows its opening words under `Nova replied in #trip`.
- A row shows two lines of title and three of text. Offer **Show more** for the rest, and open it in place, wrapped and selectable.
- In a title, say what happened before any name. Put names last and cut them to fit, so the clamp cuts only a name.
- When the text has one fact per line, show its first three facts whole instead of three lines. Show the count of facts it leaves out only after **Show more**.
- If an untitled message would run past two lines, give it a title that says what happened and a body with why and the Next, so the clamp never hides the Next.
- Write a refusal to fit two lines: what failed, then the one thing to do. The cause goes in its details.

## A list that could not load

- If a list could not load, say so in its place in one line, with Try again. Pass the line as `RetryRow`'s children.
- Keep the cause and Copy details in the toast and the Notices row, not in the list.
