---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app: a label, button, menu item, error, empty state, toast, dialog, or panel. Also use when choosing a token, class recipe, or control in the renderer.
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
Put further detail behind a tooltip, a **More details** disclosure, or a **Learn more** link.
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

Every error and empty state needs a Next. A toast usually reports a Change. A status bar shows a State.

- Follow the instruction rules in `dohc-writing`: one instruction per sentence, 20 words or fewer.
- Use the active voice and name who acted. Leave dohc out when the surface makes it obvious: `Saved`.
- Always name a failing actor: `dohc could not reach the relay`, not `The relay could not be reached`.
- Attribution labels such as `Edited by agent` are fine as they are.
- Call a thing what the surrounding UI calls it, every time. Never show an internal name. Check both the code and the shipping UI, because they often differ.
- Keep the words literal. Leave out metaphors, jokes, irony, exclamation marks, and emoji.
- Use sentence case: `New folder`.
- Leave the period off labels, buttons, and fragments. Full sentences keep theirs.
- Use numerals for counts a person scans or acts on: `Delete 12 files`. Inside a sentence, a word can read better: `A file changed on two machines`.
- State the mechanism or say nothing. Cut promises such as `magically`, `just works`, `powered by AI`, `seamless`, `powerful`, and `smart`.
- Keep sync clearly opt-in. Sync starts off, and signing in alone does not turn it on.

### Errors

Write up to three parts, in this order. Leave out any part you do not know.

1. What happened, in the person's words for things.
2. Why, if dohc knows. Never guess.
3. What to do next, as an instruction or a control.

Never show a raw error code alone, blame the person, or apologize. `Sorry, something went wrong` says nothing.

The sync strings show the standard: `A file changed on two machines`, `This machine doesn't have this file.`, and `One file has two copies.`

### Empty states

Use `EmptyState`, with one line that says what is missing and what to do.
Check that the action exists on that surface before you name it.

| Instead of | Write |
| --- | --- |
| `No results` | `No files match "budget". Try a shorter search.` |
| `Nothing here yet` | `This folder is empty. Add a file to start.` |

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

## Where messages go

| Situation | Where it goes |
| --- | --- |
| The whole workspace is unusable | A full-height state over the workbench, which goes inert |
| One thing failed, and the workspace still works | A toast at the bottom right, above the update toast, then a row in Notices until it is retried or dismissed |
| Something finished out of sight, such as a background job | A toast at the bottom right that fades, and a row in Notices |
| An action whose result the person can see | No toast and no row |
| A control's own input is wrong | Inline, beside the control |

- Use these places. Do not add a new one for a new message.
- Report a cause once. When the title bar names the server as the problem, features that need the server, such as live editing, add no indicator, toast or row of their own. A state dohc is still fixing by itself shows at once where it lives, as a ring. Its toast and row come only once the ring has shown for 15 s.
- Keep the toast and its row when it holds the only Undo for the change.
- Keep the workbench still when a message arrives. No bar slides in across the top.
- Give a message about something the person can retry a **Try again** control on the toast and the row.
- Put a copy control beside text a person might need to report. Use an icon on the toast and the row, and a **Technical details** disclosure on a full-height state. Copy what the person reads, one line per fact, never a log.
- Let a repeat of the same message, or the same kind, replace its earlier row.
- Closing a toast keeps its row. Dismissing the row removes it.
- A row in Notices stays unread until the pointer or keyboard focus rests on it for 0.6 s, or the person presses **Mark all read**. Reading a row closes its toast and keeps the row.
- A row shows two lines of title and three of text. Offer **Show more** for the rest, and open it in place, wrapped and selectable.
- When the text has one fact per line, show its first three facts whole instead of three lines. Show the count of facts it leaves out only after **Show more**.
- If an untitled message would run past two lines, give it a title that says what happened and a body with why and the Next, so the clamp never hides the Next.
- Restarting or closing the app asks once, in one dialog.
- Report errors through the shell's `reportError` callback instead of rendering them yourself.
- For a list or section whose read failed, show `RetryRow`.

## Controls

The look in one line: warm paper, quiet graphite, one sans for every word of the interface, serif for brand moments, and color only for meaning.

Use `DohcMark` for the mark, `DohcWordmark` for the name, and `DohcLockup` for both. They live in `packages/brand/src/DohcLogo.tsx`.
The mark is an SVG in `currentColor`, with no gradient, shadow, or badge.

Compose the controls in `apps/desktop/src/renderer/ui/controls.tsx` first: `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton`, `IconButton`, `Pill`, `SectionLabel`, `EmptyState`, and `RetryRow`.
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
| `bg-accent`, `text-accent` | The brand accent: primary buttons, checked and active states, focus rings |
| `bg-agent`, `text-agent` | The default agent color |
| `bg-match`, `text-match` | Find-match highlight only |
| `text-success`, `text-warning`, `text-danger` | State only |

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
- Center only a short message that stands alone, such as an empty panel.

