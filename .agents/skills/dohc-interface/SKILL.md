---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app: a button, label, menu item, error, empty state, toast, dialog, panel, or any string inside a control. Also use when choosing a token, class recipe, or control shape in the renderer. Covers both the words and the parts they sit in.
---

# Building dohc's interface

Two questions at once: what is this control made of, and what do its words say. This file answers both, because you decide both in the same edit.

Tokens themselves are not documented here. `apps/desktop/src/renderer/styles.css` is the source of truth, mirrored in `tokens.ts`, and `tokens.test.ts` fails when the two drift or when a pair misses WCAG AA. Read the code for values. Read this for meaning.

The discipline behind the words is the `dohc-writing` skill: Orwell plus ASD-STE100 Simplified Technical English, applied by register. UI copy is almost entirely the strict register, because the user acts on it and cannot ask a follow-up question.

## Identity

- **Mark:** the drop-lobe. A single stroked lobe contour with a central datum dot. SVG only, `currentColor` for both stroke and dot, no gradient, no shadow, no automotive badge. Source of truth: `packages/brand/src/DohcLogo.tsx` (`DohcMark`, `DohcWordmark`, `DohcLockup`, `DohcBrandBlock`).

## The words

The Controls section below covers the parts. This section covers the words inside them.

The rule in one line: **say what is true, what changed, and what to do next.** In that order, in the fewest plain words that carry it.

UI copy is almost entirely the **strict** register: the user acts on it and cannot ask a follow-up question.

### The four moves

Nearly every string in dohc is one of these. Know which one you are writing.

| Move | Job | Shape |
| --- | --- | --- |
| **State** | Say what is true now | `3 files changed on this machine` |
| **Change** | Say what just happened | `Moved 4 files to Archived` |
| **Ready** | Say something is now usable | `Agent result, ready to review` |
| **Next** | Say what the user can do | `Choose which copy to keep` |

An empty state and an error both owe the user a **Next**. A toast usually owes a **Change**. A status bar owes a **State**.

**Change or Ready?** Change reports a finished action. Ready reports that something became usable. `Moved 4 files to Archived` is a Change. If nothing new became usable, it is a Change.

### Rules

- **One instruction per sentence. 20 words or fewer.** If it needs two sentences, write two.
- **Active voice, named actor**. Unless the actor is dohc and the surface makes that obvious. `Saved` and `Moved 4 files to Archived` are correct; naming dohc there adds a word and no information. Never use the passive to hide a *failing* actor: write `dohc could not reach the relay`, not `the relay could not be reached`. Attribution labels are the other exemption: `Edited by agent` is a label naming who acted, not a sentence hiding an actor.
- **Name the thing the way the UI already names it.** Read the surrounding surface and match it. Never invent a synonym, and never carry an internal name into user-facing text. Check what the code calls it *and* what the shipping UI calls it, because those differ more often than you would expect.
- **Same word every time.** If it is a `file` in the sidebar it is a `file` in the error. Do not vary wording to avoid repetition.
- **No figurative language, no jokes, no irony.** Not because dohc is humorless . Because the user reading this string is usually mid-task and sometimes worried.
- **Sentence case.** Capitalize the first word and proper nouns only. `New folder`, not `New Folder`.
- **No terminal period on labels, buttons, or fragments.** Full sentences in body text and errors keep their periods.
- **Numerals for counts the user scans or acts on**, `3 files changed`, `Delete 12 files`, `2 conflicts`. A number woven into a sentence may be a word where that reads better: `A file changed on two machines` is correct. The test is whether the reader is counting something or reading a sentence.
- **Never magical.** No `magically`, `automatically figures out`, `just works`, `powered by AI`. State the mechanism or say nothing.
- **No marketing words.** `seamless`, `robust`, `powerful`, `effortless`, `intelligent`, `smart`, `cutting-edge`. These are the easy catch, not the point. A string can contain none of them and still be slop.

### Errors

Three parts, in order. Cut any part that is genuinely unknown; never invent it.

1. **What happened**, in the user's nouns.
2. **Why**, if we actually know. No guessing.
3. **What to do next**, as a direct instruction or an action control.

