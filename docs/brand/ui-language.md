# dohc UI language — control recipes

This is the working spec for how dohc's desktop UI is built, at the level of
concrete class recipes. It exists so every surface — human- or agent-built —
composes the same language instead of re-inventing controls per file.
`docs/brand/design-system.md` holds the brand story; this file holds the how.

The soul in one line: **warm paper, quiet graphite, mono metadata, serif brand
moments, color only for meaning.**

## Tokens (semantic, theme-aware — never hex in components)

Defined in `apps/desktop/src/renderer/styles.css` (mirrored in `tokens.ts`,
sync-tested). Consume via Tailwind utilities:

| Utility | Meaning |
| --- | --- |
| `bg-bg` | Document paper — the lightest surface; editors, inputs, popover tiles |
| `bg-panel` | Sidebars, cards, menus — one step down from paper |
| `bg-panel-2` | Insets, hover fills, status/title bars — two steps down |
| `border-line` | Every hairline. 1px, no exceptions |
| `text-ink` | Primary text |
| `text-muted` | Secondary text (labels, inactive items) |
| `text-subtle` | Decorative text ONLY (hints, timestamps, kbd) — 3:1 floor |
| `bg-accent` / `text-accent` | Green-graphite. Primary buttons, checked/active semantics, focus rings. THE brand accent |
| `text-agent` / `bg-agent` | Agent presence/attribution — the olive voice |
| `bg-match` / `text-match` | Find-match highlight ONLY. Never decoration |
| `text-success` / `warning` / `danger` | State semantics only |

Rules: no raw hex anywhere in TSX; no Tailwind palette colors (`zinc-*`,
`blue-*`, `black`, `white`) except the existing `bg-black/20` overlay dim.

## Type scale

| Role | Recipe |
| --- | --- |
| Body / rows / inputs | `text-[13px]` (the 13px UI baseline) |
| Dense secondary | `text-[12px] text-muted` |
| Hints, timestamps, kbd | `text-[11px] text-subtle` (often `font-mono`) |
| Section labels | `text-[10px] font-semibold uppercase tracking-wide text-subtle` |
| Panel/dialog titles | `text-sm font-semibold text-ink` |
| Brand/editorial moments | `font-serif` (first-run headline, editor quotes) — use sparingly |
| Paths, counts, ids, keys | `font-mono` — the metadata voice (IBM Plex Mono) |

Never invent fractional sizes (`text-[10.5px]`); snap to 10/11/12/13px.

## Radius scale

| Element | Radius |
| --- | --- |
| Inline chips, kbd | `rounded` (4px) |
| Buttons, inputs, list rows, menu items | `rounded-md` (6px) |
| Cards, menus, dropdowns, larger buttons | `rounded-lg` (8px) |
| Popovers, dialogs, modals | `rounded-xl` (12px) |
| Pills, dots, avatars | `rounded-full` |

## Elevation (classes in styles.css — do not write ad-hoc shadows)

| Class | Use |
| --- | --- |
| `dohc-popover` | Menus, dropdowns, floating chrome |
| `dohc-elevated` | Dialogs, modal cards, first-run card |
| `dohc-pop-in` | Entrance for ANY floating surface (130ms settle; respects reduced-motion) |
| `dohc-paper-grid` | Faint grid texture — brand moments only, never workaday panels |

Flat panels (sidebars, rails, inline sections) get borders, not shadows.

## Control recipes

The canonical implementations live in
`apps/desktop/src/renderer/ui/controls.tsx` — `PrimaryButton`,
`SecondaryButton`, `IconButton`, `Pill`, `Kbd`, `SectionLabel`,
`EmptyState`. **Compose those first**; the raw recipes below exist for
elements the primitives don't cover (inputs, rows, cards) and for surfaces
where a conditional class needs the recipe inline.

Primary button:
`rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50`

Secondary button:
`rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink`

Ghost icon button (toolbars, row affordances):
`grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink`

Text input:
`w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-subtle focus:border-ink` (mono content → add `font-mono`)

List row (menus, trees, results):
`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75` + state:
active `bg-line text-ink` · selected-not-active `bg-line/60 text-ink` · rest `text-muted hover:bg-panel-2 hover:text-ink`
(inset rows in panels: parent gets `px-1`, row keeps `rounded-md`)

Card / grouped section:
`rounded-lg border border-line bg-panel p-3` (modal cards: `rounded-xl p-5` + `dohc-elevated`)

kbd chip:
`rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle`

Count/status pill:
`rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted` (semantic: swap text color, never the fill)

Segmented control:
container `flex rounded-lg border border-line bg-panel-2 p-0.5`, segment `rounded-md px-2.5 py-1 text-xs transition-colors`, active `bg-bg text-ink shadow-sm`, rest `text-muted hover:text-ink`

Empty state:
centered column, `gap-4`; optional `DohcMark` in `text-line` (ghost); one `text-sm text-muted` line; actions as kbd-chip buttons. Never a wall of gray text.

Agent attribution: olive voice — `text-agent` name/icon or a 6px `bg-agent` dot. Never a filled olive block.

## Motion

- Hover/active: `transition-colors duration-75`–`100`
- Real movement (expand, slide): 120–180ms ease-out; panels 220–280ms; no bounce
- Floating surfaces enter with `dohc-pop-in`; nothing else animates on mount
- Reduced-motion is handled globally — never inline `animation` that bypasses it

## Intentionality checklist (per surface)

1. What is the ONE thing this surface is for? Its strongest visual weight goes there.
2. Every border earned? Prefer whitespace/bg steps; boxes-in-boxes is the smell.
3. Hierarchy readable squinting? Title → sections → rows → metadata.
4. All interactive states present? (hover, active, focus-visible, disabled, empty, loading, error)
5. Metadata in the mono voice, decorative text `text-subtle`, semantics the only color?
6. Would Notion/Linear ship it? If not, it isn't done.

## Hard invariants (breaking these breaks the product)

- Every `data-testid`, `aria-*`, `role`, and accessible name is PINNED by e2e —
  restyle freely, never rename/remove/restructure them away.
- No new dependencies. No `any`. No styles.css edits from surface work — new
  shared patterns get proposed, not inlined.
- Icons: lucide-react only, 12–18px, `strokeWidth={1.9}` for rail-scale icons.
- Focus: global `:focus-visible` ring is the default; only opt out when a
  surface provides an equivalent (and say why in a comment).
- A11y floors: body text ≥ 4.5:1, decorative ≥ 3:1, on the surface it sits on.
