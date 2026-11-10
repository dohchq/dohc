---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app or phone app: a label, button, menu item, error, empty state, toast, dialog, or panel. Also use when choosing a token, class recipe, or control in the renderer.
---

# dohc's interface

Write in plain and simple language.
A person reads these words in the middle of a task, sometimes worried, and cannot ask what they mean.

Token values live in `apps/desktop/src/renderer/styles.css`, mirrored in `tokens.ts`.
`tokens.test.ts` fails when the two drift or when a color pair misses WCAG AA.
Read the code for values and this skill for meaning.

## Show first

Before reading a word, a person should see what a surface is, its state, and what to do next.
Use words only for the person's own content and for facts a picture cannot show, such as an error's cause.

To test a surface, hide every word that is not the person's own content.
If the purpose, state, or next click disappears, show it with an icon, position, shape, or color.
Who can reach the work is a fact a picture can't show. A share row says it in words: `sam@ridge.co can edit`, `1 person can edit, 2 can view`, `Anyone with the link can view`.

| Instead of | Show |
| --- | --- |
| A type label (`DOCUMENT`) | The file's icon |
| A panel title that repeats the active rail icon | The rail's active mark |
| The same status twice (`Local · saved`, then `Saved`) | One mark in one place |
| A helper sentence under a control | A live preview of its effect, or a tooltip |
| A scope tag on every row | One group heading per scope |
| Prose about what changed | A number, a bar, or the changed words highlighted |
| A label saying who is an agent | The agent's square avatar |

Some meaning still needs words or its own mark:

- Every icon-only control keeps an accessible name and a tooltip.
- Distinct states keep distinct marks. Saved on this machine, accepted by the host, and waiting to share are three states.
- An error keeps its sentence. The icon marks it, and the words explain it.
- Color always comes with a shape, an icon, or a position, so the meaning survives grayscale and color blindness.
- Use the lucide icon people already know for the action.

## Words

Use as few words as possible in anything a person sees without a hover or a click.
Put further detail behind a tooltip, a **Details** disclosure, or a **Learn more** link.
Link **Learn more** only to a page that exists.
Keep an error and its next step in view.

Say what is true, what changed, and what to do next, in that order.

Most strings do one of four jobs:

| Job | Example |
| --- | --- |
| State: what is true now | `3 files changed on this machine` |
| Change: what just happened | `Moved 4 files to Archived` |
| Ready: something new became usable | `Agent result, ready to review` |
| Next: what the person can do | `Choose which copy to keep` |

Every error needs a Next, and so does an empty state when the person can act there. A toast usually reports a Change. A status bar shows a State.

- Follow the instruction rules in `dohc-writing`: one instruction per sentence, 20 words or fewer.
- Use the active voice and name who acted. Leave dohc out when the surface makes it obvious: `Saved`.
- Always name a failing actor: `dohc could not reach the relay`, not `The relay could not be reached`.
- Attribution labels such as `Edited by agent` are fine as they are.
- Call a thing what the surrounding UI calls it, every time. Never show an internal name. Check both the code and the shipping UI, because they often differ.
- Keep the words literal. Leave out metaphors, jokes, irony, exclamation marks, and emoji.
- Use sentence case: `New folder`.
- Leave the period off labels, buttons, and fragments. Full sentences keep theirs.
- Use numerals for counts a person scans or acts on: `Delete 12 files`. Inside a sentence, a word can read better: `A file changed on two machines`.
- A count beside a list counts every item the list holds, whatever its state. It includes items in collapsed groups or past **Show more**. A row that only groups others, such as a folder in Pages, is not an item. If more remain to load, add `+`: `24+`.
- State the mechanism or say nothing. Cut promises such as `magically`, `just works`, `powered by AI`, `seamless`, `powerful`, and `smart`.
- Keep sync clearly opt-in. Sync starts off, and signing in alone does not turn it on.

### Errors

Write up to three parts, in this order. Leave out any part you do not know.

1. What happened, in the person's words for things.
2. Why, if dohc knows. Never guess.
3. What to do next, as an instruction or a control.

Never show a raw error code alone, blame the person, or apologize. `Sorry, something went wrong` says nothing.

Write `could not` in an error, not `couldn't`.

The sync strings show the standard: `A file changed on two machines`, `This machine doesn't have this file.`, and `One file has two copies.`

### Empty states

Use `EmptyState`, with one line that says what is missing, and what to do when the person can act there.
Check that the action exists on that surface before you name it.

| Instead of | Write |
| --- | --- |
| `No results` | `No files match "budget".` |
| `Nothing here yet` | `This folder is empty.` |

