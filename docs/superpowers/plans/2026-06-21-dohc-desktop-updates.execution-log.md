# dohc Desktop Updates Execution Log

## 2026-06-21

### Scope

Execute `docs/superpowers/plans/2026-06-21-dohc-desktop-updates.md` end to end:
runtime updater behavior, renderer update actions, release scripts, release
workflow, robust tests/smokes, non-draft PR, and CodeRabbit review loop.

### Subagents

- Runtime updater/IPC explorer: inspect update wiring and test seams.
- Renderer UX explorer: inspect notice/settings/menu command surfaces.
- Release automation explorer: inspect script/workflow conventions.

### Initial execution map

1. Add/update pure updater state and Electron updater wiring.
2. Add validated IPC/preload bridge methods for update state, check, and install.
3. Add renderer action surfaces for ready updates.
4. Add release metadata/manifest/mock-server scripts with tests.
5. Add desktop release workflow with dry-run/signing/channel guards.
6. Run local gates, fix failures, then publish a non-draft PR.
7. Run CodeRabbit and PR review loops until clean or explicitly blocked.

### Results

- Implemented packaged-update defaults through electron-builder's baked
  `app-update.yml` feed using GitHub Releases as the first dogfood update host,
  with `DOHC_UPDATE_URL` retained only as an explicit packaged/mock override.
- Added an `AutoUpdateController` with channel derivation, public state,
  coalesced manual checks, guarded install/restart, install-on-quit behavior,
  and pre-update site-preview cleanup.
- Added trusted IPC/preload bridge methods for `getUpdateState`,
  `checkForUpdates`, and `installUpdate`, plus strict preload validation for
  public update metadata.
- Added Help menu, command palette, status context menu, notice-center, toast,
  and Settings update actions. Dismissing the update toast no longer removes
  the persistent notice/action.
- Added release helpers:
  - `scripts/resolve-desktop-release.mjs`
  - `scripts/update-desktop-package-version.mjs`
  - `scripts/merge-update-manifests.mjs`
  - `scripts/mock-update-server.mjs`
  - `scripts/release-smoke.mjs`
  - `scripts/desktop-release-scripts.test.mjs`
- Added `.github/workflows/desktop-release.yml` with main-branch nightly
  releases, tag/manual latest releases, manual dry-runs, package stamping,
  signing gates, and GitHub release publication.

### Verification

- `node --test scripts/desktop-release-scripts.test.mjs` passed on local
  Node 18.
- Installed workspace dependencies with `pnpm install --frozen-lockfile`; the
  first install ran under local Node 18 and produced the repo's expected engine
  warning. Renderer/jsdom tests require Node 20+/24, so a temporary Linux
  Node 24.14.0 runtime was downloaded to `/tmp/dohc-node-v24.14.0-linux-x64`
  for verification.
- With Linux Node 24.14.0:
  - `pnpm --filter @dohc/desktop test src/updates/electronUpdater.test.ts src/ipc/channels.test.ts src/ipc/bridgeContract.test.ts src/window/applicationMenu.test.ts src/renderer/workbench/StatusBar.test.tsx src/renderer/settings/DesktopSettings.test.tsx src/renderer/DesktopWorkspaceShell.test.tsx` passed: 7 files, 126 tests.
  - `pnpm --filter @dohc/desktop typecheck` passed.
  - `node scripts/release-smoke.mjs` passed.
  - `node --test scripts/desktop-release-scripts.test.mjs` passed: 4 tests.
  - `pnpm --filter @dohc/desktop build` passed.
  - `node apps/desktop/scripts/package-smoke.mjs` passed and verified the
    release-ready GitHub publish configuration.
  - Initial full run: `pnpm --filter @dohc/desktop test` passed: 70 files,
    695 tests.

### Remaining Release Configuration

- `updates.dohc.com` did not resolve during the CodeRabbit follow-up audit, so
  it is not baked into shipped apps yet. Before migrating from GitHub Releases
  to `updates.dohc.com`, configure DNS/CDN/object storage and run the bridge
  release checklist documented in the plan.
- macOS/Windows real releases require signing credentials; dry-runs and Linux
  packaging do not.

### CodeRabbit Follow-Up

- Ran `coderabbit review --agent` on PR #42.
- Addressed the returned findings:
  - added bridge-release migration runbook details.
  - made updater tests model `before-quit-for-update` after `quitAndInstall`.
  - pinned GitHub Actions to commit SHAs and added release concurrency.
  - documented publish-job `contents: write`.
  - removed the unvalidated R2 feed publish path from the first-host workflow.
  - required a real commit SHA for release metadata.
  - changed manifest fallback `releaseDate` to current time.
  - tightened manifest parser context reset behavior.
  - surfaced restart failures in the update toast/notice.
  - added restart failure and `canInstall: false` renderer tests.
- Ran a second `coderabbit review --agent` pass and addressed the returned
  follow-up findings:
  - added updater controller `stop()` cleanup and lifecycle coverage.
  - documented idempotent pre-update site-preview cleanup.
  - set checkout `persist-credentials: false`.
  - aligned zod/preload finite percent validation and boundary tests.
  - rejected conflicting duplicate update-manifest file entries.
  - handled mock-server read races.
  - validated nightly dates as real calendar dates.
  - made missing manifest `releaseDate` deterministic by omitting it.
  - added Settings update failure and busy-state tests.
- Ran a third `coderabbit review --agent` pass and addressed the returned
  follow-up findings:
  - expanded `publicUpdateState` coverage and renamed the active-check test.
  - added `%00` mock-update-server rejection coverage.
  - preserved release-smoke stack traces on failure.
  - switched the first shipped update host to GitHub Releases because
    `updates.dohc.com` DNS was not configured yet.
  - expanded manifest merge metadata assertions.
  - added Settings `onUpdateState` subscription coverage.
- Final verification after third-pass fixes:
  - `pnpm --filter @dohc/desktop test` passed: 70 files, 704 tests.
  - `pnpm --filter @dohc/desktop typecheck` passed.
  - `node --test scripts/desktop-release-scripts.test.mjs` passed: 6 tests.
  - `node scripts/release-smoke.mjs` passed.
  - `node apps/desktop/scripts/package-smoke.mjs` passed with GitHub Releases
    publish configuration.
