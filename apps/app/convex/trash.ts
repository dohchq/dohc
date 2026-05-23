import { internalQuery, internalMutation } from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import { isCanonicalEntityId } from './entityId'
import { recordEntityWriteCapture } from './captures'
import { applyAtomCapture } from './atomCapture'
import { reconcileAtomIdIndex } from './atomId'
import { deriveSearchFields } from './searchText'

// Structural recoverability (Phase 2). Snapshot-before-destroy, at the
// data layer, model-independent, convex-test-verified.
//
// ACCURATE guarantee (re-review): within RETENTION —
//  • every DELETE (atom/folder/entity, agent OR public UI) is fully
//    recoverable;
//  • every AGENT / confirmed overwrite of user content snapshots the
//    immediately-prior version (never coalesced);
//  • the editor's rapid keystroke AUTOSAVE is recoverable to the
//    START OF EACH ≤10-min edit window (coalesced ON PURPOSE so a
//    500ms autosave loop can't flood/DoS the trash table) — discrete
//    keystroke states *within* a window are not separately retained.
// So "no irrecoverable loss" holds for deletes and deliberate
// overwrites; for keystroke autosave it is "recoverable to the last
// session boundary," by design.

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const PURGE_BATCH = 100
const RESTORE_LIST_MAX = 200

export type TrashKind = 'atom' | 'folder' | 'entity'

/** Plain helper (not a Convex function) so the delete chokepoints in
 *  atoms/folders/entities can snapshot before hard-deleting. */
export async function recordTrash(
  ctx: MutationCtx,
  args: {
    workspaceId: string
    kind: TrashKind
    ref: string
    payload: unknown
  },
): Promise<void> {
  await ctx.db.insert('trash', {
    workspaceId: args.workspaceId,
    kind: args.kind,
    ref: args.ref,
    payload: args.payload,
    deletedAt: Date.now(),
  })
}

/** Default coalescing window: at most one snapshot per (kind,ref) per
 *  10 min, so a tight edit/plugin loop can't flood the trash table
 *  (the entity path previously had NO coalescing — a plugin calling
 *  window.dohc.patch in a loop was an unbounded-growth DoS). */
export const COALESCE_MS = 10 * 60 * 1000

/** recordTrash, but skipped if an equivalent snapshot for the same
 *  (kind,ref) was taken within `windowMs`. The single coalescing
 *  primitive shared by the atom and entity snapshot paths. */
export async function recordTrashCoalesced(
  ctx: MutationCtx,
  args: {
    workspaceId: string
    kind: TrashKind
    ref: string
    payload: unknown
    windowMs?: number
  },
): Promise<void> {
  const win = args.windowMs ?? COALESCE_MS
  const recent = await ctx.db
    .query('trash')
    .withIndex('by_workspace_kind_ref', (q) =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('kind', args.kind)
        .eq('ref', args.ref),
    )
    .order('desc')
    .first()
  if (recent && Date.now() - recent.deletedAt < win) return
  await recordTrash(ctx, args)
}

export const _listTrash = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const rows = await ctx.db
      .query('trash')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .order('desc')
      .take(RESTORE_LIST_MAX)
    return rows.map((r) => ({
      id: r._id,
      kind: r.kind,
      ref: r.ref,
      deletedAt: r.deletedAt,
    }))
  },
})

/**
 * Restore one trashed item back into its live table. Fail-safe: if a
 * live row already exists at the same key, do NOT clobber it — report
 * and leave the trash row in place so nothing is lost either way.
 */
type RestoreResult =
  | { ok: true; kind: TrashKind; ref: string }
  | {
      ok: false
      reason: 'not-found' | 'live-exists' | 'corrupt-payload' | 'non-canonical'
    }

const isStr = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0

/** Restore one trash row. Validates payload shape (fail LOUD, not
 *  silent String() coercion — a wrong restore is the worst failure
 *  for a recovery layer). On any non-OK result the trash row is
 *  PRESERVED so nothing is lost either way. */