Never show a raw error code as the whole message. Never blame the user. Never apologize, `Sorry, something went wrong` states nothing, offers nothing, and costs a line.

The sync surface is already the house standard. These are good, keep writing like this:

> `A file changed on two machines`
> `This machine doesn't have this file.`
> `Your other machine removed this file.`
> `One file has two copies.`

Each names the actor, states one fact, and uses the user's noun. Their spelled numbers are deliberate. These are sentences, not counts. See the numerals rule above.

### Empty states

An empty state is a **Next**, not a shrug. One `text-sm text-muted` line that says what is missing and what to do about it, per the `EmptyState` recipe in `ui-language.md`.

**The Next must work on that surface.** Verify the control or the flow exists there before you write the instruction. An empty state that tells the user to do something the surface does not offer is worse than one that says nothing, because it costs them a search.

| Instead of | Write |
| --- | --- |
| `No results` | `No files match "budget". Try a shorter search.` |
| `Nothing here yet` | `This folder is empty. Add a file to start.` |
| `No chats` | `No chats in this workspace yet.`. Beside a control that actually creates one |

### Agent copy

Agent activity gets the olive `agent` voice visually. In words:

- Completed work: past tense, with the count when one exists and means something. `Updated 3 files`. Some runs change no countable set, say what happened without inventing a number.
- Work in progress: name the concrete action, and the count when known. `Reading 40 files`. Never `Working on it…`.
- Work waiting on the user: state the gate. `Waiting for your review`.
- Attribute plainly. `Edited by agent`, never a personality, never a name we invented, never first person unless the agent is genuinely speaking.
- Never imply the agent understood, decided, or thought. It acted.

### Destructive and irreversible actions

- Name the exact thing and the exact count. `Delete 12 files from Research?`
- **State the true recovery path, including the fallback.** dohc file deletes are always recoverable: the system trash, or `<workspace>/.dohc/trash` whenever the system-trash operation fails. Which is any rejection, not only a drive that lacks a trash. Name both locations. Never write `This cannot be undone.` here. (The shipping dialog at `Explorer.tsx:1528` says "on drives without one", which understates the trigger, `deletePath` catches *any* `trashItem` error. Correct it when you touch that dialog.)
- Write `This cannot be undone` only where it is true, and verify before you write it. Durability is a contract, not a tone, see the product invariants in `AGENTS.md`.
- Label the confirm button with the verb, not `OK`. `Delete files`.
- Never use `Are you sure?` as the whole question. It states nothing.

### Before / after

| Before | After | Why |
| --- | --- | --- |
| `Your changes have been successfully saved!` | `Saved` | Passive, padded, exclaimed. Six words for one fact. |
| `Something went wrong. Please try again later.` | `dohc could not reach the sync relay. Check your connection.`. With a `Retry` action | Names the failing actor, one instruction per sentence, and the retry is a control rather than a second instruction. |
| `Seamlessly sync your workspace across all your devices` | `When you turn on sync, this workspace stays current on every machine you join it from.` | Marketing word out, and the opt-in stays visible. Sync is off by default and signing in alone does not enable it. |
| `The document was unable to be loaded by the editor` | `The editor could not open this file.` | Active voice, the noun the UI uses, shorter. |
| `Are you sure you want to do this?` | `Delete 12 files from Research? They move to the system trash, or this workspace's .dohc/trash if that fails, and you can restore them.` | States the count and the true recovery path including the fallback. Dohc deletes are recoverable, so `This cannot be undone` would be false. |
| `AI is analyzing your workspace…` | `Agent is reading 40 files.` | Concrete, countable, no magic. |

### Where shipping copy disagrees with itself

This file is new and the app predates it. Existing strings are not automatically conformant.

But most apparent violations are not one bad string. dohc's UI vocabulary is **unsettled, and mixed inside single surfaces**, not merely different from one surface to the next. `WikilinkPicker` says `page links` and `No files match` in one component. Settings describes attachments with `files` a few rows above two `document` options. Renaming whichever string looks like the odd one out only moves the inconsistency somewhere else.

**Settle a vocabulary, do not rename a string.** Choosing what a thing is called is a deliberate decision taken across every surface that shows it, and it has to be made before any renaming starts.

