# Desktop Component Reuse Map — Phase 3 Recon

Date: 2026-06-10
Scope: every component in `apps/app/src/components/`, plus shell-relevant code in
`apps/app/src/routes/` and `apps/app/src/lib/`, classified for the Electron desktop
pivot (Phase 3 shell, Phase 6 file UX).

## Mechanical criterion (from the plan, Phase 3 Step 3)

A component is **reuse-as-is** only if it has no imports (direct or transitive) from
`convex/react`, Convex React hooks (`@convex-dev/agent/react`),
`apps/app/convex/_generated`, or web router internals (`@tanstack/react-router`,
TanStack Start). If its data access can be lifted to props fed by the typed desktop
bridge (`window.dohcDesktop`, `apps/desktop/src/ipc/bridgeContract.ts`), it is
**port-with-swap**. Otherwise **rebuild**. Components with no desktop surface are
**skip-not-needed-for-desktop**.

Ground truth for the coupled set (grep for `convex/react | @tanstack/react-router |
@convex-dev` over `apps/app/src/components/`): AtomEditor, AtomView,
AttachmentComposer, Chat, CommandPalette, GraphView, HtmlAtomFrame, Markdown,
Onboarding, SearchOverlay, ShareDialog, SharedAtomView, SharingPanel,
UploadFileButton, ViewFrame, ViewsSidebar, WorkspaceManagementDialog,
WorkspaceSwitcher (18 files). Everything else in the directory is import-clean at
the module level — but see Traps for two clean-looking files that drag Convex in
transitively (FileTree, AgentChatSidebar) and one that drags in the whole editor
(CommandPalette → AtomEditor).

## Styling system facts

- **Tailwind CSS v4.2.4** (`tailwindcss` + `@tailwindcss/vite` in
  `apps/app/package.json`), CSS-first config — there is **no tailwind.config.js**;
  everything lives in `apps/app/src/styles.css` (2,695 lines): `@import 'tailwindcss'`,
  a `@custom-variant dark (&:where([data-theme=dark], …))` keyed off `data-theme` on
  `<html>`, and an `@theme inline` block (line 265) that maps semantic CSS vars to
  Tailwind utilities (`bg-page`, `text-ink`, `border-rule`, `text-ink-dim`, …).
  Components are styled with Tailwind utility classes inline; no CSS modules, no
  styled-components.
- **Design tokens**: two layers.
  1. Brand tokens `--dohc-*` (warm paper `#f7f6f1`, panel `#fffefa`, graphite ink
     `#151515`, accent `#2d342e`; dark = green-black via `[data-theme='dark']`).
     Declared source of truth: `packages/brand/src/tokens.css`, exported as
     `@dohc/brand/tokens.css` in `packages/brand/package.json`.
  2. Semantic surface tokens `--color-*` (page/surface/panel/ink/rule/accent/folder
     colors/status), shadows, radii, motion (`--t-fast/base/slow`), and font stacks —
     all in the `:root` block of `apps/app/src/styles.css`.
  - **Drift risk**: `styles.css` does NOT `@import` the brand tokens file — it
    re-declares the `--dohc-*` values inline (only a comment references
    `packages/brand/src/tokens.css`). Two copies of the brand palette exist today.
- **Fonts**: IBM Plex Mono via `@fontsource/ibm-plex-mono` (only webfont); serif/sans
  are system stacks (Iowan Old Style / Aptos) — desktop-friendly, no font CDN.
- **Can the desktop renderer share the stylesheet?** Yes, mechanically: add
  `tailwindcss`, `@tailwindcss/vite`, and `@fontsource/ibm-plex-mono` to
  `apps/desktop` (electron-vite ^5 / vite ^8 supports the Tailwind v4 plugin) and
  import the same CSS. But `styles.css` is 2.7k lines of app-wide rules including
  web-page chrome. Recommended split: extract the token layer (`:root`, dark
  override, `@theme inline`, `@custom-variant dark`) into a shared file (or finally
  make `@dohc/brand/tokens.css` the real import), then give the desktop its own thin
  `desktop.css` on top — which is exactly what the plan's Phase 3 file list
  (`apps/desktop/src/renderer/desktop.css`) expects. Theme switching reuses
  `lib/use-theme.ts` (pure: localStorage + `data-theme` attribute, no router/Convex);
  the first-paint inline script currently in `routes/__root.tsx` must be replicated in
  `apps/desktop/src/renderer/index.html`.
