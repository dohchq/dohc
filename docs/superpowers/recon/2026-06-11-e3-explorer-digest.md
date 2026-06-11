# E3 Explorer Parity — Recon Digest (build contract)

Recon date 2026-06-11. Old-web sources cited as `7277c39^:<path>` (recover via
`git show`). Plan section: `docs/superpowers/plans/2026-06-11-dohc-desktop-experience-parity.md:175-205`.

## 1. Old tree libs anatomy (what ports, what strips)

| Lib | Exports | Backend needs | Convex coupling | Tests recoverable? |
|---|---|---|---|---|
| `7277c39^:apps/app/src/lib/file-tree-nav.ts` (114 ln) | `navigateTree(rows, currentPath, key) -> NavAction`, `FlatRow`, `NavAction` | none — pure WAI-ARIA tree keyboard model over the flattened visible-row list | zero | **as-is** (`file-tree-nav.test.ts`, 150 ln, pure vitest) |
| `7277c39^:apps/app/src/lib/file-tree-dnd.ts` (94 ln) | `planDrop(source, target) -> DropAction`, `DragSource`, `DropTarget` | a move IPC taking `{fromPath, toPath}` | zero | **as-is** (`file-tree-dnd.test.ts`, 110 ln) |
| `7277c39^:apps/app/src/lib/file-tree-optimistic.ts` (~150 ln) | `applyPendingTreeMoves`, `projectTreePath`, `pendingTreeMoveSettled`, `parentDir`, `pathInsideFolder`, `PendingTreeChange` | none — pure pending-op overlay projected onto `(files, folders)` until the authoritative refresh confirms | imports `FileRow`/`FolderInput` from path-tree (Convex-era `_id`/`source`/`fileId` fields; pending rows fabricate `_id: pending:<id>`) | **near as-is** (`file-tree-optimistic.test.ts`, 179 ln) — retype `FileRow` to the desktop `WorkspaceFileEntry`-shaped row |
| `path-tree.ts` — **already live** at `apps/web/src/lib/path-tree.ts` (217 ln, + `path-tree.test.ts` 169 ln) | `buildTree(files, folders) -> TreeNode`, `nodeLabel`, `ancestors`, `FolderInput` (string OR `{path, icon?, color?, starred?}`) | flat path list; explicit `folders` input keeps EMPTY folders visible | code is Convex-free; types carry legacy optional fields (`_id`, `source`, `systemLocked`…) — slim on port | **as-is**, copy/slim into desktop (or hoist to a package) |