**Never touch a pinned name.** `ui-language.md` states it as a hard invariant: every `data-testid`, `aria-*`, `role`, and accessible name is pinned by e2e and must never be renamed, removed, or restructured away. Updating the tests does not buy you permission. Change the visible copy and leave the accessible name as it is.

Known so far:

- The editor and linking surface is **mixed, and the term is unsettled**. It says `page` in `Link another page` (`slashCommands.tsx:83`), `aria-label="page links"` (`WikilinkPicker.tsx:210`) and `aria-label="Page title"` (`PageIdentity.tsx:260`), but `file` in `No files match "…"` (`WikilinkPicker.tsx:218`), inside the very same component. Decide the vocabulary before changing anything, and leave the two pinned `aria-label`s alone regardless.
- `apps/desktop/src/renderer/settings/SettingsDialog.tsx` is **mixed**: `document` at `:487`, `:662` and `:669`, but `files` at `:630` a few rows above them.
- `apps/desktop/src/renderer/workbench/Explorer.tsx:1528`, the delete dialog says the trash fallback happens "on drives without one", but `deletePath` falls back on *any* `trashItem` rejection. The stated condition is narrower than the real one.

Do not read existing copy as an example of the rules. And note that `${confirmDelete.length} items` in that same delete dialog is *correct*, the selection can mix files and folders, so `files` would be false.

### Checklist per string

1. Which move is it, State, Change, Ready, or Next?
2. Does it owe the user a **Next**? Does it give one?
3. Every noun the same as the surrounding UI uses, and none of them internal?
4. Active voice with a named actor?
5. 20 words or fewer, one instruction?
6. Any word that promises rather than states? Cut it.
7. Read it aloud during a bad moment. A failed sync, a lost file. Does it help, or does it perform?

## The controls

This is the working spec for how dohc's desktop UI is built, at the level of concrete class recipes. It exists so every surface, human- or agent-built, composes the same language instead of re-inventing controls per file. The Words section above holds what goes inside these controls. Read it before writing any label, error, empty state, or toast.

The soul in one line: **warm paper, quiet graphite, mono metadata, serif brand moments, color only for meaning.**

### Tokens (semantic and theme-aware, never hex in components)

Defined in `apps/desktop/src/renderer/styles.css` (mirrored in `tokens.ts`, sync-tested). Consume via Tailwind utilities:

| Utility | Meaning |
| --- | --- |
| `bg-bg` | Document paper. The lightest surface; editors, inputs, popover tiles |
| `bg-panel` | Sidebars, cards, menus. One step down from paper |
| `bg-panel-2` | Insets, hover fills, status/title bars, two steps down |
| `border-line` | Every hairline. 1px, no exceptions |
| `text-ink` | Primary text |
| `text-muted` | Secondary text (labels, inactive items) |
| `text-subtle` | Decorative text ONLY (hints, timestamps, kbd), 3:1 floor |
| `bg-accent` / `text-accent` | Green-graphite. Primary buttons, checked/active semantics, focus rings. THE brand accent |
| `text-agent` / `bg-agent` | Agent presence/attribution, the olive voice |
| `bg-match` / `text-match` | Find-match highlight ONLY. Never decoration |
| `text-success` / `warning` / `danger` | State semantics only |

Rules: no raw hex anywhere in TSX; no Tailwind palette colors (`zinc-*`, `blue-*`, `black`, `white`) except the existing `bg-black/20` overlay dim.

### Type scale

| Role | Recipe |
| --- | --- |
| Body / rows / inputs | `text-[13px]` (the 13px UI baseline) |
| Dense secondary | `text-[12px] text-muted` |
| Hints, timestamps, kbd | `text-[11px] text-subtle` (often `font-mono`) |
| Section labels | `text-[10px] font-semibold uppercase tracking-wide text-subtle` |
| Panel/dialog titles | `text-sm font-semibold text-ink` |
| Brand/editorial moments | `font-serif` (first-run headline, editor quotes), use sparingly |
| Paths, counts, ids, keys | `font-mono`. The metadata voice (IBM Plex Mono) |

Never invent fractional sizes (`text-[10.5px]`); snap to 10/11/12/13px.

### Radius scale