A Home section with nothing in it keeps its header and shows one muted line under it, not `EmptyState`: `No pages yet.`
The header's + is that line's Next, so the line names a Next only when the header has none, as Apps does.
The line is not a keyboard stop. The header's toggle reads it as its description.
In a workspace of your own, Pages, Collections and Apps always show. A share view shows only the kinds it holds. While a section's list is still being read, it holds one row's height and shows no line, so it never says it is empty too soon.

### Agents

- Finished work: past tense, with a count when the count means something. `Updated 3 files`. Never invent a count.
- Work in progress: the concrete action, with the count when it is known. `Reading 40 files`, not `Working on it…`.
- When more can load, show the loaded count as a lower bound, `49+`, read aloud as "49 or more files". Never show a loaded count as the total.
- Waiting on the person: the reason. `Waiting for your review`.
- Attribution: `Edited by agent`. No invented names or personalities. Use first person only when the agent itself is speaking.
- Say what the agent did, not that it understood, decided, or thought.

### Deletes and other actions that lose work

- Name the exact thing and count: `Delete 12 files from Research?`
- State the true recovery path. Check it in the code first.
- In a workspace, a deleted file goes to the system trash, or to `.dohc/local/trash` when the system trash refuses it. Name both locations. If neither takes the file, dohc refuses the delete.
- A shared copy has no trash. Say who still has the file and how to take the change back.
- Write `This cannot be undone` only after you confirm it is true.
- Label the confirm button with the verb, such as `Delete files`, never `OK`.
- Use `DangerButton` for the confirm button.
- Never ask only `Are you sure?`.

### Before and after

