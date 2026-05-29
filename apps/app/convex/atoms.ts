import { v } from 'convex/values'
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import { recordTrash, recordTrashCoalesced } from './trash'
import { applyAtomCapture } from './atomCapture'
import { clearAtomCaptures } from './captures'
import { isSafeAtomPath } from './inlineAtom'
import { deriveSearchFields } from './searchText'
import { internal } from './_generated/api'
import {
  seedAtomIdIntoBody,
  reconcileAtomIdIndex,
  releaseAtomIdOnDelete,
  collectConcreteRefs,
  normalizeFileId,
  extractFrontmatterId,
  extractFrontmatterIcon,
  setFrontmatterIcon,
  isHtmlAtomBody,
  isHtmlPath,
  isCommandAtomBody,
  isSkillAtomBody,
  isLegacySkillPath,
  isWorkspaceCommandPath,
  isWorkspaceSkillPath,
  splitFrontmatter,
  joinFrontmatter,
  injectFrontmatterTitle,
  extractLeadingH1,
  countTypeLines,
  deriveTitle,
} from './atomId'
import {
  SystemLockError,
  UserLockError,
  type LockContext,
} from './atomLocks'
import {
  cascadeDeleteSharesForFileId,
  resolveShareAccess,
  ownerAtomByFileId,
} from './atomShares'
import { scheduleHocuspocusDeleteDocument } from './hocuspocusAdmin'
import type { MutationCtx } from './_generated/server'

// Snapshot-coalescing window. The editor auto-saves every ~500ms; we
// must NOT write a trash snapshot per keystroke. Instead we snapshot
// the PRE-EDIT body at most once per atom per window, so a user can
// always recover to "before this editing session" with bounded growth.
const SNAPSHOT_COALESCE_MS = 10 * 60 * 1000 // 10 min

// ── Shared destructive-op impls. ROOT-CAUSE FIX (Phase-2 review):
// there used to be two parallel code paths — public mutations (the
// UI) and internal mutations (the agent) — and only the agent path
// snapshotted. Now BOTH public and internal entry points call these
// single impls, so recoverability is structural, not path-specific.

export async function snapshotAtomBodyCoalesced(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  priorBody: string,
  priorSource: string,
) {
  await recordTrashCoalesced(ctx, {
    workspaceId,
    kind: 'atom',
    ref: `${path} (pre-edit)`,
    payload: { path, body: priorBody, source: priorSource },
    windowMs: SNAPSHOT_COALESCE_MS,
  })
}