async function restoreRow(
  ctx: MutationCtx,
  workspaceId: string,
  // a Doc<'trash'>, loosely typed to avoid a generated-type import cycle
  row: { _id: import('./_generated/dataModel').Id<'trash'>; kind: TrashKind; ref: string; payload: unknown },
): Promise<RestoreResult> {
  const p = (row.payload ?? {}) as Record<string, unknown>

  if (row.kind === 'atom') {
    if (!isStr(p.path) || typeof p.body !== 'string') {
      return { ok: false, reason: 'corrupt-payload' }
    }
    const clash = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', p.path as string),
      )
      .unique()
    if (clash) return { ok: false, reason: 'live-exists' }
    // file-org-v1 §2.4 (Track-4 D4.1a) — restore brings the cosmetic +
    // lock + notice flags back EXACTLY as deleted. Each is defensively
    // read: a trash row that predates Track-4 has no flags in payload,
    // so they default to undefined and the restored atom is plain.
    const insertDoc: Record<string, unknown> = {
      workspaceId,
      path: p.path,
      body: p.body,
      updatedAt: Date.now(),
      source: isStr(p.source) ? p.source : 'user',
    }
    if (p.systemLocked === true) insertDoc.systemLocked = true
    if (p.userLocked === true) insertDoc.userLocked = true
    if (p.starred === true) insertDoc.starred = true
    if (isStr(p.migrationNotice)) insertDoc.migrationNotice = p.migrationNotice
    Object.assign(
      insertDoc,
      deriveSearchFields(p.path, isStr(p.body) ? p.body : ''),
    )
    await ctx.db.insert('atoms', insertDoc as any)
    // R3 §1 — restore is the 5th atom-write chokepoint: no prior ⇒
    // every inline value is FRESH-withheld (coalesced non-confirmed),
    // never auto-shared by a stale confirm. Mirrors entity restore.
    await applyAtomCapture(ctx, workspaceId, p.path, null, p.body)
    // atom-address-v1 §1.2/§1.3 — restore-from-trash is the ONLY
    // operation that may resurrect a tombstone (it carries the
    // original identity: p.body's frozen frontmatter id). A released
    // row for that id flips back to bound→this path; any OTHER write
    // reusing a dead id is a loud collision (never here). The
    // `live-exists` clash above already fails restore-into-occupied-
    // path loudly, so resurrection never displaces an occupant.
    await reconcileAtomIdIndex(
      ctx,
      workspaceId,
      p.path as string,
      p.body as string,
      { isRestore: true },
    )
  } else if (row.kind === 'folder') {
    if (!isStr(p.path)) return { ok: false, reason: 'corrupt-payload' }
    const clash = await ctx.db
      .query('folders')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', p.path as string),
      )
      .unique()
    // file-org-v1 §2.4 — folder restore may also recreate cosmetic
    // metadata. Two payload variants exist in the trash:
    //   1) PRE-Track-4 / undecorated: { path } only — restore the
    //      folder row, no metadata side-effect (back-compat).
    //   2) Decorated (icon/color/starred): restore the folders row
    //      AND a fresh folderMetadata row.
    //   3) Decorated-empty-folder (metadata-only delete): payload
    //      has cosmetics but no `folders` row was present to delete
    //      — restore should ONLY recreate the folderMetadata row.
    // Refuse path-clash on EITHER table to keep the invariant
    // "restore never overwrites a live row."
    const metaClash = await ctx.db
      .query('folderMetadata')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', p.path as string),
      )
      .unique()
    if (clash || metaClash) return { ok: false, reason: 'live-exists' }
    const hasCosmetic =
      isStr(p.icon) || isStr(p.color) || p.starred === true
    // R4 fold (Codex FAIL-4) — `metaOnly:true` marker means the
    // trash row originated from a metadata-only delete (the user
    // cleared all decoration on a decorated-empty folder via the
    // picker, OR folders.remove swept an orphan folderMetadata).
    // Restore ONLY the folderMetadata row in that case — there
    // was no `folders` row to restore.
    const metaOnly = p.metaOnly === true
    if (!metaOnly) {
      await ctx.db.insert('folders', {
        workspaceId,
        path: p.path,
        createdAt: Date.now(),
      })
    }
    if (hasCosmetic) {
      await ctx.db.insert('folderMetadata', {
        workspaceId,
        path: p.path,
        icon: isStr(p.icon) ? p.icon : undefined,
        color: isStr(p.color) ? p.color : undefined,
        starred: p.starred === true ? true : undefined,
        updatedAt: Date.now(),
      })
    }
  } else {
    if (
      !isStr(p.type) ||
      !isStr(p.slug) ||
      p.data == null ||
      typeof p.data !== 'object'
    ) {
      return { ok: false, reason: 'corrupt-payload' }
    }
    // Phase-3 review (Codex HIGH): restore is a third entity-write
    // chokepoint. A legacy/non-canonical payload ({type:"a/b"}) would
    // re-introduce the capture-ref-ambiguity leak. Refuse it (the
    // trash row is PRESERVED — see the success-only delete below — so
    // nothing is lost; it can be migrated/hand-fixed later).
    if (!isCanonicalEntityId(p.type, p.slug)) {
      return { ok: false, reason: 'non-canonical' }
    }
    const clash = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type_slug', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('type', p.type as string)
          .eq('slug', p.slug as string),
      )
      .unique()
    if (clash) return { ok: false, reason: 'live-exists' }
    await ctx.db.insert('entities', {
      workspaceId,
      type: p.type,
      slug: p.slug,
      data: p.data,
      updatedAt: Date.now(),
    })
    // R2.1 (C2, per-KEY): restore is the 4th entity-write chokepoint
    // — a restored entity is a re-created value; withhold each scalar
    // field until the owner re-confirms THAT key.
    const rd = (p.data ?? {}) as Record<string, unknown>
    for (const [k, val] of Object.entries(rd)) {
      if (
        typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        await recordEntityWriteCapture(ctx, workspaceId, p.type, p.slug, k)
      }
    }
  }
  await ctx.db.delete(row._id)
  return { ok: true, kind: row.kind, ref: row.ref }
}

