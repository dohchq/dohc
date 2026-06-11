# dohc Desktop Experience & Parity Plan

> **North star:** if Obsidian and VS Code had a baby, raised on AI and
> collaboration, built for everyday people — not engineer power users.
> WYSIWYG is key. When in doubt, get inspired by VS Code.

**Status:** draft for execution. Successor to
`2026-06-10-dohc-desktop-local-first-cloud-sync.md` (complete: phases 0–18).
That plan delivered the local-first core — workspace contract, watcher/history,
sync, collab, MCP, packaging, performance gates. This plan delivers the
**product experience**: the desktop currently ships a functional-but-minimal
shell while the rich UX (Tiptap editor, activity bar, chat, graph, sharing,
file management) died with the Convex web app in phase 13.

**The reuse-first thesis of this plan:** almost nothing here is built from
scratch. The full rich UI exists in git history at `7277c39^` (pre-deletion):
`ActivityBar.tsx`, `AtomEditor.tsx` (Tiptap: slash commands, wikilinks, inline
atoms, floating menus), `Chat.tsx`, `GraphView.tsx`, `SearchOverlay.tsx`,
`ShareDialog/SharingPanel/ImportsExportsPanel`, `PropertiesPanel`,
`NoticeCenter`, `Skeleton`, `EmojiPicker`, `DatabaseStudio/DatabaseTableGrid`,
and the pure libs `file-tree-dnd.ts`, `file-tree-nav.ts`,
`file-tree-optimistic.ts`, `wikilinkPlugin.ts`, `inlineAtomPlugin.ts`,
`floatingMenuPosition.ts` — plus `editor-v2/` (Tiptap↔Hocuspocus schema
contracts, markdown import/export) at `7277c39`. Porting rule (proven in the
last plan): strip Convex hooks, feed data through the typed desktop bridge,
keep the component's UX. The hocuspocus service still carries the SAME Tiptap
extensions server-side (`services/hocuspocus/src/import-export.ts`), so the
rich-doc collab path already has its server half.

**Recovery commands:**

```bash
git show 7277c39^:apps/app/src/components/AtomEditor.tsx
git show 7277c39:apps/app/src/editor-v2/dohc-markdown-extensions.ts
git ls-tree -r 7277c39^ --name-only -- apps/app/src
```

---

## Standing rules (apply to every phase)

- **Perf budgets stay hard gates** (`check:performance`): typing long task
  ≤50ms, 250KB open ≤150ms, cold launch ≤2s. Any phase that risks one states
  its strategy up front (E4 does).
- **Every file operation** goes through the path-safe IPC
  (`validateUserWritePath` + realpath containment) and lands in
  watcher/history as a change set. The editor and explorer are never
  privileged writers.
- **Definition of done — EVERY phase, no exceptions.** A phase is not done
  (and the next phase MUST NOT start) until all eight gates pass, in order:
  1. **Unit tests** (vitest) for every new pure module/model.
  2. **The phase's NAMED Playwright E2E spec is green** (each phase below
     names its spec; a phase that ships UI without driving it end-to-end in
     a real Electron window has not shipped).
  3. **The FULL desktop E2E suite is green** — every existing spec, not just
     the new one. A phase that breaks `firstRunWorkspace`, `liveCoEditing`,
     `localAgent`, `performance`, or `productReadiness` is not done.
  4. **`check:performance` exit 0** (budgets are hard; new surfaces add
     budgets, never erode them) and **`check:lean`** (knip + debt +
     architecture) green.
  5. **Screenshots + design-review loop** on every UI phase: capture at
     1280×800 and 1536×960, light AND dark, into
     `test-results/screenshots/<phase>/`; an adversarial design critique
     reviews them against the E0 language and the Obsidian/Linear/VS Code
     bar; visual findings are fixed before commit.
  6. **Commit** (`eN: …`), execution log updated.
  7. **Codex review of the commit** (gpt-5.5 xhigh, read-only) — launched
     immediately after the commit, EVERY phase, not just risky ones. Security
     phases (E3 file-op IPC, E6 agent spawning) get an explicitly
     adversarial prompt.
  8. **Confirmed findings fixed** in an `eN(fix)` commit — triaged with
     adversarial verification, fixed, re-gated (steps 2–4 re-run) — before
     the next phase begins. The fix commit is part of the phase, not debt.