| Before | After |
| --- | --- |
| `Your changes have been successfully saved!` | `Saved` |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.`, with a **Try again** control |
| `The document was unable to be loaded by the editor` | `The editor could not open this file.` |
| `AI is analyzing your workspace…` | `Agent is reading 40 files.` |

### When shipping copy disagrees

Existing strings do not all follow these rules, and some surfaces use two words for one thing.
The editor's link picker says `page links` in its accessible name and `No files match` in its empty state.
Settle the word across every surface before you change any string.
A copy fix changes visible words only, so keep the `data-testid`, `aria-*`, `role`, and accessible name.
When a list waits on a cause, say what the list will show once the cause is fixed.
Do not reuse another surface's question.
Signed out, the Sharing view's **Shared with me** says `Connect a server to get what others share with you.`
About's Access asks who has access, so it keeps `Connect your server to check who has access.`
Name a server only when dohc knows it, in the interface font: `Not connected to example.com`.
`12 items` in the Explorer's delete dialog is correct, because a selection can mix files and folders.

## Dialogs, forms and inputs

A dialog asks about one action.
Show what the action will change, and write only what the person needs to decide.

### The card

Use `ConfirmDialog` for a dialog with one action: a title, at most one short sentence of body, then the buttons. An action that loses work can take two sentences.
The card's `p-6` and `gap-6` separate them, so add no dividers.
A divider only separates a fixed header or footer from a list that scrolls.

Every confirmation is the same card, 440px wide:

- A 32px tile holds the action's 16px glyph at the card's left, `rounded-lg`. A danger confirmation tints it `bg-danger-tint text-danger`; any other uses `bg-panel-2 text-muted`.
- The glyph names the action: `Trash2` for a delete, `Archive` for archive, `Eraser` for clear, `Layers` for a version.
- The text starts 44px in, after the tile and a 12px gap. The title, the body, lists, escape steps and the buttons all start at that edge.
- A confirmation that needs more than `ConfirmDialog`, such as a busy state or a dialog of its own, builds the same card from `ConfirmationCard`, `ConfirmationHead` and `ConfirmActions`, and passes `confirmPanel` to its `Overlay`. The panel takes focus as the dialog opens, so it carries the dialog's role, title and sentences, and the arrow and held-Enter keys.

- The title names the action and its object: `Merge version-1 into Main`, `Delete 12 files from Research?`.
- The body states the one fact the title and buttons leave out, such as what stays or what cannot come back. Most dialogs need none.
- For an action that loses work, the body can say what the action reaches beyond the title, then how to get it back, as [Deletes](#deletes-and-other-actions-that-lose-work) asks.
- If the fact is a set of things, show the names, the count, or the diff instead of a sentence about them.
- Never explain how a feature works, what it cannot do in general, or its release stage.
- If a limit changes what this action does, say what happens to the person's things: `2 files over 5 MB stay as they are.`

### Buttons

Put Cancel, then one primary, at the right. Nothing else sits in that row.
A step that saves something before the decision, such as `Save recovery file` or `Copy the record`, sits in the body beside the sentence that says what it keeps, as a row-size button (`ConfirmEscape`).
Name the primary with the title's verb: `Merge into Main`.
Use `DangerButton` when the action deletes something or loses work.
A disabled button keeps its shape and drops its color. A primary or danger confirm takes the `bg-line` fill; every kind shows its label and icon in `text-subtle`, with no hover. A danger confirm turns red only when pressing it will act.
An icon button has no label and its icon is already subtle at rest, so a disabled icon button dims to 40%.
Never label a button `OK`, `Yes`, or `Confirm`.
The safe choice reads **Cancel** when it cancels the action the person chose, such as Remove from list.
It reads **Go back** only on a warning about leaving typing or drawing changes that dohc has not kept, because it returns the person to that work: `Quit without your typing?`.

### Focus and keys

- If the dialog has a field, the first field takes focus.
- If it has none, a `ConfirmDialog` focuses its primary, so Enter runs it. If the primary waits for a choice in the dialog, the first control takes focus. Any other dialog focuses its panel.
- A `ConfirmDialog` that opens while someone types, in a field, editable text or an app's frame, focuses its panel, so their next Enter can't run the primary.
- In a `ConfirmDialog`, the arrow keys move between the buttons, and a held Enter does nothing.
- Give the panel `aria-labelledby` on its title and `aria-describedby` on its body's sentences, so a screen reader reads both. Lists and controls stay out of the description. A `ConfirmDialog` takes them in `details`.
- Enter in a single-line field runs the primary.
- Escape and Cancel close the dialog, except where the Dialog recipe says only its own buttons close it.
- When the dialog closes, focus goes back to the control that opened it.

### While the action runs

- The primary says what is happening, `Merging…`, and stays disabled. Add no status line.
- If closing doesn't stop the action, the secondary reads **Close** and takes focus.
- If the person can see the result, close the dialog.
- If they cannot, the title becomes the result, `Merged 4 files into Main`, above one `Done`.
- A failure shows in the dialog, as [Where messages go](#where-messages-go) says.

### Fields

- Put a label above each field, with no colon. Mark an optional field `Optional` after its label.
- A field edited in place, such as a rename in the tree, a page title or a property pill, uses its place as its label. It still needs an accessible name. For a required name, such as a file or folder, a blur with nothing typed cancels, and Enter with nothing typed shows the error. A page title or a property value can be left empty.
- A placeholder shows an example value or nothing. It never holds the instruction or the label.
- Check a field when focus leaves it or the person presses the primary. Never check on each key. A length limit can count down while they type.
- Show the error under the field with `FieldError`: `text-danger`, after a 12px `CircleAlert` on its first line. Say what is wrong and how to fix it: `Enter a name for the version.`
- Give the field `aria-invalid`, and point its `aria-describedby` at the error.
- Do not disable the primary to show that a field is empty or wrong. Pressing it shows the errors and focuses the first one.
- A disabled control says why, beside it or on its second line.

### Message boxes from main

Main asks some questions in the system's message box, such as before a quit loses typing.

- Show it with `showMessageBox` from `window/messageBox.ts`. It titles the box `dohc` and gives it push buttons, where Windows would draw command links.
- List the action first and the safe choice last: `Quit anyway`, `Go back`. Windows shows them in that order, and macOS reverses it.
- When the action loses work, make the safe choice the default and Escape's answer.
- Windows draws the box light in both themes. Leave it as the system draws it.

### Words in dialogs and explanations

The Words rules apply, and these too:

- Use no em or en dashes. End the sentence, or use a comma.
- Cut `please`, `simply`, `just`, `note that`, `make sure`, `currently`, `for now`, and `at the moment`.
- If dohc knows the answer, do not hedge with `may` or `might`.
- Do not start a sentence with a name a person chose, such as a version or a file. Put it later: `You can keep working in version-1.`
- Check every claim in the code before you write it. The merge dialog said versions cover only text files, but binary files merge too.

### Before and after: the merge dialog

| Before | After |
| --- | --- |
| `Everything version-1 changed will be brought into Main. version-1 stays as it is, so you can keep working in it. Your unsaved changes are saved first.` | `You can keep working in version-1.` The title already says Main gets the changes. |
| A divider, then `Versions cover text files during the alpha — other files stay exactly as they are. If Main changed in ways that clash with version-1, you'll choose what to keep, file by file.`, then a divider | Nothing. The first claim was false, and the conflict step shows itself when it comes. |
| A `Merging version-1 into Main…` paragraph | The primary reads `Merging…` |

The title, `Merge version-1 into Main`, and the buttons, Cancel and `Merge into Main`, stay.
The after also drops the sentence about unsaved changes, because saving first is what a person expects.

## Where messages go