export const _restore = internalMutation({
  args: { workspaceId: v.string(), trashId: v.id('trash') },
  handler: async (ctx, { workspaceId, trashId }): Promise<RestoreResult> => {
    const row = await ctx.db.get(trashId)
    if (!row || row.workspaceId !== workspaceId) {
      return { ok: false, reason: 'not-found' }
    }
    return await restoreRow(ctx, workspaceId, row)
  },
})

const SUBTREE_PAGE = 200

/**
 * Restore a deleted folder AND every trashed item that was inside it,
 * in one op (a recursive delete produced one folder row + N atom/
 * folder rows under `<folder>/`).
 *
 * Re-review fix: the prior version did a fixed `.take(1000)` over ALL
 * workspace trash + stopped on `restored===0`, which silently
 * mis-completed when matchable rows fell outside the window (e.g. lots
 * of unrelated older trash). Now it PAGINATES the whole workspace
 * trash with a cursor and reschedules until `isDone` — every row is
 * scanned exactly once, so it is both complete and terminating
 * (pages are finite, cursor is monotonic).
 */
export const _restoreSubtree = internalMutation({
  args: {
    workspaceId: v.string(),
    folderPath: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    soFarRestored: v.optional(v.number()),
    soFarSkipped: v.optional(v.number()),
  },
  handler: async (ctx, { workspaceId, folderPath, cursor, soFarRestored, soFarSkipped }) => {
    const clean = folderPath.replace(/^\/+|\/+$/g, '')
    const prefix = `${clean}/`
    const page = await ctx.db
      .query('trash')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .order('asc')
      .paginate({ numItems: SUBTREE_PAGE, cursor: cursor ?? null })
    let restored = soFarRestored ?? 0
    let skipped = soFarSkipped ?? 0
    for (const r of page.page) {
      if (r.ref !== clean && !r.ref.startsWith(prefix)) continue
      const res = await restoreRow(ctx, workspaceId, r)
      if (res.ok) restored++
      else skipped++
    }
    const done = page.isDone
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.trash._restoreSubtree, {
        workspaceId,
        folderPath,
        cursor: page.continueCursor,
        soFarRestored: restored,
        soFarSkipped: skipped,
      })
    }
    // `nextCursor` is also returned so the continuation is drivable
    // deterministically (tests / a future sync caller) — prod relies
    // on the scheduled self-reschedule above.
    return {
      restored,
      skipped,
      done,
      nextCursor: done ? null : page.continueCursor,
    }
  },
})

/**
 * Retention purge. Batched + self-rescheduling so it stays within
 * Convex transaction limits (per the Convex guidelines: never
 * unbounded; use .take(n) + ctx.scheduler).
 */
export const _purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_RETENTION_MS
    const expired = await ctx.db
      .query('trash')
      .withIndex('by_deletedAt', (q) => q.lt('deletedAt', cutoff))
      .take(PURGE_BATCH)
    for (const r of expired) await ctx.db.delete(r._id)
    if (expired.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.trash._purgeExpired, {})
    }
    return { purged: expired.length }
  },
})
