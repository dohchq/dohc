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
graphite, almost monochrome). Fonts: brand serif/sans stacks are system
fonts; `IBM Plex Mono` and the handwriting face `Homemade Apple` load
from Google Fonts.
