---
id: dohc-desktop-updates-2026-06-21
title: "dohc Desktop Updates"
---

# dohc Desktop Updates

## Product decision

dohc Desktop should use signed, channel-aware Electron updates with a visible
"update and restart" action. For the MVP/dogfood period, pushes to `main`
should publish the fast-moving `nightly` channel so users on that channel get
an update notification soon after CI publishes the release. Tagged semver
releases should publish the calmer `latest` channel.

The user experience should feel like Codex/VS Code: updates are discovered in
the background, never interrupt writing or agent work, and surface as a small
notice when an update is ready. The user can click a button to restart into the
new version, dismiss it, or let the downloaded update apply on quit.

## Recommendation

Ship this in two channels from day one:

- `nightly`: built from `main`, prerelease, frequent, expected to move quickly.
- `latest`: built from `vX.Y.Z` tags, public/stable, lower noise.

During prelaunch, the primary download can simply be the nightly build. Before
public alpha, decide whether nightly needs a side-by-side app identity like VS
Code Insiders (`app.dohc.desktop.nightly`, product name `dohc Nightly`) or
whether the single dogfood app should continue tracking nightly.

Prefer a public generic update feed at `https://updates.dohc.com/desktop` backed
by durable object storage/CDN once dohc has real users. It avoids requiring
user machines to call private GitHub APIs or hold tokens. A GitHub Releases
provider is acceptable for the first implementation if the update repo/releases
are public, and it matches the local `t3code` pattern.

## Current repo state

dohc already has a strong partial updater foundation:

- `apps/desktop/package.json` depends on `electron-updater`.
- `apps/desktop/electron-builder.yml` already builds auto-updatable targets:
  `dmg` plus `zip` on macOS, `nsis` on Windows, and `AppImage` on Linux.
- `apps/desktop/src/updates/updateMachine.ts` models checking, available,
  downloading, ready, offline, and error states.
- `apps/desktop/src/updates/electronUpdater.ts` wires `electron-updater` into
  that machine.
- `apps/desktop/src/main.ts` broadcasts update state to all windows.
- `apps/desktop/src/ipc/channels.ts`, `bridgeContract.ts`, and `preload.ts`
  validate the main-to-renderer update event boundary.
- `apps/desktop/src/renderer/workbench/NoticeCenter.tsx` already shows an
  update-ready toast/notice.
- `apps/desktop/scripts/package-smoke.mjs` already checks release-relevant
  packaging and signing intent.

The missing pieces are:

- a baked production feed fallback. Right now packaged builds only update when
  `DOHC_UPDATE_URL` is set, which real users will not have.
- an explicit install/restart IPC action. The UI can dismiss the ready notice,
  but cannot yet ask Electron to `quitAndInstall`.
- release automation. There is no `.github/workflows` release pipeline in this
  worktree.
- signed/notarized release gates in CI.
- channel/version scripts for `main` nightly releases and tagged stable
  releases.
- local end-to-end updater verification with two packaged versions and a mock
  feed.

## Reference behavior

Use these references while implementing:

- Local `t3code` release workflow:
  `/home/ice/dev/oss-repos/t3code/.github/workflows/release.yml`
- Local `t3code` desktop artifact builder:
  `/home/ice/dev/oss-repos/t3code/scripts/build-desktop-artifact.ts`
- Local `t3code` updater service and IPC:
  `/home/ice/dev/oss-repos/t3code/apps/desktop/src/updates/DesktopUpdates.ts`
  and `/home/ice/dev/oss-repos/t3code/apps/desktop/src/ipc/methods/updates.ts`
- Local `t3code` nightly/version helpers:
  `/home/ice/dev/oss-repos/t3code/scripts/resolve-nightly-release.ts`,
  `/home/ice/dev/oss-repos/t3code/scripts/update-release-package-versions.ts`,
  and `/home/ice/dev/oss-repos/t3code/scripts/merge-update-manifests.ts`
- Local `t3code` mock update server:
  `/home/ice/dev/oss-repos/t3code/scripts/mock-update-server.ts`
- Electron Builder auto-update docs:
  `https://www.electron.build/auto-update.html`
- Electron Builder publish docs:
  `https://www.electron.build/docs/publish/`
