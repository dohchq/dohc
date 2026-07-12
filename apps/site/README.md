# dohc marketing site

Static, zero-build marketing site — plain HTML, CSS, and a few lines of
JS. Text is the primitive, so the site itself is inspectable text.

## Run locally

Any static file server works:

```bash
npx serve apps/site
# or
python3 -m http.server -d apps/site 4173
```

## Deploy

Point any static host (Cloudflare Pages, Netlify, GitHub Pages, S3) at
this directory. There is no build step.

## Design

The visual centerpiece is Steve Jobs's 1976 handwritten Apple-1 spec
note (`assets/apple-1-note.jpg`), paired with a recreated "dohc spec
sheet" in the same one-page handwritten format — the site's argument is
that work used to fit on a readable page, and dohc puts it back there.

Brand tokens mirror `packages/brand/src/tokens.css` (warm paper +
graphite, almost monochrome). Fonts: brand serif/sans stacks are system
fonts; `IBM Plex Mono` and the handwriting face `Homemade Apple` load
from Google Fonts.
