# E2 recon digest — VS Code-style workbench (build contract)

Sources: current shell (`apps/desktop/src/renderer/`), history at `7277c39^`
(old web ActivityBar/SidebarChrome/ViewsSidebar), plan Phase E2
(docs/superpowers/plans/2026-06-11-dohc-desktop-experience-parity.md:153-174).

## 1. Current shell anatomy → workbench parts

`DesktopRoot.tsx` mounts `DesktopFirstRun` or `DesktopWorkspaceShell` (DesktopRoot.tsx:1-50).
`DesktopWorkspaceShell.tsx` tree (line refs):

- `div[data-testid=workspace-shell].app-chrome` (244-248) — stays the root testid.
- `Titlebar` (249-254) — already E1-done; testids `titlebar`, `workspace-switcher`, `titlebar-quick-open`. Unchanged.
- Middle row (255):
  - `aside w-60 bg-panel-2` (257-309) → becomes **SidePanel hosting the Explorer view**:
    `nav[data-testid=file-tree][aria-label=Files]` flat list of memoized `FileRow`s (259-285);
    footer with "New file" / "Import files" buttons (287-307) → Explorer view-header actions
    (ViewsSidebar header-with-actions pattern: title + count + action icons, see §2).
  - `main` (312-350): `FileInspector` when `selected` (313-319), else empty-state hints (320-348). → **EditorTabs + editor body**; empty state stays for zero tabs.
  - `aside[data-testid=history-timeline][aria-label=History] w-64` (354-395) → **stays a default-visible right rail in E2** (see risk §7 — 4 specs assert the timeline without any click: firstRunWorkspace.spec.ts:77-111, markdownEditing.spec.ts:53, performance.spec.ts:373-390, productReadiness.spec.ts:407). The History activity-bar item toggles this rail; do NOT move it behind the left panel in E2.
- `footer h-7` (399-431) → **StatusBar.tsx**: `span[data-testid=sync-status][data-state=…]` (400-410, `SYNC_LABEL`/`SYNC_DOT` maps at 14-28); "Connect dohc Cloud" button (412-419); `button[data-testid=open-settings]` (420-429).
- Overlays (433-475): `CommandPalette` (`command-palette`), quick-open `CommandPalette` (`quick-open`, 439-451), `NewFileDialog`, `Overlay>CloudLogin`, `Overlay>DesktopSettings`. **Overlays stay shell-root-mounted**; activity-bar Cloud/Settings items open the same overlays (`setCloudOpen`/`setSettingsOpen`).
- Command registry (188-232): 8 commands, palette + menu route through it (`onMenuCommand` 234-242; `MENU_COMMANDS` closed set in src/ipc/channels.ts:5-15, preload allowlist preload.ts:71-79). Workbench adds commands HERE (view switching, close-tab).
- Data flow stays at the root: `openWorkspace` starts the watcher, `onWorkspaceActivity` → `refreshFiles`+`refreshHistory` (136-152). Views consume root state; never per-view subscriptions.

**Testids the suite pins (workbench MUST keep, exact semantics):**
`workspace-shell` (visible in ~all 14 specs; `toContainText("notes/today.md")` firstRunWorkspace.spec.ts:139),
`file-tree` (10 specs; `closest("aside")` bg must be panel-2, visualLanguage.spec.ts:140-147; toggle-sidebar ⇒ `toHaveCount(0)` then visible, windowChrome.spec.ts:122-124),
`sync-status` + `data-state` attr (firstRunWorkspace.spec.ts:76, productReadiness.spec.ts:623,696),
`history-timeline` (4 specs above), `command-palette`, `quick-open` (firstRunWorkspace, windowChrome, performance),
`open-settings` (visualLanguage:176,212; productReadiness:390), `settings-panel`, `titlebar`, `workspace-switcher`, `titlebar-quick-open`,
button accessible-name `/connect dohc cloud/i` (cloudLogin:87,114; cloudSync:110; liveCoEditing:87; firstRunWorkspace:152; productReadiness:104),
all `view-*`/inspector testids (`file-inspector`, `view-markdown`, `markdown-edit-toggle`, `markdown-editor`, `markdown-save-state`, `view-csv`, `view-database`, `collab-editor`…) — untouched if the inspector mounts inside the active tab.
**Known honest update:** firstRunWorkspace.spec.ts:119 `expect(palette.getByRole("option")).toHaveCount(8)` — breaks the moment E2 adds any command. Update the count + the comment listing commands (lines 117-122) in the same commit.

