# Controls

A dohc control does the action it names and never opens an agent prompt. [`AGENTS.md`](../../../AGENTS.md) gives the rule under "Agent agnostic".

The look in one line: warm paper, quiet graphite, one sans for every word of the interface, serif for brand moments, and color only for meaning.

Use `DohcMark` for the mark, `DohcWordmark` for the name, and `DohcLockup` for both. They live in `packages/brand/src/DohcLogo.tsx`.
The mark is an SVG in `currentColor`, with no gradient, shadow, or badge.

Compose the controls in `apps/desktop/src/renderer/ui/controls.tsx` first: `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton`, `IconButton`, `Pill`, `SectionLabel`, `EmptyState`, `RetryRow`, and `FieldError`.
To inline a control's classes, copy them from that file.
Use the recipes below only for parts it does not cover.

## Tokens

Token values live in `apps/desktop/src/renderer/styles.css`, mirrored in `tokens.ts`.
`tokens.test.ts` fails when the two drift or when a color pair misses WCAG AA.

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

Choose a state color by what happened:

- Danger marks a surface or list whose read failed, so it shows nothing. It also marks an item that is broken, such as an automation dohc can't read, wherever the item sits.
- Warning marks what is missing when some of a surface's or list's sources didn't load beside others that did.
- Warning also marks work dohc is holding or has paused, where it waits, such as History paused in History's pane. The notice that reports the failure behind it is an error, so it takes danger.
- The plain mark is for what the person's own rules or a list's limit leave out, such as a file History no longer tracks.
- Put a list's limit in a `bg-panel-2` band above its rows, never in a row. Show its whole sentence: how many the list includes, and how to see the rest.

## Type

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

## Radius and elevation

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