export async function upsertAtomImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: string
    path: string
    body: string
    source?: string
    /** false (default) = the agent path: refuse to overwrite a
     *  user-authored atom unless explicitly confirmed. true = the
     *  user's own editor: overwriting their own content is allowed
     *  (still snapshotted for fat-finger recovery). */
    isUserEdit?: boolean
    allowUserOverwrite?: boolean
    /** file-org-v1 §2.3 (Track-4 D4.1a). true ⇒ this write is
     *  permitted to overwrite a `systemLocked` atom — held ONLY by
     *  `_upsertSystem` (audit-by-grep enforced; currently no prod
     *  callers). Public/agent paths NEVER set this. */
    allowSystemOverride?: boolean
    /** file-org-v1 §2.3 — this write is the one that's TURNING the
     *  systemLocked flag on (so the lock-guard inside this same call
     *  doesn't fire on the freshly-locked state). Only `_upsertSystem`
     *  sets it. */
    writeSystemLocked?: boolean
    /** When set on a brand-new atom, create it as private to this
     *  user. Used for user/agent-created docs in org workspaces. */
    defaultPrivateOwnerUserId?: string
  },
): Promise<Id<'atoms'>> {
  const {
    workspaceId,
    path,
    body,
    source,
    isUserEdit,
    allowUserOverwrite,
    allowSystemOverride,
    writeSystemLocked,
    defaultPrivateOwnerUserId,
  } = args
  // R3 §8 (Codex R3-build): reject a NUL note path at the write
  // surface — `refKey`'s in-memory delimiter is U+0000; a NUL in the
  // free-form atom `ref` must never reach the gate set.
  if (!isSafeAtomPath(path)) {
    throw new Error(`invalid atom path (contains U+0000): ${JSON.stringify(path)}`)
  }
  // atom-address-v1 §1.1 — seed the stable frontmatter `id:` BEFORE
  // the write so the persisted body carries it (idempotent: a body
  // that already has an id is returned unchanged; a re-saved
  // addressed file keeps its own id). `finalBody` is what we persist
  // and diff/capture against from here on.
  const finalBody = await seedAtomIdIntoBody(ctx, workspaceId, path, body)
  const existing = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  const now = Date.now()
  if (existing) {
    // file-org-v1 §2.3 (Track-4 D4.1a). Lock-guard chokepoint #1.
    // Fires BEFORE the user-content-overwrite guard so the more
    // specific taxonomy wins: a userLocked user-authored atom throws
    // UserLockError (not the generic refuse-overwrite Error).
    //   systemLocked is overridable only by `allowSystemOverride`
    //     (held by `_upsertSystem`). Throws SystemLockError otherwise.
    //   userLocked refuses agent/system writes but the user's OWN
    //     editor (isUserEdit) still succeeds — line 39 mandate: the
    //     user can always edit their own locked file.
    if (existing.systemLocked && allowSystemOverride !== true) {
      throw new SystemLockError(path, 'edit')
    }
    // D4.1a R1-fold (indep FAIL-3): `_upsertSystem` owns the system
    // slot. A user-lock decorating a system atom must NOT halt the
    // system writer. The system slot's owner asserts ownership
    // regardless of user decoration; the user can still unlock later.
    if (
      existing.userLocked &&
      !isUserEdit &&
      allowSystemOverride !== true
    ) {
      throw new UserLockError(path, 'edit')
    }
    if (
      existing.source === 'user' &&
      !isUserEdit &&
      allowUserOverwrite !== true
    ) {
      throw new Error(
        `refusing to overwrite user-authored atom "${path}" without confirmation`,
      )
    }
    if (finalBody !== existing.body) {
      // Re-review accuracy fix: only the editor's keystroke autosave
      // (isUserEdit) coalesces — that's the flood source. An AGENT
      // write (incl. a confirmed overwrite of user content) ALWAYS
      // takes a full snapshot, so it can never ride a user's open
      // coalescing window and leave the immediately-prior content
      // unrecoverable.
      if (isUserEdit) {
        await snapshotAtomBodyCoalesced(
          ctx,
          workspaceId,
          path,
          existing.body,
          existing.source ?? 'agent',
        )
      } else {
        await recordTrash(ctx, {
          workspaceId,
          kind: 'atom',
          ref: `${path} (pre-overwrite)`,
          payload: {
            path,
            body: existing.body,
            source: existing.source ?? 'agent',
          },
        })
      }
    }
    // Track-3 P2a: clear the per-file migration advisory on a
    // USER edit (the user's edit IS acknowledgment — the banner
    // disappears the moment they touch the file). Agent writes do
    // NOT clear it (the user themselves must confirm).
    const noticePatch =
      isUserEdit && existing.migrationNotice != null
        ? { migrationNotice: undefined }
        : {}
    // file-org-v1 §2.3 — `_upsertSystem` writes systemLocked:true on
    // every refresh of its target (idempotent; cheap; survives any
    // accidental flag clear). Other callers leave the flag untouched.
    const systemLockPatch =
      writeSystemLocked === true ? { systemLocked: true } : {}
    await ctx.db.patch(existing._id, {
      body: finalBody,
      updatedAt: now,
      source: source ?? existing.source,
      ...noticePatch,
      ...systemLockPatch,
      ...deriveSearchFields(path, finalBody),
    })
    // R3 §1 — structural atom capture (the body-change chokepoint):
    // diff prior vs new inline values; changed ⇒ withheld until
    // confirmed; unparseable ⇒ parse-fail sentinel (fail-closed).
    await applyAtomCapture(ctx, workspaceId, path, existing.body, finalBody)
    // atom-address-v1 §1.3 — keep the rename-proof index in step
    // (same txn; OCC-atomic). An implicit write at a new path with an
    // existing id is classified rename vs copy here.
    await reconcileAtomIdIndex(ctx, workspaceId, path, finalBody, {
      isRestore: false,
    })
    return existing._id
  }
  // file-org-v1 §2.3 — first-write of a system atom is born locked.
  const systemLockInsert =
    writeSystemLocked === true ? { systemLocked: true } : {}
  const id = await ctx.db.insert('atoms', {
    workspaceId,
    path,
    body: finalBody,
    updatedAt: now,
    source: source ?? (isUserEdit ? 'user' : 'agent'),
    ...systemLockInsert,
    ...deriveSearchFields(path, finalBody),
  })
  if (defaultPrivateOwnerUserId) {
    await ctx.db.insert('atomAccess', {
      atomId: id,
      mode: 'private',
      ownerUserId: defaultPrivateOwnerUserId,
      allowedUserIds: [],
      setAt: now,
      setByUserId: defaultPrivateOwnerUserId,
    })
  }
  // R3 §1 — new note: no prior ⇒ every inline value is withheld
  // until the owner confirms it (strict; closes C2 for atoms).
  await applyAtomCapture(ctx, workspaceId, path, null, finalBody)
  await reconcileAtomIdIndex(ctx, workspaceId, path, finalBody, {
    isRestore: false,
  })
  return id
}

export async function removeAtomImpl(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
): Promise<void> {
  const existing = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  if (!existing) return
  // file-org-v1 §2.3 (Track-4 D4.1a) — lock-guard chokepoint #2.
  // Delete-context message variant. systemLocked refuses ALL deletes
  // (no override here); userLocked refuses ALL deletes (the user's
  // own delete still works after they unlock via setLock).
  if (existing.systemLocked) {
    throw new SystemLockError(path, 'delete')
  }
  if (existing.userLocked) {
    throw new UserLockError(path, 'delete')
  }
  await recordTrash(ctx, {
    workspaceId,
    kind: 'atom',
    ref: path,
    payload: {
      path: existing.path,
      body: existing.body,
      source: existing.source ?? 'agent',
      // file-org-v1 §2.4 — trash payload carries the cosmetic +
      // lock + migration flags so a restore brings them back
      // EXACTLY as deleted (a starred lock survives the trip; an
      // unlocked-after-deletion user can't lose decoration as a
      // side-effect). trash.restore reads them defensively.
      systemLocked: existing.systemLocked ?? false,
      userLocked: existing.userLocked ?? false,
      starred: existing.starred ?? false,
      migrationNotice: existing.migrationNotice,
    },
  })
  await ctx.db.delete(existing._id)
  // R3 §1/M6 — drop ALL capture rows for the deleted note (incl. the
  // parse-fail sentinel). A future recreate re-withholds fresh.
  await clearAtomCaptures(ctx, workspaceId, path)
  // D4.14/D4.25 — release-or-tombstone this file's id. Free it
  // (reusable, no `_2`) UNLESS another atom's formula concretely
  // references it, in which case tombstone so the stale ref renders
  // `—` instead of silently hijacking a recreate. The deleted atom
  // is already gone from the scan.
  const concreteRefs = await collectConcreteRefs(
    ctx,
    workspaceId,
    new Set([path]),
  )
  await releaseAtomIdOnDelete(ctx, workspaceId, existing.body, path, concreteRefs)
  // sharing-v1 1a — deleting a file REVOKES all its shares. Grants do
  // NOT ride the trash payload, so a restore does not silently
  // resurrect access — a re-share is required.
  const deletedFileId = extractFrontmatterId(existing.body)
  if (deletedFileId) {
    await cascadeDeleteSharesForFileId(ctx, workspaceId, deletedFileId)
    await scheduleHocuspocusDeleteDocument(ctx, {
      workspaceId,
      atomId: deletedFileId,
    })
  }
}

