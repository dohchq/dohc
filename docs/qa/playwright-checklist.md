# Visual QA checklist

Run the app and capture screenshots across viewports and states. Paths
are relative to `/home/ice/dev/dohc`.

```bash
pnpm --filter @dohc/desktop run build
pnpm --filter @dohc/desktop exec playwright test \
  --config playwright.config.ts e2e/sites-preview.spec.ts
```

## Viewports

- 390×900 mobile · 768×1024 tablet · 1440×900 desktop · 1728×1117 wide.

## States

unauthenticated sign-in · signed-out route · loading · onboarding (new) ·
onboarding (in-progress) · post-onboarding workspace · no file selected ·
markdown document · source mode · HTML atom · graph view ·
Sites activity · static site preview · dev server preview · built site
preview · build diagnostic · chat open · chat closed · share dialog · properties panel ·
command palette · folder picker · dark mode · system-prefers-dark (no
explicit theme).

## Sites Manual QA

The automated Electron coverage verifies direct disk creation, site
detection, static preview, dev server preview, built preview, and a Vite site
that imports `@dohc/sdk` to read a local workspace file through the preview
bridge.

1. Create `clients/acme/site/index.html` directly on disk and confirm Sites
   lists it without any dohc-specific manifest.
2. Create `clients/acme/site/package.json` with `dev` and `build` scripts,
   then confirm Dev and Build previews render in dohc.
3. Confirm source files open as ordinary editable files from Explorer.
4. Confirm a site using `@dohc/sdk` can read an intended local text file in
   preview, while missing or disallowed paths surface an error instead of a
   blank pane.
5. Imports/exports check: accepted shares should materialize under
   `shared-with-me`; publishing a site that references them must stay behind
   an explicit review boundary.

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
