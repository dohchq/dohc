# dohc desktop settings page execution log

## Phase 1/2/3 combined foundation

- [x] Contract/test slice
- [x] Implementation slice
- [x] Targeted verification
- [x] Review findings
- [x] Fix loop
- [x] Exit gate

Initial execution map:

- Build typed user and workspace settings models/storage first, mirroring
  `workspaceUiState.ts` tolerant read and atomic write patterns.
- Wire narrow IPC/preload bridge methods only after model tests exist.
- Extract the existing `Agents & MCP` panel into the new settings shell without
  changing behavior.
- Move theme mode into user settings while preserving the titlebar theme bridge.
- Add focused renderer tests before broad Electron E2E.
- Add settings-specific smoke and E2E after the shell can run in the built app.

## Implementation completed

- Added strict user settings and workspace-local settings models with tolerant
  read, bounded files, atomic writes, and `.dohc` metadata safety.
- Added typed IPC channels for user settings, workspace settings, and bounded
  clipboard writes.
- Kept the sandboxed preload dependency-free at runtime; main remains the zod
  validation boundary for result schemas.
- Built a searchable settings dialog with General, Appearance, Workbench,
  Agents & MCP, Cloud & Sync, Privacy, Keyboard, and Advanced sections.
- Extracted the existing MCP settings behavior into `AgentsMcpSettings` and
  preserved the stale active-run guard.
- Moved theme mode into persisted user settings while keeping the native
  titlebar theme bridge and legacy `localStorage` migration.
- Added Activity Bar, Status Bar, command palette, native menu, status context
  menu, and `Ctrl/Cmd+,` entry points.
- Added settings-specific smoke and E2E coverage, including persistence,
  search, corrupt settings recovery, clipboard copy, and minimum window size.

## Verification

- `pnpm --filter @dohc/desktop typecheck`
- `pnpm --filter @dohc/desktop test`
- `pnpm --filter @dohc/desktop build`
- `pnpm --filter @dohc/desktop smoke:settings`
- `pnpm --dir apps/desktop exec playwright test --config playwright.config.ts e2e/settings.spec.ts`
- `git diff --check`

The verification loop used the settings-specific smoke and E2E gates for this
feature plus the full desktop unit suite and desktop build. The broader desktop
E2E pack remains outside this feature gate because the touched runtime paths are
covered directly by `e2e/settings.spec.ts`.

## Fix loop notes

- Repaired desktop jsdom test resolution by pinning desktop to `jsdom@27.2.0`;
  `jsdom@29.1.1` pulled a CJS/ESM-incompatible `html-encoding-sniffer` path
  for the current Vitest harness.
- Repaired the sandboxed preload by removing runtime imports from
  `bridgeContract`; the emitted preload now starts from `electron` plus
  dependency-free channel validators.
- Replaced renderer clipboard writes in settings with a bounded main-process
  clipboard IPC so Electron E2E can verify actual copied config text.
- Hardened the first-run E2E helper so it waits for either first-run or an
  already-mounted workspace shell instead of committing to one surface too
  early.
- Added workspace-scoped request cancellation and visible retry feedback around
  the Agents & MCP settings panel so stale async responses cannot repaint the
  current workspace.

## CodeRabbit review loop

PR: https://github.com/dohc-ai/dohc/pull/41

CodeRabbit findings fixed:

- Critical: complete the reduce-motion override so descendant pseudo-elements
  also disable animation and transitions.
- Major: reset Agents & MCP busy state on workspace changes; add
  workspace-scoped async cancellation; avoid optimistic `"stored"` sources for
  pending workspace saves; preserve nested workspace privacy fields.
- Minor: route clipboard copy through bounded main-process IPC; show copy/load
  failures in the settings UI; add visible focus styles for switches; document
  the `jsdom@27.2.0` pin in JSON-safe package metadata.
- Trivial: add explicit preload payload types, stable warning keys, settings
  merge helpers, a default settings-section constant, safer theme toggle
  rejection handling, and expanded IPC/test documentation.

Rejected findings:

- Vitest 4 / jsdom 29 migration: rejected for this settings PR. The desktop app
  still sits in the repo's broader Vitest 2 test-runner cohort, while a
  Vitest-major upgrade would be a separate test-infrastructure migration across
  desktop, web, and workspace packages. This PR keeps the scoped,
  fully-validated `jsdom@27.2.0` desktop pin and documents the reason in
  `dependencyNotes`.
- The package dependency-note request was implemented as `dependencyNotes`
  because comments are not valid JSON.