- Desktop renderer today (`apps/desktop/src/renderer/main.ts`) is a placeholder with
  inline styles and **no React dependency yet** — Phase 3 adds react/react-dom to
  `apps/desktop/package.json`.

## Component classification — `apps/app/src/components/`

Legend: AS-IS = reuse-as-is · SWAP = port-with-data-layer-swap · REBUILD · SKIP =
skip-not-needed-for-desktop. "Coupling evidence" lists the disqualifying imports
(or "clean" + actual imports). Test files (`*.test.ts`) excluded.

| Component | Classification | Coupling evidence | Desktop relevance |
|---|---|---|---|
| `ActivityBar.tsx` (77 L) | AS-IS | clean: `lucide-react`, `type AppView` from `../lib/appViews` (pure). Fully props-driven (`view`, callbacks) | layout shell (left rail switching files/agent/views/graph) |
| `AgentActivityTimeline.tsx` (233 L) | AS-IS | clean: react, lucide, `../lib/chatActivity` (zero imports, pure). Memoized, props-driven | agent panel — the exact "timeline, not one giant paragraph" surface Phase 3 E2E asserts |
| `AgentChatSidebar.tsx` (863 L) | SWAP | own imports clean (react, lucide, `SidebarChrome`, `Skeleton`, `lib/dialog-focus`, `type AgentAccessMode`) **but** imports and renders `WorkspaceSwitcher` (line 19 / line 410), which is Convex+router coupled. Swap = inject the switcher as a prop/slot | agent panel chrome + thread list |
| `AgentModelPicker.tsx` | AS-IS | clean: react, `react-dom` `createPortal`, lucide. Pure controlled component | agent panel (model selection) |
| `AgentRunRail.tsx` (228 L) | AS-IS | clean: react, lucide, `formatWorkedDuration` from `../lib/chatActivity` (pure) | agent panel (run status rail) |
| `AppFrame.tsx` | SWAP | pure re-export of `ViewFrame` — inherits ViewFrame's Convex coupling | app runtime (Phase 7), none for Phase 3 |
| `AsciiSketchModal.tsx` | AS-IS | clean: react + `AsciiSketcher` | editor (sketch modal) — defer |
| `AsciiSketcher.tsx` (3,605 L) | AS-IS | clean: react, `../lib/asciiSketchMetadata` (pure) | editor (ascii sketches) — defer |
| `AtomEditor.tsx` (3,043 L) | SWAP (heavy) | `useAction, useQuery` from `convex/react` (lines 10, 2769, 2847–2915: `api.auth.getCollabToken`, inline-atom / formula / query-block resolution), `../../convex/_generated/api` + `Id`; also `editor-v2/hocuspocusProvider` (cloud collab WebSocket). Core is TipTap + Yjs + `y-indexeddb` (`IndexeddbPersistence`) — already local-capable. Swap = lift the 4 resolution queries + collab token to props/bridge callbacks; hocuspocus becomes optional (cloud-sync phases) | editor — Phase 3 editor area centerpiece |
| `AtomView.tsx` (1,174 L) | SWAP | `useMutation, useQuery` from `convex/react`, `useAuth` from `@workos/authkit-tanstack-react-start/client`, `../../convex/_generated/api`. Already takes a `DohcBackendClient` prop (types-only, clean) — half the lift exists | editor page wrapper (frontmatter, properties, share, view-source) |
| `AttachmentComposer.tsx` | SWAP | `useMutation` from `convex/react`, `_generated/api` + `Id`, `lib/storageUpload` (type-only `Id` import). Upload mutations → bridge | agent panel (chat attachments), upload/import |
| `Chat.tsx` (3,101 L) | REBUILD (data layer) | `useAction, useMutation, useQuery` from `convex/react`, **`useUIMessages` from `@convex-dev/agent/react`** (streaming message protocol is Convex-agent-native), `_generated/api` + `Id`, `lib/chat-optimistic` (Convex `OptimisticUpdate` types). Transport cannot be "lifted to props" — desktop agent streaming arrives over the IPC bridge (Phase 11). Presentational children (AgentActivityTimeline, AgentRunRail, AgentModelPicker, Markdown) survive; exported pure helpers (`formatChatTimestamp`, `ContextWindowMeter`, `AgentAccessPicker`) are salvageable | agent panel (message list + composer) |
| `CommandPalette.tsx` (465 L) | SWAP (easy) | `useQuery` from `convex/react` ×3 (`api.skills.list`, `api.skills.listCommands`, `api.apps.list`, lines 217–219); **value import `OPEN_SKETCH_EVENT` from `./AtomEditor`** (line 13 — drags the whole 3k-line editor + Convex into the bundle); `useActiveWorkspaceId` from `lib/active-workspace` (clean — localStorage context, no router). All actions already arrive as props (`onOpenAtom`, `onFireSkill`, `onFireCommand`, `onOpenView`, `onPromptAgent`). Swap = pass `skills`/`commands`/`views` as props from the bridge + move the event constant to a tiny shared module | command palette — this IS the ⌘K palette (mounted in `routes/_app.tsx:2398`, hotkey at `:1507`) |
| `DatabaseStudio.tsx` (64 L) | AS-IS | clean: imports only `DatabaseTableGrid`. 100% props-driven (`database: { path, version, tables, ops }`), styled with token utilities (`bg-paper`, `text-ink-dim`, `border-rule`) | database studio (Phase 6/8) |
| `DatabaseTableGrid.tsx` (36 L) | AS-IS | clean at runtime: `import type { DatabaseColumn } from '../../convex/databaseSchema'` — **type-only** import of a hand-written (non-`_generated`) pure-TS file, erased at build. Note: move the type to `packages/workspace-contracts` when Convex dies (Phase 13) | database studio (Phase 6/8) |
| `EmojiPicker.tsx` (82 L) | AS-IS | clean: react + lazy `import('@emoji-mart/react'/'@emoji-mart/data')` | file tree / editor (icon picking) |
| `FileTree.tsx` (2,324 L) | SWAP (small) | own data access is **fully props-driven** (`files`, `folders`, `onOpen`, `onCreatePage`, `onMoveFile`, … ~25 props; `backendClient` prop is a type-only `DohcBackendClient` import — clean). Sole disqualifier: static value import of `UploadFileButton` (lines 41–44), whose unconditional `useMutation` calls require a ConvexProvider. Swap = make the upload affordance injectable or port UploadFileButton first. All tree logic libs (`path-tree`, `file-tree-nav`, `file-tree-dnd`, `file-tree-optimistic`, `folderTokens`, `dialog-focus`) are pure | file tree — Phase 3 sidebar centerpiece |
| `FileTypeView.tsx` (322 L) | AS-IS | clean: react, lucide. Props-driven (`{ path, mediaType, extension, body?, assetUrl? }`); fetches text assets via plain `fetch(assetUrl)` — desktop bridge supplies a custom-protocol/data URL | file views — Phase 6 FileInspector seed (md/csv/json/image/audio/pdf dispatch) |
| `FolderPicker.tsx` (320 L) | AS-IS | clean: react, lucide, `FOLDER_COLORS` from `lib/folderTokens` (pure) | file tree (folder color/icon) |
| `GraphView.tsx` (802 L) | SWAP | `useQuery` from `convex/react` (`api.graph…`), `_generated/api`, types from `../../convex/graph`, `d3-force-3d`. Liftable to a `nodes/edges` prop | none for Phase 3/6 (graph view — defer; no desktop phase requires it) |
| `HtmlAtomFrame.tsx` | SWAP | `useQuery` from `convex/react` + `_generated/api` (formula resolution), `useActiveWorkspaceId` (clean). Iframe sandbox rendering itself is portable | file views (HTML atoms, Phase 6/7) |
| `Markdown.tsx` (268 L) | SWAP (easy) | single `useQuery(api.assets.resolveAsset)` (line 195) to resolve `asset:` hrefs; `convex/react`, `_generated/api` + `Id`. Swap = asset-URL resolver prop/bridge call. Rest is react-markdown + remark-gfm | agent panel (chat rendering), file views |
| `NotFoundPage.tsx` | SKIP | clean (lucide, `@dohc/brand`) but it is the web router 404 page | none |
| `NoticeCenter.tsx` (160 L) | AS-IS | clean: react, lucide. Self-contained context/provider + `useNotice` | layout shell (toasts/notices, sync errors) |
| `Onboarding.tsx` | SKIP | `useAction, useMutation` from `convex/react`, `_generated/api` + `Id`. Web onboarding — Phase 3 explicitly replaces it with `DesktopFirstRun.tsx` and bans "web onboarding page" UX; Phase 3 Step 5 delete-or-justify candidate | none (replaced by DesktopFirstRun) |
| `PropertiesPanel.tsx` (132 L) | AS-IS | clean: react, lucide, `lib/frontmatter` (pure) | editor (frontmatter properties) |
| `SearchOverlay.tsx` (215 L) | SWAP | `useQuery(api.search.run)`, `useMutation(api.search.ensureIndexed)` from `convex/react`; `normalizeQuery` from `../../convex/searchText` (hand-written pure TS — portable). Swap = local search via bridge (Phase 5 indexes / ripgrep-style) | command palette / quick-open (⌘⇧F full-content search; pairs with ⌘K palette for the Phase 3 "quick open" E2E) |
| `ShareDialog.tsx` | SWAP (defer) | `useMutation, useQuery` from `convex/react`, `_generated/api` + `Id`. Copy helpers live in pure `shareDialogCopy.ts` | none until cloud sharing (Phase 9/10) |
| `SharedAtomView.tsx` | SKIP | `convex/react`, `@workos/authkit-tanstack-react-start/client`, `_generated`. Public share-link viewer — stays a web surface | none |
| `SharingPanel.tsx` | SWAP (defer) | `useMutation, useQuery` from `convex/react`, `_generated/api` + `Id` | none until cloud sharing (Phase 9/10) |
| `SidebarChrome.tsx` (102 L) | AS-IS | clean: react, lucide, `DohcMark` from `@dohc/brand`, `useTheme` from `lib/use-theme` (pure localStorage/DOM) | file tree + layout shell (sidebar header/footer, theme toggle) |
| `Skeleton.tsx` (320 L) | AS-IS | clean: pure CSS-token skeletons (`--dohc-skeleton-*`) | all surfaces (loading states) |
| `UploadFileButton.tsx` (146 L) | SWAP (small) | `useMutation(api.assets.generateUploadUrl / registerWorkspaceFile)` from `convex/react`, `_generated` `Id`, `lib/storageUpload`. Already has a non-Convex path: when the optional `backendClient` prop is set it calls `backendClient.uploadFile()` instead — but the hooks are still called unconditionally, so it crashes without a ConvexProvider. Swap = make the Convex mutations injectable/optional | upload/import action (Phase 3 shell requirement; Phase 6 Step 3) |
| `ViewFrame.tsx` (386 L) | SWAP (defer) | `useQuery` from `convex/react`, `_generated/api`, app-bundle build pipeline (`../apps/buildAppBundle.functions`, `AppRuntimeHost`, `appShell`) | app runtime area (Phase 7) |
| `ViewsSidebar.tsx` | SWAP (defer) | `useQuery(api.apps.list)` from `convex/react`, `_generated/api`; renders `WorkspaceSwitcher` (coupled) | apps/views sidebar (Phase 7) |
| `WikilinkPicker.tsx` (236 L) | AS-IS | clean: react, lucide, `@tiptap/pm/state`, types from `wikilinkPlugin` / `floatingMenuPosition` (pure) | editor (wikilink autocomplete) |
| `WorkspaceManagementDialog.tsx` | REBUILD | `useAction, useMutation, useQuery` from `convex/react`, **`useNavigate` from `@tanstack/react-router`**, `_generated/api` + `Id`. Cloud-workspace CRUD semantics don't map to the local registry | workspace switcher (management) — desktop variant comes from Phase 4 registry |
| `WorkspaceSwitcher.tsx` (314 L) | REBUILD | `useQuery` from `convex/react`, **`useNavigate` from `@tanstack/react-router`**, `_generated/api`, imports `WorkspaceManagementDialog`. Desktop workspaces have a different shape (`WorkspaceRegistryResult`: `workspaceId/rootPath/kind/mode` via `window.dohcDesktop.getWorkspaceRegistry()`) and switching must not navigate a router. Keep the visual pattern (portal dropdown), rebuild the data + navigation | workspace switcher (Phase 3 shell requirement) |
| `floatingMenuPosition.ts` | AS-IS | zero imports — pure geometry | editor + palette positioning |
| `inlineAtomPlugin.ts` | AS-IS | clean: `@tiptap/pm/*`, `lib/inlineAtom` (pure) | editor (inline atoms) |
| `wikilinkPlugin.ts` | AS-IS | clean: `@tiptap/pm/*`, types from `inlineAtomPlugin` | editor (wikilinks) |
| `shareDialogCopy.ts` | AS-IS | zero imports — pure copy/formatting | sharing (deferred) |