// Public CRUD for synthesized atoms. workspaceId is derived from auth.

export const list = query({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // personal. Membership-gated by requireWorkspace when an org id is
  // supplied. (Adds to every public atoms surface; see also getByPath,
  // upsert, remove, move, setLock, setIcon, setStar, idAdvisory.)
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    // P1 (multiplayer-and-h-followups §6.5) — filter atoms the viewer
    // can't read. Per-row resolveAtomAccess: ~3 db lookups (atomAccess,
    // atomTombstones, folderAccess walk) per atom. For typical workspaces
    // (~hundreds of atoms, few access overrides) the cost is small;
    // optimize via batch-preload if profiling shows a hot path.
    const visible: typeof rows = []
    for (const r of rows) {
      if (await canReadAtom(ctx, r._id, viewerSubject)) visible.push(r)
    }
    return visible
      .map((r) => ({
        _id: r._id,
        path: r.path,
        title: deriveTitle(r.body, r.path),
        updatedAt: r.updatedAt,
        source: r.source ?? 'agent',
        // §5 tree-perception (Track-2 P3b + Track-3 P1): a `type:
        // html`/`type: skill` atom has NO file extension, so the
        // tree MUST signal "this is a page" / "this is a skill".
        // Derived via the §6 one-predicate (no new parser); legacy
        // `skills/*` (no frontmatter) ALSO projects 'skill' during
        // the compat window so the Sparkles icon is correct
        // immediately. Advisory/additive — never affects routing.
        // D4.13 — a `.html` path is a page (extension-determined,
        // case-insensitive), OR (backward-compat) a `type: html`
        // body.
        type:
          isHtmlPath(r.path) || isHtmlAtomBody(r.body)
            ? ('html' as const)
            : isCommandAtomBody(r.body) || isWorkspaceCommandPath(r.path)
              ? ('command' as const)
              : isSkillAtomBody(r.body) ||
                  isWorkspaceSkillPath(r.path) ||
                  isLegacySkillPath(r.path)
              ? ('skill' as const)
              : null,
        // file-org-v1 §3.1 (Track-4 D4.4a) — project the three
        // boolean flags so the FileTree can render lock/star
        // affordances without an extra round-trip. Defaults are
        // false (undefined → false) so pre-Track-4 rows render
        // plain. Pure projection; no behavior change.
        systemLocked: r.systemLocked ?? false,
        userLocked: r.userLocked ?? false,
        starred: r.starred ?? false,
        // emoji-icons — the page's icon emoji, read from frontmatter
        // `icon:` (the file's metadata; null ⇒ default icon)
        icon: extractFrontmatterIcon(r.body),
        // D4.8e — project the rename-proof fileId from frontmatter
        // so the editor's formula plugin can resolve `{= id.key }`
        // references to the file's CURRENT title (without exposing
        // the stale id text to the user). null when the atom has
        // no `id:` in frontmatter (pre-Track-1 / legacy rows).
        fileId: extractFrontmatterId(r.body),
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  },
})

export const getByPath = query({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const row = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!row) return null
    // P1 — gate by access. Non-allowed viewers see null (consistent
    // with "atom doesn't exist for me" — search/queries/etc. produce
    // the same fail-closed shape).
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canReadAtom(ctx, row._id, viewerSubject))) return null
    return row
  },
})

// atom-address-v1 §1.4 — the REQUIRED, proactive surfacing of an
// auto-suffixed / colliding address (Independent P1-build dispositive:
// because b1 hides the `id:`, a silent `_2` is "a hidden id the user
// can't explain"). Owner-scoped, read-only, cheap. The editor renders
// the result as a calm INLINE one-liner on the affected file (never a
// modal — design §1.4) so the user always learns of it WITHOUT having
// to suspect anything; `⟨⟩ source` is the fix affordance.
//   collision  — this file's id is claimed elsewhere / unbound ⇒ its
//                `{=…}` refs render "—" until the id is made unique.
//   suffixed   — benign: the address was auto-named `<wanted>_n`
//                because another file wanted `<wanted>`.
export const idAdvisory = query({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (
    ctx,
    { path, activeWorkspaceId },
  ): Promise<{
    kind: 'collision' | 'suffixed' | null
    fileId: string | null
    wanted: string | null
  }> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const none = { kind: null, fileId: null, wanted: null } as const
    const atom = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!atom) return none
    // P1 (multiplayer-and-h-followups §6.5) — collapse to the
    // missing-shape for atoms the viewer can't read. Without this,
    // a teammate could probe whether `alice/secret.md` exists by
    // calling idAdvisory and getting back a non-`none` fileId.
    // Same no-existence-oracle pattern as atoms.getByPath /
    // htmlAtoms.getRenderable / search.run.
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canReadAtom(ctx, atom._id, viewerSubject))) return none
    const fileId = extractFrontmatterId(atom.body)
    if (fileId === null) return none

    const rows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) =>
        q.eq('workspaceId', workspaceId).eq('fileId', fileId),
      )
      .collect()
    const bound = rows.find((r) => r.state === 'bound')
    // Bound to a DIFFERENT path, or not bound at all though the body
    // carries the id ⇒ this file lost the collision; refs broken.
    if (!bound || bound.path !== path) {
      return { kind: 'collision', fileId, wanted: normalizeFileId(path) }
    }
    // Well-bound to this path. Flag ONLY a true auto-suffix of THIS
    // path's candidate (`<cand>_<digits>`) — never a normal renamed
    // file (whose id intentionally differs from its new path).
    const cand = normalizeFileId(path)
    if (fileId !== cand && new RegExp(`^${escapeRegex(cand)}_\\d+$`).test(fileId)) {
      return { kind: 'suffixed', fileId, wanted: cand }
    }
    return { kind: null, fileId, wanted: cand }
  },
})