| Situation | Where it goes |
| --- | --- |
| The whole workspace is unusable | A full-height state over the workbench, which goes inert |
| One thing failed, and the workspace still works | A toast at the bottom right, then a row in Notices until it is retried or dismissed |
| An update is available or downloaded | The Update button at the top right of the title bar. No toast and no row |
| Something finished out of sight, such as a background job | A toast at the bottom right that fades, and a row in Notices |
| An action whose result the person can see | No toast and no row |
| A control's own input is wrong | Inline, beside the control |

- Use these places. Do not add a new one for a new message.
- Report a cause once. When the title bar names the server as the problem, features that need the server, such as live editing, add no indicator, toast or row of their own. A state dohc is still fixing by itself shows at once where it lives, as a ring. Its toast and row come only once the ring has shown for 15 s.
- A dialog shows the failure of an action it started in place, above the button that retries it, and files no toast or row while it is open. If the dialog closed before the answer, the failure takes a toast and a row.
- Keep the toast and its row when it holds the only Undo for the change.
- Keep the workbench still when a message arrives. No bar slides in across the top.
- Toasts and Notices sit above every dialog. The bell does not: it dims with the rest of the window. Opening a dialog closes Notices.
- Give a message about something the person can retry a **Try again** control on the toast and the row.
- A message beside **Try again** does not end with its own `Try again.` sentence. An ending that says more stays: `Try again later.`, `…then choose Try again.`
- A toast's worded actions sit in a row under its text, as on its Notices row. This keeps the text wide. Keep the toast's close × at the top right.
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
- Let a repeat of the same message, or the same kind, replace its earlier row.
- A later success for the same thing takes back its failure's toast and row, whichever control started it.
- Where Restricted Mode holds something back, show its band at the top of the pane or card it holds back. Disable the controls that would start it, with the band's words as their reason.
- Closing a toast keeps its row. Dismissing the row removes it.
- A row in Notices stays unread until the pointer or keyboard focus reaches it, the person presses **Mark all read**, or the person opens what the row is about. Taking the row's own step, such as Open note, also reads it. Reading a row closes its toast and keeps the row.
- A Notices row opens what it is about. A click, Enter or Space on the row goes where its Open or Review action goes, and reads the row. A row whose actions only change state, such as **Try again**, opens where the problem is, or nowhere. Opening a row never retries, sends, installs or deletes.
- A row with nowhere to go has no pointer, hover fill, role or Tab stop. Arrow keys still reach it, so the keyboard can read and dismiss it.
- A row's own actions and icon controls do only what they name, and never also open the row.
- When what a row is about is gone, its text becomes `dohc could not find this chat.` or `dohc could not find this file.`, and the row stops opening, with no toast and no navigation.
- On a row that opens, **Show more** expands clipped text, and a click on the text opens the row.
- A held change or refused save whose row is still unread shows its toast again each time dohc starts. Reading its row stops that.
- F6 moves focus to the first worded action, such as **Try again**, on the toast that appeared last. With no worded action, it lands on **Details**, and with neither, on the toast.
- A row has a dismiss × only when dismissing it acknowledges something that is over. A row about something still wrong, such as **History paused** or **Couldn't confirm this workspace's account**, has no × and stays until it ends.
- **Clear**, beside **Mark all read**, dismisses every row that has a ×, under **On this computer** and **Sent to you**, and shows only while such a row exists. Two kinds stay: a row that holds the only Undo for a change, and set-aside edits, whose Dismiss deletes the text for good.
- Clear leaves one line at the top of the list, `Cleared 7 notices`, with **Undo**, and moves focus to Undo. The line stays until Notices closes. dohc dismisses the rows only then, so Undo brings back exactly what was cleared. Opening a dialog closes Notices too, which commits them. If dohc quits first, the cleared rows come back at the next start, because their Undo was still open. A dismissal that fails brings its row back.
- A row keeps its title line for the icon controls, copy and dismiss. Its worded actions, such as **Try again**, sit on a line under its text.
- A row shows two lines of title and three of text. Offer **Show more** for the rest, and open it in place, wrapped and selectable.
- In a title, say what happened before any name. Put names last and cut them to fit, so the clamp cuts only a name.
- When the text has one fact per line, show its first three facts whole instead of three lines. Show the count of facts it leaves out only after **Show more**.
- If an untitled message would run past two lines, give it a title that says what happened and a body with why and the Next, so the clamp never hides the Next.
- Write a refusal to fit two lines: what failed, then the one thing to do. The cause goes in its details.
- Restarting or closing the app asks once, in one dialog.
- Report errors through the shell's `reportError` callback instead of rendering them yourself, except a dialog's own action, as above.
- If a list could not load, say so in its place in one line, with Try again. Pass the line as `RetryRow`'s children.
- Keep the cause and Copy details in the toast and the Notices row, not in the list.

## Controls