- **Windows verification gate:** the user runs Windows natively. Each UI phase
  ends with a Windows-side checklist (chrome, fonts, context menus, drag-drop)
  — recorded in the execution log; WSLg screenshots are NOT sufficient
  evidence of native feel.
- **Branch:** continue on `claude/desktop-local-first-cloud-sync` or branch
  `claude/desktop-experience` from it — single branch, commit per phase,
  execution log discipline (Resume Snapshot, Decision Ledger) carries over in
  `…-experience-parity.execution-log.md`.

---

## Phase E0: Modern visual language (kill the warm paper)

The warm paper + graphite palette (`#faf7f2`) reads dated. Replace with a
modern neutral system — the Notion/Linear/VS Code family: near-white surfaces,
cool gray scale, one confident accent, crisp hairline borders, comfortable
density.

**Files:** `apps/desktop/src/renderer/styles.css` (token system),
`index.html` (inline first-paint colors), every component using `bg-bg`,
`text-ink`, `border-line` etc. (tokens keep their NAMES — only values change —
so this is a token-file edit plus an audit pass, not a mass rewrite).

- [ ] **Light mode tokens (DECIDED D-E5: graphite minimal —
  Notion-style near-monochrome):** background `#ffffff`, panel `#fafafa`,
  panel-2 `#f4f4f5`, border `#e4e4e7` (1px, never 2), ink `#18181b`,
  muted `#52525b`, subtle `#a1a1aa`. **Accent = ink**: primary buttons are
  black-on-white (white-on-ink fill), active/selected rows are gray tints
  (`#f4f4f5` hover, `#e4e4e7` active), links are ink with underline,
  active activity-bar icon is full-ink vs subtle-gray inactive. Color
  appears ONLY where semantics demand it: success/danger/conflict states,
  collaborator presence cursors, and a neutral-blue text-selection tint for
  legibility — never as brand decoration. Focus rings: 2px ink outline with
  offset (a11y-checked in both modes). Shadows: barely-there
  (`0 1px 3px rgb(0 0 0 / 0.06)`), overlays only. Radius: 6–8px. Type:
  Inter (bundle it) with system-ui fallback; 13px UI / 15–16px editor;
  tabular numerals in tables.
- [ ] **Dark mode as a first-class equal** (VS Code Dark+/Linear dark
  family): background `#18181b`–`#1e1e20` range, not brown-tinted.
- [ ] Remove every warm-tinted hex from `index.html`'s first-paint style and
  `styles.css`; `backgroundColor` in `createMainWindow.ts` follows the theme.
- [ ] **Density + spacing scale:** 4px grid; sidebar rows 28px (VS Code-like),
  not airy web spacing.
- [ ] Gate — **E2E spec: `apps/desktop/e2e/visualLanguage.spec.ts`** (token
  values applied in a real window, light⟷dark flip, computed styles carry NO
  warm-family hexes); design-review screenshots (first-run, shell, editor,
  palette, settings) light+dark; zero `#faf7f2`-family values left (grep
  gate); WCAG AA contrast on all token pairs (scripted check); codex review
  per the definition of done.

## Phase E1: Native window chrome + app identity

The window currently uses stock OS chrome — the single biggest "not a real
app" signal. The t3code recon (execution-log digest, Phase 2) already
specifies the adoption target.

**Files:** `apps/desktop/src/window/createMainWindow.ts`, new
`src/renderer/Titlebar.tsx`, `src/main.ts` (menu), new
`src/window/windowState.ts` (+ test), app icons.