Counts (38 production .tsx + 4 .ts helpers): **20 reuse-as-is** (16 components + 4
helpers), **16 port-with-swap** (incl. AppFrame alias), **3 rebuild**, **3 skip**.

## Shell-relevant code outside components/

| Module | Classification | Coupling evidence | Desktop relevance |
|---|---|---|---|
| `routes/_app.tsx` (2,788 L) | REBUILD as `DesktopWorkspaceShell.tsx` | `@tanstack/react-router`, `convex/react`, `@workos/authkit…`, `_generated/api`. But it is the blueprint: panel layout (FileTree + ActivityBar + AtomView/FileTypeView + AgentChatSidebar + AgentRunRail), keyboard map (⌘K palette `:1507`, ⌘⇧F search, ⌘\ chat, ⌘⇧S sharing), palette/search mounting (`:2398`), `openAtom` dispatch. Copy the structure and shortcut map, feed everything from the bridge | layout shell — primary Phase 3 reference |
| `routes/__root.tsx` | REBUILD as `DesktopRoot.tsx` | `@tanstack/react-router`, `ConvexProviderWithAuth`, WorkOS. Carries the first-paint theme inline script — replicate in `renderer/index.html` | layout shell root |
| `routes/_app.$workspaceSlug*.tsx`, `_app.shared.$shareId.tsx`, `signed-out.tsx`, `routes/api`, `routes/r` | SKIP | router file-routes / server routes | none |
| `lib/active-workspace.tsx` | AS-IS | clean — React context over localStorage, explicitly no URL derivation | workspace switcher state |
| `lib/appViews.ts`, `chatActivity.ts`, `agentAccess.ts`, `dialog-focus.ts`, `path-tree.ts`, `file-tree-nav.ts`, `file-tree-dnd.ts`, `file-tree-optimistic.ts`, `folderTokens.ts`, `frontmatter.ts`, `mediaTypes.ts`, `palette-fire.ts`, `use-theme.ts`, `asciiSketchMetadata.ts`, `dslparse.ts`, `inlineAtom.ts`, `sourceHighlight.ts`, `pastedAttachments.ts`, `viewPaths.ts`, `atomId.ts` | AS-IS | grep-verified: no convex/router imports anywhere in `lib/` except the three below | file tree, palette, agent panel, editor, theme |
| `lib/convex-client.ts`, `lib/chat-optimistic.ts`, `lib/use-auth-bridge.ts` | SKIP | Convex client / Convex optimistic-update types / WorkOS↔Convex auth bridge | none |
| `lib/storageUpload.ts` | AS-IS (note) | only `import type { Id } from '../../convex/_generated/dataModel'` — type-only, erased at build; retype when porting upload | upload/import |
| `backend/backendClient.ts` | AS-IS | pure types (`DohcBackendClient`, `WorkspaceFile`) — zero imports. The desktop bridge can implement this same interface | data layer seam for FileTree/AtomView/UploadFileButton |
| `src/apps/AppRuntimeHost.tsx`, `src/views/ViewRuntimeHost.tsx`, `appShell.ts`, `buildAppBundle.*` | SWAP (defer) | bundle building hits Convex actions; iframe shell itself is portable | app runtime (Phase 7) |
| `editor-v2/import-export.ts`, `dohc-markdown-extensions.ts`, `indexeddbState.ts` | AS-IS | clean: tiptap/yjs/js-yaml only | editor (md⇄ydoc, persisted state) |
| `editor-v2/hocuspocusProvider.ts` | SWAP (defer) | `@hocuspocus/provider` WebSocket collab — cloud-sync concern (Phase 9/10), not Phase 3 | editor collab |

