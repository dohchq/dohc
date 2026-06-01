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
Views activity · rendered folder view · `.views` source file · view build
diagnostic · chat open · chat closed · share dialog · properties panel ·
command palette · folder picker · dark mode · system-prefers-dark (no
explicit theme).

## Folder Views Manual QA

The automated Playwright coverage verifies the sandboxed runtime and SDK
message loop. The authenticated workspace flow still needs manual QA until
the e2e harness can seed logged-in Convex workspaces.

1. Create `clients/acme/tasks.md` with `{status: active}` and
   `{next_action: send proposal}`.
2. Create `clients/acme/.views/overview/src/App.tsx` with a small React
   view that calls `dohc.fields.query({ source: '.', keys: ['status',
   'next_action'] })`.
3. Open Views, select `clients/acme / Overview`, and confirm the iframe
   renders the two fields.
4. Click `Open source` from the view header and confirm Files opens
   `clients/acme/.views/overview/src/App.tsx` in source mode.
5. From the source atom, click `Open view` and confirm it returns to the
   rendered view.
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