- [ ] **Frameless chrome:** macOS `titleBarStyle: "hiddenInset"` +
  `trafficLightPosition {x:16,y:18}`; Windows/Linux `titleBarStyle: "hidden"`
  + `titleBarOverlay { height: 40, color/symbolColor theme-synced }` (update
  overlay colors on theme toggle via IPC).
- [ ] **Custom titlebar strip** (drag region): app glyph, workspace switcher,
  centered quick-open/search affordance (Cmd/Ctrl+P), right-side window
  padding for overlay controls.
- [ ] **Real application menu** (File/Edit/View/Go/Help) with working
  accelerators — New File, New Folder, Open Workspace, Import, Toggle
  Sidebar, Toggle Theme, Command Palette, Zoom, About. Edit menu wired to
  clipboard roles so copy/paste works everywhere.
- [ ] **Window state persistence** (bounds, maximized, per-display sanity) in
  a pure `windowState.ts` with tests; restore on launch.
- [ ] App icon set (ico/icns/png) wired in dev AND electron-builder config.
- [ ] Gate — **E2E spec: `apps/desktop/e2e/windowChrome.spec.ts`** (custom
  titlebar renders, drag region present, menu accelerators fire, window
  state persists across relaunch); Windows checklist (snap layouts, overlay
  hover states, menu accelerators); codex review per the definition of done.

## Phase E2: VS Code-style workbench

**Files:** new `src/renderer/workbench/` — `ActivityBar.tsx`, `SidePanel.tsx`,
`EditorTabs.tsx`, `StatusBar.tsx`, `workbenchState.ts` (+ tests); port
patterns from history `ActivityBar.tsx`/`SidebarChrome.tsx`.

- [ ] **Activity bar** (leftmost icon rail, 48px): Explorer, Search, Graph,
  Apps, Agent, History/Catch-up, bottom: Cloud status, Settings. Each toggles
  the side panel; badge dots (pending conflicts, agent running).
- [ ] **Side panel:** collapsible (Cmd/Ctrl+B), resizable (drag handle,
  persisted width), per-view header with actions.
- [ ] **Editor tabs:** multiple open files, dirty indicator, middle-click
  close, Cmd/Ctrl+W, reorder by drag, overflow menu. Open-editors state in a
  pure `workbenchState.ts` model with tests.
- [ ] **Status bar:** workspace name, sync status (existing `sync-status`
  data), conflict count, agent-run indicator, theme toggle, update-ready
  toast hook (Phase 14 `updateMachine` messages finally get their surface).
- [ ] Gate — **E2E spec: `apps/desktop/e2e/workbench.spec.ts`** (activity-bar
  view switching, panel toggle/resize persistence, full tab lifecycle incl.
  dirty indicators + relaunch restore); screenshots light/dark; codex review
  per the definition of done.

## Phase E3: Explorer parity (file management)

**Files:** rewrite `src/renderer/workbench/Explorer.tsx` (replaces the flat
list in `DesktopWorkspaceShell`); port `file-tree-nav.ts`, `file-tree-dnd.ts`,
`file-tree-optimistic.ts` from history into `src/renderer/workbench/` (pure,
testable); new IPC: `createFolder`, `renamePath`, `deletePath`, `movePath`
(all through `validateUserWritePath` + realpath containment; delete via
`shell.trashItem` — recoverable, never hard-delete).

- [ ] **Real folder tree:** nested expand/collapse (`.context/me.md` shows as
  folder `.context` ▸ `me.md`), folder-first sort, indent guides, persisted
  expansion state, keyboard nav (arrows/enter/F2), file-type icons.
- [ ] **Create:** inline new-file AND new-folder (context menu + toolbar +
  palette + File menu).