export const upsert = mutation({
  args: {
    path: v.string(),
    body: v.string(),
    source: v.optional(v.string()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, body, source, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    // P1 (multiplayer-and-h-followups §6.5) — write-path access
    // gate. Notion-full: read == write at the per-atom layer, so a
    // teammate can't overwrite your private atom (canWriteAtomPath
    // routes to canReadAtom for an existing path), AND can't
    // PLANT a doc in your private folder (folder cascade applies
    // on the creation branch). Hard-error rather than fail-soft —
    // a silent no-op would mask data loss in the editor.
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canWriteAtomPath(ctx, workspaceId, path, viewerSubject))) {
      throw new Error('You do not have access to write at this path.')
    }
    // The user's own editor. Overwriting their own content is allowed
    // (isUserEdit) but still snapshotted (coalesced) so a fat-finger
    // auto-save is recoverable.
    const out = await upsertAtomImpl(ctx, {
      workspaceId,
      path,
      body,
      source,
      isUserEdit: true,
      defaultPrivateOwnerUserId:
        workspaceId !== viewerSubject ? viewerSubject : undefined,
    })
    return out
  },
})

// sharing-v1 1b — collaborative edit of a SHARED atom. The grantee
// writes the OWNER's canonical atom through a single transaction that:
//   1. resolveShareAccess re-verifies the grant (revoke-while-editing
//      is denied — TOCTOU-safe, the check is in THIS transaction);
//   2. requires permission:'edit';
//   3. OPTIMISTIC CONCURRENCY — rejects if the atom changed since the
//      grantee loaded it (baseVersion), so a stale save never silently
//      clobbers the owner's (or a co-editor's) intervening edit;
//   4. refuse-on-missing — addresses by fileId→current path; if the
//      owner renamed/deleted it, refuse (NEVER insert a zombie atom).
// The write routes through upsertAtomImpl into the OWNER's workspace
// (snapshot + capture + reconcile as usual); owner locks still block.
export const upsertSharedAtom = mutation({
  args: {
    shareId: v.id('atomShares'),
    body: v.string(),
    // The exact body the grantee loaded/last-saved. The guard is a
    // CONTENT compare-and-swap, NOT a timestamp — `updatedAt` is a
    // wall-clock millisecond, so two saves in the same ms could both
    // pass a `updatedAt===baseVersion` check and silently clobber
    // (codex final review P1). A body compare is collision-proof.
    baseBody: v.string(),
  },
  handler: async (ctx, { shareId, body, baseBody }) => {
    const access = await resolveShareAccess(ctx, shareId)
    if (!access) throw new Error('You no longer have access to this file.')
    if (access.permission !== 'edit') {
      throw new Error('You only have view access to this file.')
    }
    const atom = await ownerAtomByFileId(
      ctx,
      access.ownerWorkspaceId,
      access.fileId,
    )
    if (!atom) {
      throw new Error('This file was moved or deleted by its owner.')
    }
    if (atom.body !== baseBody) {
      // The canonical body changed since the grantee loaded it →
      // CONFLICT (the client surfaces this + offers a reload). Exact
      // content match ⇒ no same-millisecond clobber window.
      throw new Error(
        'CONFLICT: this file changed since you opened it — reload to get the latest before editing.',
      )
    }
    // sharing-v1 1b review (P1): a grantee fully controls `body`, so a
    // present frontmatter `id:` that DIFFERS from the granted fileId
    // would persist into the owner's workspace — corrupting the
    // owner's own formula resolution (body-id ≠ index-id ⇒ skipped)
    // and self-bricking the share (the read path's id-match belt then
    // refuses it). Mirror the read-path belt on the write: a shared
    // edit may never change the file id. (A MISSING id is fine —
    // seedAtomIdIntoBody re-injects the bound id from the path.)
    const incomingId = extractFrontmatterId(body)
    if (incomingId !== null && incomingId !== access.fileId) {
      throw new Error('A shared edit may not change the file id.')
    }
    // Write into the OWNER's workspace, addressed by the CURRENT path.
    // allowUserOverwrite (the grant authorizes editing the owner's
    // content) but NOT isUserEdit (so an owner USER-lock still blocks
    // a grantee). seedAtomIdIntoBody keeps the frozen id; reconcile
    // keeps the index bound.
    await upsertAtomImpl(ctx, {
      workspaceId: access.ownerWorkspaceId,
      path: atom.path,
      body,
      source: 'user',
      allowUserOverwrite: true,
    })
    // The just-written body is the client's new base (it advances
    // remoteBodyRef to `body` on success — no returned token needed).
    return { ok: true as const }
  },
})

export const remove = mutation({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    // P1 — delete is a write. Same gate as upsert; canWriteAtomPath
    // returns false for a tombstoned atom (correct: the tombstone
    // recovery flow is the ONLY way to operate on it).
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canWriteAtomPath(ctx, workspaceId, path, viewerSubject))) {
      throw new Error('You do not have access to delete this atom.')
    }
    await removeAtomImpl(ctx, workspaceId, path)
  },
})