DnD semantics (VSCode/Finder, header of file-tree-dnd.ts): file→folder = into;
file→file = next to (target's parent); folder→folder = into; root container =
workspace root. No-ops: same parent, folder onto itself/descendant, self-drop.
The IPC must re-enforce the folder-into-itself refusal — `planDrop` is UI-only.

Old `FileTree.tsx` (2324 ln, `7277c39^:apps/app/src/components/FileTree.tsx`) is
props-driven (no Convex hooks inside): all mutations arrive as `onRenameFile`,
`onMoveFolder`, etc. (props at :71-137). Patterns worth lifting: inline
create/rename editbox with optimistic pending change + rollback-on-error
(`commitRename` ~:935-965, `beginPending` auto-expands the target dir ~:915),
`normalizeTreeInputPath` typed-path semantics ("alpha" in folder `team` →
`team/alpha`; a typed path with `/` wins). Strip: WorkspaceSwitcher, shared-with-me,
upload button, presence context, lock/star/folder-meta, EmojiPicker.
`FolderPicker.tsx` (320 ln) is the icon/color popover — defer (cosmetics, not E3 core).
Old tree had NO multi-select; the plan's multi-select is net-new design.

## 2. New IPC design (security-critical)

Existing idioms to mirror exactly:
- Handler shape: `assertTrustedSender(event)` then `Payload.parse` then
  `requireWorkspace` then op then `Result.parse` (`apps/desktop/src/main.ts:418-424` createWorkspaceFile).
- Lexical validation: `validateUserWritePath` (`packages/workspace-core/src/paths.ts:60-99`)
  refuses traversal (incl. percent-decode-to-fixpoint), absolutes, `.dohc` at any
  depth, case-insensitively, with Windows trailing-dot/space alias stripping.
- Realpath containment for EXISTING targets: `resolveWorkspaceFile`
  (`apps/desktop/src/workspaces/workspaceAssets.ts:42-56`).
- Realpath containment for NOT-YET-EXISTING targets: `existingAncestor` +
  `isInside` pre-mkdir, re-check post-mkdir (`apps/desktop/src/workspaces/workspaceFiles.ts:11-22,74-88`).

New ops (put in `workspaceFiles.ts` beside createFile; channels in
`src/ipc/channels.ts:71-112` CHANNELS map; schemas in `bridgeContract.ts` using the
existing `WORKSPACE_ID` / `PATH_STRING` bounded primitives at :22-27):

```
CreateWorkspaceFolderPayload { workspaceId: WORKSPACE_ID, relativePath: PATH_STRING } -> { path }
MoveWorkspacePathPayload    { workspaceId, fromPath: PATH_STRING, toPath: PATH_STRING } -> { path }   // rename === move; one engine, F2 and DnD both call it
DeleteWorkspacePathPayload  { workspaceId, relativePath: PATH_STRING } -> { trashed: z.boolean() }
ExportWorkspaceZipPayload   { workspaceId, relativePath: PATH_STRING.optional() } -> { path: PATH_STRING | null } // null = save dialog cancelled
```

`movePath` rules (BOTH sides validated):
1. `validateUserWritePath(fromPath)` AND `(toPath)` — `.dohc` refused on either
   side by `isReservedPath` (paths.ts:35-41); never special-case it again.
2. Source: realpath-contain via the `resolveWorkspaceFile` idiom, but use
   `lstat`-based resolution of the PARENT + refuse symlink sources (the tree
   never lists symlinks — `listFiles` skips them, workspaceFiles.ts:52).
3. Destination: `existingAncestor(dirname(dest))` must be inside `realpath(root)`
   BEFORE `mkdir -p`, re-check after (workspaceFiles.ts:74-88 verbatim).
4. Refuse overwrite: `lstat(dest)` exists ⇒ throw — EXCEPT when
   `realpath(dest) === realpath(source)` (case-only rename on a
   case-insensitive fs must be allowed; on Linux this branch never triggers).
   No merge semantics this phase: dir-onto-dir with same name = refuse.
5. Refuse folder into itself/descendant: `toPath === fromPath ||
   toPath.startsWith(fromPath + "/")` after normalization (mirrors planDrop).
6. Then one `fs.rename` (atomic same-device). Note POSIX `rename` silently
   clobbers — step 4's check is the only guard; TOCTOU window is acceptable
   (single-user main process), document it.

`deletePath` via `shell.trashItem(realTarget)`:
- Resolve through `resolveWorkspaceFile` first; additionally refuse
  `realTarget === realRoot`.
- **Dirs:** supported on all three platforms (Windows IFileOperation, macOS
  `trashItemAtURL`, Linux glib `g_file_trash` per XDG trash spec).
- **Linux/WSL:** `g_file_trash` needs no desktop environment — it creates
  `~/.local/share/Trash` itself — but it REJECTS for cross-filesystem paths
  without a `.Trash` topdir (common on mounts; `/mnt/c` under WSL). It throws,
  it doesn't hard-delete. **Fallback:** on rejection, move to
  `.dohc/trash/<epoch>-<leaf>` (watcher-invisible — `hasIgnoredSegment`,
  paths.ts:46-54 — so it vanishes from tree/history/sync exactly like OS
  trash; recoverable; never `rm -rf`). Verify in the E2E by asserting the file
  left the tree AND a delete change set recorded.

`createFolder`: `mkdir recursive` with the createFile containment sandwich.
Wire the existing `new-folder` menu command (currently aliased to the new-file
dialog, `DesktopWorkspaceShell.tsx:454-456`) to the real thing.

**Empty-folder visibility gap:** `listFiles` returns files only
(workspaceFiles.ts:41-64) — a fresh empty folder would be invisible after
refresh. Extend `ListWorkspaceFilesResult` additively with
`folders: z.array(PATH_STRING)` (walk already visits dirs) and feed it to
`buildTree`'s `FolderInput` — this is exactly why that parameter exists.

Per-op negative tests (unit, in `workspaceFiles.test.ts` style):
traversal (`../x`, `a/../../x`, `%2e%2e%2fx`, `..%252fx`); absolute (`/etc/passwd`,
`C:\x`, `\\srv\x`); reserved (`.dohc/ui-state.json`, `notes/.dohc/x`, `.DOHC.`,
`.dohc ` — both sides of move); symlinked-ancestor escape (link inside workspace
→ /tmp, then move/create under it); symlink-as-source refused; dest-exists
refused; case-only rename allowed / distinct-file case collision refused on a
case-insensitive fs (gate with a runtime probe, not `process.platform`); folder
into own descendant; delete root refused; trashItem-rejection fallback path.

Context-menu IPC (closed tuple, MENU_COMMANDS pattern — channels.ts:5-29):
`EXPLORER_MENU_COMMANDS = ["new-file","new-folder","rename","delete","pin",
"unpin","export-zip","open-externally","import-files"] as const` in channels.ts
(dependency-free, preload-validatable). One invoke:
`showExplorerMenu({workspaceId, path, kind: "file"|"folder"|"root", pinned: boolean})
-> Promise<ExplorerMenuCommand | null>` — main builds `Menu.buildFromTemplate`
from main-owned labels and resolves the invoke from the click callback (null on
dismiss). The renderer then drives the SAME local handlers the palette/F2 use.
Renderer never supplies labels or item structure.

OS drag-in: under `sandbox: true, contextIsolation: true`
(`electronSecurity.ts:5-7,18-20`) `File.path` does not exist (removed in
Electron 32; repo is on ^42, package.json:29). The sanctioned route is
**`webUtils.getPathForFile(file)` in the preload** (available to sandboxed
preloads since v29): expose `getPathForFile(file: File): string` on the bridge
(File passes through contextBridge), renderer handles `drop`/`dragover` with
preventDefault (window-level navigation on file-drop is already denied by the
nav policy), maps Files → absolute paths, then calls a new
`importDroppedFiles({workspaceId, paths: z.array(PATH_STRING).max(100)})` that
reuses `copyIntoWorkspace` (workspaceFiles.ts:97-114 — basename-only,
COPYFILE_EXCL, never overwrites). NOTE the trust delta: unlike
`importWorkspaceFiles` (paths from a main-process dialog, main.ts:426-438),
these absolute paths are renderer-supplied. A compromised renderer could copy
`~/.ssh/id_rsa` into a cloud-synced workspace. Bound it: cap count, refuse
sources inside any registered workspace's `.dohc`, files only this phase
(directories = follow-up with a bounded walk).

Export zip: no zip dep exists anywhere (pnpm-lock grep: no archiver/jszip/
adm-zip/yazl). Node has no zip container API. Recommendation: **store-only zip
writer (~100-120 lines) in main**, matching this repo's zero-dep habit —
local-folder zips don't need deflate, and bounding is trivial (cap file count
+ total bytes, e.g. 2k files / 256MB; skip `.dohc` via the same walk rules as
`listFiles`). Destination from `dialog.showSaveDialog` in MAIN (renderer never
names an output path). If compression becomes a requirement, `yazl` is the
smallest credible dep — decide once at review.

