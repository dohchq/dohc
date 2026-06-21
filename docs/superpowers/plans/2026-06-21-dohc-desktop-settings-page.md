---
id: dohc-desktop-settings-page-2026-06-21
title: "dohc desktop settings page"
---

# dohc desktop settings page

> **For agentic workers:** implement this with subagent-driven development.
> One integrator agent owns merge order, final decisions, and acceptance. Use
> focused subagents for disjoint lanes, run the loops in this plan after every
> phase, and track execution with checkbox steps in a companion execution log.

## Product decision

dohc desktop should grow from its current compact `Agents & MCP` settings modal
into a real settings page: searchable, scoped, inspectable, and calm enough to
be used repeatedly without feeling like an admin console.

The first version should stay reasonable. It should not attempt to expose every
possible preference. It should establish the shape of a great settings surface
and move the settings that already exist, or are clearly imminent, into an
obvious home.

The model:

> Settings are a control room for the user's local workspace and agent
> affordances. They should explain scope through structure, not prose.

## Reference patterns

- VS Code gets the most important architecture right: settings are searchable,
  grouped, scoped to user/workspace when appropriate, editable through UI, and
  still backed by inspectable JSON.
- Obsidian gets the information architecture right for a knowledge workspace:
  a simple left navigation, general/editor/appearance/hotkey sections, and
  plugin-like capability areas that can own their own settings.
- Discord gets account-like ergonomics right: a persistent settings shell with
  clear categories for notifications, privacy, account/session, and per-context
  controls that apply immediately.

Sources checked:

- [VS Code user and workspace settings](https://code.visualstudio.com/docs/configure/settings)
- [VS Code workspaces and workspace settings](https://code.visualstudio.com/docs/editing/workspaces/workspaces)
- [Obsidian Settings](https://obsidian.md/help/settings)
- [Discord notification settings](https://support.discord.com/hc/en-us/articles/215253258-Notifications-Settings-101)
- [Discord privacy settings](https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings)

## Current state in the repo

- The desktop app already has a settings entry point:
  `apps/desktop/src/renderer/settings/DesktopSettings.tsx`.
- That component is currently an `Agents & MCP` panel with workspace path,
  MCP enable/disable, copyable MCP config, and example prompts.
- It opens from:
  - `DesktopWorkspaceShell` local `settingsOpen` overlay state.
  - The command palette command labeled `Settings: Agents & MCP`.
  - The Activity Bar settings gear.
  - The Status Bar settings button.
  - The native app menu command id `settings`.
- Workbench UI state is persisted per workspace through a main-owned IPC pair
  to `.dohc/ui-state.json`.
- Theme is currently renderer `localStorage` under `dohc-theme`, mirrored to
  main through `setTitlebarTheme` so native window controls repaint correctly.

## Non-negotiables

- Do not weaken authorization, workspace scoping, or review gates.
- Browser/renderer code must not gain raw filesystem or raw Electron access.
- Settings writes must go through narrow typed IPC contracts with zod-bounded
  payloads and tolerant parsing.
- Secrets do not live in JSON settings files. Provider tokens, cloud sessions,
  and future private credentials stay in OS-backed secure storage.
- Workspace settings must be scoped to the active workspace. App/user settings
  must not silently become shared team/workspace state.
- Settings must survive corrupt or newer-version settings files by falling back
  safely, never by blanking the app.
- The settings UI must use the dohc brand: lowercase `dohc`, warm paper,
  graphite, restrained controls, no legacy product identity.

## Scope model

The settings page should make scope visible with a segmented control near the
top of the shell:

- `User`: local to this human and this desktop install.
- `Workspace`: local to the current dohc workspace.
- `Managed`: read-only future slot for organization/server-enforced policy.

Do not ship `Managed` behavior yet. Reserve the visual language so future org
policy can land without redesigning the page.

### User settings

Stored in the desktop app state directory, probably
`stateDir()/dohc-settings.json`, through a new main-owned helper similar to
`workspaceUiState.ts`.

Examples:

- Theme mode: `system`, `light`, `dark`.
- UI density: `comfortable`, `compact`.
- Editor defaults: font size, line wrapping, spellcheck.
- Notification preferences.
- Update preferences where the platform allows them.
- Default new-workspace location.
- Last-opened settings section/search.

### Workspace settings

Stored under `.dohc/settings.local.json` or another clearly local metadata file
owned by main, not through `writeWorkspaceText`.

Examples:

- Local agent/MCP server enablement for this workspace.
- Default agent driver/model for this workspace once multi-provider settings
  are ready.
- Site preview defaults.
- Workspace-specific history/workbench behavior that is preference-like, not
  transient UI state.

Keep `.dohc/ui-state.json` for ephemeral layout restoration: open tabs,
sidebars, widths, expanded folders, pins, and recent files.

### Shared workspace settings

Do not implement in the first settings page pass.

Longer term, shared workspace policy should be source-backed and reviewable,
but that needs a separate product decision because it affects collaboration,
sync, provenance, and conflict behavior.

## Information architecture

The first settings page should ship with the following sections. Some can be
read-only or "coming next" placeholders only if they prevent a weird empty
navigation model, but avoid fake controls that do nothing.

### General

- Current workspace name/path.
- Open workspace folder.
- Default workspace root.
- Launch behavior: reopen last workspace, open workspace picker, or create new.
- App version/build diagnostics.

### Appearance

- Theme mode: system, light, dark.
- Density: comfortable, compact.
- Reduce motion toggle.
- Optional: editor font size if it is already easy to apply cleanly.

This should replace the one-off `Toggle light/dark theme` mental model with a
proper setting while keeping the command as a quick action.

### Workbench

- Restore tabs on launch.
- Show history rail by default.
- Sidebar default visibility.
- Reset local workbench layout for this workspace.
- Clear quick-open recent files.

These controls should write to the right store: defaults in settings,
current/restored state in `.dohc/ui-state.json`.

### Editor

- Line wrap.
- Font size.
- Spellcheck.
- Markdown preview/editor preferences as they become real.
- Later: wiki-link and inline atom preferences.

Keep this small until the editor has more configurable behavior.

### Agents & MCP

Move the existing `DesktopSettings` behavior here:

- Workspace path.
- dohc MCP server status.
- Enable/disable current workspace MCP server.
- Copy MCP config.
- Agent driver probe/status once stable.
- Current active local agent/session status.

This section should remain extremely direct. The user should never wonder
whether enabling MCP grants cloud access or bypasses workspace boundaries.

### Cloud & sync

- Cloud connection state.
- Connect/sign out.
- Sync enabled/disabled for current workspace.
- Link to manage workspace members.
- Later: share/publish review settings.

This can reuse existing `CloudLogin` and workspace management surfaces rather
than duplicating their full workflows.

### Privacy & permissions

- Explain and control local agent permission defaults when those defaults
  exist.
- Reset remembered allow/deny decisions.
- External link/file open confirmations, if introduced.
- Notification privacy defaults.

This is where Discord's category clarity matters: privacy is not an advanced
dumping ground.

### Keyboard

- Read-only command list in the first pass.
- Later: editable keybindings with conflict detection.

Do not implement half-working keybinding edits. A searchable command list is
already useful and sets up the future.

### Sites & previews

- Default preview behavior.
- Stop all running site previews.
- Port/process diagnostics.
- Later: build command defaults and publish review preferences.

### Advanced

- Open user settings JSON.
- Open workspace local settings JSON.
- Reset section to defaults.
- Reset all user settings.
- Reset all workspace-local settings.
- Export diagnostics bundle.

Advanced should be real escape hatches, not a junk drawer.

## UI shape

Use the existing overlay entry point at first, but make the panel feel like a
full settings page:

- Width around `920-1040px`, height around `min(760px, calc(100vh - 96px))`.
- Left sidebar with section icons and labels.
- Header with title, scope switcher, search input, and close icon button.
- Main content as an unframed scroll area.
- Each setting row has label, short helper text, current value/control, and a
  reset affordance when modified.
- Search filters rows and sections by title, description, keywords, and setting
  id.
- `@modified` can be a later VS Code-style filter, but the row model should
  already know whether a value differs from default.
- Use segmented controls for small enumerations, switches for booleans, selects
  for longer option sets, sliders/number inputs for numeric values, and icon
  buttons with tooltips for reset/copy/open actions.
- No nested cards. Repeated section rows can be bordered rows or simple panels,
  but the page should not become a stack of decorative cards.

On narrow windows, collapse the left navigation into a section select above the
content. Text must not overlap or depend on viewport-scaled font sizes.

## Architecture plan

### 1. Rename the surface without breaking behavior

- Keep `DesktopSettings.tsx` temporarily as the exported entry, or rename it to
  `SettingsDialog.tsx` with a compatibility export.
- Move the current MCP JSX into
  `apps/desktop/src/renderer/settings/AgentsMcpSettings.tsx`.
- Change the command palette label from `Settings: Agents & MCP` to `Settings`.
- Add specific commands later:
  - `Settings: Open Agents & MCP`
  - `Settings: Open Keyboard Shortcuts`
  - `Settings: Open User Settings JSON`

### 2. Add typed settings models

Add pure model modules before UI wiring:

- `apps/desktop/src/settings/userSettings.ts`
- `apps/desktop/src/workspaces/workspaceSettings.ts`
- `apps/desktop/src/renderer/settings/settingsRegistry.ts`

The model should expose defaults, parse, serialize, merge, reset, and modified
checks as pure functions with unit tests.

Suggested initial schemas:

```ts
type ThemeMode = "system" | "light" | "dark";
type Density = "comfortable" | "compact";

type DesktopUserSettings = {
  version: 1;
  appearance: {
    themeMode: ThemeMode;
    density: Density;
    reduceMotion: boolean;
  };
  general: {
    launchBehavior: "last-workspace" | "workspace-picker" | "new-workspace";
    defaultWorkspaceRoot?: string;
  };
  editor: {
    fontSize: number;
    lineWrap: boolean;
    spellcheck: boolean;
  };
  notifications: {
    updates: boolean;
    agentRuns: boolean;
  };
};
```

Keep the first persisted shape boring. The power comes from typed scope and
good UI, not from a giant settings object.

### 3. Add main-owned storage and IPC

Extend `bridgeContract.ts`, `channels.ts`, `preload.ts`, and `main.ts` with:

- `getUserSettings(): Promise<DesktopUserSettings>`
- `setUserSettings(payload): Promise<DesktopUserSettings>`
- `resetUserSettings(payload): Promise<DesktopUserSettings>`
- `getWorkspaceSettings(payload: { workspaceId }): Promise<WorkspaceSettings>`
- `setWorkspaceSettings(payload): Promise<WorkspaceSettings>`
- Optional later: `openSettingsJson(payload)`.

Storage rules:

- Read tolerant: missing/corrupt/oversized/unknown-version files return
  defaults.
- Write atomic: temp file plus rename.
- File size capped before read, as with `workspaceUiState.ts`.
- Main parses payloads before writing and parses results before returning.
- Preload exposes narrow methods only.

### 4. Move theme from localStorage to settings

Replace `theme.ts` storage with `appearance.themeMode`.

- `system` follows `prefers-color-scheme`.
- `light` and `dark` force the theme.
- The effective theme still mirrors to main through `setTitlebarTheme`.
- `rememberChromeTheme` should persist the effective theme so launch chrome
  does not flash incorrectly.
- On first migration, read old `localStorage["dohc-theme"]` once and write it
  into user settings if no user setting exists.

Keep the quick command `Toggle light/dark theme`, but make it cycle between
`light` and `dark` as an explicit override. The settings UI remains the place
to choose `system`.

### 5. Build the settings shell

Create renderer components:

- `SettingsDialog.tsx`
- `SettingsSidebar.tsx`
- `SettingsSearch.tsx`
- `SettingsSection.tsx`
- `SettingRow.tsx`
- `settingsControls.tsx`

The shell owns:

- Active section.
- Scope.
- Search query.
- Loaded user/workspace settings.
- Save state per scope.
- Error state for failed IPC reads/writes.

Rows should be descriptor-driven enough to avoid repeated layout code, but not
so abstract that every setting becomes a tiny DSL.

### 6. Wire existing sections

First implementation target:

- General: workspace path and app diagnostics.
- Appearance: theme mode, density, reduce motion.
- Agents & MCP: current production behavior.
- Cloud & sync: connect/status entry points.
- Advanced: reset settings and open diagnostics placeholders if not ready.

Second implementation target:

- Workbench reset/current defaults.
- Editor settings applied to markdown editor.
- Keyboard read-only command list.
- Sites preview controls.
- Privacy/permissions once agent permission persistence exists.

### 7. Add keyboard and menu integration

- Add native app menu accelerator for settings:
  - macOS: `Cmd+,`
  - Windows/Linux: `Ctrl+,`
- Route it through the existing closed `MENU_COMMANDS` command id.
- Keep Activity Bar and Status Bar settings buttons.
- Command palette should support specific section-open commands once the shell
  accepts `initialSection`.

### 8. Testing plan

Unit tests:

- User settings parse/default/migrate/reset.
- Workspace settings parse/default/reset.
- Corrupt/oversized settings file handling.
- Modified detection and reset behavior.
- Theme mode effective-theme calculation.

IPC/preload tests:

- Channels tuple and bridge contract stay aligned.
- Renderer cannot pass unknown settings keys or invalid enum values.
- Main returns defaults on corrupt files.
- Writes are scoped to the correct user or workspace store.

React tests:

- Settings opens from shell command.
- Search filters sections and rows.
- Section navigation preserves unsaved/in-flight state.
- Appearance controls apply immediately and persist.
- Existing MCP enable/disable/copy behavior keeps passing.
- Reset buttons only affect the correct scope.

Electron Playwright:

- Open settings from Activity Bar, Status Bar, command palette, and accelerator.
- Change theme, relaunch, verify renderer and native chrome start with the
  expected theme.
- Corrupt settings JSON manually, relaunch, verify app still opens with
  defaults and a non-destructive warning.
- At small window sizes, verify no text overlap and the section nav collapses.

## Settings quality bar

The settings page is not accepted when it merely renders. It must be robust
under normal use, corrupt local state, relaunches, workspace switches, keyboard
navigation, and narrow windows.

### Required test files

Add or update focused coverage in these areas:

- `apps/desktop/src/renderer/settings/*.test.tsx` for renderer behavior,
  section navigation, search, row controls, reset affordances, loading states,
  errors, and existing MCP workflows.
- `apps/desktop/src/settings/*.test.ts` for user-settings defaults, parsing,
  migration, serialization, reset, modified detection, and effective-theme
  calculation.
- `apps/desktop/src/workspaces/workspaceSettings.test.ts` for workspace-local
  settings storage, corrupt/oversized files, symlink escape refusal, and atomic
  writes.
- `apps/desktop/src/ipc/bridgeContract.test.ts` and
  `apps/desktop/src/ipc/channels.test.ts` for settings IPC contracts and closed
  channel sets.
- `apps/desktop/src/window/applicationMenu.test.ts` for the settings
  accelerator and menu command.
- `apps/desktop/src/renderer/DesktopWorkspaceShell.test.tsx` for settings
  entry-point routing and section-open commands.
- `apps/desktop/e2e/settings.spec.ts` for real Electron behavior.

### Required renderer/unit scenarios

- Existing `Agents & MCP` status, enable, disable, stale-refresh, and copy
  tests keep passing after extraction.
- Settings can render with only defaults; no bridge response may be required to
  avoid a blank panel.
- Search filters by section title, row title, helper text, keyword, and setting
  id, and has a polished empty state.
- Section navigation does not drop in-flight saves or stale async responses
  onto the wrong workspace.
- Every interactive row has a default value, current value, modified state, and
  reset behavior.
- Scope switching between `User` and `Workspace` never writes to the wrong
  store.
- Failed reads/writes show a recoverable inline error and do not close the
  settings page.
- Keyboard navigation can reach search, section navigation, controls, reset
  buttons, copy buttons, and close.
- Close restores focus to the opener when possible.
- Long paths, long setting names, and disabled/loading text do not overflow the
  panel.

### Required storage and IPC scenarios

- Missing settings files return defaults.
- Corrupt JSON returns defaults and surfaces a non-destructive warning where
  useful.
- Oversized files are ignored before JSON parsing.
- Unknown future-version files do not crash the app.
- Writes are atomic temp-file-plus-rename writes.
- Workspace settings under `.dohc` cannot escape through a malicious symlink.
- Settings writes do not create workspace history/change-set noise.
- Renderer payloads with unknown enum values, oversized strings, or wrong
  workspace ids are rejected.
- Secrets, provider tokens, cloud credentials, and session material cannot be
  serialized into JSON settings shapes.

### Required Electron E2E scenarios

Create `apps/desktop/e2e/settings.spec.ts` and cover:

- Open settings from Activity Bar, Status Bar, command palette, app menu, and
  accelerator.
- Search for `theme`, `mcp`, and a nonsense query.
- Toggle theme to light and dark, close settings, relaunch, and verify the
  effective renderer theme starts correctly.
- Choose `system` theme and verify it follows the mocked or native
  `prefers-color-scheme` path without breaking the titlebar theme bridge.
- Enable and disable the MCP server from settings and verify status text.
- Copy MCP config and verify the clipboard includes the active workspace path.
- Switch between two workspaces and verify workspace-scoped settings do not
  leak across them.
- Corrupt the user settings file between launches and verify the app still
  opens settings with defaults plus a recoverable warning.
- Resize to `1040x760`, `920x700`, and the desktop minimum/narrow width and
  verify no overlap, clipped controls, or inaccessible close button.
- Open settings, perform a change, close, reopen, and verify the value persists
  or intentionally resets according to its scope.

Prefer semantic Playwright assertions and failure screenshots/traces over
pixel-perfect snapshots. The existing config already retains screenshots and
traces on failure through `apps/desktop/playwright.config.ts`.

### Required smoke coverage

Keep the existing desktop boot smoke:

```bash
pnpm build:desktop
pnpm smoke:desktop
```

Add a settings-specific smoke that runs against the built desktop app. It may be
a small Playwright-backed script or a dedicated grep-tagged E2E spec, but it
must be callable as a short command from the repo root.

Suggested command names:

```bash
pnpm smoke:settings:desktop
pnpm --filter @dohc/desktop smoke:settings
```

The settings smoke should:

- Launch the built app with a temp workspace.
- Open settings through the fastest stable entry point.
- Assert the settings shell, search input, and `Agents & MCP` section render.
- Toggle or select a harmless Appearance setting.
- Close and reopen settings.
- Fail on fatal main/renderer logs, preload errors, blank windows, and early
  process exit.

This smoke should stay under 20 seconds locally. It is a confidence check, not
a substitute for full Electron E2E.

### Cleanliness requirements

- Settings components should be split by responsibility; no single component
  should become a second `DesktopWorkspaceShell`.
- Descriptor-driven row rendering is allowed, but avoid a settings DSL so
  abstract that simple behavior is hard to inspect.
- Keep test helpers local and readable; do not create broad global mocks that
  hide IPC mistakes.
- Use accessible names and `data-testid` only where semantic queries are not
  stable enough.
- Avoid screenshot-only verification for behavior; screenshots catch layout
  regressions, assertions prove the feature works.
- Do not ship TODO controls. A deferred setting can appear only as static
  explanatory text or be omitted.

## Agentic execution workflow

Use a main integrator plus focused subagents. The point is not to create a big
committee; it is to reduce blind spots while keeping file ownership obvious.

Create an execution log when implementation starts:

```text
docs/superpowers/plans/2026-06-21-dohc-desktop-settings-page.execution-log.md
```

For every phase, the integrator should write the execution map as checkbox
steps before editing:

```md
- [ ] Contract/test slice
- [ ] Implementation slice
- [ ] Targeted verification
- [ ] Review findings
- [ ] Fix loop
- [ ] Exit gate
```

### Subagent lanes

Each subagent must return changed files, APIs introduced, assumptions, risks,
and exact commands run. Subagents should not revert unrelated work and should
assume other agents may be editing disjoint parts of the codebase.

#### Integrator

Owns:

- Final merge order.
- Conflict resolution.
- Phase acceptance against this plan.
- Deciding which review findings to fix immediately.
- Keeping one consistent product shape across lanes.

The integrator should be the only one to combine changes across renderer,
main-process, storage, and tests.

#### Renderer shell subagent

Owns:

- `apps/desktop/src/renderer/settings/DesktopSettings.tsx`
- New settings renderer files such as `SettingsDialog.tsx`,
  `SettingsSidebar.tsx`, `SettingsSearch.tsx`, `SettingsSection.tsx`,
  `SettingRow.tsx`, and `settingsControls.tsx`
- Settings React tests

Does not touch:

- IPC contracts
- Main-process handlers
- Settings storage helpers

Handoff contract:

- Existing `Agents & MCP` behavior still works.
- Sidebar/search/row layout exists.
- Section state and initial-section routing are explicit.
- Loading, error, disabled, and empty-search states are covered.

#### Settings model/storage subagent

Owns:

- `apps/desktop/src/settings/userSettings.ts`
- `apps/desktop/src/workspaces/workspaceSettings.ts`
- Unit tests for defaults, parsing, migration, reset, modified detection,
  file caps, tolerant reads, and atomic writes

Does not touch:

- Renderer UI
- Preload bridge
- `main.ts`

Handoff contract:

- Exports zod schemas and TypeScript types.
- Missing, corrupt, oversized, and newer-version files fall back safely.
- Workspace metadata writes cannot escape through symlinks.
- Settings writes do not create workspace history noise.
- Secrets are structurally excluded from JSON settings.

#### IPC boundary subagent

Owns:

- `apps/desktop/src/ipc/bridgeContract.ts`
- `apps/desktop/src/ipc/channels.ts`
- `apps/desktop/src/preload.ts`
- The settings handlers in `apps/desktop/src/main.ts`
- IPC and channel tests

Only one subagent should touch these IPC choke points in a phase.

Handoff contract:

- Renderer gets narrow typed methods only.
- Payloads and results are zod-bounded.
- Invalid renderer payloads are rejected.
- Main derives workspace identity from `workspaceId` and registry lookup.
- No raw Electron, Node, or filesystem access leaks into renderer code.

#### Theme integration subagent

Owns:

- `apps/desktop/src/renderer/theme.ts`
- Appearance setting application after user-settings IPC exists
- One-time migration from `localStorage["dohc-theme"]`
- Theme-specific tests

Handoff contract:

- `system`, `light`, and `dark` all work.
- Effective theme still mirrors through `setTitlebarTheme`.
- Native chrome starts in the expected theme after relaunch.
- The quick toggle command remains useful without hiding the `system` option.

#### Workbench/menu subagent

Owns:

- Settings entry points in `DesktopWorkspaceShell.tsx`
- Native menu integration in `apps/desktop/src/window/applicationMenu.ts`
- Command labels and section-opening commands
- Accelerator tests where practical

Avoid concurrent broad edits to `DesktopWorkspaceShell.tsx`; it is a dense
integration file. Prefer one owner or tiny sequenced patches.

Handoff contract:

- The command label is `Settings`.
- `Cmd+,` on macOS and `Ctrl+,` on Windows/Linux open settings.
- Activity Bar, Status Bar, app menu, and command palette entry points still
  work.
- Section-opening commands can route to `initialSection`.

#### QA/regression subagent

Owns:

- Running targeted test commands.
- Adding or updating tests in owned test files when the production owner agrees.
- Reporting failures first, not sweeping production-code fixes into shared
  implementation files.

Handoff contract:

- Test command matrix is recorded.
- Failures include exact command, failing test, and suspected owning lane.

#### Security review subagent

Read-mostly. Audits:

- Renderer-to-main boundaries.
- Workspace scoping.
- `.dohc` metadata writes.
- Corrupt JSON and oversized file handling.
- Secret exclusion from JSON settings.
- No weakening of the product invariants in `AGENTS.md`.

Findings come back first; the owning implementation lane fixes them.

#### UX/visual QA subagent

Owns:

- Playwright-driven screenshot checks.
- Narrow-window overlap checks.
- Keyboard access review.
- IA clarity review.

It may edit renderer CSS/components only when explicitly assigned the renderer
shell lane. Otherwise it reports findings for the renderer owner.

### Implementation loop

For each phase:

1. Read the relevant existing files and this plan section.
2. Write the phase checklist into the execution log.
3. Define the model/contract for the slice.
4. Write or update the smallest failing tests.
5. Implement the smallest production change.
6. Run the narrowest relevant tests.
7. Fix failures before expanding scope.
8. Run the phase's exit gate.
9. Record what changed, what was tested, what still feels risky, and which
   subagent findings were accepted or rejected.

Preserve existing behavior before adding new behavior. In particular, Phase 1
must keep the existing `Agents & MCP` tests passing before persistence work
starts.

### Review loop

After each phase, answer these in the execution log:

- Does every changed setting have a clear scope: user, workspace, or future
  managed policy?
- Does every row have a default, current value, modified state, and reset story?
- Are there any fake controls or placeholders that look interactive but do
  nothing?
- Did renderer code gain raw filesystem, Node, or Electron access?
- Are all IPC payloads/results bounded and parsed?
- Are secrets excluded from JSON settings?
- Are corrupt, oversized, and newer-version settings files tolerated?
- Did any change weaken authorization, workspace scoping, sharing boundaries,
  locks, review gates, sandboxing, or provenance?
- Does the diff rely on raw full-body markdown patching as source of truth?

If any answer is weak, run a fix loop before moving on.

### Regression loop

Targeted commands while iterating:

```bash
pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/desktop test
pnpm --filter @dohc/desktop test -- src/renderer/settings/DesktopSettings.test.tsx
pnpm --filter @dohc/desktop test -- src/ipc/bridgeContract.test.ts src/ipc/channels.test.ts
pnpm --filter @dohc/desktop test -- src/workspaces/workspaceUiState.test.ts
```

Full gates before merge:

```bash
pnpm typecheck
pnpm test
pnpm build:desktop
pnpm smoke:settings:desktop
pnpm smoke:desktop
pnpm test:desktop:e2e
```

Relevant existing test anchors:

- `apps/desktop/src/renderer/settings/DesktopSettings.test.tsx`
- `apps/desktop/src/renderer/DesktopWorkspaceShell.test.tsx`
- `apps/desktop/src/ipc/bridgeContract.test.ts`
- `apps/desktop/src/ipc/channels.test.ts`
- `apps/desktop/src/workspaces/workspaceUiState.test.ts`
- `apps/desktop/playwright.config.ts`
- `apps/desktop/e2e/helpers/desktopApp.ts`
- `apps/desktop/e2e/settings.spec.ts`

### Visual QA loop

Use Playwright assertions plus failure screenshots rather than brittle golden
image baselines.

Check settings at:

- `1040x760`
- `920x700`
- Desktop minimum/narrow width

Verify:

- Opens from Activity Bar, Status Bar, command palette, app menu, and
  accelerator.
- Search results and empty search state.
- Light, dark, and system theme.
- Comfortable and compact density.
- Loading, disabled, and error states.
- Corrupt-settings warning.
- No text overlap or clipped controls.
- Keyboard focus starts sensibly and returns to the opener on close.

### Subagent verification loop

Before merge, run independent no-edit review passes:

- Security subagent: IPC, preload, main storage, and workspace scoping.
- Persistence subagent: corrupt, oversized, symlink, atomic write, and
  no-history behavior.
- UX subagent: information architecture, scope clarity, keyboard access,
  search, reset affordances, and no fake controls.
- Visual QA subagent: Playwright screenshots and overlap checks.
- Regression subagent: command matrix and failure report.

The integrator triages findings, assigns fixes back to owning lanes, then runs
the relevant loop again.

### PR and CodeRabbit loop

After implementation is complete and the full regression gates pass, the
integrator must open a ready, non-draft PR. Do not open a draft PR for the final
settings-page implementation unless the user explicitly overrides this plan.

The PR description must include:

- User-visible summary.
- Storage/IPC/security summary.
- Screenshots or failure-screenshot links for the settings page at normal and
  narrow sizes.
- Exact unit, smoke, build, and E2E commands run.
- Known residual risks, if any.

Once the PR is open:

1. Wait for CodeRabbit's PR review, or run the CodeRabbit CLI review flow if
   the GitHub review is not available.
2. Triage CodeRabbit comments by severity and ownership lane.
3. Fix every actionable critical, major, and minor issue unless it is clearly
   wrong or conflicts with a product invariant.
4. If a finding is rejected, leave a concise PR comment explaining why.
5. Push fixes and wait for CodeRabbit to re-review.
6. Repeat until CodeRabbit approves or reports no remaining actionable issues.

Do not merge or mark the feature done while CodeRabbit has unresolved
actionable critical or major issues. If CodeRabbit is unavailable because of
auth, network, or service failure, record the exact blocker and do not claim
CodeRabbit approval.

## Implementation phases

### Phase 1: Settings shell extraction

Goal: a real settings page with the existing MCP feature preserved.

- Extract `AgentsMcpSettings`.
- Build `SettingsDialog` with sidebar/search/header.
- Keep data fetching only for existing MCP calls.
- Update labels to `Settings`.
- Add section-open support in the shell.

This phase should be small enough to review visually and should not introduce
new persistence yet.

Exit gate:

- `pnpm --filter @dohc/desktop test -- src/renderer/settings/DesktopSettings.test.tsx`
- Settings renderer tests cover navigation, search, loading, error, reset, and
  keyboard behavior for the shell.
- Settings opens from all existing entry points.
- Existing MCP enable/disable/copy behavior is unchanged.
- No new settings persistence exists yet.

### Phase 2: User settings persistence

Goal: typed app/user settings with Appearance live.

- Add `DesktopUserSettings` schema/model/storage.
- Add IPC/preload bridge.
- Migrate theme from localStorage.
- Implement `Appearance`.
- Add reset-to-default per row.

This is the first phase that needs persistence and launch/relaunch testing.

Exit gate:

- User-settings model/storage tests pass.
- `pnpm --filter @dohc/desktop test -- src/ipc/bridgeContract.test.ts src/ipc/channels.test.ts`
- Settings-specific smoke opens the built app and verifies the Appearance
  section renders.
- Theme migration from old `localStorage` is covered.
- Corrupt and oversized user settings files fall back to defaults.
- Relaunch preserves effective theme.

### Phase 3: Workspace settings persistence

Goal: settings that belong to the current workspace have a durable local home.

- Add `WorkspaceSettings` schema/model/storage.
- Keep `Agents & MCP` status/runtime state separate from persisted preference.
- Add workspace-local reset.
- Add `Advanced` links for opening JSON or showing file paths.

Do not merge this with `.dohc/ui-state.json`; UI restoration and intentional
settings are different primitives.

Exit gate:

- Workspace-settings model/storage tests pass.
- Symlink escape, corrupt JSON, oversized file, and atomic write behavior are
  covered.
- Electron E2E proves user settings and workspace settings remain separated
  across at least two workspaces.
- Workspace settings do not create workspace history noise.
- User settings and workspace settings cannot overwrite each other.

### Phase 4: Workbench/editor integration

Goal: make settings change behavior beyond theme.

- Add workbench default controls and reset-current-layout actions.
- Add editor font size/line wrap/spellcheck if the editor stack can consume
  them cleanly.
- Make command palette section-opening commands.
- Add keyboard command list.

Exit gate:

- `DesktopWorkspaceShell` tests cover entry points and section routing.
- `apps/desktop/e2e/settings.spec.ts` covers Activity Bar, Status Bar, command
  palette, app menu, and accelerator entry points.
- Workbench reset only affects intended local UI state.
- Editor settings have focused tests or remain visibly deferred.
- Keyboard command list is searchable and read-only unless conflict detection
  is implemented.

### Phase 5: Privacy, permissions, sites

Goal: settings catches up with dohc's agent and site surfaces.

- Permission reset and policy controls when permission persistence is ready.
- Site preview diagnostics and stop-all controls.
- Cloud/sync settings deeper than connect/manage shortcuts.

Exit gate:

- Security review subagent finds no renderer/main boundary regression.
- Site preview controls stop only the active workspace's previews.
- Permission controls do not bypass skill-turn gates, locks, or sharing
  boundaries.
- Settings-specific smoke, desktop boot smoke, and full desktop E2E pass.
- Full regression gates pass before merge.
- A ready, non-draft PR is opened after the full gates pass.
- CodeRabbit review loops until approval or no remaining actionable issues.

## Open questions

- Should settings eventually open as an editor tab instead of a modal overlay?
  VS Code's modal settings would fit the current overlay system, but a tab
  could better match dohc's "workspace as inspectable surfaces" direction.
- Should workspace settings ever be shared/synced, or should shared policy be
  a separate source-backed artifact with explicit review gates?
- How much of keyboard shortcut editing is worth building before commands are
  stable enough to expose as a public contract?
- Should user settings JSON be edited inside dohc, opened externally, or shown
  as a read-only diagnostics file until schema migration is more mature?

## Acceptance criteria for first useful version

- Settings opens from every current entry point and the app menu accelerator.
- The page has left navigation, search, and at least General, Appearance, and
  Agents & MCP sections.
- The existing MCP enable/disable/copy workflow still works.
- Theme mode is a real setting with `system`, `light`, and `dark`.
- Settings persistence is typed, bounded, main-owned, and tolerant of corrupt
  files.
- A settings-specific smoke test exists and passes against the built desktop
  app.
- `apps/desktop/e2e/settings.spec.ts` covers entry points, search, theme
  persistence, MCP controls, workspace scoping, corrupt settings fallback, and
  narrow-window layout.
- Reset affordances exist for changed settings.
- The UI is responsive down to the desktop minimum window size.
- Tests cover models, storage, IPC boundaries, React behavior, smoke behavior,
  Electron E2E behavior, and relaunch persistence.
- Final implementation lands in a ready, non-draft PR.
- CodeRabbit review has approved or has no remaining actionable issues; any
  rejected findings are documented in the PR.