// Rename an atom path. Atomic across:
//   1. the atom itself moves from old → new path
//   2. every other atom whose body contains [[oldPath]] or ![[oldPath]]
//      (with or without the .md extension) gets its body rewritten to
//      point at the new path
// This keeps wikilinks/transclusions stable across moves.
export const move = mutation({
  args: {
    fromPath: v.string(),
    toPath: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { fromPath, toPath, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    if (fromPath === toPath)
      return {
        ok: true as const,
        moved: 0,
        linkUpdates: 0,
        skippedLockedCount: 0,
        skippedLockedSample: [] as string[],
      }
    // R3 §8 (Codex holistic LOW): the NUL-path reject is a WRITE-
    // surface guarantee — enforce it on the move destination too, not
    // only upsert (the claim must equal the code).
    if (!isSafeAtomPath(toPath)) {
      throw new Error(`invalid atom path (contains U+0000): ${JSON.stringify(toPath)}`)
    }

    // P1 — move is a write at BOTH ends: the rename touches the
    // source atom (so the caller must be able to write the source)
    // AND lands a new row at the destination (so the destination
    // folder cascade applies — can't move a doc INTO a teammate's
    // private folder). Both checks before any state changes.
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canWriteAtomPath(ctx, workspaceId, fromPath, viewerSubject))) {
      throw new Error('You do not have access to move this atom.')
    }
    if (!(await canWriteAtomPath(ctx, workspaceId, toPath, viewerSubject))) {
      throw new Error('You do not have access to move into this destination.')
    }

    const src = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', fromPath),
      )
      .unique()
    if (!src) throw new Error(`not found: ${fromPath}`)
    const srcAccess = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q) => q.eq('atomId', src._id))
      .unique()

    // file-org-v1 §2.3 (Track-4 D4.1a) — lock-guard chokepoint #3.
    // Rename-context message variant. A system atom is part of the system
    // contract; a userLocked atom is the user's explicit "don't touch this".
    if (src.systemLocked) throw new SystemLockError(fromPath, 'rename')
    if (src.userLocked) throw new UserLockError(fromPath, 'rename')

    const dst = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', toPath),
      )
      .unique()
    if (dst) throw new Error(`already exists: ${toPath}`)

    const now = Date.now()
    const movedId = await ctx.db.insert('atoms', {
      workspaceId,
      path: toPath,
      body: src.body,
      updatedAt: now,
      source: src.source,
      // file-org-v1 §2.4 — preserve cosmetic+lock state through a
      // rename. starred/userLocked follow the file (a star on
      // "draft.md" survives → "shipped.md"). systemLocked is never
      // set here (the chokepoint above refused), so we don't carry
      // it — the lock invariant is "system path is part of the
      // contract; if we got here, the source was NOT systemLocked".
      ...(src.starred ? { starred: true } : {}),
      ...(src.userLocked ? { userLocked: true } : {}),
      // Track-3 P2a: path-move clears the migration advisory — the
      // user moving the file IS acknowledgment that they've decided
      // about its skill-ness (moved out of `skills/` ⇒ no longer a
      // skill; moved within `skills/` ⇒ they kept it, deliberately).
      // Recompute search fields — the path changed (basename/path feed
      // searchText), even though the body is unchanged.
      ...deriveSearchFields(toPath, src.body),
    })
    if (srcAccess) {
      await ctx.db.insert('atomAccess', {
        atomId: movedId,
        mode: srcAccess.mode,
        ownerUserId: srcAccess.ownerUserId,
        allowedUserIds: srcAccess.allowedUserIds,
        setAt: srcAccess.setAt,
        setByUserId: srcAccess.setByUserId,
      })
      await ctx.db.delete(srcAccess._id)
    }
    // snapshot the source before the delete side of the move
    await recordTrash(ctx, {
      workspaceId,
      kind: 'atom',
      ref: `${fromPath} (moved→${toPath})`,
      payload: { path: fromPath, body: src.body, source: src.source ?? 'agent' },
    })
    await ctx.db.delete(src._id)
    // R3 §1 — old path: drop its captures; new path: fresh capture
    // (no prior ⇒ every inline value re-withheld at the new path
    // until re-confirmed — a rename is NOT a strict bypass).
    await clearAtomCaptures(ctx, workspaceId, fromPath)
    await applyAtomCapture(ctx, workspaceId, toPath, null, src.body)
    // atom-address-v1 §1.3 — EXPLICIT rename. Critically this runs
    // AFTER the src delete: `move` inserts-then-deletes, so were this
    // called earlier the old path would still be live and the
    // heuristic would mis-classify a rename as a loud copy. Old path
    // now gone ⇒ the id (frozen in src.body) rebinds fromPath→toPath
    // and every `{=…id…}` reference stays resolved.
    await reconcileAtomIdIndex(ctx, workspaceId, toPath, src.body, {
      isRestore: false,
    })

    // Cascade wikilink rewrites across the rest of the vault.
    const fromNoExt = fromPath.replace(/\.md$/i, '')
    const toNoExt = toPath.replace(/\.md$/i, '')
    const escapedFrom = escapeRegex(fromPath)
    const escapedFromNoExt = escapeRegex(fromNoExt)
    // D4.7d — legacy editor's markdown serializer escapes the
    // OPENING brackets on save: typing `[[playground/a]]` in the
    // editor produces `\[\[playground/a]]` in the stored body
    // (CommonMark only requires the opening `[`s to be escaped to
    // suppress link parsing; closing `]]` stays bare). The cascade
    // regex must match BOTH forms — `[[...]]` from seeded fixtures
    // / agent writes + `\[\[...]]` from legacy-editor-typed bodies.
    const linkRe = new RegExp(
      `\\\\?\\[\\\\?\\[(!?)(${escapedFrom}|${escapedFromNoExt})\\\\?\\]\\\\?\\]`,
      'g',
    )

    const all = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()

    let updated = 0
    let skippedLockedCount = 0
    const skippedLockedSample: string[] = []
    for (const a of all) {
      if (a.path === toPath) continue
      linkRe.lastIndex = 0
      if (!linkRe.test(a.body)) continue
      linkRe.lastIndex = 0
      const rewritten = a.body.replace(linkRe, (_, bang) => `[[${bang}${toNoExt}]]`)
      if (rewritten !== a.body) {
        // file-org-v1 §2.5 (Track-4 D4.1a) — SKIP-REWRITE-ON-LOCKED.
        // A locked atom's body is the user's (or system's) frozen
        // contract; a wikilink cascade triggered by SOMEONE ELSE'S
        // rename must NOT mutate it. Counted + sampled so the UI can
        // surface a "you renamed X but Y, Z still point at the old
        // path" notice (cosmetic; non-blocking; no advisory model).
        if (a.userLocked || a.systemLocked) {
          skippedLockedCount++
          if (skippedLockedSample.length < 20) skippedLockedSample.push(a.path)
          continue
        }
        // recoverability for the in-place body rewrite, coalesced
        await snapshotAtomBodyCoalesced(
          ctx,
          workspaceId,
          a.path,
          a.body,
          a.source ?? 'agent',
        )
        await ctx.db.patch(a._id, {
          body: rewritten,
          updatedAt: now,
          ...deriveSearchFields(a.path, rewritten),
        })
        // R3 §1 — cascade is a link-only rewrite ⇒ the value-atom
        // diff is empty (no-op); but route it through the contract so
        // a body that DID change a value can never bypass capture.
        await applyAtomCapture(ctx, workspaceId, a.path, a.body, rewritten)
        updated++
      }
    }

    return {
      ok: true as const,
      moved: 1,
      linkUpdates: updated,
      skippedLockedCount,
      skippedLockedSample,
    }
  },
})

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Internal mirrors used by the agent's tools (called from authed actions,
// which pass workspaceId through).