## 3. Sync + history semantics per op

How a rename flows today (three independent layers — none corrupt, one warts):
- **Watcher/history:** no rename detection. `pathsToEvents` infers from
  existence: old path absent ⇒ `delete`, new path present ⇒ `update`
  (`workspaceWatcher.ts:45-70`); both land in ONE settle batch ⇒ ONE change set
  with delete+write file ops (`batchedSync.ts:21-31` — a `rename` event kind
  exists in the vocabulary but the watcher never emits it). History reads
  "You edited 2 files" (`changeSetStore.ts:202-217`). Acceptable this phase;
  a rename-aware summary is cosmetic follow-up.
- **Scan-diff:** pairs same-sha delete+create into a real `rename` op
  (`packages/workspace-fs/src/diff.ts:53-68`). A rename of a DIRTY file (sha
  differs from baseline) won't pair ⇒ pushes as delete+create. Fine.
- **Cloud push:** same-folder renames push as `rename` ops; cross-folder
  renames are DECOMPOSED to delete+create because the server rejects
  cross-folder renames (`cloudSync.ts:197-215`; pinned by
  `mergeSync.test.ts:225-243`). Folder rename = N per-file renames/decompositions.

So the E3 `movePath` (one `fs.rename`) is already sync-safe on the push path.
**The risk is pull-before-push:** `firstContact` pulls THEN pushes
(`cloudSyncEngine.ts:95-100`). Rename a synced file while offline, relaunch →
pull sees a baseline entry whose local file is gone and applies the
no-resurrect rule: remote content lands as `<oldPath>.conflict`
(`cloudSync.ts:337-343`), THEN push sends the rename. Net: rename works but a
spurious `<old>.md.conflict` appears in the tree. Steady-state online renames
are clean (watcher batch → `queueSync` debounced push, cloudSyncEngine.ts:135-145,
nothing pulls in between). Tests that must pin behavior:
1. workspace-sync unit: same-folder rename pushes ONE `rename` op (sibling of
   mergeSync.test.ts:225); cross-folder already pinned.