| Part | Spacing |
| --- | --- |
| Row in a panel, tree, or menu | `h-7` (28 px), `gap-2` between icon and label |
| Row in a picker or on a page | `h-8` (32 px), `gap-2` |
| Panel header | `h-9` (36 px), `px-3`, the same height as the tab strip |
| Panel content | Starts 8 px under the header |
| Section in a panel | `mt-4` (16 px) before it, except the first. Its label row is `h-6 px-3`, and the first row follows directly. |
| Icon button | `size-6` (24 px) in panels, rows, and toolbars. `size-7` in the title bar. `size-9` in the rail. |
| Button | `h-8 px-3 text-[13px]` for `PrimaryButton`, `SecondaryButton`, and `DangerButton`. `h-7` compact, `h-6` in a row. |
| Card | `p-3`, with `gap-2` inside |
| Popover | `p-3`. A menu's frame is `p-1`, because its rows bring their own `px-2`. |
| Dialog | `p-6` and `gap-6` between its parts. The title uses the page and dialog title role; its one-line description follows with `gap-1`. A section label sits 8 px over its fields. The buttons end the dialog, right-aligned, `gap-2` apart. No header or footer band. |
| Dialog with a preview | The title, fields, and buttons form the left column, `p-6`. The preview fills the right column from top to bottom on `bg-panel-2`, `p-6`. |
| Dialog that scrolls | Only a body that scrolls gets bands: header and footer `px-6 py-4` with a rule, body `p-6`. |
| Settings page | `px-12 pt-10`, as wide as the page column. The page title is 24 px over the first section. |
| Settings section | `SettingsSection`: a heading in the panel title role, 8 px over a card. Sections sit 32 px apart. A page with one group has one card and no heading. |
| Settings row | `SettingRow`: `py-4` with a rule between rows. The name is `text-[13px] font-medium`; its description is `text-[12px] text-muted`, `mt-1` under it. Controls sit on the right and use the default button size. Reset appears left of them only when the value differs from its default, so they never move. When the control is a list, its name and Reset sit beside the list's first row (`top`). |
| Empty state | `EmptyState`: `gap-4 px-6`. Do not build your own. |
| Toast and Notices row | `px-3 py-2`, `gap-2` |

### Recipes

Text input: `w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink`. Add `font-mono` for code.

List row (menus, trees, results): `flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75`.

- At rest: `text-muted hover:bg-hover hover:text-ink`.
- Active or selected: `bg-selected text-ink`. The active row adds `font-medium`.
- Never fade a state fill, as in `bg-selected/85`. `tokens.test.ts` rejects it.
- Keyboard focus keeps the global accent outline, never an ink ring. A 30% ink ring is under 3:1 on the selected fill.
- Inside a scroller, draw the focus outline inset: `rounded-md focus-visible:-outline-offset-2`.
- In a panel, give the parent `px-1`.

Active option: when focus stays on a frame or input with `aria-activedescendant`, compose `MENU_ACTIVE_OPTION` from `ui/Menu.tsx`.
It draws the accent outline on the active option, where Enter acts, whether the keyboard or the pointer moved it. The fill alone is about 1.2:1.

Card: `rounded-lg border border-line bg-panel p-3`. A modal card uses `rounded-xl p-6` and `dohc-elevated`.

Dialog: build it on `Overlay`. Cancel, the X, and Escape close it.
While closing would discard hand-written work, as with open merge conflicts, only the dialog's own buttons close it.
A press outside a dialog does nothing, so a stray click cannot discard what a person typed.
Only pickers and popovers close on a press outside: the command palette, quick open, menus, and an action's Run or Cancel question. They hold nothing worth keeping.
Pass `closeOnBackdrop` to `Overlay` for a picker only.

Segmented control: track `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs transition-colors`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`.

Kbd chip: `rounded border border-line bg-bg px-1 font-sans text-[11px] text-subtle`.

Empty state: a centered column with `gap-4`, an optional `DohcMark` in `text-line`, one `text-sm text-muted` line, and actions as kbd-chip buttons.

`Pill` changes meaning through its `tone`, which swaps the text color and keeps the fill.

### Agent attribution

An agent's avatar is a rounded square (`rounded-lg`, or `rounded` at the 18px size). A person's avatar is round.
Shape is the cue, because a person can choose each agent's color. The default color is the `agent` token.
Give every agent mark a text alternative, as `AgentBadge` does.
`AgentName` and `AgentBadge` color the name and sparkle beside an avatar to match it. An agent label with no avatar uses `text-agent`.
A running agent shows a 6px round `bg-agent` dot.

### Motion

- Hover and press: `transition-colors` at 75 to 100ms.
- Real movement, such as expanding or sliding: 120 to 180ms ease-out. Panels take 220 to 280ms. No bounce.
- Floating surfaces enter with `dohc-pop-in`. Nothing else animates on mount.
- Reduced motion is handled globally. Never write an inline `animation` that bypasses it.

### Hard rules

- End-to-end tests pin every `data-testid`, `aria-*`, `role`, and accessible name. Rewording and restyling keep them. A surface can become something else, such as the right panel changing from Chats to About. Then change them in the same PR as the tests that read them.
- Surface work adds no dependencies, no `any`, and no `styles.css` edits. Propose a new shared pattern instead of inlining it.
- Use lucide-react icons only, at 12 to 18px, with `strokeWidth={1.9}` at rail size.
- Keep the global `:focus-visible` ring. Do not add `outline-none`, with two exceptions, each explained in a comment. Where a ring would clip, opt out only if the frame shows focus another way, as the command palette's `focus-within:border-ink` does. A dialog's panel never wears the ring: it holds focus only until Tab reaches its controls, which show their own.
- Keep body text at 4.5:1 or more and decorative text at 3:1 or more against its surface.

## Before you finish

1. Is the surface's one job obvious, and does it carry the most visual weight?
2. Does every border earn its place? Prefer space and background steps to boxes inside boxes.
3. Are hover, active, focus-visible, disabled, empty, loading, and error states all there?
   Loading: the header shows at once. The skeleton under it stays blank for its first 150 ms, so a fast read never flashes, then stays until the answer comes, with no deadline. Only an error answer shows Try again.
4. Is every visible string as short as it can be, with further detail behind a hover or a click?
5. Does each string do one job, and does every error and empty state give a Next?
6. Does every noun match the surrounding UI?
7. Read each string as someone whose sync just failed. Does it help them?
8. Would Notion or Linear ship it? If not, it is not done.
