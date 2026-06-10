# Visual QA checklist

> **Historical.** This document describes the pre-desktop-pivot (Convex-era)
> setup and is kept as a record. Current architecture and workflows:
> desktop E2E in `apps/desktop/e2e/` (`pnpm test:desktop:e2e`).

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
Apps activity · rendered folder app · `.apps` source file · app build
diagnostic · chat open · chat closed · share dialog · properties panel ·
command palette · folder picker · dark mode · system-prefers-dark (no
explicit theme).

## Apps Manual QA

The automated Playwright coverage verifies the sandboxed runtime and SDK
message loop. The authenticated workspace flow still needs manual QA until
the e2e harness can seed logged-in Convex workspaces.

1. Create `clients/acme/tasks.md` with `{status: active}` and
   `{next_action: send proposal}`.
2. Create `clients/acme/.apps/overview/src/App.tsx` with a small React
   app that imports from `@dohc/app` and reads the source through
   `useDoc` or `useCollection`.
3. Open Apps, select `clients/acme / Overview`, and confirm the iframe
   renders the two fields.
4. Click `Open source` from the app header and confirm Files opens
   `clients/acme/.apps/overview/src/App.tsx` in source mode.
5. From the source atom, click `Open app` and confirm it returns to the
   rendered app.
6. Imports/exports check: grant an export from workspace A to workspace B,
   confirm the withheld values, and verify a workspace B view using
   `dohc.imports.list()` shows only granted values. Revoke the grant and
   verify the import disappears.

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
