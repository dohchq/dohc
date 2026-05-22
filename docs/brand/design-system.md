# dohc — design system

The full visual intent lives in the brand bible
(`dohc-brand-bible.html`, kept outside the app repo). Production tokens
live in `packages/brand/src/tokens.css` and the app's `src/styles.css`.
This is the working summary.

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

| Token        | Light       | Dark        |
| ------------ | ----------- | ----------- |
| bg           | `#f7f6f1`   | `#121211`   |
| panel        | `#fffefa`   | `#1c1b1a`   |
| panel-2      | `#ece9e1`   | `#272624`   |
| ink          | `#151515`   | `#f4f1ea`   |
| muted        | `#66635d`   | `#aaa69c`   |
| accent       | `#2d342e`   | `#d7d0c0`   |

Semantic (state only): success `#4f7666`, warning `#a77a35`, danger
`#b64b37`, info `#3868a6`. Dark mode is warm-neutral charcoal + warm ink — never
pure black/white.

## Type

- **Serif** — `'Iowan Old Style', 'Charter', Georgia, serif`. Brand
  moments, empty-state headlines, page intros.
- **Sans** — `'Aptos', 'Segoe UI', ui-sans-serif, system-ui, sans-serif`.
  All daily UI, body, buttons, menus.
- **Mono** — `'IBM Plex Mono', …`. Metadata, file names, counts, source
  state, keyboard hints. The only shipped webfont.

Letter spacing 0. No viewport-width font scaling.

## Layout

8px controls, 12px cards, 18px main panels. 1px borders, subtle shadows
for major surfaces only, faint grid as brand texture. Motion: 120–180ms
controls, 220–280ms panels, ease out, no bounce. Visible focus rings.

## Voice

Plainspoken, precise, never magical. State what is, what changed, what is
ready, and the next action. Empty states explain what is missing and what
to do next.