- Electron `autoUpdater` docs:
  `https://www.electronjs.org/docs/latest/api/auto-updater`
- VS Code update/channel behavior:
  `https://code.visualstudio.com/docs/supporting/faq`

Important lessons:

- `electron-builder` should generate update metadata (`latest.yml`,
  `latest-mac.yml`, `latest-linux.yml`, or channel equivalents) next to the
  built artifacts.
- macOS updates require a signed app, and the macOS `zip` artifact is required
  for Squirrel.Mac metadata.
- Windows auto-update should use NSIS.
- `quitAndInstall` should only run after `update-downloaded`.
- Do not call `setFeedURL` for normal packaged releases when `app-update.yml`
  already contains the builder-generated feed. Keep `DOHC_UPDATE_URL` only as a
  dev/mock override.
- VS Code-style updates are background and opt-out capable; the prompt should
  be a restart affordance, not a forced restart.
- Linux updates only work for supported targets/runtimes. Treat AppImage as the
  first Linux update path and document package-manager updates separately if
  deb/rpm/repos are added later.

## Desired user experience

Status bar / notice center:

- No update UI for idle/up-to-date checks.
- If an update is downloading, optionally show progress in the notice center,
  not as an interrupting modal.
- Once downloaded, show a compact toast and notice-center item:
  "Update X is ready."
- Primary action: `Update and restart`.
- Secondary action: dismiss. If `autoInstallOnAppQuit` remains enabled, the
  message should say the update will finish on quit.

Settings / command palette:

- `Check for Updates` command.
- `Update and Restart` command when downloaded.
- Current version and channel in Settings.
- Later: `Update mode` with `automatic`, `manual`, and `off`, mirroring VS Code
  without overbuilding it for MVP.

Main process behavior:

- Check on startup after the first window is visible.
- For nightly dogfood builds, poll every 10-15 minutes while the app is open.
- For latest/stable builds, poll every 1-4 hours.
- Never check while quitting, installing, or while another check/download is in
  flight.
- Never restart automatically while the user is working.

## Channel and version model

Use semver-compatible versions:

- Stable tag: `v0.2.0` -> package version `0.2.0`, update channel `latest`.
- Nightly from main: `0.2.1-nightly.20260621.<runNumber>` -> update channel
  `nightly`, release tag `v0.2.1-nightly.20260621.<runNumber>`.

Nightly base version should be the next patch after the current stable package
version. This matches `t3code` and keeps nightly versions monotonically ahead of
the last stable build.

Channel rules:

- A `latest` build should only look at `latest`.
- A `nightly` build should only look at `nightly`.
- Moving between channels should be explicit in settings or by installing the
  other build. Do not silently move stable users onto nightly because `main`
  changed.
- If nightly and latest share one app identity during dogfood, the app should
  derive its default channel from its version suffix.
- Do not rely on version suffix detection alone for publishing or runtime
  channel behavior. Each build must set:
  - `autoUpdater.channel` to the resolved channel.
  - `autoUpdater.allowPrerelease` to `true` only for `nightly`.
  - provider publish `channel` explicitly for GitHub/nightly builds.
- Do not use one physical channel hierarchy if it lets prerelease builds see
  stable manifests or permits accidental downgrades. Prefer separate feed paths
  or separate channel manifest files for `latest` and `nightly`.
- Do not publish different bytes under the same version. Nightly workflow
  reruns must either be idempotent or include a unique value such as
  `run_attempt` or `run_id` in the version/tag.
- Stable releases must be reproducible from their tag. The source at the tag
  should already contain the stable `apps/desktop/package.json` version; only
  nightly builds should temporarily mutate package versions in CI.

## Release hosting options

### Option A: GitHub Releases first

Pros:

- Closest to `t3code`.
- Fastest to wire with `electron-builder` and `action-gh-release`.
- Release assets and generated notes live in one obvious place.

Cons:

- Best for public releases. Private GitHub update feeds require user-machine
  credentials and create rate-limit/secret problems.
- Less control over CDN behavior and staged rollout edits.

Use this if the release repo/assets can be public during dogfood.

### Option B: Generic feed on `updates.dohc.com`

Pros:

- Public anonymous checks with no bundled token.
- Works whether the source repo is private or public.
- Easy to put Cloudflare R2/S3 plus CDN in front of artifacts.
- Clear future path for staged rollouts and rollback controls.

