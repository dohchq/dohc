# Words

[`SKILL.md`](SKILL.md) holds the rules for every string. These add to them.

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
- Never label a button `OK`, `Yes`, or `Confirm`.
- Use numerals for counts a person scans or acts on: `Delete 12 files`. Inside a sentence, a word can read better: `A file changed on two machines`.
- Beside a list, count every item the list holds, whatever its state. Include items in collapsed groups and past **Show more**. Do not count a row that only groups others, such as a folder in Pages. If more items remain to load, add `+`: `24+`.
- State the mechanism or say nothing. Cut promises such as `magically`, `just works`, `powered by AI`, `seamless`, `powerful`, and `smart`.
- Keep sync clearly opt-in. Sync starts off, and signing in alone does not turn it on.

## Errors

Write up to three parts, in this order. Leave out any part you do not know.

1. What happened, in the person's words for things.
2. Why, if dohc knows. Never guess.
3. What to do next, as an instruction or a control.

Never show a raw error code alone, blame the person, or apologize. `Sorry, something went wrong` says nothing.

Write `could not` in an error, not `couldn't`.

The sync strings show the standard: `A file changed on two machines`, `This machine doesn't have this file.`, and `One file has two copies.`

## Empty states

Use `EmptyState`, with one line that says what is missing. Do not build your own.
If the line names an action, check first that the action exists on that surface.
[`controls.md`](controls.md#recipes) says what `EmptyState` shows.

| Instead of | Write |
| --- | --- |
| `No results` | `No files match "budget".` |
| `Nothing here yet` | `This folder is empty.` |

A Home section with nothing in it keeps its header and shows one muted line under it, not `EmptyState`: `No pages yet.`
The header's + is that line's Next, so the line names a Next only when the header has none, as Apps does.
The line is not a keyboard stop. The header's toggle reads it as its description.
In a workspace of your own, Pages, Collections and Apps always show. A share view shows only the kinds it holds. While a section's list is still being read, it holds one row's height and shows no line, so it never says it is empty too soon.

## Agents

- Finished work: past tense, with a count when the count means something. `Updated 3 files`. Never invent a count.
- Work in progress: the concrete action, with the count when it is known. `Reading 40 files`, not `Working on it…`.
- When more can load, show the loaded count as a lower bound, `49+`, read aloud as "49 or more files". Never show a loaded count as the total.
- Waiting on the person: the reason. `Waiting for your review`.
- Attribution: `Edited by agent`. No invented names or personalities. Use first person only when the agent itself is speaking.
- Say what the agent did, not that it understood, decided, or thought.

## Deletes and other actions that lose work

- Name the exact thing and count: `Delete 12 files from Research?`
- State the true recovery path. Check it in the code first.
- In a workspace, a deleted file goes to the system trash, or to `.dohc/local/trash` when the system trash refuses it. Name both locations. If neither takes the file, dohc refuses the delete.
- A shared copy has no trash. Say who still has the file and how to take the change back.
- Write `This cannot be undone` only after you confirm it is true.
- Label the confirm button with the verb, such as `Delete files`.
- Use `DangerButton` for the confirm button.
- Never ask only `Are you sure?`.

## Dialogs and explanations

These rules add to the rest for the words of a dialog and of any explanation.
[`dialogs.md`](dialogs.md) says what a dialog's title, body and buttons hold.

- Use no em or en dashes. End the sentence, or use a comma.
- Cut `please`, `simply`, `just`, `note that`, `make sure`, `currently`, `for now`, and `at the moment`.
- If dohc knows the answer, do not hedge with `may` or `might`.
- Do not start a sentence with a name a person chose, such as a version or a file. Put it later: `You can keep working in version-1.`
- Check every claim in the code before you write it. The merge dialog said versions cover only text files, but binary files merge too.

The merge dialog's body was `Everything version-1 changed will be brought into Main. version-1 stays as it is, so you can keep working in it. Your unsaved changes are saved first.`
It is now `You can keep working in version-1.`, because the title already says Main gets the changes.

## Before and after

| Before | After |
| --- | --- |
| `Your changes have been successfully saved!` | `Saved` |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.`, with a **Try again** control |

## When shipping copy disagrees

Existing strings do not all follow these rules, and some surfaces use two words for one thing.
The editor's link picker says `page links` in its accessible name and `No files match` in its empty state.

- Settle the word across every surface before you change any string.
- When a list waits on a cause, say what the list will show once the cause is fixed.
- Do not reuse another surface's question. Signed out, the Sharing view's **Shared with me** says `Connect a server to get what others share with you.` About's Access asks who has access, so it keeps `Connect your server to check who has access.`
- Name a server only when dohc knows it, in the interface font: `Not connected to example.com`.
- `12 items` in the Explorer's delete dialog is correct, because a selection can mix files and folders.