## Traps

1. **FileTree looks coupled but isn't (and vice versa).** Its 2,324 lines are fully
   props-driven — the only Convex in its module graph is the static
   `UploadFileButton` import. Port UploadFileButton (or inject the upload slot) and
   FileTree drops straight into the desktop shell. Conversely **AgentChatSidebar**
   looks clean by its own imports but renders `WorkspaceSwitcher`, which pulls
   `convex/react` + `@tanstack/react-router` + `WorkspaceManagementDialog`
   transitively.
2. **CommandPalette → AtomEditor.** A one-constant value import
   (`OPEN_SKETCH_EVENT`) drags the entire 3k-line editor — TipTap, Yjs, hocuspocus,
   and `convex/react` — into any bundle containing the palette. Move the constant to
   a shared module before porting.
3. **UploadFileButton's `backendClient` path is a decoy.** The non-Convex branch
   exists, but `useMutation` is called unconditionally at the top of the component,
   so it throws outside a `ConvexProvider`. It must still be ported, not reused.
4. **Token duplication.** `styles.css` re-declares the `--dohc-*` brand palette
   instead of importing `@dohc/brand/tokens.css`. If desktop copies the token block a
   third copy appears; fix the import chain while extracting the shared token layer.
5. **Type-only Convex imports are safe but tracked.** `DatabaseTableGrid`
   (`convex/databaseSchema`) and `lib/storageUpload` (`_generated/dataModel`) import
   types only — fine at runtime, but they must be re-homed (e.g.
   `packages/workspace-contracts`) before Phase 13 deletes Convex.
