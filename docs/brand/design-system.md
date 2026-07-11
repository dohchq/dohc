# dohc — design system

The full visual intent lives in the brand bible
(`dohc-brand-bible.html`, kept outside the app repo). The SHIPPED tokens
live in `apps/desktop/src/renderer/styles.css` (mirrored in `tokens.ts`,
sync- and contrast-tested); `packages/brand/src/tokens.css` holds the
brand-reference values they were derived from. Concrete control recipes
for building UI live in `docs/brand/ui-language.md`. This is the working
summary.

## Identity

- **Name:** always lowercase `dohc` in UI, docs, and package labels
  (spoken "dock"). Never DOHC/Dohc in the wordmark.
- **Mark:** the drop-lobe — a single stroked lobe contour with a central
  datum dot. SVG only, `currentColor` for both stroke and dot, no
  gradient, no shadow, no automotive badge. Source of truth:
  `packages/brand/src/DohcLogo.tsx` (`DohcMark`, `DohcWordmark`,
  `DohcLockup`, `DohcBrandBlock`).

## Color

Almost monochrome. Color separates surface, hierarchy, and state — never
decoration.

Shipped values (contrast-solved against the WCAG pairs in
`apps/desktop/src/renderer/tokens.test.ts` — the app hierarchy needs
`bg` lightest with panels stepping down, so panel/panel-2 differ from the
brand-reference cards-on-paper model):

| Token        | Light       | Dark        |
| ------------ | ----------- | ----------- |
| bg           | `#faf9f5`   | `#131211`   |
| panel        | `#f3f1ea`   | `#1b1d1a`   |
| panel-2      | `#ebe8e0`   | `#181715`   |
| line         | `#e4e1d8`   | `#2a2925`   |
| ink          | `#1c1b18`   | `#f6f4ee`   |
| muted        | `#55524a`   | `#a9a599`   |
| subtle       | `#7f7b6e`   | `#7d7a6e`   |
| accent       | `#2d342e`   | `#d7d0c0`   |
| agent        | `#5c6250`   | `#b7b8a4`   |
| match        | `#3a7ee9`   | `#2f6ce9`   |

Semantic (state only): success `#38684e` / `#82c29b`, warning `#8a6420` /
`#d9a94e`, danger `#a6402c` / `#e08065` (light / dark). `agent` is the
olive attribution voice for agent activity; `match` means exactly one
thing: "your find-match". Dark mode is warm charcoal with green-black
cards — never pure black/white.

## Type

- **Serif** — `'Iowan Old Style', 'Charter', Georgia, serif` (system
  stack). Brand moments, editor blockquotes, empty-state headlines.
- **Sans** — `'InterVariable', system-ui, 'Segoe UI', sans-serif`
  (bundled webfont). All daily UI, body, buttons, menus. This is a
  deliberate divergence from the brand-reference stack in
  `packages/brand` (`'Aptos', …`): Aptos is not redistributable, so the
  app bundles Inter for identical rendering on every OS; the Aptos stack
  remains for external brand surfaces that inherit system fonts.
- **Mono** — `'IBM Plex Mono', ui-monospace, …` (bundled webfont).
  Metadata, file names, counts, source state, keyboard hints.

Letter spacing 0. No viewport-width font scaling.

## Layout

8px controls, 12px cards, 18px main panels. 1px borders, subtle shadows
for major surfaces only, faint grid as brand texture. Motion: 120–180ms
controls, 220–280ms panels, ease out, no bounce. Visible focus rings.

## Voice

Plainspoken, precise, never magical. State what is, what changed, what is
ready, and the next action. Empty states explain what is missing and what
to do next.
