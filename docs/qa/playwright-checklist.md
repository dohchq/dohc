# Visual QA checklist

Run the app and capture screenshots across viewports and states. Paths
are relative to `/home/ice/dev/dohc`.

```bash
pnpm dev
pnpm --filter @dohc/app exec playwright screenshot \
  --viewport-size=1440,900 http://localhost:3000 /tmp/dohc-desktop.png
pnpm --filter @dohc/app exec playwright screenshot \
  --viewport-size=390,900 http://localhost:3000 /tmp/dohc-mobile.png
```

## Viewports

- 390×900 mobile · 768×1024 tablet · 1440×900 desktop · 1728×1117 wide.

## States

unauthenticated sign-in · signed-out route · loading · onboarding (new) ·
onboarding (in-progress) · post-onboarding workspace · no file selected ·
markdown document · source mode · HTML atom · graph view ·
chat open · chat closed · share dialog · properties panel · command
palette · folder picker · dark mode · system-prefers-dark (no explicit
theme).

## Checks

- Drop-lobe logo is never clipped; the inner dot is light in dark mode.
- No horizontal overflow; no text overlap; buttons fit their labels.
- Focus rings visible; color contrast acceptable (body ≥ 4.5:1).
- Brand mark present but not overused; no legacy purple/pink palette;
  no gradient.
- No legacy product words anywhere in visible UI.
- **Approachability:** labels are clear, empty states explain the next
  action, controls look trustworthy, and a non-engineer can tell what to
  do next without reading docs.