export const _listInternal = internalQuery({
  // atom-address-v1 §5.2 (Phase-4 precondition 1): optional `limit`
  // to BOUND the query-block `docs.glob` read. Omitted ⇒ unbounded
  // (byte-identical for the agent callers); given ⇒ take limit+1 so
  // truncation is detectable + honestly disclosed.
  //
  // P1 (multiplayer-and-h-followups §6.5): optional `viewerSubject` —
  // when provided, filter to atoms the viewer can READ (private +
  // restricted atoms the viewer isn't allowed in are dropped). Agent
  // tools that surface paths to the model MUST pass it so the agent
  // can't read a teammate's private atom via list_atoms. Omitted
  // (e.g. seed flows) ⇒ unfiltered, back-compat with the v0 surface.
  args: {
    workspaceId: v.string(),
    limit: v.optional(v.number()),
    viewerSubject: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, limit, viewerSubject }) => {
    const base = ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    const rows =
      limit === undefined ? await base.collect() : await base.take(limit + 1)
    if (!viewerSubject) return rows.map((r) => r.path).sort()
    const visible: typeof rows = []
    for (const r of rows) {
      if (await canReadAtom(ctx, r._id, viewerSubject)) visible.push(r)
    }
    return visible.map((r) => r.path).sort()
  },
})

export const _getInternal = internalQuery({
  // P1: optional `viewerSubject` — when provided, returns null if
  // the viewer can't read this atom. Agent tools pass it; legacy /
  // system callers omit (back-compat).
  args: {
    workspaceId: v.string(),
    path: v.string(),
    viewerSubject: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, path, viewerSubject }) => {
    const row = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!row) return null
    if (
      viewerSubject &&
      !(await canReadAtom(ctx, row._id, viewerSubject))
    ) {
      return null
    }
    return row.body
  },
})

export const _upsertInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    body: v.string(),
    source: v.optional(v.string()),
    // STRUCTURAL GUARD (Phase-2 review). The agent write path must NOT
    // silently overwrite a USER-authored atom (.context/me.md, hand-edited
    // dashboards) — that is the prompt-injection blast radius. This is
    // a data-layer invariant, independent of model/prompt: an agent
    // write over user content THROWS unless explicitly allowed (the
    // write_atom tool only sets this after user confirmation).
    allowUserOverwrite: v.optional(v.boolean()),
    // P1 (multiplayer-and-h-followups §6.5) — when present, gate the
    // write through canWriteAtomPath against THIS user's access. The
    // agent-tool callers (write_atom + capture etc.) pass the actor
    // subject; system callers (seed flows) call without it (allowed — the system surface is intentionally
    // unconstrained, audit-by-grep enforces that).
    viewerSubject: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { workspaceId, path, body, source, allowUserOverwrite, viewerSubject },
  ) => {
    if (
      viewerSubject &&
      !(await canWriteAtomPath(ctx, workspaceId, path, viewerSubject))
    ) {
      throw new Error('You do not have access to write at this path.')
    }
    // Agent path: the guard + coalesced snapshot live in the single
    // shared impl (isUserEdit defaults false → user-content overwrite
    // refused unless allowUserOverwrite).
    return await upsertAtomImpl(ctx, {
      workspaceId,
      path,
      body,
      source,
      allowUserOverwrite,
      defaultPrivateOwnerUserId:
        viewerSubject && workspaceId !== viewerSubject ? viewerSubject : undefined,
    })
  },
})