| Element | Radius |
| --- | --- |
| Inline chips, kbd | `rounded` (4px) |
| Buttons, inputs, list rows, menu items | `rounded-md` (6px) |
| Cards, menus, dropdowns, larger buttons | `rounded-lg` (8px) |
| Popovers, dialogs, modals | `rounded-xl` (12px) |
| Pills, dots, avatars | `rounded-full` |

### Elevation (classes in styles.css, do not write ad-hoc shadows)

| Class | Use |
| --- | --- |
| `dohc-popover` | Menus, dropdowns, floating chrome |
| `dohc-elevated` | Dialogs, modal cards, first-run card |
| `dohc-pop-in` | Entrance for ANY floating surface (130ms settle; respects reduced-motion) |
| `dohc-paper-grid` | Faint grid texture, brand moments only, never workaday panels |

Flat panels (sidebars, rails, inline sections) get borders, not shadows.

### Control recipes

The canonical implementations live in `apps/desktop/src/renderer/ui/controls.tsx`, `PrimaryButton`, `SecondaryButton`, `IconButton`, `Pill`, `Kbd`, `SectionLabel`, `EmptyState`. **Compose those first**; the raw recipes below exist for elements the primitives don't cover (inputs, rows, cards) and for surfaces where a conditional class needs the recipe inline.

Primary button: `rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50`

Secondary button: `rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink`

Ghost icon button (toolbars, row affordances): `grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink`

Text input: `w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink` (mono content → add `font-mono`). No `outline-none`: the global `:focus-visible` accent ring must stay for keyboard users. `focus:border-ink` alone is too subtle. Only opt out where a ring would clip (rounded overflow-hidden popovers) AND the frame provides an equivalent (e.g. the command palette's `focus-within:border-ink` row).

List row (menus, trees, results): `flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75` + state: active `bg-line text-ink` · selected-not-active `bg-line/60 text-ink` · rest `text-muted hover:bg-panel-2 hover:text-ink` (inset rows in panels: parent gets `px-1`, row keeps `rounded-md`)

Card / grouped section: `rounded-lg border border-line bg-panel p-3` (modal cards: `rounded-xl p-5` + `dohc-elevated`)

kbd chip: `rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle`

Count/status pill: `rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted` (semantic: swap text color, never the fill)

Segmented control: container `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs transition-colors`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`

Empty state: centered column, `gap-4`; optional `DohcMark` in `text-line` (ghost); one `text-sm text-muted` line; actions as kbd-chip buttons. Never a wall of gray text.

Agent attribution: olive voice. `text-agent` name/icon or a 6px `bg-agent` dot. Never a filled olive block.

### Motion

- Hover/active: `transition-colors duration-75`–`100`
- Real movement (expand, slide): 120–180ms ease-out; panels 220–280ms; no bounce
- Floating surfaces enter with `dohc-pop-in`; nothing else animates on mount
- Reduced-motion is handled globally, never inline `animation` that bypasses it

### Intentionality checklist (per surface)

1. What is the ONE thing this surface is for? Its strongest visual weight goes there.
2. Every border earned? Prefer whitespace/bg steps; boxes-in-boxes is the smell.
3. Hierarchy readable squinting? Title → sections → rows → metadata.
4. All interactive states present? (hover, active, focus-visible, disabled, empty, loading, error)
5. Metadata in the mono voice, decorative text `text-subtle`, semantics the only color?
6. Every string checked against the Words section above: right noun, active voice, and a next action where one is owed?
7. Would Notion/Linear ship it? If not, it isn't done.

### Hard invariants (breaking these breaks the product)

- Every `data-testid`, `aria-*`, `role`, and accessible name is PINNED by e2e, restyle freely, never rename/remove/restructure them away.
- No new dependencies. No `any`. No styles.css edits from surface work, new shared patterns get proposed, not inlined.
- Icons: lucide-react only, 12–18px, `strokeWidth={1.9}` for rail-scale icons.
- Focus: global `:focus-visible` ring is the default; only opt out when a surface provides an equivalent (and say why in a comment).
- A11y floors: body text ≥ 4.5:1, decorative ≥ 3:1, on the surface it sits on.