A dohc control does the action it names. No control opens a prompt box for an agent. People ask their agents in their own tools or in dohc chat, and an automation they build may message their agent. An agent reaches the same action through the CLI or MCP.

The look in one line: warm paper, quiet graphite, one sans for every word of the interface, serif for brand moments, and color only for meaning.

Use `DohcMark` for the mark, `DohcWordmark` for the name, and `DohcLockup` for both. They live in `packages/brand/src/DohcLogo.tsx`.
The mark is an SVG in `currentColor`, with no gradient, shadow, or badge.

Compose the controls in `apps/desktop/src/renderer/ui/controls.tsx` first: `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton`, `IconButton`, `Pill`, `SectionLabel`, `EmptyState`, `RetryRow`, and `FieldError`.
To inline a control's classes, copy them from that file.
Use the recipes below only for parts it does not cover.

### Tokens

Never write hex or Tailwind palette colors (`zinc-*`, `blue-*`, `black`, `white`) in components.

| Utility | Use |
| --- | --- |
| `bg-bg` | Paper: editors, inputs, popover tiles |
| `bg-panel` | Chrome: title bar, rails, sidebars, tab strip, cards, menus |
| `bg-panel-2` | Insets in the chrome: pills, counts, segmented tracks, inline code, section bands |
| `hover:bg-hover` | Hover fill |
| `bg-selected` | Selected row fill |
| `bg-scrim` | The dim behind a modal |
| `border-line` | Every hairline, always 1px |
| `text-ink` | Primary text |
| `text-muted` | Secondary text, such as labels and inactive items |
| `text-subtle` | Decorative text only: hints, timestamps, kbd |
| `bg-accent`, `text-accent` | The brand accent: primary buttons, checked and active states, keyboard focus |
| `bg-agent`, `text-agent` | The default agent color |
| `bg-match`, `text-match` | Find-match highlight only |
| `text-success`, `text-warning`, `text-danger` | State only |
| `bg-danger-fill`, `text-on-danger` | A danger confirm's fill and label. Dark has its own deeper fill, so never put `text-danger` text on it |
| `bg-line` as a fill | A disabled primary or danger confirm |
| `bg-danger-tint` | The tile behind a danger confirmation's glyph, and nothing else |

A surface or list whose read failed, so it shows nothing, takes danger. When some of its sources didn't load beside others that did, what's missing takes warning. Work dohc is holding or has paused takes warning where it waits, such as History paused in History's pane. The notice that reports the failure behind it is an error, so it takes danger. What the person's own rules or a list's limit leave out, such as a file History no longer tracks, takes the plain mark. A list's limit goes in a `bg-panel-2` band above its rows, never in a row, and its whole sentence shows: how many the list includes, and how to see the rest. An item that is broken, such as an automation dohc can't read, takes danger wherever it sits.

### Type

| Role | Classes |
| --- | --- |
| Body, rows, inputs | `text-[13px]` |
| Dense secondary text | `text-[12px] text-muted` |
| Hints, timestamps, shortcuts | `text-[12px] text-subtle` |
| Section labels | `dohc-section-label`: `text-[12px] font-medium text-subtle`, in sentence case |
| Page and dialog titles | `text-base font-semibold text-ink` |
| Panel titles, and section headings on a page | `text-sm font-semibold text-ink` |
| Brand moments, such as the first-run headline | `font-serif`, rarely |
| Code and Markdown source | `font-mono` |

Set small text at 10, 11, 12, or 13px. Never write a fractional size such as `text-[10.5px]`.
Paths, counts, times, and shortcuts use the interface font. `<kbd>` defaults to mono, so give it `font-sans`.
Never uppercase a label.

Show a path on one line as its first folder, "…", its last folders and the name. Never cut the start of a name; put the full path in the tooltip.
`PathLine` in `ui/PathLine.tsx` draws it.
When a row is too narrow for a whole name, cut the name in the middle and keep its extension: `product-pl….md`. When two rows in one list have the same name, show the folder before it: `plans/notes.md`.
When a line holds a name beside other words, such as who made a change, the other words give way first, each down to a 48px floor, and the name keeps its room longest.

When the title bar is crowded, Go to… and the Restricted Mode pill give way first. Each narrows to its icon and keeps its words as its tooltip and accessible name.
The Alpha pill stays. The workspace and version names keep at least three letters and an ellipsis, with the full name in the tooltip.
Nothing in the title bar overlaps, and the buttons at its right never move.

### Radius and elevation

| Element | Radius |
| --- | --- |
| Inline chips, kbd | `rounded` (4px) |
| Buttons, inputs, list rows, menu items | `rounded-md` (6px) |
| Cards, menus, dropdowns, larger buttons | `rounded-lg` (8px) |
| Popovers, dialogs, modals | `rounded-xl` (12px) |
| Pills, dots, a person's avatar | `rounded-full` |

