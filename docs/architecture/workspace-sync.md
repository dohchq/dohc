# Workspace Sync: The Merge Engine

Cloud sync moves changes between a living desktop workspace folder and a
dohc Cloud (or self-hosted) workspace. The engine merges in place — it never
re-materializes the working copy, because a clone-style pull would destroy
`.dohc` (identity, history, op logs) and any not-yet-pushed files. The
implementation is `createMergeSync` in
`packages/workspace-sync/src/cloudSync.ts`; the desktop loop around it is
`apps/desktop/src/workspaces/cloudSyncEngine.ts`.

Design floor, everywhere in this document: **silent loss is never
acceptable.** When in doubt the engine keeps both versions and tells the
user, in prose — never git conflict markers
(`packages/workspace-core/src/conflicts.ts`).

## Two manifests, deliberately split

- `.dohc/manifest.json` — workspace **identity** (id, kind, mode), owned by
  workspace-core/desktop.
- `.dohc/sync-manifest.json` — the **sync baseline**
  (`MANIFEST_PATH` in `packages/workspace-fs/src/metadata.ts`): per-file
  `{ id, kind, contentType, revision, sha256 }` plus the server binding.

Identity must survive anything sync does; the baseline can be rebuilt. Both
are written atomically (temp + rename) so a crash never truncates them. A
corrupt baseline raises `CorruptManifestError` and is **never** reset to
empty — that would re-create and conflict-spam every previously-synced file.
Only a genuinely absent file (ENOENT) means "fresh, never synced".

## Push: scan-diff with an in-place baseline

`push()` scans the folder against the baseline (`scanWorkspaceDiff`),
filters out `*.conflict` rescue files, decomposes cross-folder renames into
delete + create (the server rejects cross-folder renames; with the partial
unique index from migration 0003 this is safe and content-equivalent), skips
oversize binaries (`MAX_INLINE_FILE_SIZE`) without wedging the batch, and
POSTs the operations to `sync/apply`.

The new baseline is rebuilt from the T0 scan hashes plus the per-op
revisions the server returned — never a post-push rescan. Only ops the
server reported ok advance the baseline, so a partial failure leaves the
rest pending for a clean retry, and an edit made during the push window
stays dirty.

## Pull: per-file three-way merge

For every remote file, `pull()` compares three states: the **baseline**
entry (last agreed sync point), the **live disk** content (re-hashed via
`diskSha` immediately before every overwrite/delete decision, so an edit
made mid-pull is seen — never a stale scan), and the **remote** revision.

- Baseline current and remote unchanged: leave local state alone, clean or
  mid-edit.
- Local clean, remote changed: write the remote content, advance the
  baseline.
- Local dirty (differs from baseline AND remote): the remote content lands
  beside it as `<path>.conflict` — a rescue file, plainly visible, never a
  git marker — and the baseline does not advance, so the local edit still
  pushes.
- Disk already equals remote (self-heal): adopt revision + sha into the
  baseline without rewriting the file or spawning a spurious conflict.

### The no-resurrect rule

A baseline entry whose local file is gone is a **local deletion**, not a
clean slot to fill. The engine never resurrects it: incoming remote content
lands as `<path>.conflict`, and the deletion still pushes. Symmetrically, a
remote deletion only deletes locally when the local copy exactly matches the
baseline; a dirty copy stays and re-creates on the next push.

### Trust boundaries

The server is outside the local trust boundary: pulled paths are validated
(`assertSafeWorkspacePath`), a remote file may never write into `.dohc/**`,
and `*.conflict` markers are local-only artifacts that are never pulled.

## Server binding and dead sessions

- The baseline records which server/workspace produced it. If the engine is
  pointed elsewhere, `ServerBindingMismatchError` refuses **all** sync —
  re-pointing at an empty server must not mass-delete clean local files.
  Verified on pull and push alike (`readBoundManifest`).
- A confirmed 401 raises `UnauthorizedSyncError`: the desktop engine flips
  `authExpired`, stops the retry loop, and the UI shows
  cloud-disconnected / "session expired — reconnect"
  (`cloudSyncEngine.ts`, `apps/desktop/src/renderer/CloudLogin.tsx`).
  Local data is untouched; retrying a dead token forever while claiming
  "connected" is the failure mode this prevents.

## The desktop loop

`createCloudSyncEngine` serializes everything on one chain (pushes never
interleave): `start()` runs first contact (initialize baseline, pull, push)
and rethrows failures so enable-sync cannot falsely report success;
afterwards each settled watcher batch queues a debounced push (1.5 s).
Transient failures keep pending counts up and retry on the next batch —
they never crash the app or lose local data.

## Live co-editing through the same write path

Live co-editing does not bypass the file model — it materializes through it.
The canonical-state model
(`apps/desktop/src/renderer/collab/collabSession.ts`, decision D-07):

- the **file is canonical while the shared doc is closed**; the moment a
  collab session is live, the Yjs CRDT is canonical and the file is a
  projection.
- entry is **synced-gated** (`useCollabDoc.ts`): the editor only switches to
  collab mode once the Hocuspocus provider is connected AND synced, so a
  half-loaded doc can never overwrite the local file. Until then the local
  autosave path owns writes.
- the doc projects ("materializes") to the file only at settle points —
  debounce, session close, explicit save — and each materialization records
  the sha of exactly what was written, so the watcher recognizes the write
  as self-produced and does not loop it back into the doc.
- an external edit during a session (an agent, a sync pull) folds into the
  live doc by three-way merge against the last materialized text
  (`mergeMarkdown` in
  `packages/workspace-history/src/conflictResolution.ts` — conservative
  line merge, overlap = conflict, both versions preserved verbatim, no git
  markers; an AI proposal can sit alongside, but only a human applies it).
- delete with unmaterialized content rescues to `<name>.recovered.<ext>`
  rather than dropping work.

Because the materialized file goes through the normal watcher → change-set →
push path, and the server-side projection worker writes the live doc's
plainText into the same `atoms`/`atom_revisions` tables the sync API reads
(`docs/architecture/dohc-cloud.md`), live participants and pull-based
clients converge on the same content.

## Proof

`packages/workspace-sync/src/cloudSync.test.ts` and
`batchedSync.test.ts` cover the engine; the end-to-end proofs are
`apps/desktop/e2e/cloudSync.spec.ts` and
`apps/desktop/e2e/liveCoEditing.spec.ts` (two Electron clients converging
over a real server).