- [ ] **Rename:** F2/context menu inline editbox; rename propagates through
  watcher/history as a change set (and the sync engine's rename handling).
- [ ] **Delete:** context menu + Del key, confirm dialog, `shell.trashItem`.
- [ ] **Move by drag:** drag rows onto folders (drop highlight, auto-expand
  hover), guarded by the same path validation; multi-select drag.
- [ ] **Pin/favorites:** pin section at top of explorer, persisted in
  `.dohc/ui-state.json` (sidecar, never synced as user content).
- [ ] **Import/export:** "Import files…" (exists) + "Add folder to
  workspace…" + export file/folder/workspace as zip (new IPC, bounded).
- [ ] **OS drag-in:** drop files/folders from Explorer/Finder to import.
- [ ] Gate — **E2E spec: `apps/desktop/e2e/explorer.spec.ts`** covering EVERY
  operation (create file/folder, rename, delete-to-trash, drag-move, pin,
  multi-select, OS drag-in, export) with the watcher recording each as a
  change set; traversal/symlink negative tests on every new IPC; codex
  review with an explicitly ADVERSARIAL file-op-security prompt (this phase
  adds four filesystem-mutating IPC surfaces).

## Phase E4: WYSIWYG editor (Tiptap returns)

The answer to "what happened to Tiptap": it lived in the web app
(`AtomEditor.tsx`) and `editor-v2/`, was never ported to the desktop textarea
editor, and was deleted with the Convex app. It comes back as the DESKTOP
editor now — same library family the hocuspocus server already speaks.

**Files:** new `src/renderer/editor/` — port from history:
`AtomEditor.tsx` (strip Convex hooks → bridge), `editor-v2/dohc-markdown-extensions.ts`,
`wikilinkPlugin.ts`, `inlineAtomPlugin.ts`, `floatingMenuPosition.ts`,
`WikilinkPicker.tsx`, `EmojiPicker.tsx`; deps: `@tiptap/core`,
`@tiptap/starter-kit`, `@tiptap/markdown`, `@tiptap/extension-table`,
collab: `@tiptap/extension-collaboration` + existing `@hocuspocus/provider`.

- [ ] **WYSIWYG by default** for markdown: headings, bold/italic/strike,
  lists/checklists, tables, code blocks, blockquotes, images (via
  `dohc-file://`), links, wikilinks with picker, slash commands (`/heading`,
  `/table`, `/todo`…), floating selection toolbar, drag handles.
- [ ] **The file stays canonical markdown on disk:** serialize via
  `@tiptap/markdown` on the same settle/save path (bounded write IPC →
  watcher → history). Round-trip property tests: markdown → doc → markdown
  is stable for the supported node set (port `editor-v2/import-export` tests).
- [ ] **Source button:** toolbar toggle (and Cmd/Ctrl+/) WYSIWYG ⟷ raw
  markdown source (the existing textarea path, kept). State per tab.
- [ ] **Collab goes rich:** Tiptap binds the Yjs `body` XmlFragment — the
  hocuspocus server already imports/projects rich docs
  (`markdownToYDoc`/`yDocToMarkdown`); flip the postgres bootstrap
  `plainText` flag to rich for `.md` atoms. **Decision D-E1 (migration):**
  existing plainText collab docs re-bootstrap from `atoms.body` markdown on
  next open (server hook already re-bootstraps uninitialized docs; verify the
  plainText→rich transition path and write the data-loss test). The
  canonical-state materialization model (`collabSession.ts`) is unchanged —
  it gates WHEN to write; only the doc shape changes.
- [ ] **Performance strategy (stated up front):** budgets unchanged. Typing
  ≤50ms long-task: Tiptap is fine at human doc sizes. 250KB open ≤150ms:
  docs over a size threshold (~64KB) open in the existing fast read view
  (IncrementalMarkdownDocument) with an explicit "Edit" affordance that
  mounts Tiptap; the perf E2E keeps measuring the default path. If Tiptap
  mount-on-edit exceeds 1s on the 250KB fixture, lazy-load the editor chunk
  and record numbers.
- [ ] Gate — **E2E spec: `apps/desktop/e2e/editorWysiwyg.spec.ts`** (typing,
  slash commands, tables, wikilink picker, source toggle, markdown lands on
  disk byte-stable) PLUS `liveCoEditing.spec.ts` UPDATED for the rich doc
  (two clients, content survives, converges, no markers — the exact phase-10
  invariants — plus the plainText→rich migration data-loss test); round-trip
  property tests; perf E2E green; design review of the editor surface; codex
  review per the definition of done.

## Phase E5: Feature parity sweep (the missing 90%)

Inventory from `git ls-tree -r 7277c39^ -- apps/app/src` — every web-app
feature gets an explicit verdict. **Port** = recover from history, de-Convex,
wire to bridge/workspace-api. **Adapt** = same UX, new local-first data
source. **Retire** = recorded with reason (default-retired list below — user
can veto).

### E5.0 Performant search (anchor feature — lands FIRST in the sweep)

Search is a headline capability, not a checklist row. Two surfaces, each with
a hard budget wired into `packages/performance`:

- **Quick-open (Cmd/Ctrl+P)** — file-name fuzzy search. Already exists and
  already gated (`fileTreeSearchTenThousandPathsMs ≤100ms`,
  `fileTreeSearchVisibleResultMs ≤200ms`). Keep; polish ranking (prefix >
  word-boundary > fuzzy; recent files boosted; pinned first).
- **Content search (Cmd/Ctrl+Shift+F)** — workspace-wide full text, the VS
  Code way: bundle **ripgrep** (`@vscode/ripgrep` — ships win32/macOS/Linux
  binaries, the exact engine VS Code uses) spawned from the MAIN process,
  results STREAMED over IPC as they arrive. No index to build or invalidate,
  instant on cold start, scales far beyond our workspace sizes.
  - Search-as-you-type with debounce + cancellation (kill the previous rg by
    PID on every keystroke); first results paint while the scan continues.
  - Match highlighting, surrounding-line context, grouped-by-file results
    with expand/collapse; click lands in the editor at the match (editor
    scroll-to + highlight).
  - Filters: case, whole word, regex toggle, include/exclude globs; ALWAYS
    excludes ignored segments (`.dohc`, `.git`, `node_modules`) and binary
    files (rg does this natively).
  - Path safety: rg runs rooted at the workspace; results re-validated
    against the workspace root before display (no symlink-escape rows).
  - **New perf budgets (additions to `budgets.ts`, named in the phase's
    codex review per the budget-edit rule):**
    `contentSearchFirstResultMs: 300` and `contentSearchCompleteMs: 1500`
    over a generated 10,000-file / ~100MB workspace fixture;
    `searchKeystrokeLongTaskMs: 50` (typing in the search box never janks the
    renderer). **E2E spec: `apps/desktop/e2e/search.spec.ts`** (results stream
    in, cancellation on keystroke, filters, click-to-open-at-match, ignored
    segments excluded) + the perf E2E scenario + `check:performance` rows +
    screenshots; codex review per the definition of done.
  - **Replace-in-files is OUT of scope** for E5.0 (destructive bulk edit
    needs the boundary-policy treatment; ledger it for later).
- **Deferred upgrade (Decision D-E6, default: defer):** a ranked FTS index
  (SQLite FTS5 in a `.dohc/cache` sidecar via `node:sqlite`, updated
  incrementally from watcher change sets) for instant ranked results and
  future semantic search. Only if rg's grep-style results prove insufficient
  for everyday users; verify FTS5 is compiled into `node:sqlite` first.

| Feature (history source) | Verdict | Desktop data source |
|---|---|---|
| SearchOverlay.tsx | **Adapt** — UI ports from history; engine per **E5.0** (ripgrep streamed over IPC; budgets above) | ripgrep over the workspace; quick-open path index |
| GraphView.tsx (+force layout) | **Port** | local link graph parsed from wikilinks/md links (pure lib + worker; d3-force deps return, desktop-only) |
| PropertiesPanel.tsx | **Port** | frontmatter read/write through the editor's markdown round-trip |
| NoticeCenter.tsx | **Port** | local notices: sync errors, conflicts, agent runs, update-ready |
| Catch-up ("while you were away") | **Adapt** | `catchUpSummary` (workspace-history — exists, unwired) over change sets; also wire `describeConflict` (closes the phase-18 tracked gap) |
| ShareDialog/SharingPanel/shareDialogCopy | **Adapt** | postgres `shares` + `GET /shared/atoms/:id`; needs NEW workspace-api endpoints: create/revoke share, list-my-shares (server lane) |
| WorkspaceManagementDialog | **Adapt** | members list + **invitations** — closes the tracked member-invite gap (Better Auth organization plugin primitives; server lane) |
| ImportsExportsPanel | **Port** (split: import exists; export new — E3 zip IPC) | local fs |
| DatabaseStudio/DatabaseTableGrid | **Port** (richer grid/editing than current basic studio) | existing sqlite IPC |
| CommandPalette (web's richer one) | **Merge** into desktop palette: file ops, view switching, theme, every E3 action | local |
| WorkspaceSwitcher | **Polish** existing | registry |
| AttachmentComposer / UploadFileButton | **Adapt** | import IPC |
| Skeleton.tsx, EmojiPicker.tsx | **Port** (used by editor/chat) | — |
| Apps runtime (ViewFrame/AppFrame) | **Phase 7b finally lands**: sandboxed iframe runtime + file-backed RPC persistence bridge + AppTester browser checks; "Apps" activity tab runs trusted apps | existing apps/trust model |
| Onboarding.tsx (agentic web onboarding) | **Retire** (desktop first-run owns this) | — |
| HtmlAtomFrame, ViewsSidebar, AsciiSketcher, inlineAtom live values | **Retire by default** (Convex-era surfaces; revisit on demand) | — |
| Chat.tsx / AgentChatSidebar / AgentRunRail / AgentModelPicker | **Adapt UI, replace engine** → Phase E6 | ACP |

- [ ] Each Port/Adapt lands with unit tests + **its own E2E spec**
  (`apps/desktop/e2e/<feature>.spec.ts` — graph, properties, catchUp,
  sharing, importExport, databaseStudio, appRuntime…); each Retire goes in
  the Decision Ledger. Each E5 sub-feature commit gets its own codex review
  (the sweep is many commits, not one).
- [ ] Gate: parity checklist reviewed against the user's list (this doc's
  header) — every named gap (imports/exports, add folder, delete, rename,
  pin, drag-move, activity bar, graph, agent, source button, folder tree)
  has a green E2E.

## Phase E6: Agent panel — embed, don't build

**Requirement:** local-first agent chat inside dohc using the user's OWN
agent (Claude Code, Codex, Gemini CLI…), not a from-scratch agent runtime.

**Options considered (Decision D-E2 — recommend A):**

- **A. ACP — Agent Client Protocol (RECOMMENDED).** The now-standard protocol
  for embedding coding agents in editors (Zed external agents; VS Code "ACP
  Client" extension; an Obsidian community plugin does exactly this for a
  notes app). Claude Code, Codex CLI, Gemini CLI, OpenCode, Copilot and
  others speak it. dohc spawns the user's agent as an ACP subprocess in the
  workspace root and renders our own chat panel (messages, tool-call cards,
  diffs, permission prompts) with the TS protocol lib
  (`@zed-industries/agent-client-protocol`). We own the UX; we don't own the
  agent. Permission requests route through dohc's boundary policy; sessions
  start/stop through the existing agent-run attribution seam; the dohc MCP
  server is auto-registered so agents get workspace tools. Port `Chat.tsx`
  UX (bubbles, context meter, busy states) from history for the look.
- **B. Embedded terminal (xterm.js + node-pty).** The t3code approach: a real
  PTY panel running the user's CLI verbatim. Cheapest, perfect fidelity —
  but terminal UX contradicts "everyday people", no structured
  approvals/attribution, no rich tool cards. Keep as a power-user escape
  hatch AFTER A (a "Terminal" panel is cheap once node-pty is in).
- **C. Claude Agent SDK + codex app-server.** Deepest per-vendor integration,
  fully custom UI — but two bespoke protocol clients, vendor lock-in, most
  build. Rejected while ACP covers both vendors.
- **D. AI SDK + ACP community provider.** Build chat on Vercel AI SDK UI with
  the ACP provider as the model. Viable implementation detail of A if its
  UI primitives save time; evaluate during E6 recon.

**DIRECTIVE (user, 2026-06-11): follow t3code's patterns**
(`/home/ice/dev/oss-repos/t3code`) — it is tried and tested, and critically
its design makes users' EXISTING SUBSCRIPTIONS (Claude Pro/Max via the
`claude` CLI login, ChatGPT Plus/Pro via Codex's ChatGPT OAuth) work
first-class. No API keys in dohc, ever — the user's installed, logged-in CLI
is the auth. The t3code patterns to adopt (re-expressed in plain dohc
TypeScript — their packages are Effect-TS-shaped, so we follow the
architecture, not the imports):

- **Provider / Driver / Adapter separation** (`apps/server/src/provider/`):
  a `Driver` per vendor knows the executable, detection, install hint, and
  home-dir layout (`ClaudeDriver` → `claude`; `CodexDriver` → Codex
  app-server processes); an `Adapter` per vendor translates its protocol to
  one internal session interface; a `ProviderRegistry` + instance registry
  detects what's installed and tracks live sessions; a **session reaper**
  tears down orphaned agent processes; an **NDJSON event logger** records
  every protocol event for debugging.
- **Claude Code via ACP** (their `effect-acp` is generated from the official
  ACP schema v0.11.3, incl. terminal support) — ours uses the official
  `@zed-industries/agent-client-protocol` TS lib against the same schema.
- **Codex via its NATIVE app-server protocol** (their
  `effect-codex-app-server`), NOT ACP — this is the protocol the official VS
  Code extension uses and the proven ChatGPT-subscription path: the adapter
  must handle `account/chatgptAuthTokens/refresh` (plan-token refresh
  mid-session) and `mcpServer/oauthLogin/completed` events the way
  `CodexAdapter.ts` does.
- **Subscription-aware model handling**: `ClaudeProvider.ts` normalizes
  subscription-tier model aliases — the model picker must distinguish
  plan-included models from API models and default to the plan.
- **Managed agent homes** (`ClaudeHome.ts`, `CodexHomeLayout.ts`): t3code
  isolates per-instance `CODEX_HOME`/Claude home so instances cannot corrupt
  each other's auth. dohc adapts the pattern with the OPPOSITE default:
  desktop sessions use the user's REAL `~/.claude`/`~/.codex` so their
  existing login/subscription works with zero re-auth; isolation stays
  available per-workspace for advanced cases. If the agent is not logged in,
  surface the CLI's own login flow (never collect credentials ourselves).

- [ ] Recon: map t3code's `ClaudeAdapter`/`CodexAdapter` session lifecycle,
  permission-request flow, and error normalization into a dohc driver
  interface spec; verify both CLIs' spawn + auth passthrough on WINDOWS
  (t3code targets server/cloud — Windows process + home-path differences are
  our recon delta); pick protocol lib/schema versions.
- [ ] Agent panel UI (activity-bar view): agent picker (detect installed
  CLIs), session list per workspace, message stream with tool-call cards,
  STOP button, permission prompt surface (maps ACP permission requests →
  dohc confirm dialogs; boundary-crossing language from collaborationPolicy).
- [ ] Wire attribution: panel session ⇒ `startAgentRun`/`endAgentRun` so
  agent edits are attributed in history (seam exists).
- [ ] Auto-configure the dohc MCP server for the spawned agent (config
  injection per agent CLI's mechanism).
- [ ] Gate — **E2E spec: `apps/desktop/e2e/agentPanel.spec.ts`** with a FAKE
  ACP agent binary AND a fake codex app-server (scripted JSON-RPC) — session
  lifecycle, streamed tool-call cards, permission flow (boundary-crossing
  requires confirmation), STOP, file edit lands in history attributed,
  subscription-token-refresh event handled; manual matrix with real Claude
  Code + Codex (logged-in subscriptions) recorded in the log; codex review
  with an explicitly ADVERSARIAL agent-spawning/credential-safety prompt.

## Phase E7: Native polish + full QA matrix

- [ ] Context menus everywhere (editor, tabs, explorer, status bar) via
  Electron `Menu` over IPC.
- [ ] Full keyboard map documented + tested (VS Code-familiar: Cmd/Ctrl+P/
  Shift+P/B/W/N/S, F2, Del…).
- [ ] Recent workspaces (File ▸ Open Recent + OS jump list), `Open with dohc`
  file association (packaged builds).
- [ ] Update-ready toast wired to `updateMachine` user-visible messages.
- [ ] Empty states, loading skeletons, focus rings, reduced-motion respect.
- [ ] Readiness re-run: extend `productReadiness.spec.ts` with the new
  surfaces; full battery (`typecheck`, all suites, desktop E2E, perf,
  check:lean) green; Windows manual checklist signed off in the log.

---

## Decision points for the user (defaults marked)

All decisions below are **DECIDED (user, 2026-06-11)** — no open defaults
remain; the plan is fully executable.

| # | Decision | Default |
|---|---|---|
| D-E1 | Collab doc shape flips plainText → rich Tiptap `body` for `.md` (server supports both; migration test required) | **DECIDED: flip to rich** in E4 (plainText→rich re-bootstrap migration + data-loss tests required) |
| D-E2 | Agent integration approach | **DECIDED (user, 2026-06-11): follow t3code's patterns**, AMENDED by recon (docs/superpowers/recon/2026-06-11-e6-agent-driver-spec.md): t3code's actual tested Claude path is `@anthropic-ai/claude-agent-sdk` (not ACP) — so dohc ships THREE drivers behind one AgentDriver interface: Claude via agent-sdk (t3code-tested, incl. the subscription-tier probe), Codex via its native app-server protocol (t3code-tested, ChatGPT token semantics), generic ACP driver for everything else (Gemini/Cursor/OpenCode…, per t3code's AcpSessionRuntime). Subscription auth via the user's logged-in CLIs/homes (never API keys). Terminal escape-hatch later |
| D-E3 | Default-retired web features (HTML atoms, Views runtime, AsciiSketcher, agentic onboarding) stay retired | **DECIDED: all stay retired** |
| D-E4 | Phase 7b app runtime is in scope (E5) — it is the largest single item after the editor | **DECIDED: in scope** |
| D-E5 | Accent color / brand direction for the new palette | **DECIDED: graphite minimal** (near-monochrome, accent = ink, color only for semantics — see E0 tokens) |
| D-E6 | Content-search engine: ripgrep-streamed (VS Code model) now; SQLite FTS5 ranked index only if grep-style results prove insufficient | **DECIDED: ripgrep now, FTS5 deferred** |

## Sequencing

E0 → E1 → E2 → E3 → E4 → E5 → E6 → E7, with lanes: E0+E1 can run together;
E3's pure tree libs and E4's editor port are parallel after E2; **E5.0 search
starts as soon as E2's activity bar exists** (it only needs a panel to live
in); E5's server items (shares CRUD, invites) are a parallel server lane; E6
recon can start any time. Estimated shape mirrors the last plan: commit per phase, adversarial
review per phase, execution log as the resume surface.