Cons:

- CI must upload artifacts and metadata manually.
- Need to own manifest layout and retention.

Use this before broader user distribution, even if GitHub Releases is used for
the first dogfood implementation.

Feed layout and publish order:

- Use immutable artifact paths that include version, platform, arch, and file
  hash or release tag.
- Upload installers, zips, AppImages, `.blockmap` files, and checksummed
  artifacts first.
- Verify every artifact is downloadable before publishing channel metadata.
- Publish or replace the channel metadata last.
- Give artifacts long cache lifetimes; give channel metadata low cache TTL or
  atomic replacement semantics.
- Retain every artifact referenced by any live channel manifest.

Feed migration rule:

- `app-update.yml` is baked into installed apps. Moving from GitHub Releases to
  `updates.dohc.com` requires shipping a bridge release on the old feed that
  points future installed apps to the new feed, then keeping the old feed alive
  long enough for stragglers.

Bridge-release runbook:

1. Freeze the old feed's channel metadata and record every artifact URL it
   references.
2. Ship a signed bridge release on the old feed. That build must keep the old
   update provider reachable for the current update, but bake the new
   `updates.dohc.com` feed into `app-update.yml` for subsequent releases.
3. Verify the bridge release from an installed old-feed build on macOS,
   Windows, and Linux before changing DNS, redirects, or object-store routing.
4. After the bridge release is live, configure the old feed to either serve the
   bridge metadata directly or redirect channel metadata to an equivalent
   bridge manifest. Do not redirect artifact URLs unless the updater smoke test
   proves blockmaps and installers still resolve.
5. Keep the old feed, bridge artifacts, and any old-feed manifests available for
   at least one full dogfood release cycle plus a documented straggler window.
   Do not delete them until telemetry or manual audit shows old-feed clients are
   below the accepted threshold.
6. Document rollback: restore the previous old-feed manifest first, then remove
   redirects, then republish the last known-good new-feed manifest if needed.

Recommended path:

1. Implement code/UX in a provider-neutral way.
2. Start with GitHub Releases if it gets dogfood updates moving fastest.
3. Keep `electron-builder.yml` generic-provider-compatible so moving to
   `updates.dohc.com` is a release-pipeline change, not an app rewrite.

## Agentic execution workflow

This plan is intentionally bigger than a single clean patch. Implement it with
subagents, narrow ownership, and repeated verification loops.

Execution rules:

- Before code edits, create a short execution map in a sibling execution log:
  `docs/superpowers/plans/2026-06-21-dohc-desktop-updates.execution-log.md`.
- Split work into disjoint ownership slices so subagents can help without
  fighting over the same files.
- Tell every subagent that other agents may be editing the repo and they must
  not revert unrelated work.
- Prefer worker subagents for bounded code changes and explorer subagents for
  specific risk audits.
- After each slice, run targeted tests, update the execution log with commands
  and results, inspect the diff, then continue.
- Run a delete-or-justify pass after every phase. Update code should not leave
  dead env-only paths, stale comments, or duplicate command surfaces.
- Do not declare the plan complete until release CI, local smoke coverage, and
  CodeRabbit review loops have passed or the user explicitly accepts a named
  remaining risk.

Suggested subagents:

- Runtime updater worker: owns `apps/desktop/src/updates`,
  update-related IPC/preload contracts, and main-process updater wiring.
- Renderer UX worker: owns `NoticeCenter`, `StatusBar`, Settings, command
  palette/menu surfaces, and renderer tests.
- Release automation worker: owns release scripts, manifest merge helpers,
  mock update server, and GitHub Actions workflow.
- QA explorer: audits test coverage, failure modes, and missing platform cases
  before the PR is opened.
- Security/signing explorer: audits signing/notarization, feed trust, token
  handling, IPC boundaries, and update-hosting assumptions.

Core loops:

1. TDD loop: write or update the failing test, prove the failure, implement the
   smallest change, prove the pass.
2. Package loop: build/package locally, run package smoke, run fuse smoke, fix
   until both pass.
3. Mock-update loop: install/launch version A, serve version B, check, download,
   restart, confirm version B.