export const _setBodyCache = internalMutation({
  args: {
    workspaceId: v.string(),
    atomId: v.string(),
    markdown: v.string(),
    projectionHash: v.string(),
    schemaVersion: v.number(),
    ydocStateVector: v.string(),
    lastEditedByUserId: v.optional(v.string()),
    projectedAt: v.number(),
  },
  handler: async (
    ctx,
    {
      workspaceId,
      atomId,
      markdown,
      projectionHash,
      schemaVersion,
      ydocStateVector,
      lastEditedByUserId,
      projectedAt,
    },
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'missing-atom' | 'frontmatter-id-mismatch' }
  > => {
    const atom = await ownerAtomByFileId(ctx, workspaceId, atomId)
    if (!atom) {
      return { ok: false, reason: 'missing-atom' }
    }

    if (extractFrontmatterId(markdown) !== atomId) {
      return { ok: false, reason: 'frontmatter-id-mismatch' }
    }

    await ctx.db.patch(atom._id, {
      body: markdown,
      updatedAt: projectedAt,
      ...(lastEditedByUserId ? { lastEditedByUserId } : {}),
      bodyProjectionHash: projectionHash,
      bodyProjectionVersion: schemaVersion,
      bodyProjectionStateVector: ydocStateVector,
      bodyProjectedAt: projectedAt,
      ...deriveSearchFields(atom.path, markdown),
    })
    await applyAtomCapture(ctx, workspaceId, atom.path, atom.body, markdown)
    await reconcileAtomIdIndex(ctx, workspaceId, atom.path, markdown, {
      isRestore: false,
    })
    return { ok: true }
  },
})

export const _removeInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    // P1 — same pattern as _upsertInternal: agent callers pass
    // viewerSubject; system callers omit it.
    viewerSubject: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, path, viewerSubject }) => {
    if (
      viewerSubject &&
      !(await canWriteAtomPath(ctx, workspaceId, path, viewerSubject))
    ) {
      throw new Error('You do not have access to delete this atom.')
    }
    await removeAtomImpl(ctx, workspaceId, path)
  },
})

// file-org-v1 §2.3 (Track-4 D4.1a) — the SOLE entry that may overwrite
// a `systemLocked` atom AND that writes `systemLocked: true`. There
// are currently no production callers; an audit-by-grep test
// (src/__tests__/upsertSystemAudit.test.ts) refuses an unreviewed caller.
// Lifecycle invariant: every `_upsertSystem` call re-asserts the lock
// (idempotent), so an accidental flag clear is healed on the next
// system refresh. NEVER expose as a public mutation.
export const _upsertSystem = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    body: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, path, body, source }) => {
    return await upsertAtomImpl(ctx, {
      workspaceId,
      path,
      body,
      source,
      allowSystemOverride: true,
      writeSystemLocked: true,
    })
  },
})

// file-org-v1 §3.2 + §2-A.1 (Track-4 D4.1b ATOMIC, R2-fold of indep
// FAIL-1) — user-controlled LOCK toggle. `setLock` touches ONLY the
// `userLocked` flag. `systemLocked` stays owned by `_upsertSystem`
// (audit-by-grep enforced; currently no production callers). The user
// has NO public API to mutate
// `systemLocked` because exposing it would be a DoS surface (any
// caller could mark arbitrary atoms as "system-managed" and
// undeletable).
//
// Indep R2 fold: the OLDER refuse-on-systemLocked branch was wrong.
// A user who locked an agent-written atom BEFORE a system refresh
// would get permanently stuck with an orphan userLocked
// decoration (functionally inert because `_upsertSystem` bypasses
// both locks per D4.1a R1-fold FAIL-3, but symbolically stuck — no
// path to clear). The fix: setLock toggles userLocked regardless
// of systemLocked state. The user can always clear their own
// decoration; the system flag is untouched.
//
// The agent tool `set_lock` lives in agent.ts under §2-A.1 with the
// requireDirectUserAuthorization gate (a skill body cannot toggle
// locks behind the user's back).
async function setLockImpl(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  locked: boolean,
): Promise<{ ok: true; locked: boolean; changed: boolean }> {
  const existing = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  if (!existing) throw new Error(`not found: ${path}`)
  // NOTE: NO refuse-on-systemLocked branch. The user can always
  // toggle their own userLocked decoration; the systemLocked flag
  // is unaffected (still owned by `_upsertSystem`).
  const wasLocked = existing.userLocked === true
  if (wasLocked === locked) {
    return { ok: true as const, locked, changed: false }
  }
  await ctx.db.patch(existing._id, {
    userLocked: locked ? true : undefined,
  })
  return { ok: true as const, locked, changed: true }
}

export const setLock = mutation({
  args: {
    path: v.string(),
    locked: v.boolean(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, locked, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    return await setLockImpl(ctx, workspaceId, path, locked)
  },
})

// Internal mirror — invoked by the agent's `set_lock` tool (§2-A.1
// gated). Public callers use `api.atoms.setLock` (above) which goes
// through requireWorkspace; the agent path threads `workspaceId`
// from the authed action.
export const _setLockInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    locked: v.boolean(),
  },
  handler: async (ctx, { workspaceId, path, locked }) => {
    return await setLockImpl(ctx, workspaceId, path, locked)
  },
})