Use the classes in `styles.css` instead of writing shadows:

- `dohc-popover` for menus and floating chrome.
- `dohc-elevated` for dialogs and modal cards.
- `dohc-pop-in` as the entrance for every floating surface.
- `dohc-paper-grid` for a faint grid, in brand moments only.

Flat panels get borders, not shadows.

### Spacing

Space shows what belongs together. Take it from one scale and use it the same way on every screen.

The scale is 4, 8, 12, 16, 20, 24, 32, 40, and 48 px. In Tailwind these are `1`, `2`, `3`, `4`, `5`, `6`, `8`, `10`, and `12`.

- Take every gap, margin, and padding between things from the scale.
- Do not use half steps such as `gap-2.5` or `mt-0.5`, or arbitrary values such as `px-[7px]`, between things.
- Inside one control, follow its recipe. The recipes for inputs, kbd chips, pills, and segmented controls keep their own small values.

Closeness:

- Put things that belong together closer than things that do not.
- Make each level of grouping at least twice the gap of the level inside it. Rows in a list touch, and their height sets the rhythm.
- Put a heading closer to what it labels than to what comes before it.
- Separate sections with space, not a rule. Keep a rule only where it marks an edge you can drag, a band that scrolls, or the rows inside a card.

One left edge:

- In a column, start text, icons, headings, and fields at one left edge.
- In a panel, that edge is 12 px from the panel's side. Headers and section labels use `px-3`. A list uses `px-1`, and its rows use `px-2`.
- Let hover and selected fills hang outside the edge. Do not indent a row's text to make room for its fill.
- A section label starts on the edge. Its collapse chevron follows the label.
- A tree's first chevron starts on the edge. Each level indents so a child's icon starts where its parent's name starts.

Alignment:

- Put a label on the first line of its control, not at the middle of a control that wraps.
- Buttons side by side share one height and one text size.

Position:

- Anchor a page-like surface at a fixed top. Do not center it vertically, because content that loads later moves it.
- Every dialog uses `OverlayFrame`'s top anchor, so a dialog that loads a list, opens Details or grows keeps its title in place. `appearance="warning"` only puts the dialog above other dialogs and focuses its panel.
- Center only a short message that stands alone, such as an empty panel.

| Part | Spacing |
| --- | --- |
| Row in a panel, tree, or menu | `h-7` (28 px), `gap-2` between icon and label |
| Row in a picker or on a page | `h-8` (32 px), `gap-2` |
| Panel header | `h-9` (36 px), `px-3`, the same height as the tab strip |
| Panel content | Starts 8 px under the header |
| Section in a panel | `mt-4` (16 px) before it, except the first. Its label row is `h-6 px-3`, and the first row follows directly. |
| Icon button | `size-6` (24 px) in panels, rows, and toolbars. `size-7` in the title bar. `size-9` in the rail. Inside a line of text, use a plain `button` at `size-4` (16 px), so the line keeps its height. Give it `align-top` and a `text-muted` glyph, as on the Try again beside a count in Versions. `IconButton` stays 24 px even when given `size-4`. |
| Button | `h-8 px-3 text-[13px]` for `PrimaryButton`, `SecondaryButton`, and `DangerButton`. `h-7` compact, `h-6` in a row. `GhostButton` is `h-6 px-2 text-xs`, with `gap-2` after its icon. |
| Card | `p-3`, with `gap-2` inside |
| Popover | `p-3`. A menu's frame is `p-1`, because its rows bring their own `px-2`. |
| Dialog | `p-6` and `gap-6` between its parts. The title uses the page and dialog title role; its one-line description follows with `gap-1`. A section label sits 8 px over its fields. The buttons end the dialog, right-aligned, `gap-2` apart. No header or footer band. |
| Dialog with a preview | The title, fields, and buttons form the left column, `p-6`. The preview fills the right column from top to bottom on `bg-panel-2`, `p-6`. |
| Dialog that scrolls | Only a body that scrolls gets bands: header and footer `px-6 py-4` with a rule, body `p-6`. |
| Settings page | `px-12 pt-10`, as wide as the page column. The page title is 24 px over the first section. |
| Settings section | `SettingsSection`: a heading in the panel title role, 8 px over a card. Sections sit 32 px apart. A page with one group has one card and no heading. |
| Settings row | `SettingRow`: `py-4` with a rule between rows. The name is `text-[13px] font-medium`; its description is `text-[12px] text-muted`, `mt-1` under it. Controls sit on the right and use the default button size; in a narrow pane they wrap under the name and start at its left edge. Reset appears left of them only when the value differs from its default. A row that can reset keeps Reset's place, so the controls never move or wrap when it appears. When they wrap, Reset's place stays at the end of the name's line. When the control is a list, its name and Reset sit beside the list's first row (`top`). |
| Empty state | `EmptyState`: `px-6`, then the picture, 12 px, one line, 16 px, at most one action. Do not build your own. |
| Toast and Notices row | `px-3 py-2`, `gap-2` |