4. CI loop: push, inspect every failed check, reproduce locally when possible,
   fix, push again.
5. Review loop: resolve CodeRabbit and human review comments until the PR is
   approved.

## Implementation phases

### Phase 0: Execution map and risk audit

- Create the execution log.
- Spawn at least two explorer subagents:
  - one for updater/release/signing risks.
  - one for testing/QA/regression risks.
- Record their findings in the execution log and fold accepted changes into the
  implementation checklist.
- Confirm the first hosting choice: public GitHub Releases or
  `updates.dohc.com`.
- Confirm whether nightly is same app identity or side-by-side app identity.
- Confirm what signing credentials are available for macOS and Windows.

### Phase 1: Runtime updater behavior

- Change `apps/desktop/src/updates/electronUpdater.ts` so production packaged
  builds use the baked `app-update.yml` feed by default.
- Keep `DOHC_UPDATE_URL` as an explicit override for mock/dev feeds only.
- Add a main-process install action that calls `autoUpdater.quitAndInstall`
  only after `update-downloaded`.
- Handle `before-quit-for-update`. Electron's update quit path does not behave
  exactly like normal quit, so dohc must still flush sync state, stop local
  servers/site previews, settle agent state, and close windows cleanly.
- Decide whether to keep `autoDownload = true` for dohc. Recommended MVP:
  keep auto-download, show the button only after the update is downloaded, and
  keep `autoInstallOnAppQuit = true`.
- Add update poll scheduling in main after first window creation.
- Extend the update state crossing to include bounded optional fields:
  `version`, `percent`, `canInstall`, `canCheck`, and `channel`.
- Add preload/IPC methods:
  `getUpdateState`, `checkForUpdates`, and `installUpdate`.
- Keep all payloads closed and validated like the current update-state event.
- Add tests for the install path, feed fallback, no-feed disabled state, and
  repeated checks.
- Add offline, corrupt metadata, invalid semver, and update server 404 tests.
- Add a regression test proving dev builds never self-update unless explicitly
  placed into mock-update mode.
- Add concurrency tests proving repeated checks coalesce while checking,
  downloading, installing, or quitting; progress values are bounded; and
  `quitAndInstall` is called at most once for a downloaded version.

### Phase 2: Renderer UX

- Add `Update and restart` action to the update toast and notice-center item.
- Add a `Check for Updates` command to the command palette and app menu.
- Add a small Settings section showing current version, channel, last checked
  time, and current update status.
- Dismissed update notices should stay quiet for that downloaded version, but
  the notice center should still retain the actionable update.
- Keep downloaded update readiness separate from toast visibility and key it by
  version, so dismissing the toast never discards the install action and a newer
  version can still notify again.
- Add tests in `StatusBar.test.tsx` / `NoticeCenter` coverage for ready,
  dismissed, install-click, progress, and no-overlap states.
- Add accessibility assertions for button labels, focus order, and live-region
  behavior.
- Add visual/layout checks for narrow windows so update toasts cannot overlap
  status bar controls or hide important sync/agent notices.

### Phase 3: Release scripts

Add focused scripts under `scripts/` or `apps/desktop/scripts/`:

- `resolve-desktop-release.mjs` or `.ts`: resolve channel, version, tag, name,
  prerelease/latest flags, and short SHA for push/tag/manual releases.
- `update-desktop-package-version.mjs` or `.ts`: temporarily align
  `apps/desktop/package.json` for nightly CI builds only.
- `merge-update-manifests.mjs` or `.ts`: merge per-arch macOS manifests, and
  later Windows arm64/x64 manifests if Windows arm64 is enabled.
- `mock-update-server.mjs` or `.ts`: serve release artifacts from a local
  folder with path traversal guards, modeled on `t3code`.
- `release-smoke.mjs` or `.ts`: fixture-test version resolution and manifest
  merging without requiring full packaging.

Keep these scripts boring and testable. The `t3code` scripts are powerful but
Effect-heavy; dohc can use plain Node scripts unless the repo standard changes.

Script tests must include:

- stable tag resolution.
- nightly version resolution from current package version, date, run number,
  and SHA.