## Spacing

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
- [`dialogs.md`](dialogs.md#layout) says where a dialog sits and how its parts are spaced.

| Part | Spacing |
| --- | --- |
| Row in a panel, tree, or menu | `h-7` (28 px), `gap-2` between icon and label |
| Row in a picker or on a page | `h-8` (32 px), `gap-2` |
| Panel header | `h-9` (36 px), `px-3`, the same height as the tab strip |
| Panel content | Starts 8 px under the header |
| Section in a panel | `mt-4` (16 px) before it, except the first. Its label row is `h-6 px-3`, and the first row follows directly. |
| Icon button | `size-6` (24 px) in panels, rows, and toolbars. `size-7` in the title bar. `size-9` in the rail. Inside a line of text, use a plain `button` at `size-4` (16 px), so the line keeps its height. Give it `align-top` and a `text-muted` glyph, as on the Try again beside a count in Versions. `IconButton` stays 24 px even when given `size-4`. |
| Button | [`ui/controls.tsx`](../../../apps/desktop/src/renderer/ui/controls.tsx) holds each button's height, padding and text size: the default, `compact`, and `row` for a button in a row. In a page toolbar beside a `PrimaryButton`, give `GhostButton` `size="toolbar"`. |
| Popover | `p-3`. A menu's frame is `p-1`, because its rows bring their own `px-2`. |
| Settings page | `px-12 pt-10`, as wide as the page column. The page title is 24 px over the first section. |
| Settings section | Use `SettingsSection` in [`settings/SettingRow.tsx`](../../../apps/desktop/src/renderer/settings/SettingRow.tsx), which holds the heading and the spacing. A page with one group has one card and no heading. |
| Settings row | Use `SettingRow` in the same file, which holds the row's spacing, text styles, wrapping, and Reset's place. Controls sit on the right and use the default button size. Reset appears left of them only when the value differs from its default. When the control is a list, pass `top`, so its name and Reset sit beside the list's first row. |
| Toast and Notices row | `px-3 py-2`, `gap-2` |

## Recipes

Text input: `w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink`. Add `font-mono` for code.

List row (menus, trees, results): copy `MENU_ROW` and `MENU_ROW_TONE` from [`ui/Menu.tsx`](../../../apps/desktop/src/renderer/ui/Menu.tsx). They hold the row's classes and its rest and current tones.

- At rest, a row takes `hover:bg-hover hover:text-ink`.
- Active or selected: `bg-selected text-ink`. The active row adds `font-medium`. A picked row takes the picked fill, `bg-(--dohc-selection)`, instead.
- The picked fill marks the rows an action will act on, only in the list where they were picked. The open file has the selected fill and medium weight in every list. When it is also picked, it keeps the picked fill and gains a 2 px ink edge.
- If a row's name is content, such as a share's file, draw the name in `text-ink`. If the share ended or was removed, keep its name `text-muted`.
- Never fade a state fill, as in `bg-selected/85`. `tokens.test.ts` rejects it.
- In a panel, give the parent `px-1`.
- A disabled menu row says why on a second line under its label. Not in a tooltip. Pass it as the `MenuItem`'s `description`; the row dims its icon and label, not its fill.

Active option: when focus stays on a frame or input with `aria-activedescendant`, compose `MENU_ACTIVE_OPTION` from `ui/Menu.tsx`.
It draws the selected fill on the active option, where Enter acts, whether the keyboard or the pointer moved it. A list that also marks its current row with the fill, such as the tab overflow menu, Turn into and the callout type menu, adds the row's accent line while the keyboard moves. Compose `MENU_ACTIVE_OPTION_BESIDE_CURRENT` for it. A picker you type into, such as Go to, the command palette, / and [[, shows the fill only.

Card: `rounded-lg border border-line bg-panel p-3`, with `gap-2` inside. A modal card uses `rounded-xl p-6` and `dohc-elevated`.

Press outside: every dialog, picker, popover, and menu closes on a press outside. [`dialogs.md`](dialogs.md#closing) says how a dialog closes.

Segmented control: track `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs transition-colors`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`.

Kbd chip: `rounded border border-line bg-bg px-1 font-sans text-[11px] text-subtle`.

Empty state: when a panel or page has nothing yet, `EmptyState` shows a picture of what it holds once it has items, its one line, and at most one compact action. `ui/controls.tsx` holds its spacing and text style. Use `PrimaryButton` only when making the thing is the surface's job. A failure keeps its warning glyph and Try again, never a picture. An empty section inside a surface with other content stays one muted line.

`Pill` changes meaning through its `tone`, which swaps the text color and keeps the fill.

## Keyboard focus

- Focus shows only while the person moves with the keyboard: Tab, Shift+Tab, the arrows, Home, End, Page Up, Page Down, and F6.
- `keyboardNavigation.ts` sets `data-keyboard-nav` on the root for those keys. A pointer press or any other key clears it.
- So a click, a dialog's first focus, and a shortcut such as Ctrl+P show no focus. Escape, Delete and Backspace leave the mark as it was, so closing or removing the focused thing from the keyboard still shows where focus went.
- A confirm dialog's buttons show the ring whenever Chromium's `:focus-visible` matches, so a dialog opened from the keyboard shows where Enter acts at once. Opened with the pointer, it shows the ring after the first Tab or arrow, as everywhere else.
- Give a row `dohc-focus-row`: the hover fill and a 1px accent line inside its edge. A selected row keeps its fill and adds the line.
- A row that opens one thing puts a button on its title, stretched over the row with `dohc-row-open`. The whole row then takes the `dohc-focus-row` mark and hover fill as one target, and the row's own controls sit above the stretch.
- Every other control wears the global halo, a 2px accent outline, 60% in light and 50% in dark, that follows its radius. Text fields keep their border and underline.
- Inside a scroller, draw a control's halo inset with `focus-visible:-outline-offset-2`. The row's line is already inset.
- If you show keyboard focus another way, such as a fill or a layer, put the `keyboard:` variant before `focus-visible:`. Never draw a mark under a bare `focus-visible:`. A confirm dialog's buttons are the only exception, as above.
- A menu opened with the pointer marks no row, and the hover fill follows the pointer. The first arrow key marks a row with the fill. Until a row is marked, Enter and Space mark the row the menu opened on, its checked row or else its first, and run nothing. A menu opened from the keyboard marks that row at once.

## Agent attribution

An agent's avatar is a rounded square (`rounded-lg`, or `rounded` at the 18px size). A person's avatar is round.
Shape is the cue, because a person can choose each agent's color. The default color is the `agent` token.
Give every agent mark a text alternative, as `AgentBadge` does.
`AgentName` and `AgentBadge` color the name and sparkle beside an avatar to match it. An agent label with no avatar uses `text-agent`.
A running agent shows a 6px round `bg-agent` dot.

## Chat

A question's status is words and an icon, never a pill. An open question without options shows Answer beside it.

## Motion

- Hover and press: `transition-colors` at 75 to 100ms.
- Real movement, such as expanding or sliding: 120 to 180ms ease-out. Panels take 220 to 280ms. No bounce.
- Floating surfaces enter with `dohc-pop-in`. Nothing else animates on mount.
- Reduced motion is handled globally. Never write an inline `animation` that bypasses it.
- Landing on what a person asked to see, such as a heading from the outline or a message from Notices, washes it once with `dohc-target-flash` after the scroll settles, and moves focus to it. With reduced motion, the wash shows and clears without fading.