## 2. Old ActivityBar patterns to port (from `7277c39^`)

`apps/app/src/components/ActivityBar.tsx`: `nav` rail (`w-12`, vertical, border-r, bg-panel);
`ITEMS: Array<{view, label, Icon}>` data table; per-item `button` with `title` + `aria-label` +
`aria-current={active ? "page" : undefined}`; active indicator = absolute 2.5px ink bar on the left
edge; lucide icons `size-[18px] strokeWidth={1.9}`; inactive `text-ink-faint`, active full-ink
(matches D-E5 graphite: active icon full-ink vs subtle-gray, plan lines 104-106); bottom slot via
`mt-auto border-t` (sidebar collapse toggle lived there).
`SidebarChrome.tsx`: `SidebarHeader` (brand + icon-button cluster) — superseded by the Titlebar;
`ThemeToggleButton` icon-cycle pattern → port to StatusBar (desktop `theme.ts` is binary
light/dark `toggleTheme`, so 2 states not 3). `ViewsSidebar.tsx` header pattern to reuse per view:
icon + uppercase tracking title + right-aligned count/actions, hover-reveal row actions
(`opacity-0 group-hover:opacity-100 focus:opacity-100`).

**Desktop changes:** items per plan (plan:160-162): Explorer (`Files` icon), Search, Graph, Apps,
Agent, History; bottom: Cloud status, Settings. Clicking the active item toggles the panel
(replaces the old explicit collapse button; Ctrl+B equivalent). Badges: small dot on Explorer/status
for `syncStatus.state === "conflict"`, dot on Agent when `getAgentRunStatus().activeRun !== null`
(§6). Search/Graph/Apps/Agent panels are E5.0/E5/E6 content — E2 ships the rail + empty panel
shells ("coming in this plan" placeholder is acceptable; E5.0 starts as soon as the rail exists,
plan:455-456). Keep `title`+`aria-label`+`aria-current` exactly as the old component.

## 3. workbenchState (pure model + unit tests)

New `src/renderer/workbench/workbenchState.ts`, pure like `window/windowState.ts` (parse =
tolerant, corrupt ⇒ defaults; clamp like windowState.ts:23-31):

```ts
type ViewId = "explorer" | "search" | "graph" | "apps" | "agent" | "history";
interface WorkbenchState {
  activeView: ViewId;            // default "explorer"
  sidebarVisible: boolean;       // default true
  sidebarWidth: number;          // clamp 180–480, default 240 (today's w-60)
  tabs: Array<{ path: string; pinned?: boolean }>;
  activeTab: string | null;
}
```
`dirty` is RUNTIME-ONLY (derived from editor save-state, §4) — never persisted.
Pure transitions (each unit-tested): `openTab(path)` (no dup; activates), `closeTab(path)`
(next-activation rule: neighbor, VS Code-style), `activateTab`, `moveTab(from,to)`, `togglePin`,
`setView(v)` (same view ⇒ toggle `sidebarVisible`), `toggleSidebar`, `setSidebarWidth(clamped)`,
plus `parseUiState(raw) / serializeUiState(state)`.