- invalid version rejection.
- stable tag/package-version mismatch rejection.
- manual workflow inputs cannot publish `latest` with a nightly version.
- stable releases ignore nightly tags and nightly versions.
- `GITHUB_OUTPUT` writing.
- macOS manifest merge with x64/arm64 files.
- Windows manifest merge fixtures, even if Windows arm64 is not enabled yet.
- path traversal rejection in the mock update server.
- mock server content-type and 404 behavior.

### Phase 4: GitHub Actions release workflow

Create `.github/workflows/desktop-release.yml`.

Triggers:

- `push` to `main` -> `nightly`.
- tag push `v*.*.*` excluding nightly tags -> `latest`.
- `workflow_dispatch` with channel/version inputs.

Tag/loop guards:

- Exclude `*-nightly.*` with an explicit job `if` condition, not only a tag
  glob.
- Nightly release tags must not trigger the stable release path.
- The stable `finalize` version bump must not accidentally publish a stale
  nightly from an older built SHA.
- Immediately before publishing a nightly, verify that `origin/main` still
  points at the SHA that was built.

Jobs:

- `preflight`: checkout with full history, install pnpm, resolve release
  metadata, run desktop typecheck/tests/package smoke/fuse smoke.
- `build`: matrix across:
  - macOS arm64
  - macOS x64
  - Windows x64
  - Linux x64 AppImage
- `publish`: download artifacts, merge updater manifests, publish GitHub
  Release or upload to `updates.dohc.com`.
- `finalize`: only for stable releases, optionally commit the stable package
  version bump back to `main`.

Workflow rules:

- Use `concurrency` so multiple main pushes do not publish stale nightly
  releases after a newer run has started.
- Set explicit workflow permissions. Use read-only permissions for preflight
  and build jobs; grant `contents: write` only to the publish job; add OIDC or
  cloud permissions only where signing/upload providers require them.
- Use protected environments for signing and release publication.
- Fail release builds if signing is required but secrets are missing.
- Upload artifacts with short retention before publish.
- Do not publish unsigned macOS/Windows release artifacts.
- Generate release notes from commits or GitHub release notes.
- Keep nightly releases prerelease and `make_latest: false`.
- Keep stable releases `make_latest: true`.
- Add a manual `dry_run` workflow input that builds and uploads artifacts but
  does not publish/update manifests.
- Add a `release-smoke` job that validates generated artifacts include exactly
  the expected installers, blockmaps, and channel manifests.
- Add workflow summary output with version, channel, tag, artifact list, and
  update feed URL.
- Require CI to pass before publishing the release assets users can update to.
- If the update host is still undecided, the workflow must remain dry-run only:
  build and upload artifacts for inspection, but do not publish a live release
  or mutate live channel metadata.

### Phase 5: Signing and notarization

macOS:

- Require `CSC_LINK`, `CSC_KEY_PASSWORD`, and Apple notarization credentials in
  release CI.
- Keep `dmg` and `zip` targets.
- Ensure hardened runtime stays enabled.
- Add a CI-only `-c.forceCodeSigning=true` build flag.

Windows:

- Require a real certificate path. Azure Trusted Signing is preferable long
  term; `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` is acceptable for first release.
- Keep NSIS as the update target.

Linux:

- Treat AppImage as the first auto-update path.
- If adding deb/rpm later, document that OS package managers may own updates
  instead.

Signing tests/gates:

- Package smoke fails when `DOHC_REQUIRE_SIGNING=1` and required signing
  secrets are missing.
- Make signing checks platform-specific. A macOS job needs mac cert and
  notarization secrets; a Windows job needs Windows certificate or Azure Trusted
  Signing configuration.
- macOS release CI verifies signing and notarization with `spctl`/`codesign`
  where runner support allows it.
- macOS release CI verifies stapling where runner support allows it.
- Windows release CI verifies Authenticode signature where runner support
  allows it.
- Pin/check expected publisher identity so certificate rotation is intentional
  and cannot silently break update trust.
- Unsigned local packages must remain clearly labeled as dev artifacts and
  never uploaded as release assets.

### Phase 6: Local verification

Build and test with two versions:

1. Build version A with a mock update feed.
2. Build version B into the same mock feed.
3. Launch version A packaged.
4. Confirm it detects version B.
5. Confirm the renderer shows the update-ready notice.
6. Click `Update and restart`.
7. Confirm the relaunched app reports version B.

