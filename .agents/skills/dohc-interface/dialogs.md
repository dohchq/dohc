# Dialogs, forms and inputs

A dialog asks about one action.
Show what the action will change, and write only what the person needs to decide.
[`words.md`](words.md#dialogs-and-explanations) holds the rules for a dialog's words.

## The card

Use `ConfirmDialog` for a dialog with one action: a title, at most one short sentence of body, then the buttons. An action that loses work can take two sentences.
The card's spacing separates them, so add no dividers.
A divider only separates a fixed header or footer from a list that scrolls.

Every confirmation is the same card. `ConfirmationCard` in [`ui/ConfirmDialog.tsx`](../../../apps/desktop/src/renderer/ui/ConfirmDialog.tsx) holds its width, its tile and the tile's tint, and its one text column.

- The glyph in the tile names the action: `Trash2` for a delete, `Archive` for archive, `Eraser` for clear, `Layers` for a version.
- Put the title, the body, lists, escape steps and the buttons in the text column, so all start at one edge.
- If a confirmation needs more than `ConfirmDialog`, such as a busy state or a dialog of its own, compose `ConfirmationCard`, `ConfirmationHead` and `ConfirmActions`. Pass `confirmPanel` to its `Overlay` as `panelProps`. The panel takes focus as the dialog opens, so it carries the dialog's role, title and sentences, and the arrow and held-Enter keys.

What the card says:

- The title names the action and its object: `Merge version-1 into Main`, `Delete 12 files from Research?`.
- The body states the one fact the title and buttons leave out, such as what stays or what cannot come back. Most dialogs need none.
- For an action that loses work, the body can say what the action reaches beyond the title, then how to get it back, as [Deletes](words.md#deletes-and-other-actions-that-lose-work) asks.
- If the fact is a set of things, show the names, the count, or the diff instead of a sentence about them.
- Never explain how a feature works, what it cannot do in general, or its release stage.
- If a limit changes what this action does, say what happens to the person's things: `2 files over 5 MB stay as they are.`

## Buttons

Put Cancel, then one primary, at the right. Nothing else sits in that row.
A step that saves something before the decision, such as `Save recovery file` or `Copy the record`, sits in the body beside the sentence that says what it keeps, as a row-size button (`ConfirmEscape`).
Name the primary with the title's verb: `Merge into Main`.
A disabled button keeps its shape and drops its color. A primary or danger confirm takes the `bg-line` fill; every kind shows its label and icon in `text-subtle`, with no hover. A danger confirm turns red only when pressing it will act.
An icon button has no label and its icon is already subtle at rest, so a disabled icon button dims to 40%.
The safe choice reads **Cancel** when it cancels the action the person chose, such as Remove from list.
It reads **Go back** only on a warning about leaving typing or drawing changes that dohc has not kept, because it returns the person to that work: `Quit without your typing?`.

## Focus and keys

- If the dialog has a field, the first field takes focus.
- If it has none, a `ConfirmDialog` focuses its primary, so Enter runs it. If the primary waits for a choice in the dialog, the first control takes focus. Any other dialog focuses its panel.
- A `ConfirmDialog` that opens while someone types, in a field, editable text or an app's frame, focuses its panel, so their next Enter can't run the primary.
- In a `ConfirmDialog`, the arrow keys move between the buttons, and a held Enter does nothing.
- Give the panel `aria-labelledby` on its title and `aria-describedby` on its body's sentences, so a screen reader reads both. Lists and controls stay out of the description. A `ConfirmDialog` takes them in `details`.
- Enter in a single-line field runs the primary.
- Escape and Cancel close the dialog, except where [Closing](#closing) says only its own buttons close it.
- When the dialog closes, focus goes back to the control that opened it.

## While the action runs

- The primary says what is happening, `Merging…`, and stays disabled. Add no status line.
- If closing doesn't stop the action, the secondary reads **Close** and takes focus.
- If the person can see the result, close the dialog.
- If they cannot, the title becomes the result, `Merged 4 files into Main`, above one `Done`.
- A failure shows in the dialog, as [`messages.md`](messages.md#when-to-report) says.

## Closing

Build a dialog on `Overlay`. Cancel, the X, Escape, and a press outside close it.
A press outside does what Escape does, through the same `onClose`. While a dialog must not close, such as while it saves or while closing would discard open merge conflicts, its `onClose` does nothing, so only its own buttons close it.
A field that can't save yet sets `data-unsaved` and says why beside it. A press outside then keeps the dialog open and focuses that field.
A press closes one surface, as Escape does, and an edit in place takes the first Escape. A press that closes a menu leaves its dialog open, and a press that starts inside the panel never closes it.

## Layout

Every dialog uses `OverlayFrame`'s top anchor, so a dialog that loads a list, opens Details or grows keeps its title in place. `appearance="warning"` only puts the dialog above other dialogs and focuses its panel.

| Part | Spacing |
| --- | --- |
| Dialog | `p-6` and `gap-6` between its parts. The title uses the page and dialog title role; its one-line description follows with `gap-1`. A section label sits 8 px over its fields. The buttons end the dialog, right-aligned, `gap-2` apart. No header or footer band. |
| Dialog with a preview | The title, fields, and buttons form the left column, `p-6`. The preview fills the right column from top to bottom on `bg-panel-2`, `p-6`. |
| Dialog that scrolls | Only a body that scrolls gets bands: header and footer `px-6 py-4` with a rule, body `p-6`. |

## Fields

- Put a label above each field, with no colon. Mark an optional field `Optional` after its label.
- A field edited in place, such as a rename in the tree, a page title or a property pill, uses its place as its label. Give it an accessible name.
- If an in-place field holds a required name, such as a file or folder, an empty blur cancels the edit. An empty Enter shows the error. A page title or a property value can be left empty.
- A placeholder shows an example value or nothing. It never holds the instruction or the label.
- Check a field when focus leaves it or the person presses the primary. Never check on each key. A length limit can count down while they type.
- Show the error under the field with `FieldError`: `text-danger`, after a 12px `CircleAlert` on its first line. Say what is wrong and how to fix it: `Enter a name for the version.`
- Give the field `aria-invalid`, and point its `aria-describedby` at the error.
- Do not disable the primary to show that a field is empty or wrong. Pressing it shows the errors and focuses the first one.
- A disabled control says why, beside it or on its second line.

## Message boxes from main

Main asks some questions in the system's message box, such as before a quit loses typing.

- Show it with `showMessageBox` from `window/messageBox.ts`. It titles the box `dohc` and gives it push buttons, where Windows would draw command links.
- List the action first and the safe choice last: `Quit anyway`, `Go back`. Windows shows them in that order, and macOS reverses it.
- When the action loses work, make the safe choice the default and Escape's answer.
- Windows draws the box light in both themes. Leave it as the system draws it.
