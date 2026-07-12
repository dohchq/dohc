# Imports, exports, and sharing

One model: **everything that enters or leaves a workspace is files, and the
only cross-workspace mechanism is a relay share.** Importing puts files where
the user aimed. Exporting writes the files the user already has (markdown
first). Sharing grants a filtered, live, read-only view of files — and a
received share should itself be files inside the recipient's workspace, not a
separate surface.

Decisions behind this document (2026-07-12, Ice):

1. Unify on files-in / files-out plus relay shares. The
   workspace-to-workspace *field-exchange* "Imports / Exports panel" the
   product spec used to promise is **retired** (see the last section).
2. Share mounts — a received share materializing as a read-only live folder
   in the recipient's own workspace — are the destination for the receive
   side, implemented in full (engine + desktop + relay), not as a thin slice.
3. First slice shipped with this document: import destination targeting,
   rename-on-collision, an import summary, and "Export as Markdown…".

## Files in (import)

Entry points: File → "Import Files…", the command palette, the explorer
context menu (root **and** folders), and OS drag-in onto the file tree.

Behavior:

- **Files land where the user aimed.** A drop onto a folder imports into that
  folder; a folder's "Import Files…" imports into it; everything else
  defaults to the workspace root. The renderer names the destination
  (`targetDir`), and main re-validates it end to end
  (`resolveImportDestination` in `apps/desktop/src/workspaces/workspaceFiles.ts`:
  lexical validation, must already exist as a real non-symlink directory,
  realpath containment). Imports never mkdir.
- **Collisions rename, never overwrite and never silently drop.** An import
  of `notes.md` beside an existing `notes.md` lands as `notes (2).md`
  (`COPYFILE_EXCL` on every attempt, bounded variant budget).