**Persistence location — recommend workspace-local `.dohc/ui-state.json`:**
- Plan E3 already names this exact file for explorer pins ("persisted in `.dohc/ui-state.json`
  (sidecar, never synced as user content)", plan:197-198) — one file, one decision.
- The watcher/tree/history already ignore `.dohc` at any depth: `IGNORED_SEGMENTS`
  (packages/workspace-core/src/paths.ts:46-55), tree walker `IGNORED_DIRS`
  (src/workspaces/workspaceFiles.ts:25), and firstRunWorkspace.spec.ts:111 +
  productReadiness.spec.ts:411 pin that `.dohc` never appears in the timeline. The sync engine is
  fed from already-filtered watcher batches, so the file never uploads. **No new ignore work.**
- It travels with the folder (reattach keeps tabs), and is per-workspace by construction —
  `stateDir()` (WorkspaceRegistry.ts:23-25) would need a keyed map in one global file and dies
  with userData.
- Constraint: the renderer CANNOT write it through `writeWorkspaceText` —
  `validateUserWritePath` refuses reserved `.dohc` paths (paths.ts:35-41,
  workspaceFiles.test.ts:23). Add a narrow IPC pair `getWorkspaceUiState`/`setWorkspaceUiState`
  handled in main writing directly under the workspace root (same pattern as
  `.dohc/agent-runs.json` in AgentIntegration). Renderer debounces writes (~500ms).
`stateDir()` stays for app-level state only (registry, window state, credentials).

## 4. Editor tabs

Today: single `selected: string | null` (shell:89); `FileInspector` mounted with
`{workspaceId, path, refreshKey: changeSets.length, onOpenPath}` (shell:313-319). Two open paths:
tree click → `selectFile` which marks `file-open-start` (shell:118-122), and quick-open `run:
() => setSelected(file.path)` (shell:447) which does NOT mark. Replace both with one
`openFile(path)` that (a) marks `file-open-start`, (b) dispatches `openTab`. The
`openMarkdown250KbMs` budget chain is: click ⇒ `file-open-start` ⇒ MarkdownView mount effect
measures `markdown-open` + freshness mark `markdown-opened` (FileInspector.tsx:207-212;
consumed performance.spec.ts:305-340 via `freshMeasure`). Tab ACTIVATION of an already-open tab
should also mark `file-open-start` (it remounts the inspector unless kept alive — simplest: one
mounted FileInspector for the active tab, exactly today's behavior, re-read on switch).
- **Dirty:** MarkdownView's `saveState` ("saving"/"error", FileInspector.tsx:176, 800ms autosave
  237-243) is the only dirty source. Lift via an `onSaveStateChange` callback prop threaded from
  FileInspector → shell; tab shows dot while `saveState !== "saved"`. `markdown-save-state`
  testid must keep rendering in the doc header (markdownEditing + productReadiness assert it).
- **Close:** middle-click via `onAuxClick`/`button === 1`; Ctrl/Cmd+W in the existing shell
  keydown handler (shell:154-177 — it is the single owner of accelerators; the menu displays but
  never registers them, shell:158-160). Add `close-tab` to the command registry.
- **Reorder by drag:** pointer-events on the tab strip (no dep) — can land late in E2; the gate
  spec covers it (plan:170-172).
- Specs asserting current single-file behavior: all of them only ever assert the OPENED file's
  view (fileTypes:60, appPackage:67, markdownEditing:27, performance:321-329 swaps big.md⇄small.md
  via tree clicks — tab switching must still trigger a fresh read + measure, which the
  remount-on-activate model gives for free). firstRunWorkspace:139 passes via tab label OR
  inspector header (both contain `notes/today.md`). No spec asserts "only one file open".

## 5. Resizable side panel (no new deps)

Drag handle: 4px-wide `div` on the panel's right edge, `cursor-col-resize`,
`onPointerDown` ⇒ `setPointerCapture`, `onPointerMove` ⇒ `setSidebarWidth(clamp(e.clientX -
ACTIVITY_BAR_W))`, `onPointerUp` ⇒ persist (debounced into ui-state). Clamping logic lives in
workbenchState (unit-tested, windowState precedent). Width applied as inline `style={{width}}`
replacing `w-60` (shell:258). Ctrl+B (shell:170-173) and the `toggle-sidebar` command/menu item
(shell:211-214, channels.ts:12) rewire to `dispatch(toggleSidebar)` — hidden must UNMOUNT the
panel (windowChrome.spec.ts:122 asserts `file-tree` `toHaveCount(0)`). Keep `aside` +
`bg-panel-2` + `nav[data-testid=file-tree]` structure for visualLanguage.spec.ts:140-147.

## 6. Status bar contract

- **sync-status:** move the span verbatim (testid + `data-state` + dot/label maps,
  shell:14-28,400-410). Source unchanged: `getSyncStatus`/`openWorkspace` →
  `deriveSyncStatus` (packages/workspace-core/src/syncStatus.ts:29-43, called in
  workspaceActivity.ts:46-64).
- **Conflict count:** NOT surfaced today — `SyncStatusResult` is `{state, pendingChangeCount,
  lastSyncedAtMs}` (bridgeContract.ts:202-213); the engine snapshot's `conflictCount` is collapsed
  to `hasConflict` (workspaceActivity.ts:56). Additive zod field `conflictCount` plumbed from
  `statusFor` — additive, no spec touches it.
- **Agent-run indicator:** `bridge().getAgentRunStatus({workspaceId})` →
  `{mcpEnabled, activeRun, lastRun}` (bridgeContract.ts:489, AgentIntegration.ts:178-192).
  Pull-based; refresh on the existing `onWorkspaceActivity` tick (shell:144-147) — no new event.
- **Update toast:** `startAutoUpdates` already takes `onState` (electronUpdater.ts:26,42) but
  main.ts:831 passes none and no main→renderer channel exists. Hook point: pass `onState` ⇒
  `webContents.send("desktop:update-state", state)` to all windows; preload must validate against
  a closed shape exactly like `menuCommand` (preload.ts:71-79); StatusBar shows `state.message`
  when `status === "ready"` (messages already written, updateMachine.ts:36-45). Dev/E2E never
  fires (gated on isPackaged + DOHC_UPDATE_URL) — unit-test the renderer surface with a fake.
- **Cloud + Settings + theme:** the `/connect dohc cloud/i` BUTTON NAME and `open-settings`
  testid must survive (5 + 4 specs, §1) — keep both as status-bar items even though the activity
  bar gains Cloud/Settings at the bottom (both routes call the same `setCloudOpen`/
  `setSettingsOpen`). Theme toggle: StatusBar button running the existing `toggle-theme` command
  (shell:226-229); windowChrome.spec.ts:127-135 only uses the menu path — unaffected.

## 7. Risks

E2E exposure (37 tests / 14 specs), tests touching moved surfaces:
- productReadiness (11/11): file-tree, history-timeline, sync-status data-state, open-settings,
  connect-cloud — all keepable verbatim. Highest volume, no expected edits.
- performance (7/7): launch budgets key off `workspace-shell` visibility; tree/timeline text
  waits; quick-open search measures; markdown-open chain (§4). No edits if contracts above hold.
- windowChrome (4): menu `toggle-sidebar` ⇒ file-tree count, settings via menu, theme flip.
- firstRunWorkspace (3): **palette `toHaveCount(8)` needs an honest update** (only known edit);
  rest keepable (sync-status, history-timeline, footer names, quick-open).
- liveCoEditing (2), localAgent (2): connect-cloud name / open-settings + mcp toggles — keepable.
- markdownEditing, fileTypes, sqliteImport, appPackage, visualLanguage, cloudLogin, cloudSync,
  desktopLaunch (1 each): tree-click → view assertions; visualLanguage additionally pins sidebar
  `aside` bg-panel-2 and the no-warm-hex grep — the new ActivityBar/StatusBar chrome must use
  tokens only.

Perf budgets at risk (packages/performance/src/budgets.ts:7-22):
- `coldLaunchToShellMs` 2000 / `warmLaunchToShellMs` 1000 — measured to `workspace-shell`
  visible (performance.spec.ts:184-196); the rail/tabs/statusbar add first-paint work. Keep them
  dumb (no lazy imports needed, but no new deps either).
- `rendererInitialBundleMb` ratchet (+10% fails, budgets.ts:35) — lucide icons are tree-shaken
  per-import; fine, but no icon-font/new libs.
- `openMarkdown250KbMs` 150 + `typingLongTaskMs` 50 — tab-strip re-renders on save-state flips
  must be memoized (FileRow precedent, shell:55-58); dirty flips every 800ms while typing.
- `openThousandFileWorkspaceMs` / `fileTreeSearch*` — Explorer stays today's flat list until E3;
  quick-open stays CommandPalette (it records the `file-tree-search-query/visible` measures,
  CommandPalette.tsx:41-45).
- `workspace-shell-interactive` + `file-tree-loaded` marks fire in shell effects
  (DesktopWorkspaceShell.tsx:126-131) — no spec reads them TODAY, but they're the named
  interactive marks; keep both `markOnce` calls in the workbench root where syncStatus/files
  state still lands (do not move them into a view that may be unmounted).
- History rail removal would break 4 specs (§1) — E2 keeps it default-visible.
