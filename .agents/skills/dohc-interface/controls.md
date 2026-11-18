# Controls

The look: warm paper, quiet graphite, one sans for every word of the interface, serif for brand moments, and color only for meaning.

Use the controls in [`ui/controls.tsx`](../../../apps/desktop/src/renderer/ui/controls.tsx) first: `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton`, `IconButton`, `Pill`, `SectionLabel`, `EmptyState`, `RetryRow`, and `FieldError`. Use the recipes below only for parts that file doesn't cover.

For the logo, use `DohcMark`, `DohcWordmark`, or `DohcLockup` from `packages/brand/src/DohcLogo.tsx`.

## Tokens

Token values live in `apps/desktop/src/renderer/styles.css`, mirrored in `tokens.ts`. `tokens.test.ts` fails when they drift or a color pair misses WCAG AA. Never write hex or Tailwind palette colors (`zinc-*`, `blue-*`, `black`, `white`) in components.

| Utility | Use |
| --- | --- |
| `bg-bg` | Paper: editors, inputs, popover tiles |
| `bg-panel` | Chrome: title bar, rails, sidebars, tab strip, cards, menus |
| `bg-panel-2` | Insets in the chrome: pills, counts, segmented tracks, inline code, bands |
| `hover:bg-hover` | Hover fill |
| `bg-selected` | Selected row fill |
| `bg-scrim` | The dim behind a modal |
| `border-line` | Every hairline, always 1px |
| `text-ink` | Primary text |
| `text-muted` | Secondary text, such as labels and inactive items |
| `text-subtle` | Decorative text only: hints, timestamps, kbd |
| `bg-accent`, `text-accent` | Primary buttons, checked and active states, keyboard focus |
| `bg-agent`, `text-agent` | The default agent color |
| `bg-match`, `text-match` | Find-match highlight only |
| `text-success`, `text-warning`, `text-danger` | State only |
| `bg-danger-fill`, `text-on-danger` | A danger confirm's fill and label |
| `bg-line` as a fill | A disabled primary or danger confirm |
| `bg-danger-tint` | The tile behind a danger confirmation's glyph only |

Danger marks something that failed or is broken. Warning marks something partly loaded, held, or paused.

## Type

| Role | Classes |
| --- | --- |
| Body, rows, inputs | `text-[13px]` |
| Dense secondary text | `text-[12px] text-muted` |
| Hints, timestamps, shortcuts | `text-[12px] text-subtle` |
| Section labels | `dohc-section-label`, in sentence case |
| Page and dialog titles | `text-base font-semibold text-ink` |
| Panel titles and section headings | `text-sm font-semibold text-ink` |
| Brand moments | `font-serif`, rarely |
| Code and Markdown source | `font-mono` |

Use 10, 11, 12, or 13px for small text, never a fraction. Paths, counts, times, and shortcuts use the interface font, so give `<kbd>` `font-sans`. Never uppercase a label. Draw a path with `PathLine` from `ui/PathLine.tsx`. Cut a long name in the middle so its extension shows.

## Radius and elevation

| Element | Radius |
| --- | --- |
| Inline chips, kbd | `rounded` (4px) |
| Buttons, inputs, list rows, menu items | `rounded-md` (6px) |
| Cards, menus, dropdowns | `rounded-lg` (8px) |
| Popovers, dialogs, modals | `rounded-xl` (12px) |
| Pills, dots, a person's avatar | `rounded-full` |

Use `dohc-popover` for menus and floating chrome, `dohc-elevated` for dialogs, and `dohc-pop-in` as every floating surface's entrance. Flat panels get borders, not shadows.

## Spacing

The scale is 4, 8, 12, 16, 20, 24, 32, 40, and 48 px (Tailwind `1` to `12`). Take every gap, margin, and padding between things from it. No half steps such as `gap-2.5` and no arbitrary values such as `px-[7px]`. Inside one control, follow its recipe.

- Put things that belong together closer than things that don't. Each level of grouping gets at least twice the gap of the level inside it.
- Put a heading closer to what it labels than to what comes before it.
- Separate sections with space, not a rule.
- In a panel, text, icons, and headings start on one edge, 12 px from the side. Hover and selected fills hang outside that edge.
- Anchor a page at a fixed top. Center only a short message that stands alone.

| Part | Spacing |
| --- | --- |
| Row in a panel, tree, or menu | `h-7`, `gap-2` between icon and label |
| Row in a picker or on a page | `h-8`, `gap-2` |
| Panel header | `h-9`, `px-3` |
| Icon button | `size-6` in panels and toolbars, `size-7` in the title bar, `size-9` in the rail |
| Popover | `p-3`. A menu's frame is `p-1` |
| Dialog | `p-6`, `gap-6` between parts |
| Toast and Notices row | `px-3 py-2`, `gap-2` |
| Settings | `SettingsSection` and `SettingRow` in `settings/SettingRow.tsx` |

## Recipes

- **Text input:** `w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink`.
- **List row:** copy `MENU_ROW` and `MENU_ROW_TONE` from `ui/Menu.tsx`. At rest, `hover:bg-hover hover:text-ink`. Selected, `bg-selected text-ink`. Never fade a state fill. A disabled menu row says why on a second line, through `MenuItem`'s `description`.
- **Card:** `rounded-lg border border-line bg-panel p-3`, `gap-2` inside.
- **Segmented control:** track `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`.
- **Kbd chip:** `rounded border border-line bg-bg px-1 font-sans text-[11px] text-subtle`.
- Every dialog, picker, popover, and menu closes on a press outside.

## Keyboard focus

Focus shows only while the person moves with the keyboard. `keyboardNavigation.ts` sets `data-keyboard-nav` on the root for those keys.

- Give a row `dohc-focus-row`: the hover fill and a 1px accent line inside its edge.
- Every other control wears the global halo, a 2px accent outline. Inside a scroller, inset it with `focus-visible:-outline-offset-2`.
- If you show focus another way, use the `keyboard:` variant, never a bare `focus-visible:`.

## Agents

An agent's avatar is a rounded square. A person's is round. Shape tells them apart, because people pick agent colors. Give every agent mark a text alternative, as `AgentBadge` does. A running agent shows a 6px round `bg-agent` dot.

## Motion

- Hover and press: `transition-colors` at 75 to 100ms.
- Movement: 120 to 180ms ease-out. Panels: 220 to 280ms. No bounce.
- Only floating surfaces animate on mount, with `dohc-pop-in`.
- Reduced motion is handled globally. Never write an inline `animation` that bypasses it.