// file-org-v1 §3.2 (Track-4 D4.1a) — STAR is a pure cosmetic mutation:
// it never edits the body and never affects routing/captures/locks.
// Public path only (no agent tool); the agent has no reason to star.
// Idempotent: re-applying the same value is a no-op patch.
// emoji-icons — set (or clear, with '') a file's icon emoji. The icon
// lives in the frontmatter `icon:` (the file's metadata), so this
// rewrites the body through the normal chokepoint (preserves the id).
export const setIcon = mutation({
  args: {
    path: v.string(),
    icon: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, icon, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const existing = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!existing) throw new Error(`not found: ${path}`)
    const trimmed = icon.trim()
    if (trimmed.length > 16) throw new Error('icon too long')
    const nextBody = setFrontmatterIcon(existing.body, trimmed || null)
    if (nextBody === existing.body) return { ok: true as const, changed: false }
    await upsertAtomImpl(ctx, {
      workspaceId,
      path,
      body: nextBody,
      source: 'user',
      isUserEdit: true,
    })
    return { ok: true as const, changed: true }
  },
})

export const setStar = mutation({
  args: {
    path: v.string(),
    starred: v.boolean(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, starred, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const existing = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!existing) throw new Error(`not found: ${path}`)
    // Pure cosmetic — NOT lock-guarded. A user can always favorite/star a
    // file/folder without changing its content or lock contract.
    const next = starred ? true : undefined
    if ((existing.starred ?? false) === Boolean(next)) {
      return { ok: true as const, changed: false }
    }
    await ctx.db.patch(existing._id, { starred: next })
    return { ok: true as const, changed: true }
  },
})

// D4.27 — verify + repair the atomIds index from the atom bodies
// (the source of truth). The index is a DERIVED CACHE; this is the
// permanent, reusable recovery (replaces the one-off dev migration).
// Rebuilds bound rows from each atom's frontmatter `id:`; drops
// stale/orphan/double rows + tombstones (tombstone-while-referenced
// is a runtime behaviour re-established on the next delete, not a
// corruption-recoverable invariant). First body wins on a dup id.
// internalMutation: ops via `npx convex run`, or wire to a cron.
export const verifyAndRepairAtomIds = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const rows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    for (const r of rows) await ctx.db.delete(r._id)

    const atoms = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    const seen = new Set<string>()
    let bound = 0
    let skippedDup = 0
    let skippedNoId = 0
    for (const a of atoms) {
      const fileId = extractFrontmatterId(a.body)
      if (!fileId) {
        skippedNoId++
        continue
      }
      if (seen.has(fileId)) {
        skippedDup++ // a second body claiming the same id — first wins
        continue
      }
      seen.add(fileId)
      await ctx.db.insert('atomIds', {
        workspaceId,
        fileId,
        path: a.path,
        state: 'bound',
      })
      bound++
    }
    return { deleted: rows.length, bound, skippedDup, skippedNoId }
  },
})

// D4.29 — backfill the page TITLE for LEGACY doc atoms. Before the
// title→frontmatter switch (D4.22), a page's title was the leading
// `# H1` of the body. Such pages now show an EMPTY title field +
// the H1 in the content. This lifts the leading `# H1` into the
// `title:` frontmatter property and strips it from the body (and
// de-dups a page that already has both). Only touches plain doc
// atoms — never html (extension/filename-titled), skill, or
// action atoms (their frontmatter is functional config). One body
// wins; idempotent (a page already title:'d with no body H1 is
// untouched). internalMutation: run via `npx convex run`.
export const migrateBodyTitlesToFrontmatter = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const atoms = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    let migrated = 0
    let deduped = 0
    for (const a of atoms) {
      const { fm, rest } = splitFrontmatter(a.body)
      // Skip functional atoms: html (by extension OR type), skill,
      // action — any frontmatter `type:` line means "not a
      // plain doc".
      if (isHtmlPath(a.path) || (fm && countTypeLines(fm) > 0)) continue
      const h1 = extractLeadingH1(rest)
      if (!h1) continue // no leading body title to lift
      const inner = fm
        .replace(/^---[ \t]*\r?\n/, '')
        .replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
      const titleMatch =
        /^title:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\n]*))[ \t]*$/m.exec(inner)
      const existingTitle = titleMatch
        ? (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? '').trim()
        : null
      const title = existingTitle && existingTitle.length > 0 ? existingTitle : h1.title
      // body without the leading H1, then (re)set the title property
      const stripped = joinFrontmatter(fm, h1.bodyWithoutH1)
      const next = injectFrontmatterTitle(stripped, title)
      if (next !== a.body) {
        await ctx.db.patch(a._id, {
          body: next,
          updatedAt: Date.now(),
          ...deriveSearchFields(a.path, next),
        })
        if (existingTitle) deduped++
        else migrated++
      }
    }
    return { migrated, deduped }
  },
})

// app-wide search backfill (docs/development/search-plan.md §5). Populates
// `searchText`/`searchable` on existing atoms that predate the feature.
// Paginates and self-schedules so each transaction stays within Convex's
// read/write limits; a modest page size keeps large bodies safe. Run via
// `npx convex run atoms:_backfillSearch '{}'` (all workspaces) or scoped
// from `search.ensureIndexed` (one workspace, self-healing on first
// search). Idempotent — patches only rows whose fields aren't in sync.
export const _backfillSearch = internalMutation({
  args: {
    workspaceId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, { workspaceId, cursor, batch }) => {
    const numItems = batch ?? 40
    const q = workspaceId
      ? ctx.db
          .query('atoms')
          .withIndex('by_workspace', (i) => i.eq('workspaceId', workspaceId))
      : ctx.db.query('atoms')
    const page = await q.paginate({ cursor: cursor ?? null, numItems })
    let patched = 0
    for (const a of page.page) {
      const sf = deriveSearchFields(a.path, a.body)
      if (a.searchText !== sf.searchText || a.searchable !== sf.searchable) {
        await ctx.db.patch(a._id, sf)
        patched++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.atoms._backfillSearch, {
        workspaceId,
        cursor: page.continueCursor,
        batch: numItems,
      })
    }
    return { patched, done: page.isDone }
  },
})
