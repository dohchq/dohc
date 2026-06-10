# Phase 10 review — live co-editing (codex gpt-5.5 xhigh + collab verifier)

Reviews: codex `bu2ox7bun` on commits 2c89866 (live co-editing) + 24ffd97
(postgres-acl + collab-token) → `/tmp/codex-phase10.log`; adversarial collab
verifier `wzjt94wbp` (ACL/doc-name scoping, CRDT data-loss, token lifetime).

All four confirmed findings were data-loss / liveness in the desktop Yjs path.
Closed by `phase10(fix)`.

## Findings → fixes

- **[P1] Wrong Yjs field → blank open + cross-channel data loss.** The desktop
  bound `doc.getText("content")`, but the hocuspocus server bootstraps/projects
  markdown atoms into the `body` ProseMirror XmlFragment (or the `plainText`
  Y.Text). So the desktop opened blank, and the server `onChange` projection
  serialized an *empty* body and blanked `atoms.body` — which the merge-sync
  channel then propagated to the file (cross-channel silent loss).
  **Fix:** make the postgres/hocuspocus path plain-text-canonical — the only
  live editor on it is the desktop's plain-text textarea. `loadAtomBootstrap`
  returns `plainText: true`; `bootstrapMarkdownToYDoc` honors it (Convex/rich
  path unchanged); the desktop binds `getText("plainText")`. Field now matches
  bootstrap == projection, so atoms.body stays correct.

- **[P1] Materialize gated on connect, not sync.** `enabled = status ===
  "connected"` flipped to collab mode (and started the 800ms materialize timer)
  on a bare socket open, before the initial Yjs sync — the empty pre-sync
  Y.Text would blank the file.
  **Fix:** `useCollabDoc` exposes/derives state from the provider `onSynced`;
  `enabled` and all materialization are gated on `synced`. Until synced the
  local autosave editor (real on-disk content) owns the surface.

- **[P1] External edits clobbered (model never wired into the live path).**
  `collabSession.ts` (reconcileExternalEdit / shouldMaterialize /
  recordMaterialization) was referenced only by its own test; the live loop was
  a blind write of `collab.text`.
  An agent edit or sync pull during a live session was overwritten.
  **Fix:** wired the model into `useCollabDoc`. Every settle and every on-disk
  change runs `reconcileExternalEdit` against the last-materialized base: an
  empty/older doc folds the on-disk text IN; a clean 3-way merge applies; an
  overlapping edit is rescued to a visible `<path>.conflict` and the live
  session keeps `<path>` — never a silent overwrite, never git markers.

- **[P2] Collab JWT never refreshed.** The 5-min token was only re-fetched on
  reconnect; a long-open session would have its sync/awareness messages
  rejected after expiry.
  **Fix:** schedule `provider.sendToken()` every 4 min (the token factory
  already mints a fresh token).

## Test hardening

`liveCoEditing.spec.ts` now asserts the seeded `# Shared doc` header SURVIVES in
both editors and on client A's disk after the settle, with both edits present,
no `.conflict` artifact, and no git markers — directly catching the
blank-overwrite class the prior test missed.

## Gates

hocuspocus 87 · desktop typecheck clean · collabSession 19 + FileInspector 15 ·
workspace-sync 38 · workspace-history 20 · liveCoEditing E2E 2/2.