6. **Chat's streaming is not liftable.** `useUIMessages` from
   `@convex-dev/agent/react` is a Convex-specific live-query protocol; "lift to
   props" would mean re-implementing streaming anyway. Rebuild the message transport
   on the bridge (Phase 11) and reuse the presentational pieces.

## Recommendations

**Phase 3 first shell — pull in now:**
- AS-IS: `ActivityBar`, `SidebarChrome`, `Skeleton`, `NoticeCenter`, `FolderPicker`,
  `EmojiPicker`, `AgentActivityTimeline`, `AgentRunRail`, `AgentModelPicker`, plus
  pure libs (`path-tree`, `file-tree-nav/dnd/optimistic`, `folderTokens`,
  `dialog-focus`, `use-theme`, `active-workspace`, `chatActivity`, `appViews`) and
  the `DohcBackendClient` type as the bridge-adapter seam.
- SWAP (small, do in Phase 3): `UploadFileButton` (make Convex mutations
  injectable — unblocks `FileTree`), `FileTree` (then drops in as-is),
  `CommandPalette` (props for skills/commands/views; extract `OPEN_SKETCH_EVENT`),
  `Markdown` (asset-resolver prop).
- SWAP (medium, start in Phase 3, finish as editor lands): `AtomEditor` (lift 4
  resolution queries + collab token; keep `y-indexeddb`, gate hocuspocus),
  `AtomView` (or a slimmer desktop editor pane), `AgentChatSidebar` (switcher slot).