2. workspace-sync unit: offline-rename-then-pull produces `<old>.conflict` +
   the rename still pushes — pin the wart EXPLICITLY as accepted this phase
   (or fix by sha-pairing inside pull; out of E3 scope, record the decision).
3. E2E (cloudSync.spec.ts pattern): rename a synced file, push, assert server
   file list shows only the new path; trash a synced file, assert delete
   propagates and pull does NOT resurrect.
4. Trash and `.dohc/trash` fallback both read as plain deletes to
   watcher/scan (path leaves the user tree) — one E2E assertion each.

## 4. Explorer UI plan

Current seams (`apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`):
explorer view is the flat `files.map(FileRow)` block at :461-513 (testid
`file-tree` on the `<nav>` :464); `openFile` marks `file-open-start` then
`openTab` (:278-281); refresh on `onWorkspaceActivity` (:333-349); ui-state
load-merge/debounce/flush (:194-251). Replace the block with
`workbench/Explorer.tsx`; KEEP the `file-tree` testid on the scroll container.

- **Nested tree:** `buildTree` from `apps/web/src/lib/path-tree.ts` (copy +
  slim types) over `listWorkspaceFiles` files + the new `folders` array.
  Folder-first sort, depth indent, flatten-visible-rows → `navigateTree`.
- **Expansion + pins → ui-state:** extend `WorkspaceUiState`
  (`bridgeContract.ts:444-453`) additively: `expandedFolders:
  z.array(PATH_STRING).max(500).optional()`, `pinned:
  z.array(PATH_STRING).max(100).optional()`. Keep `version: z.literal(1)` —
  zod's non-strict parse drops unknown keys for old readers; optional fields
  parse old files. Persistence rides the existing debounce/flush (:223-251)
  via `serializeUiState` in `workbenchState.ts`.
- **Inline create/rename:** port the editbox + optimistic-pending +
  rollback-on-error pattern (old FileTree ~:870-965) on top of
  `file-tree-optimistic`; on rename/move success, remap open tabs, activeTab,
  and pins with `projectTreePath` before the watcher refresh lands.
- **Multi-select:** ctrl/shift-click set keyed by fullPath; drag of a
  selection = N sequential `movePath` calls (main stays single-op; no batch
  IPC this phase); Del = confirm dialog then N deletes.
- **Context menu:** §2 design. **OS drag-in:** §2 webUtils route.
- **Virtualization: not needed.** The 1000-file budget (1500ms,
  `budgets.ts:11`) passes today rendering all 1000 flat rows; a
  collapsed-by-default nested tree renders ~20 root rows for the same fixture
  — strictly less DOM. The 10k search budgets (`budgets.ts:12-13`) are
  measured in quick-open (`CommandPalette.tsx:43-44,81` records
  `file-tree-search-query/visible`), independent of tree rendering. Keep
  `file-tree-loaded` markOnce keyed on files state (:323-325).

