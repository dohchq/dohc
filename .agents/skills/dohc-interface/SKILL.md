---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app or phone app: a label, button, menu item, error, empty state, toast, dialog, or panel. Also use when choosing a token, class recipe, or control in the renderer.
---

# dohc's interface

Write in plain and simple language. A person reads these words in the middle of a task, sometimes worried, and can't ask what they mean.

Read the code for values and this skill for meaning. Before you choose a control, token, type size, spacing, or recipe, read [`controls.md`](controls.md). For the phone app, also read [`apps/mobile/AGENTS.md`](../../../apps/mobile/AGENTS.md).

## Show first

A person should see what a surface is, its state, and what to do next before they read a word. Use words only for the person's own content and for facts a picture can't show, such as an error's cause or who can reach the work.

To test a surface, hide every word that isn't the person's content. If the purpose, state, or next click disappears, show it with an icon, position, shape, or color.

| Instead of | Show |
| --- | --- |
| A type label (`DOCUMENT`) | The file's icon |
| The same status twice | One mark in one place |
| A helper sentence under a control | A live preview of its effect, or a tooltip |
| A scope tag on every row | One group heading per scope |
| Prose about what changed | A number, a bar, or the changed words highlighted |
| A label saying who is an agent | The agent's square avatar |

- Every icon-only control has an accessible name and a tooltip.
- Distinct states keep distinct marks.
- An error keeps its sentence. The icon marks it, and the words explain it.
- Color always comes with a shape, an icon, or a position.
- Use the lucide icon people already know for the action.

## Words

Use as few words as possible in anything a person sees without a hover or a click. Put more behind a tooltip, a **Details** disclosure, or a **Learn more** link to a page that exists.

Most strings do one job:

| Job | Example |
| --- | --- |
| State: what is true now | `3 files changed on this machine` |
| Change: what just happened | `Moved 4 files to Archived` |
| Ready: something became usable | `Agent result, ready to review` |
| Next: what the person can do | `Choose which copy to keep` |

- Call a thing what the surrounding UI calls it, every time. Never show an internal name. Check both the code and the shipping UI.
- Keep words literal. No metaphors, jokes, exclamation marks, emoji, or promises such as `seamless`, `smart`, or `powered by AI`.
- Use sentence case: `New folder`. Leave the period off labels and buttons.
- Use the active voice and name who acted: `dohc could not reach the relay`, not `The relay could not be reached`.
- Never label a button `OK`, `Yes`, or `Confirm`. Use the verb.
- Use numerals for counts: `Delete 12 files`. If more can load, show the loaded count with `+`: `24+`.
- Use no em or en dashes. Cut `please`, `simply`, `just`, `note that`, and `currently`. If dohc knows, don't hedge with `may`.
- Check every claim in the code before you write it.

| Before | After |
| --- | --- |
| `Your changes have been successfully saved!` | `Saved` |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.`, with **Try again** |

**Errors** say what happened, why if dohc knows, and what to do next, in that order. Leave out a part you don't know. Never show a raw error code alone, blame the person, or apologize. Write `could not`, not `couldn't`.

**Empty states** use `EmptyState` with one line that says what is missing: `No files match "budget".`, not `No results`. If the line names an action, check that the action exists there.

**Agents.** Finished work is past tense: `Updated 3 files`. Work in progress names the action: `Reading 40 files`, not `Working on it…`. Waiting names the reason: `Waiting for your review`. Say what the agent did, never that it thought or decided. Never invent a count or a name.

**Deletes and other actions that lose work** name the exact thing and count: `Delete 12 files from Research?` State the real way back, checked in the code. A deleted workspace file goes to the system trash, or to `.dohc/local/trash` if the system trash refuses it. Write `This cannot be undone` only when it is true. The confirm button is a `DangerButton` labeled with the verb. Never ask only `Are you sure?`.

## Where messages go

| Situation | Where it goes |
| --- | --- |
| The whole workspace is unusable | A full-height state over the workbench |
| One thing failed and the workspace still works | A toast at the bottom right, then a Notices row until it is retried or dismissed |
| An update is ready | The Update button in the title bar only |
| Something finished out of sight | A toast that fades, and a Notices row |
| The person can see the result | Nothing |
| A control's own input is wrong | Inline, beside the control |

Use these places. Don't add a new one.

- Report errors through the shell's `reportError`, not by rendering them yourself.
- Report each cause once. If the title bar already says the server is down, features that need it add nothing.
- A dialog shows a failure of its own action in place, above the button that retries it. It files a toast and a row only if it closed first.
- Give anything the person can retry a **Try again** control on the toast and the row.
- Put a Copy icon beside text a person might report, such as a command. If the copy holds more than what shows, give the message a **Details** action instead, so people see what they copy.
- A later success for the same thing removes its failure's toast and row.
- A Notices row opens what it is about. Opening never retries, sends, or deletes.
- A list that could not load says so in its place in one line, with Try again, through `RetryRow`. The cause goes in the toast and the row.

## Dialogs and forms

- A dialog asks about one action. Use `ConfirmDialog`: a title, at most one short sentence of body, then the buttons. An action that loses work can take two sentences.
- The title names the action and its object: `Merge version-1 into Main`. The body says only the one fact the title and buttons leave out. Most dialogs need none. Never explain how a feature works.
- Put Cancel, then one primary, at the right. Name the primary with the title's verb: `Merge into Main`.
- The first field takes focus. With no field, the primary does. Escape and Cancel close the dialog, and focus goes back to the control that opened it.
- While the action runs, the primary says what is happening, `Merging…`, and stays disabled.
- Put a label above each field, with no colon. A placeholder shows an example or nothing, never the instruction.
- Check a field when focus leaves it or the person presses the primary, not on each key. Show the error under it with `FieldError` and set `aria-invalid`. Don't disable the primary to show that a field is wrong.
- A disabled control says why, beside it or on its second line.

## Hard rules

- End-to-end tests pin every `data-testid`, `aria-*`, `role`, and accessible name. Rewording and restyling keep them. If a surface becomes something else, change them in the same PR as the tests that read them.
- Surface work adds no dependencies, no `any`, and no `styles.css` edits. Propose a new shared pattern instead of inlining one.
- Use lucide-react icons only, at 12 to 18px.
- Keep the global focus halo and `dohc-focus-row`. Draw no focus ring of your own.
- Keep body text at 4.5:1 contrast or more, and decorative text and focus marks at 3:1 or more.

## Redesigns

- Finish one representative section before you extend a broad redesign.
- Match preview and live visuals. Keep content useful while visuals load, and pause animation offscreen.

## Before you finish

1. Is the surface's one job obvious, and does it carry the most visual weight?
2. Does every border earn its place? Prefer space and background steps to boxes inside boxes.
3. Are hover, active, focus, disabled, empty, loading, and error states all there? A loading skeleton stays blank for its first 150 ms, so a fast read never flashes.
4. Is every visible string as short as it can be?
5. Does every error, and every empty state where the person can act, give a Next?
6. Does every noun match the surrounding UI?
7. Read each string as someone whose sync just failed. Does it help them?
8. Would Notion or Linear ship it? If not, it is not done.
