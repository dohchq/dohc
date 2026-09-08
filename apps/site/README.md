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

For site changes, read [AGENTS.md](AGENTS.md) for composition, interaction, and verification guidance.

The site uses warm paper and graphite with selective metallic accents.
[styles.css](styles.css) defines its font and material tokens. Headings use Source Serif 4;
body text and labels use Inter; handwritten accents use Homemade Apple. These fonts are bundled locally.
The embedded product demo retains its own desktop typography.