## 5. Existing specs/testids the rebuild touches

The `file-tree` testid is pinned by 13 spec files. The breaking class is
**full-path exact-text row assertions** — a nested tree shows leaf labels, so
`getByText("notes/today.md", { exact: true })` finds nothing:
- `e2e/performance.spec.ts:232` ("notes-00/note-0.md" — the
  openThousandFileWorkspaceMs gate itself) and :266 (root file, safe).
- `e2e/markdownEditing.spec.ts:27`; `e2e/liveCoEditing.spec.ts:122,134,189`;
  `e2e/cloudSync.spec.ts:153`; `e2e/workbench.spec.ts:161-162,357,392-393`
  (:225+ uses root-level names — safe);
  `e2e/productReadiness.spec.ts:309,370-374,434,482-484,635,694`;
  `e2e/fileTypes.spec.ts:60` (all nested paths); `e2e/appPackage.spec.ts:67`
  ("finance/.apps/ledger/app.json"); `e2e/sqliteImport.spec.ts:35-38`.
- Safe as-is: visibility/count-only checks (`firstRunWorkspace.spec.ts:75,90,215`,
  `windowChrome.spec.ts:122-124`, `workbench.spec.ts:91,103,120,141-143,433`,
  `visualLanguage.spec.ts:140,154` — non-exact leaf text).

Migration: one shared `openInTree(page, path)` helper in `e2e/launch.ts` that
splits the path, clicks/expands each folder segment, then clicks the leaf —
swap every full-path callsite in the SAME commit as the tree swap. Update
performance.spec.ts:232 to expand `notes-00` inside the measured window (the
budget then covers expand latency too — keep it; 1500ms has huge headroom).
Also pinned nearby: `quick-open` testid + its option roles
(performance.spec.ts:273-280), `view-empty-state`, `workspace-shell`, tab
testids — untouched if Explorer only replaces the :461-513 block.

## 6. Risks + build order

Risks, descending:
1. **Spec blast radius** (§5) — the tree swap and the e2e helper migration
   must land atomically or the suite reds across 10+ files.
2. **Four new fs-mutating IPC surfaces** — mirror the containment sandwich
   exactly; the adversarial review the plan mandates will probe move's TWO
   paths and the trash fallback. Negative tests first, handlers second.
3. **Offline-rename `.conflict` wart** (§3) — decide + pin now, or it becomes
   a user-facing mystery file after E3 ships renames.
4. **POSIX rename clobbers** — the dest-exists check is the only overwrite
   guard; case-insensitive carve-out must not reopen the hole (compare
   realpaths, not strings).
5. **Tab/pin remap on rename** — forgetting `projectTreePath` leaves dead
   tabs pointing at the old path (FileInspector read fails) and orphan pins.
6. **Renderer-supplied drop paths** (§2) — bound and document the trust delta.
7. **WSL/mount trashItem failures** — fallback must be in v1, not a patch.

Build order (each step green before the next):
1. Port pure libs + their tests (path-tree slim, nav, dnd, optimistic) into
   `src/renderer/workbench/explorer/`.
2. `workspaceFiles.ts` ops + negative unit tests; `folders` in list result;
   channels/bridgeContract/preload/main wiring (no UI yet — unit-gated).
3. Explorer.tsx read-only nested tree + expansion ui-state + keyboard nav +
   e2e `openInTree` migration + performance.spec adjustments. Run the full
   suite HERE — this is the risk-1 gate.
4. Inline create (file/folder) + F2 rename + Del/confirm delete + context-menu
   IPC; tab/pin remap.
5. Internal DnD moves + multi-select.
6. Pins section (ui-state).
7. OS drag-in (webUtils preload + importDroppedFiles).
8. Export-zip IPC + store-only writer.
9. `e2e/explorer.spec.ts` covering every op with a change-set assertion each;
   sync rename/delete pins (§3); adversarial codex review.