- REBUILD in Phase 3: `WorkspaceSwitcher` against `getWorkspaceRegistry()`;
  `DesktopWorkspaceShell` + `DesktopRoot` modeled on `routes/_app.tsx` layout and
  its keyboard map; `DesktopFirstRun` (do not port `Onboarding`).
- Styling: extract the token layer of `styles.css` (`:root` + dark override +
  `@theme inline` + `@custom-variant`) into a shared stylesheet imported by both
  apps; add Tailwind v4 + `@tailwindcss/vite` + IBM Plex Mono to `apps/desktop`.

**Defer to Phase 6+:** `FileTypeView` (AS-IS, becomes FileInspector dispatch),
`DatabaseStudio` + `DatabaseTableGrid` (AS-IS), `HtmlAtomFrame` (SWAP),
`SearchOverlay` (SWAP, needs local search bridge — Phase 5/6), `AsciiSketcher`/
`AsciiSketchModal`, `WikilinkPicker` (with editor maturity), `ViewFrame`/
`ViewsSidebar`/app runtime (Phase 7), `GraphView` (no phase requires it), `Chat`
transport rebuild (Phase 11), `ShareDialog`/`SharingPanel` (Phase 9/10).

**Never port:** `Onboarding`, `SharedAtomView`, `NotFoundPage`, `lib/convex-client`,
`lib/use-auth-bridge`, `lib/chat-optimistic`.
