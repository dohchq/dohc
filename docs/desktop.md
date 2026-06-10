# Desktop: Build, Packaging, Updates, Signing

The desktop app lives in `apps/desktop` (Electron + electron-vite). Output of
`electron-vite build` lands in `apps/desktop/dist/` (`main/main.js`,
`preload/preload.cjs`, `renderer/index.html`).

## Build

```bash
pnpm build:desktop                       # electron-vite build (root alias)
pnpm dev:desktop                         # dev with HMR
```

## Smoke gates

```bash
pnpm smoke:desktop                       # boots the built app, fails on fatal stderr
pnpm --filter @dohc/desktop smoke:package # static packaging gate (no electron-builder run)
pnpm --filter @dohc/desktop smoke:fuses  # boots a fuse-flipped Electron copy (packaged-fuse gate)
```

`smoke:package` asserts: build outputs exist, `electron-builder.yml` parses
and carries the dohc metadata + `asar: true` + the `electronFuses` hardening
block, no hard-coded signing identity, and prints the signing label —
`SIGNING: unsigned (dev)` when no certificate env is present. With
`DOHC_REQUIRE_SIGNING=1` (release pipelines) it FAILS unless
`CSC_LINK`/`WIN_CSC_LINK` is set, so an unsigned build can never pose as a
signed release.

`smoke:fuses` flips the exact `electronFuses` values from
`electron-builder.yml` onto a copied Electron binary, packs `dist/` into an
asar, and boots it — the only gate that sees fuse-dependent breakage (e.g. a
`grantFileProtocolExtraPrivileges: false` regression CORS-blocks the file://
renderer and ships a blank window). Linux only; headless runs need
`DOHC_E2E_NO_CHROMIUM_SANDBOX=1 xvfb-run -a`. This gate is why
`@electron/fuses` stays a devDependency.

## Packaging

Config: `apps/desktop/electron-builder.yml` (appId `app.dohc.desktop`,
productName `dohc`, asar, fuses flipped by electron-builder at package time).
Artifacts land in `apps/desktop/release/`. From `apps/desktop`:

```bash
pnpm --filter @dohc/desktop package          # build + package for the current OS
# or per-OS after `pnpm build:desktop`:
electron-builder --mac --publish never       # dmg + zip (zip feeds auto-update)
electron-builder --win --publish never       # nsis installer
electron-builder --linux --publish never     # AppImage
```

Note: `@dohc/*` workspace deps are bundled into `dist/` by electron-vite;
running electron-builder end-to-end (production node_modules collection) is a
release-pipeline concern, not a local gate.

## Auto-updates

- Runtime feed URL comes from the `DOHC_UPDATE_URL` env
  (`apps/desktop/src/updates/electronUpdater.ts`). Updates run **only** in a
  packaged app with that env set — local/dev builds never auto-update.
  **Release trap**: end users launch with no env vars, so shipping real
  updates requires BOTH a real `publish.url` in `electron-builder.yml` AND
  changing `updateFeedUrl` to fall back to the baked `app-update.yml` feed
  when the env is unset (env stays an override). The failure mode is silent.
- The flow is a pure state machine (`src/updates/updateMachine.ts`):
  idle → checking → available → downloading → ready (install on quit), with
  up-to-date, offline, and error/recovery branches. Tested without Electron.
- The `publish` block in `electron-builder.yml` is a stub (generic provider,
  RFC-reserved `.invalid` host) until a real release host exists.

## Signing readiness

electron-builder signs only when credentials are present in the env — nothing
is ever fake-signed:

- **macOS**: `CSC_LINK` (base64 .p12) + `CSC_KEY_PASSWORD`; notarization needs
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
- **Windows**: `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`.
- **Unsigned** (no env): artifacts build unsigned for local use;
  `smoke:package` labels them `SIGNING: unsigned (dev)`.
- **Release**: export `DOHC_REQUIRE_SIGNING=1` before the smoke (fails fast
  without certs) and pass `-c.forceCodeSigning=true` to electron-builder so a
  missing certificate fails the build instead of shipping unsigned.