### Recipes

Text input: `w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink`. Add `font-mono` for code.

List row (menus, trees, results): `flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75`.

- At rest: `text-muted hover:bg-hover hover:text-ink`.
- Active or selected: `bg-selected text-ink`. The active row adds `font-medium`. A picked row takes the picked fill, `bg-(--dohc-selection)`, instead.
- The picked fill marks the rows an action will act on, only in the list where they were picked. The open file has the selected fill and medium weight in every list. When it is also picked, it keeps the picked fill and gains a 2 px ink edge.
- If a row's name is content, such as a share's file, draw the name in `text-ink`. If the share ended or was removed, keep its name `text-muted`.
- Never fade a state fill, as in `bg-selected/85`. `tokens.test.ts` rejects it.
- Focus shows only while the person moves with the keyboard: Tab, Shift+Tab, the arrows, Home, End, Page Up, Page Down, and F6.
- `keyboardNavigation.ts` sets `data-keyboard-nav` on the root for those keys. A pointer press or any other key clears it.
- So a click, a dialog's first focus, and a shortcut such as Ctrl+P show no focus. Escape, Delete and Backspace leave the mark as it was, so closing or removing the focused thing from the keyboard still shows where focus went.
- A confirm dialog's buttons show the ring whenever Chromium's `:focus-visible` matches, so a dialog opened from the keyboard shows where Enter acts at once. Opened with the pointer, it shows the ring after the first Tab or arrow, as everywhere else.
- Give a row `dohc-focus-row`: the hover fill and a 1px accent line inside its edge. A selected row keeps its fill and adds the line.
- A row that opens one thing puts a button on its title, stretched over the row with `dohc-row-open`. The whole row then takes the `dohc-focus-row` mark and hover fill as one target, and the row's own controls sit above the stretch.
- Every other control wears the global halo, a 2px accent outline, 60% in light and 50% in dark, that follows its radius. Text fields keep their border and underline.
- Inside a scroller, draw a control's halo inset with `focus-visible:-outline-offset-2`. The row's line is already inset.
- To show keyboard focus another way, such as a fill or a layer, add the `keyboard:` variant before `focus-visible:`. Never draw a mark under a bare `focus-visible:`, except a confirm dialog's buttons, above.
- A menu opened with the pointer marks no row, and the hover fill follows the pointer. The first arrow key marks a row with the fill. Until a row is marked, Enter and Space mark the row the menu opened on, its checked row or else its first, and run nothing. A menu opened from the keyboard marks that row at once.
- In a panel, give the parent `px-1`.
- A disabled menu row says why on a second line under its label. Not in a tooltip. Pass it as the `MenuItem`'s `description`; the row dims its icon and label, not its fill.

Active option: when focus stays on a frame or input with `aria-activedescendant`, compose `MENU_ACTIVE_OPTION` from `ui/Menu.tsx`.
It draws the selected fill on the active option, where Enter acts, whether the keyboard or the pointer moved it. A list that also marks its current row with the fill, such as the tab overflow menu, Turn into and the callout type menu, adds the row's accent line while the keyboard moves. Compose `MENU_ACTIVE_OPTION_BESIDE_CURRENT` for it. A picker you type into, such as Go to, the command palette, / and [[, shows the fill only.

Card: `rounded-lg border border-line bg-panel p-3`. A modal card uses `rounded-xl p-6` and `dohc-elevated`.

Dialog: build it on `Overlay`. Cancel, the X, and Escape close it.
While closing would discard hand-written work, as with open merge conflicts, only the dialog's own buttons close it.
A press outside a dialog does nothing, so a stray click cannot discard what a person typed.
Pickers and popovers close on a press outside: the command palette, quick open, menus, and an action's Run or Cancel question. They hold nothing worth keeping.
Settings closes on a press outside too, because each field saves when the person leaves it. A field that can't save yet sets `data-unsaved` and says why beside it. The press then keeps Settings open and focuses that field.
A press closes one surface, as Escape does, and an edit in place takes the first Escape. A press that closes a menu leaves its dialog open, and a press that starts inside the panel never closes it.
Pass `closeOnBackdrop` to `Overlay` only for these.

