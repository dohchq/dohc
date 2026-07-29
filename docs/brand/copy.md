# dohc copy — the words

`docs/brand/ui-language.md` covers controls. This file covers the words inside
them. `docs/brand/design-system.md` states the voice in its Voice section;
this file makes it enforceable.

The rule in one line: **say what is true, what changed, and what to do next.**
In that order, in the fewest plain words that carry it.

The discipline behind this file is `skills/dohc-writing/SKILL.md`
(Orwell + ASD-STE100 Simplified Technical English, applied by register). UI
copy is almost entirely the **strict** register: the user acts on it and cannot
ask a follow-up question.

## The four moves

Nearly every string in dohc is one of these. Know which one you are writing.

| Move | Job | Shape |
| --- | --- | --- |
| **State** | Say what is true now | `3 files changed on this machine` |
| **Change** | Say what just happened | `Moved 4 files to Archived` |
| **Ready** | Say something is now usable | `Export ready to download` |
| **Next** | Say what the user can do | `Choose which copy to keep` |

An empty state and an error both owe the user a **Next**. A toast usually owes
a **Change**. A status bar owes a **State**.

**Change or Ready?** Change reports a finished action. Ready reports that
something became usable. `Moved 4 files to Archived` is a Change. If nothing
new became usable, it is a Change.

## Rules

- **One instruction per sentence. 20 words or fewer.** If it needs two
  sentences, write two.
- **Active voice, named actor** — unless the actor is dohc and the surface
  makes that obvious. `Saved` and `Moved 4 files to Archived` are correct;
  naming dohc there adds a word and no information. Never use the passive to
  hide a *failing* actor: write `dohc could not reach the relay`, not
  `the relay could not be reached`.
- **Name the thing the user names it.** Use the glossary in the writing skill:
  `file`, `folder`, `workspace`, `chat`, `share`, `history`, `agent`. Never
  `atom`, `entity`, `capture`, `item`, or `object` in UI copy — `capture` is
  the engine's name for the recorder; the user's word for the feature is
  `history`.
- **Same word every time.** If it is a `file` in the sidebar it is a `file` in
  the error. Do not vary wording to avoid repetition.
- **No figurative language, no jokes, no irony.** Not because dohc is humorless
  — because the user reading this string is usually mid-task and sometimes
  worried.
- **Sentence case.** Capitalize the first word and proper nouns only. `New
  folder`, not `New Folder`.
- **No terminal period on labels, buttons, or fragments.** Full sentences in
  body text and errors keep their periods.
- **Numerals for all counts**, including one through nine. `1 file`, not
  `one file`.
- **Never magical.** No `magically`, `automatically figures out`, `just works`,
  `powered by AI`. State the mechanism or say nothing.
- **No marketing words.** `seamless`, `robust`, `powerful`, `effortless`,
  `intelligent`, `smart`, `cutting-edge`. These are the easy catch, not the
  point — a string can contain none of them and still be slop.

## Errors

Three parts, in order. Cut any part that is genuinely unknown; never invent it.

1. **What happened**, in the user's nouns.
2. **Why**, if we actually know. No guessing.
3. **What to do next**, as a direct instruction or an action control.

Never show a raw error code as the whole message. Never blame the user. Never
apologize — `Sorry, something went wrong` states nothing, offers nothing, and
costs a line.

The sync surface is already the house standard. These are good, keep writing
like this:

> `A file changed on two machines`
> `This machine doesn't have this file.`
> `Your other machine removed this file.`
> `One file has two copies.`

Each names the actor, states one fact, and uses the user's noun.

## Empty states

An empty state is a **Next**, not a shrug. One `text-sm text-muted` line that
says what is missing and what to do about it, per the `EmptyState` recipe in
`ui-language.md`.

| Instead of | Write |
| --- | --- |
| `No results` | `No files match "budget". Try a shorter search.` |
| `Nothing here yet` | `This folder is empty. Add a file to start.` |
| `No chats` | `No chats in this workspace yet. Open a text file to start one.` |

## Agent copy

Agent activity gets the olive `agent` voice visually. In words:

- Completed work: past tense, with the count. `Updated 3 files`.
- Work in progress: name the concrete action, and the count when known.
  `Reading 40 files`. Never `Working on it…`.
- Work waiting on the user: state the gate. `Waiting for your review`.
- Attribute plainly. `Edited by agent` — never a personality, never a name we
  invented, never first person unless the agent is genuinely speaking.
- Never imply the agent understood, decided, or thought. It acted.

## Destructive and irreversible actions

- Name the exact thing and the exact count. `Delete 12 files from Research?`
- **State the true recovery path.** dohc file deletes are always recoverable —
  the OS trash, or `.dohc/trash` when the OS refuses. Write `They move to your
  trash.`, not `This cannot be undone.`
- Write `This cannot be undone` only where it is true, and verify before you
  write it. Durability is a contract, not a tone — see the product invariants
  in `AGENTS.md`.
- Label the confirm button with the verb, not `OK`. `Delete files`.
- Never use `Are you sure?` as the whole question. It states nothing.

## Before / after

| Before | After | Why |
| --- | --- | --- |
| `Your changes have been successfully saved!` | `Saved` | Passive, padded, exclaimed. Six words for one fact. |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.` — with a `Retry` action | Names the failing actor, one instruction per sentence, and the retry is a control rather than a second instruction. |
| `Seamlessly sync your workspace across all your devices` | `When you turn on sync, this workspace stays current on every machine you join it from.` | Marketing word out, and the opt-in stays visible — sync is off by default and signing in alone does not enable it. |
| `The document was unable to be loaded by the editor` | `The editor could not open this file.` | Active voice, glossary noun, shorter. |
| `Are you sure you want to do this?` | `Delete 12 files from Research? They move to your trash.` | States the count and the true recovery path — dohc deletes are recoverable, so `This cannot be undone` would be false. |
| `AI is analyzing your workspace…` | `Agent is reading 40 files.` | Concrete, countable, no magic. |

## Known violations in shipping copy

This file is new and the app predates it. Existing strings are not
automatically conformant. Two are confirmed:

- `apps/desktop/src/renderer/editor/slashCommands.tsx:83` — `Link another page`
  uses `page`, a banned synonym for `file`.
- `apps/desktop/src/renderer/settings/SettingsDialog.tsx:487` — "without
  changing document content" uses `document`, a banned synonym for `file`.

Fix these when you next touch the surface. Do not read existing copy as an
example of the rules.

## Checklist per string

1. Which move is it — State, Change, Ready, or Next?
2. Does it owe the user a **Next**? Does it give one?
3. Every noun from the glossary, and the same noun the surrounding UI uses?
4. Active voice with a named actor?
5. Under 20 words, one instruction?
6. Any word that promises rather than states? Cut it.
7. Read it aloud during a bad moment — a failed sync, a lost file. Does it
   help, or does it perform?