- **Every import ends with a visible summary** — "Imported 3 files into
  notes (1 skipped)." — so a batch is never quietly smaller than what the
  user handed us. Skips are sources that could not land: drag-in screening
  (symlinks, directories, special files, another workspace's `.dohc`),
  invalid basenames, or an exhausted collision budget.
- **Bytes are copied verbatim.** No format conversion on import; a markdown
  file becomes an atom because it *is* one. (Structured imports into SQLite
  stay a separate, explicit tool: `dohc_import_data`.)

Security posture is unchanged from the E3 review: the dialog flow trusts
main-process-picked paths; the drag-in flow lstat-screens renderer-supplied
paths (final-component symlinks refused before they resolve, `.dohc` sources
refused on canonical paths). The known ancestor-symlink residual and the
deferred import-confirm quarantine are documented at `importDroppedPaths`.

## Files out (export)

- **Document → file:** "Export as Markdown…" writes the raw document source
  (frontmatter included) verbatim to a `.md` file — the text-first export and
  the honest one, because the `.md` *is* the artifact. "Export as HTML…" and
  "Export as PDF…" write the self-contained render. "Copy as Markdown" stays
  clipboard-only.
- **Folder / workspace → zip:** unchanged (`collectZipEntries` +
  `buildStoreZip`, `.dohc`/`.git`/`node_modules` skipped, bounded).
- Secret-classified files (the `.env` family, per the engine path floor that
  also governs search and moments) never leave in an archive: the zip walk
  skips them and an explicitly targeted secret refuses loudly. Zips get
  shared onward; a secret that should travel must be moved out of secret
  classification deliberately, not exported by accident.

## Sharing today (relay shares)

Implemented in `services/sync-relay` and the desktop app (PR 18 / MU-C4):

- **Grant side:** share a path, folder, or version read-only, or a chat
  channel bidirectionally. Addressed to a userId or email (pending invite,
  anti-enumeration), exchanged as a `dohc-share:<shareId>:<relayUrl>` code,
  revocable from Settings.
- **The security boundary is server-side and fail-closed:** the relay filters
  the op log per share (`shareFilter.ts` allowlist — only positively
  recognized ops/fields cross; secret-classified paths refused at grant time
  and per op; every denial is a byte-identical 404).
- **Receive side (current):** a share opens as a separate read-only "shared
  view" pseudo-workspace with a manual refresh banner.

The receive side is the weak half: shared content lives on an island. The
recipient's agent cannot see it, links can't point at it, and "refresh" is a
button instead of a property of the files.

## Share mounts (the full receive-side design)

**Goal:** accepting a share can mount it as a read-only, live folder inside a
workspace the recipient chooses: `shared-with-me/<label>/…`. Shared content
becomes ordinary files — readable by the user's agent with normal tools,
linkable, searchable — while remaining a *projection* of the granter's
filtered op log, never a local source of truth.

`shared-with-me/` already exists for exactly this: it is created in every
workspace, visible in the tree, and reserved against user writes
(`isReservedPath` in `packages/workspace-core/src/paths.ts`).

### Mount lifecycle (as implemented)

- **Mount:** from "Open a share" inside a workspace (default mode *Add to
  this workspace*) or Settings → Cloud → *Shared with me*. The mount record —
  shareId, label, granter, origin relay — persists on the host workspace's
  registry entry (`shareMounts`, the `sharedChannels` precedent;
  per-workspace scoping — a mount in workspace A is unreachable from
  workspace B). The label derives from the granter (`shared-with-me/alex/`),
  deduplicated like import collisions, and is re-validated as a single safe
  path segment on every use.
- **Materialize + follow:** the existing share pull (`pullShareView` +
  versioned text store, exactly as the island `sharedView.ts` does) targets
  the mount folder; the mount's op log and fetch cursor live in its own
  nested `<mount>/.dohc/engine/engine.db`, which the host tree/watcher never
  sees (`.dohc` is ignored at any depth). Refresh runs on workspace open, on
  a slow poll while the workspace is open, and manually from the mount's
  context menu; each pass applies filtered ops, materializes changed paths
  (containment-checked), then commits the cursor (crash-safe ordering).
- **Revoked/ended:** the mount freezes with status `ended` — files stay
  readable, nothing updates, the origin-relay pin prevents a wrong-server 404
  from ever flipping a mount to ended. Unmounting deletes the projection
  folder and the record; the granter's source is untouched either way.

### Invariants

- **Read-only is enforced at every write surface, not by convention:** the
  editor (mount paths open read-only, no engine session), desktop IPC write
  handlers, and MCP mutation tools all refuse reserved paths via
  `validateUserWritePath`. A physical write that sneaks in through a rogue
  tool is not durable: the next refresh re-materializes the projection.
- **Reads are allowed where writes are refused.** Historically every content
  read reused the write validator, so agents could not read `shared-with-me/`
  at all. `validateUserReadPath` (workspace-core) is the read-side twin —
  identical traversal/encoding/`.dohc` rules, shared-with-me allowed — used
  by the desktop read surfaces (text, assets, graph, database snapshots,
  content search) and MCP read tools. Writes keep the strict validator
  everywhere.
- **No write path back to the granter.** Mounting adds zero relay routes; the
  share filter remains the only boundary, and it is already fail-closed.
- **No transitive sharing.** Mounted content cannot be granted onward from
  inside the mount: the relay's selector validation refuses reserved paths
  (the authoritative gate), the desktop refuses with honest copy, and the
  mount's context menu offers no "Share…". Re-sharing someone's work
  requires deliberately copying it into your own files, which makes it
  yours — an explicit act, not a leak.
- **The host records nothing about mounted content.** The effective-policy
  floor classifies `shared-with-me/` as untracked, so the host workspace's
  capture, engine search, exports policy, and relay push all exclude it —
  mounted content cannot leak into the host's history or its synced copy.
  Provenance lives where the content does: the mount's own nested store
  carries the share's replayed op log, and the tree boundary
  (`shared-with-me/alex/…`) states the origin more plainly than an author
  label could.
- **Workspace zips** include mounted files as the plain files they are —
  which is exactly what the user sees in the tree.

### Why this is the obvious shape

Text is the primitive: "someone shared X with me" should mean "X is files in
my workspace" — the default an agent would assume. The island view survives
as the zero-commitment preview (open a code, look, close) and as the
first-run path when no workspace exists yet; mounting is the "keep this"
gesture.

## Retired: the workspace-to-workspace field-exchange panel

The product spec used to promise an "Imports / Exports" surface where exports
publish selected *fields* and imports subscribe to them. It was never built,
and relay shares now cover the need at file/path granularity with a real
security model. Field-granular exchange, if usage ever demands it, is a share
*selector* refinement (sharing a slice of a structured file the same way a
path share slices a workspace) — not a separate panel, not a second sharing
mechanism. The spec now describes sharing as it exists.
