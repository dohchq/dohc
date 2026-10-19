# dohc marketing site

The dohc marketing site is mostly plain HTML and CSS, with one deliberately
real product surface: the interactive demo mounts the desktop app's actual
WYSIWYG editor inside an isolated shadow root. The editor, its menus, and its
document styling therefore stay in sync with `apps/desktop`.

## Run locally

Install from the repository root, then run the Vite site:

```bash
pnpm install
pnpm --filter @dohc/site dev
```

## Deploy

Build with `pnpm --filter @dohc/site build`, then point any static host
(Cloudflare Pages, Netlify, GitHub Pages, S3) at `apps/site/dist`.

## Design

Brand tokens mirror `packages/brand/src/tokens.css` (warm paper +
graphite, almost monochrome). Fonts are bundled from Fontsource packages,
with no external font requests. `styles.css` embeds `Inter`,
`Source Serif 4`, and the handwriting face `Homemade Apple`. The demo
loads `Inter` and `IBM Plex Mono` in `src/main.tsx` when it mounts.