Automate as much as practical in a desktop smoke script. If full packaged
install automation is too slow for every PR, run it in the release workflow and
keep unit/IPC/update-machine tests in regular CI.

Verification must use real installed artifacts, not unpacked build folders:

- installed `.app` on macOS.
- NSIS-installed app on Windows.
- real AppImage launch on Linux.

Each verification run must capture:

- version A and version B.
- platform and arch.
- feed URL and channel.
- update metadata filename used.
- before/after app version.
- whether install applied through the restart button or on quit.
- relevant updater logs with secrets redacted.

The local smoke must also cover:

- no update available.
- interrupted download recovers on next check.
- same-signer update succeeds.
- missing artifact, wrong hash, bad manifest, and wrong-channel manifest fail
  safely.
- app restart after update preserves open workspace registry and does not touch
  workspace files.
- update check failures do not block launch.
- dismissed update toast does not hide future newer versions.
- installing while an agent run is active is either blocked with a clear
  message or safely waits until the app is ready to quit.

### Phase 7: Rollback and operational readiness

- Make release artifacts immutable. Do not overwrite existing installer or
  manifest files after publication.
- If a bad release is published but not widely adopted, remove or repoint the
  channel manifest only after documenting the exact user impact.
- If any user may already have updated, publish a higher-version hotfix. Do not
  republish the same version with different bytes.
- Add a short runbook:
  - pause nightly publication.
  - identify bad version and affected channel.
  - publish fixed higher version.
  - verify update path from bad version to fixed version.
  - announce known issue and fixed version.
- Record update adoption and failures if telemetry/observability exists; if not,
  log locally enough detail for support without collecting private workspace
  data.

### Phase 8: Non-draft PR and review loops

When implementation and local verification are complete:

- Push the branch.
- Create a non-draft PR. The PR is not complete if it is draft.
- Include the implementation summary, test matrix, release smoke results,
  known limitations, and rollout/rollback notes in the PR body.
- Wait for CI.
- Fix every failing check.
- Run CodeRabbit on the PR and/or inspect CodeRabbit PR review comments.
- Loop until CodeRabbit has no unresolved actionable comments:
  1. fetch CodeRabbit comments and review threads.
  2. classify each item as actionable, duplicate, already fixed, or false
     positive.
  3. implement fixes for actionable comments with tests.
  4. push fixes.
  5. wait for CI and CodeRabbit again.
  6. repeat until CodeRabbit approves or only explicitly documented
     false-positive comments remain.
- If CodeRabbit authentication or tooling is unavailable, record the exact
  blocker and do not pretend a manual review is a CodeRabbit approval.
- Request final human review only after CI and CodeRabbit are clean.

## Security and product invariants

- Browser/renderer code never chooses the update feed.
- User workspace files never influence update feed URLs.
- No update tokens are bundled into the app.
- A private GitHub repository must not become the long-term user update feed
  unless a secure anonymous distribution layer sits in front of it.
- Release signing must be mandatory in release CI.
- Updater IPC must stay narrow: check, get state, install. No arbitrary feed
  mutation through the renderer.
- Release notes rendered in-app must be plain text or sanitized HTML.
- Failed updates must not block app launch, workspace access, sync, or agent
  work.
- Never force-restart during active user or agent work.
- Update downloads must verify the hashes/signatures provided by the updater
  metadata and platform signing chain.
- Release logs must not print signing secrets, tokens, Apple credentials, or
  private feed credentials.
- Update state persisted locally must be non-authoritative. The signed update
  metadata and platform updater decide what can install.

## Testing strategy

Updates are product-critical. Treat this like sync/auth code: lots of small
deterministic tests, plus a smaller number of real packaged app tests.

Pre-merge required gates:

- `pnpm --filter @dohc/desktop typecheck`
- `pnpm test:desktop`
- `pnpm build:desktop`
- `pnpm smoke:package:desktop`
- `pnpm smoke:fuses:desktop`
- `pnpm test:desktop:e2e` when UI or packaged behavior changes.
- release script unit tests.
- mock update server unit tests.
- renderer tests for notice center and settings.

Release-blocking gates:

- macOS signed/notarized packaged update from version A to B.
- Windows signed NSIS packaged update from version A to B.
- Linux AppImage update from version A to B.
- update metadata contains the expected channel and artifact URLs.
- release artifacts can be downloaded anonymously from the chosen feed.
- no unsigned macOS/Windows artifacts are attached to a release.

Regression gates:

- app launches with no network.
- app launches with invalid/corrupt update metadata.
- app launches when update host returns 404/500/timeout.
- app launches when update download is interrupted.
- workspace registry, recent workspaces, cloud credentials, local files, and
  active workspace metadata survive restart/update.
- update UI does not obscure sync conflict, cloud disconnect, or active agent
  notices.
- dev builds do not self-mutate.
- self-host/local-only use remains possible without update credentials.

Detailed checklist:

- Unit: update state machine transitions.
- Unit: feed resolution for packaged/dev/mock modes.
- Unit: IPC schema rejects malformed update events/actions.
- Unit: renderer/preload APIs cannot set or mutate feed URLs.
- Unit: `DOHC_UPDATE_URL` is honored only as a dev/mock override.
- Unit: updater install action refuses when no downloaded update exists.
- Unit: version/channel resolver handles stable, nightly, invalid, and manual
  workflow inputs.
- Unit: stable builds refuse nightly metadata, nightly builds refuse latest
  metadata unless an explicit channel switch is implemented, same-version
  updates are ignored, and downgrades are rejected.
- Unit: manifest merge preserves all arch files and rejects version conflicts.
- Unit: release notes are plain text or sanitized before any renderer display.
- Renderer: ready toast shows action and dismiss works.
- Renderer: notice center retains update after toast dismissal.
- Renderer: check/update commands call the bridge methods.
- Package smoke: release config has publish metadata and signing gates.
- Fuse smoke: packaged app still boots with release fuses.
- Release smoke: fixture manifests and release metadata match expectations.
- E2E/manual: packaged version A updates to version B via mock feed on macOS,
  Windows, and Linux AppImage before the first public release.
- Chaos: corrupt manifest, wrong hash, missing artifact, interrupted download,
  no disk space if reasonably simulatable, and permission denied on installer
  cache.
- Observability: updater errors are logged with enough context to debug but no
  secrets or workspace contents.
- Accessibility: update controls are keyboard reachable and screen-reader
  labels describe the action.
- Performance: update checks/download state events do not add sustained CPU
  polling or renderer jank.

## Definition of done

- `main` pushes publish a `nightly` update users can receive.
- semver tags publish a `latest` update users can receive.
- packaged users see an update notification without setting env vars.
- clicking `Update and restart` updates the app.
- quitting after download also applies the update if that mode stays enabled.
- signed/notarized release gates are enforced.
- local mock-update smoke proves A -> B updates.
- release runbook and rollback path are documented.
- CI passes on the non-draft PR.
- CodeRabbit has approved or has no unresolved actionable comments.

## Open decisions

- Is the first update host GitHub Releases or `updates.dohc.com`?
- Should nightly be a side-by-side app identity before public alpha, or is one
  app/channel enough during dogfood?
- What update poll interval is acceptable for frequent main pushes without
  making the status bar noisy?
- Should dohc initially expose update-channel selection in Settings, or should
  channel be determined only by the installed build?
- What signing provider will be used for Windows?

## Suggested first implementation slice

Start with the smallest slice that turns the existing scaffold into a real
dogfood updater:

- Add install IPC and `Update and restart` UI.
- Use baked `app-update.yml` in packaged builds, with `DOHC_UPDATE_URL` only as
  a dev/mock override.
- Add a local mock update server and two-version smoke instructions.
- Add the release metadata script and an initial `desktop-release.yml` for
  `main` -> nightly GitHub prereleases.
- If GitHub Releases is not confirmed as the first host, keep
  `desktop-release.yml` dry-run/no-publish until the host decision is made.
- Run exact local gates:
  - `pnpm --filter @dohc/desktop typecheck`
  - `pnpm test:desktop`
  - `pnpm build:desktop`
  - `pnpm smoke:package:desktop`
  - `pnpm smoke:fuses:desktop`
  - `pnpm test:desktop:e2e` when UI or packaged behavior changes.

That slice gives dohc the visible update-button behavior immediately, while the
release workflow and signing gates can harden before external users depend on
it.