Segmented control: track `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs transition-colors`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`.

Kbd chip: `rounded border border-line bg-bg px-1 font-sans text-[11px] text-subtle`.

Empty state: when a panel or page has nothing yet, `EmptyState` shows a picture of what it holds once it has items, one `text-[13px] text-muted` line, and at most one compact action. Use `PrimaryButton` only when making the thing is the surface's job. A failure keeps its warning glyph and Try again, never a picture. An empty section inside a surface with other content stays one muted line.

`Pill` changes meaning through its `tone`, which swaps the text color and keeps the fill.

### Agent attribution

An agent's avatar is a rounded square (`rounded-lg`, or `rounded` at the 18px size). A person's avatar is round.
Shape is the cue, because a person can choose each agent's color. The default color is the `agent` token.
Give every agent mark a text alternative, as `AgentBadge` does.
`AgentName` and `AgentBadge` color the name and sparkle beside an avatar to match it. An agent label with no avatar uses `text-agent`.
A running agent shows a 6px round `bg-agent` dot.

### Chat

A question's status is words and an icon, never a pill. An open question without options shows Answer beside it.

### Motion

- Hover and press: `transition-colors` at 75 to 100ms.
- Real movement, such as expanding or sliding: 120 to 180ms ease-out. Panels take 220 to 280ms. No bounce.
- Floating surfaces enter with `dohc-pop-in`. Nothing else animates on mount.
- Reduced motion is handled globally. Never write an inline `animation` that bypasses it.
- Landing on what a person asked to see, such as a heading from the outline or a message from Notices, washes it once with `dohc-target-flash` after the scroll settles, and moves focus to it. With reduced motion, the wash shows and clears without fading.

### Hard rules

- End-to-end tests pin every `data-testid`, `aria-*`, `role`, and accessible name. Rewording and restyling keep them. A surface can become something else, such as the right panel changing from Chats to About. Then change them in the same PR as the tests that read them.
- Surface work adds no dependencies, no `any`, and no `styles.css` edits. Propose a new shared pattern instead of inlining it.
- Use lucide-react icons only, at 12 to 18px, with `strokeWidth={1.9}` at rail size.
- Keep the global halo and `dohc-focus-row`, and draw no focus ring of your own. Add `outline-none` only where the part shows focus another way, and name that way in a comment. The command palette's frame shows it with `focus-within:border-ink`, and a menu row with its fill, plus its line beside a current row. A dialog's panel never wears the halo: it holds focus only until Tab reaches its controls, which show their own.
- Keep body text at 4.5:1 or more and decorative text at 3:1 or more against its surface. Keep every focus mark at 3:1 or more against the surface under it.

## The phone app

The phone app (`apps/mobile`) uses this skill's words and behavior. Shared words come from `@dohc/interface-words`, never copied. A phone word or behavior that differs from the desktop is listed here, with its reason, in the PR that introduces it. A difference that changes what another surface shows needs Ice's decision first. The phone does each difference below on purpose.

### Platform

- Touch targets are at least 44 pt.
- Use the system's tab bar, navigation, large titles, sheets, and haptics on iOS, and Material's on Android.
- Body text is 17 pt, with Dynamic Type. The system font is a listed difference.
- Use SF Symbols only where iOS draws the control. Use lucide for dohc's own content.
- A confirmation is an action sheet or a system alert, with the desktop's words. Delete, Forget, Leave, and Remove use the destructive style, including in a long-press menu.
- Every swipe and long-press has a visible control that does the same thing.
- Toasts sit at the bottom, in 16 pt gutters above the tab bar or the composer, on a solid surface, with a visible ×.
- The composer docks to the keyboard.
- There are no tooltips.

### Surfaces

1. **Clamps.** Toast titles take 4 lines and Notices row titles 3, where the desktop takes 2. A tap opens the rest in place, as the desktop's click or Show more does.
2. **Notices rows and VoiceOver.** A row is one element. Its actions are in the rotor in this order: the worded action, Copy, Dismiss. The spoken time is in full ("2 minutes ago"); on screen it is the desktop's ("2m ago").
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

Browser alerts gain the message text after phone push lands (Ice, Nov 9).

## Before you finish

1. Is the surface's one job obvious, and does it carry the most visual weight?
2. Does every border earn its place? Prefer space and background steps to boxes inside boxes.
3. Are hover, active, focus-visible, disabled, empty, loading, and error states all there?
   Loading: the header shows at once. The skeleton under it stays blank for its first 150 ms, so a fast read never flashes, then stays until the answer comes, with no deadline. Only an error answer shows Try again.
4. Is every visible string as short as it can be, with further detail behind a hover or a click?
5. Does each string do one job, does every error give a Next, and does every empty state give one when the person can act there?
6. Does every noun match the surrounding UI?
7. Read each string as someone whose sync just failed. Does it help them?
8. Would Notion or Linear ship it? If not, it is not done.
