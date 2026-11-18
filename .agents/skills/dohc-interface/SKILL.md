---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app or phone app: a label, button, menu item, error, empty state, toast, dialog, or panel. Also use when choosing a token, class recipe, or control in the renderer.
---

# dohc's interface

Write in plain and simple language. A person reads these words in the middle of a task, sometimes worried, and can't ask what they mean.

Read the code for values and this skill for meaning. Before you pick a control, token, size, spacing, or recipe, read [`controls.md`](controls.md). For the phone app, also read [`apps/mobile/AGENTS.md`](../../../apps/mobile/AGENTS.md).

## Show first

A person should see what a surface is, its state, and what to do next before they read a word. Use words only for the person's own content and for facts a picture can't show, such as an error's cause or who can see the work.

To test a surface, hide every word that isn't the person's content. If the purpose, state, or next click disappears, show it with an icon, position, shape, or color.

| Instead of | Show |
| --- | --- |
| A type label (`DOCUMENT`) | The file's icon |
| The same status twice | One mark in one place |
| A helper sentence under a control | A live preview, or a tooltip |
| A scope tag on every row | One heading per group |
| Prose about what changed | A number, a bar, or the changed words highlighted |
| A label saying who is an agent | The agent's square avatar |

- Every icon-only control has an accessible name and a tooltip.
- Different states get different marks.
- Color always comes with a shape, an icon, or a position.
- Use the lucide icon people already know for the action.

## Words

Use as few words as you can. Put the rest behind a tooltip, a **Details** disclosure, or a **Learn more** link to a page that exists.

Most strings do one job:

| Job | Example |
| --- | --- |
| State: what is true now | `3 files changed on this machine` |
| Change: what just happened | `Moved 4 files to Archived` |
| Ready: something can be used | `Agent result, ready to review` |
| Next: what the person can do | `Choose which copy to keep` |

- Call a thing what the rest of the UI calls it. Never show an internal name.
- Keep words literal. No metaphors, jokes, exclamation marks, emoji, or hype such as `seamless` or `powered by AI`.
- Use sentence case: `New folder`. No period on labels and buttons.
- Name who acted: `dohc could not reach the relay`, not `The relay could not be reached`.
- Label a button with its verb, never `OK`, `Yes`, or `Confirm`.
- Use numerals for counts: `Delete 12 files`. If more can load, add `+`: `24+`.
- No em or en dashes. Cut `please`, `simply`, `just`, and `currently`. Don't hedge with `may` when dohc knows.
- Check every claim in the code before you write it.

| Before | After |
| --- | --- |
| `Your changes have been successfully saved!` | `Saved` |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.`, with **Try again** |

**Errors** say what happened, why if dohc knows, and what to do next. Leave out what you don't know. Never show only an error code, blame the person, or apologize. Write `could not`, not `couldn't`.

**Empty states** use `EmptyState` with one line: `No files match "budget".`, not `No results`. If the line names an action, make sure that action exists there.

**Agents.** Finished work is past tense: `Updated 3 files`. Work in progress names the action: `Reading 40 files`, not `Working on it…`. Waiting names the reason: `Waiting for your review`. Say what the agent did, never that it thought. Never invent a count or a name.

**Deletes and other actions that lose work** name the thing and the count: `Delete 12 files from Research?` Say how to get it back, after you check the code. A deleted workspace file goes to the system trash, or to `.dohc/local/trash` if the system trash refuses it. Write `This cannot be undone` only when it's true. The confirm button is a `DangerButton` with the verb. Never ask only `Are you sure?`.

## Where messages go

| Situation | Where it goes |
| --- | --- |
| The whole workspace is unusable | A full-height state over the workbench |
| One thing failed, and the workspace still works | A toast at the bottom right, then a Notices row |
| An update is ready | The Update button in the title bar only |
| Something finished out of sight | A toast that fades, and a Notices row |
| The person can see the result | Nothing |
| A control's own input is wrong | Beside the control |

Don't add a new place.

- Report errors through the shell's `reportError`.
- Report each cause once. If the title bar says the server is down, features that need it say nothing more.
- A dialog shows its own action's failure inside the dialog, above the button that retries it. It files a toast and a row only if the dialog closed first.
- Anything the person can retry gets **Try again** on the toast and the row.
- Put a Copy icon beside text a person might report. If the copy holds more than what shows, use a **Details** action instead.
- A later success clears the failure's toast and row.
- A Notices row opens what it is about. Opening never retries, sends, or deletes.
- A list that couldn't load says so in one line with Try again, through `RetryRow`.

## Dialogs and forms

- Use `ConfirmDialog`: a title, at most one short sentence, then the buttons. An action that loses work can take two sentences.
- The title names the action and its object: `Merge version-1 into Main`. The body says only what the title and buttons leave out. Most dialogs need no body. Never explain how a feature works.
- Put Cancel, then one primary button, at the right. Name the primary with the title's verb: `Merge into Main`.
- The first field takes focus, or the primary if there is no field. Escape closes the dialog, and focus returns to what opened it.
- While the action runs, the primary says what is happening, `Merging…`, and stays disabled.
- Put a label above each field, with no colon. A placeholder shows an example or nothing.
- Check a field when focus leaves it or the person presses the primary, not on each key. Show the error under it with `FieldError` and set `aria-invalid`. Don't disable the primary to signal an error.
- A disabled control says why next to it.

## Hard rules

- End-to-end tests depend on every `data-testid`, `aria-*`, `role`, and accessible name. Keep them when you reword or restyle. If a surface becomes something else, update them and their tests in the same PR.
- UI work adds no dependencies, no `any`, and no `styles.css` edits. Propose a shared pattern instead of inlining one.
- Use lucide-react icons only, at 12 to 18px.
- Keep the global focus halo and `dohc-focus-row`. Draw no focus ring of your own.
- Body text needs 4.5:1 contrast. Decorative text and focus marks need 3:1.

## Redesigns

- Finish one section before you redesign the rest.
- Make the preview match the live UI. Keep content usable while visuals load, and pause animation offscreen.

## Before you finish

1. Is the surface's one job obvious, and does it stand out most?
2. Does every border earn its place? Prefer space and background steps to boxes in boxes.
3. Are hover, active, focus, disabled, empty, loading, and error states all there? A loading skeleton stays blank for its first 150 ms, so a fast load never flashes.
4. Is every string as short as it can be?
5. Does every error, and every empty state where the person can act, say what to do next?
6. Does every noun match the rest of the UI?
7. Read each string as someone whose sync just failed. Does it help?
8. Would Notion or Linear ship it? If not, it isn't done.
