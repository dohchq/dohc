// P1 (multiplayer-and-h-followups §6.5) — per-atom + per-folder access
// controls. Resolver function + public mutations for setting access
// modes and recovering tombstoned atoms.
//
// The resolver `resolveAtomAccess(ctx, atomId, viewerSubject)` is the
// SINGLE source of truth for "can this user read this atom"; every
// read surface (atoms.list, search.run, evalQueryBlocks, evalFormulas,
// htmlAtoms.getRenderable, atomShares.getSharedAtom, agent tools)
// will gate on it as part of the P1 read-path-filtering follow-up
// commits. This file lands the resolver + the set/recover surface so
// the filtering can be layered in incrementally.

import { v } from 'convex/values'
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { requireRole } from './orgRoles'

/** Resolution result. `allowed: false` carries a reason so callers
 *  can surface specific UX (a private atom hidden from search differs
 *  from a tombstoned one — search omits, the tombstone-admin surface
 *  shows it). */
export type AccessResolution =
  | {
      allowed: true
      mode: 'org-default' | 'private' | 'restricted'
      ownerUserId?: string
    }
  | {
      allowed: false
      reason:
        | 'atom-not-found'
        | 'tombstoned'
        | 'atom-private'
        | 'atom-restricted'
        | 'folder-private'
        | 'folder-restricted'
        | 'no-membership'
    }

/** Resolve whether `viewerSubject` can READ `atomId`.
 *
 *  Resolution order (decision P1-A):
 *    1. Membership gate is assumed UPSTREAM (every public read fn
 *       already calls `requireWorkspace(ctx, activeWorkspaceId)`
 *       which throws on non-members). Defensive null-atom check only.
 *    2. Tombstone check — `member-departed` tombstones make atoms
 *       invisible to ALL (Owners included) until `recoverTombstonedAtom`.
 *    3. Atom-level `atomAccess` row — if present, decides outright.
 *    4. Folder-cascade walk (deepest folder with a row wins).
 *    5. Org-default → allow (workspace membership grants implicit
 *       read; only the access overrides above can restrict). */
export async function resolveAtomAccess(
  ctx: QueryCtx | MutationCtx,
  atomId: Id<'atoms'>,
  viewerSubject: string,
): Promise<AccessResolution> {
  // 1. Atom existence
  const atom = await ctx.db.get(atomId)
  if (!atom) return { allowed: false, reason: 'atom-not-found' }

  // 2. Tombstone check (single by_atom index lookup)
  const tomb = await ctx.db
    .query('atomTombstones')
    .withIndex('by_atom', (q) => q.eq('atomId', atomId))
    .unique()
  if (tomb && !tomb.recoveredAt) {
    return { allowed: false, reason: 'tombstoned' }
  }

  // 3. Atom-level access override
  const atomAccessRow = await ctx.db
    .query('atomAccess')
    .withIndex('by_atom', (q) => q.eq('atomId', atomId))
    .unique()
  if (atomAccessRow) {
    if (viewerSubject === atomAccessRow.ownerUserId) {
      return {
        allowed: true,
        mode: atomAccessRow.mode,
        ownerUserId: atomAccessRow.ownerUserId,
      }
    }
    if (
      atomAccessRow.mode === 'restricted' &&
      atomAccessRow.allowedUserIds.includes(viewerSubject)
    ) {
      return {
        allowed: true,
        mode: 'restricted',
        ownerUserId: atomAccessRow.ownerUserId,
      }
    }
    return {
      allowed: false,
      reason:
        atomAccessRow.mode === 'private' ? 'atom-private' : 'atom-restricted',
    }
  }

  // 4. Folder cascade — walk path bottom-up, deepest match wins
  const segments = atom.path.split('/')
  // segments.length - 1 to skip the file itself; >= 0 to check the
  // workspace root (empty folderPath) as a final cascade step.
  for (let i = segments.length - 1; i >= 0; i--) {
    const folderPath = segments.slice(0, i).join('/')
    const folderAccessRow = await ctx.db
      .query('folderAccess')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', atom.workspaceId).eq('folderPath', folderPath),
      )
      .unique()
    if (folderAccessRow) {
      if (viewerSubject === folderAccessRow.ownerUserId) {
        return {
          allowed: true,
          mode: folderAccessRow.mode,
          ownerUserId: folderAccessRow.ownerUserId,
        }
      }
      if (
        folderAccessRow.mode === 'restricted' &&
        folderAccessRow.allowedUserIds.includes(viewerSubject)
      ) {
        return {
          allowed: true,
          mode: 'restricted',
          ownerUserId: folderAccessRow.ownerUserId,
        }
      }
      return {
        allowed: false,
        reason:
          folderAccessRow.mode === 'private'
            ? 'folder-private'
            : 'folder-restricted',
      }
    }
  }

  // 5. Org-default — allow (membership was gated upstream)
  return { allowed: true, mode: 'org-default' }
}

/** Convenience: just the boolean. Useful inside list-filter loops
 *  where the reason isn't needed. */
export async function canReadAtom(
  ctx: QueryCtx | MutationCtx,
  atomId: Id<'atoms'>,
  viewerSubject: string,
): Promise<boolean> {
  return (await resolveAtomAccess(ctx, atomId, viewerSubject)).allowed
}

/** Folder-creation gate — would this viewer be allowed to create
 *  content at `folderPath` (or inside it)? Walks the folder cascade
 *  bottom-up from `folderPath` itself UPWARD (deepest match wins),
 *  same precedence as the read resolver's folder portion. Returns
 *  true when no rule applies (org-default) or when the deepest
 *  matching rule allows this viewer. So a teammate can't `mkdir`
 *  inside your private folder, and the agent's create_folder tool
 *  inherits the same gate without a separate code path.
 *
 *  An empty `folderPath` (workspace root) only blocks if a root
 *  folderAccess row exists that denies — by convention we never set
 *  one, so root creation is always allowed for a member. */
export async function canWriteInFolder(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  folderPath: string,
  viewerSubject: string,
): Promise<boolean> {
  // folderPath '' (root) ⇒ segments = ['']; iterate i=0 only, checks
  // the empty folderPath. A non-empty 'a/b' ⇒ segments ['a','b'];
  // iterate i=2,1,0 checking 'a/b', 'a', ''.
  const segments = folderPath === '' ? [''] : folderPath.split('/')
  for (let i = segments.length; i >= 0; i--) {
    const path = i === 0 ? '' : segments.slice(0, i).join('/')
    const row = await ctx.db
      .query('folderAccess')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('folderPath', path),
      )
      .unique()
    if (row) {
      if (viewerSubject === row.ownerUserId) return true
      if (
        row.mode === 'restricted' &&
        row.allowedUserIds.includes(viewerSubject)
      ) {
        return true
      }
      return false
    }
    if (i === 0) break // we already checked the root; avoid loop underflow
  }
  return true
}

export function folderPathForPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export async function canReadPathByFolderAccess(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  path: string,
  viewerSubject: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  if (existing) return canReadAtom(ctx, existing._id, viewerSubject)
  return canWriteInFolder(ctx, workspaceId, folderPathForPath(path), viewerSubject)
}

/** Write-path gate for an atom PATH (not id) — handles both create
 *  and overwrite. Notion-full §6.5 semantic: read == write at the
 *  per-atom layer. So:
 *    • atom already exists at `path` → the answer IS canReadAtom on
 *      that atom (the existing row carries any atom-level override
 *      or sits under folder cascade);
 *    • atom does NOT exist (creation) → walk the folder cascade only
 *      (deepest match wins, same order as the read resolver). A
 *      folder marked private/restricted to someone-else blocks
 *      creation INSIDE it — otherwise a teammate could plant a
 *      doc in your private `alice/` folder. Org-default allows.
 *
 *  Tombstoned atoms are READ-denied but their PATHS are still in
 *  the live table (tombstone is a separate row). A "create at the
 *  same path" attempts to write the existing atom — caught by the
 *  canReadAtom branch above (tombstoned ⇒ allowed=false). So a
 *  member can't quietly write over a departed teammate's private
 *  doc by reusing its path. */
export async function canWriteAtomPath(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  path: string,
  viewerSubject: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  if (existing) return canReadAtom(ctx, existing._id, viewerSubject)

  // Creation path — walk folder cascade only. Same bottom-up,
  // deepest-wins order as the read resolver, minus the atom-level
  // step (no atom exists yet).
  const segments = path.split('/')
  for (let i = segments.length - 1; i >= 0; i--) {
    const folderPath = segments.slice(0, i).join('/')
    const folderAccessRow = await ctx.db
      .query('folderAccess')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('folderPath', folderPath),
      )
      .unique()
    if (folderAccessRow) {
      if (viewerSubject === folderAccessRow.ownerUserId) return true
      if (
        folderAccessRow.mode === 'restricted' &&
        folderAccessRow.allowedUserIds.includes(viewerSubject)
      ) {
        return true
      }
      return false
    }
  }
  // No folder rule found — org-default allows (membership was
  // already validated by the calling mutation's requireWorkspace).
  return true
}

// ── Mutations ─────────────────────────────────────────────────────────

/** Set or clear an atom's access mode. v1 contract: any active
 *  workspace member can set access on any atom in their workspace
 *  (matches dohc's existing "org members are equal at the data layer"
 *  pattern); the caller becomes the `ownerUserId` when setting
 *  `private` or `restricted`. Clearing (passing `mode: null`) reverts
 *  to org-default / folder-cascade.
 *
 *  Pass `mode: 'private'` with `allowedUserIds: []` (just the owner).
 *  Pass `mode: 'restricted'` with `allowedUserIds: [...]` (owner +
 *  list). The owner is ALWAYS allowed; allowedUserIds extends. */
export const setAtomAccess = mutation({
  args: {
    atomId: v.id('atoms'),
    activeWorkspaceId: v.optional(v.string()),
    mode: v.union(v.literal('private'), v.literal('restricted'), v.null()),
    allowedUserIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { atomId, activeWorkspaceId, mode, allowedUserIds },
  ) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject

    const atom = await ctx.db.get(atomId)
    if (!atom) throw new Error('Atom not found.')
    if (atom.workspaceId !== workspaceId) {
      throw new Error('Atom does not belong to the active workspace.')
    }

    // Only the existing access owner (or any member if no row exists
    // yet) can change access. This prevents another Member from
    // hijacking your `private` atom by overwriting your atomAccess row.
    const existing = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q) => q.eq('atomId', atomId))
      .unique()
    if (existing && existing.ownerUserId !== subject) {
      throw new Error(
        'Only the current access owner can change this atom\'s access.',
      )
    }

    if (mode === null) {
      // Clear — atom reverts to org-default / folder-cascade.
      if (existing) await ctx.db.delete(existing._id)
      return { ok: true as const, cleared: true }
    }

    const allowed = allowedUserIds ?? []
    // `private` MUST have an empty allowedUserIds (decision P1: private
    // means just-the-owner; use `restricted` for a list).
    if (mode === 'private' && allowed.length > 0) {
      throw new Error(
        'private mode must have an empty allowedUserIds — use restricted for a list.',
      )
    }

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    } else {
      await ctx.db.insert('atomAccess', {
        atomId,
        mode,
        ownerUserId: subject,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    }
    return { ok: true as const, cleared: false }
  },
})

/** Set or clear a folder's access mode. Same contract as
 *  `setAtomAccess` but for a folder path. Cascades to atoms inside
 *  (resolver walks bottom-up; deepest folder wins). */
export const setFolderAccess = mutation({
  args: {
    folderPath: v.string(),
    activeWorkspaceId: v.optional(v.string()),
    mode: v.union(v.literal('private'), v.literal('restricted'), v.null()),
    allowedUserIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { folderPath, activeWorkspaceId, mode, allowedUserIds },
  ) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject

    const cleanPath = folderPath.replace(/^\/+|\/+$/g, '')
    const existing = await ctx.db
      .query('folderAccess')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('folderPath', cleanPath),
      )
      .unique()
    if (existing && existing.ownerUserId !== subject) {
      throw new Error(
        'Only the current access owner can change this folder\'s access.',
      )
    }

    if (mode === null) {
      if (existing) await ctx.db.delete(existing._id)
      return { ok: true as const, cleared: true }
    }

    const allowed = allowedUserIds ?? []
    if (mode === 'private' && allowed.length > 0) {
      throw new Error(
        'private mode must have an empty allowedUserIds — use restricted for a list.',
      )
    }

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    } else {
      await ctx.db.insert('folderAccess', {
        workspaceId,
        folderPath: cleanPath,
        mode,
        ownerUserId: subject,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    }
    return { ok: true as const, cleared: false }
  },
})

/** Owner-only: recover a tombstoned atom (a member-departed private
 *  atom). The atom becomes visible again per the `newAccessMode` the
 *  Owner picks. Audit record stays in `atomTombstones` (recoveredAt +
 *  recoveredByOwnerUserId).
 *
 *  Decision P1-C: org Owners are the ONLY principals who can recover.
 *  Members can't — preserves the "Owner admin power for membership
 *  changes, no special read access" principle (decision P1-B). The
 *  Owner doesn't see the atom's CONTENT during recovery — they pick a
 *  new access (e.g. transfer ownership to a remaining team member);
 *  the new owner then sees it. */
export const recoverTombstonedAtom = mutation({
  args: {
    atomId: v.id('atoms'),
    // required (not optional) — tombstones only exist in org contexts
    activeWorkspaceId: v.string(),
    /** New access mode for the recovered atom. */
    newAccessMode: v.union(
      v.literal('org-default'),
      v.literal('private'),
      v.literal('restricted'),
    ),
    /** Required for 'private' / 'restricted'; ignored for 'org-default'. */
    newOwnerUserId: v.optional(v.string()),
    newAllowedUserIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { atomId, activeWorkspaceId, newAccessMode, newOwnerUserId, newAllowedUserIds },
  ) => {
    await requireRole(ctx, activeWorkspaceId, 'owner')
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const ownerSubject = identity.subject

    const tomb = await ctx.db
      .query('atomTombstones')
      .withIndex('by_atom', (q) => q.eq('atomId', atomId))
      .unique()
    if (!tomb) throw new Error('Atom has no tombstone — nothing to recover.')
    if (tomb.recoveredAt) {
      throw new Error('Atom has already been recovered.')
    }
    if (tomb.workspaceId !== activeWorkspaceId) {
      throw new Error('Tombstone is in a different workspace.')
    }

    // Set new access first, then mark recovered (so a partial failure
    // doesn't surface the atom without an access row).
    if (newAccessMode === 'org-default') {
      // Just drop any existing atomAccess row.
      const existing = await ctx.db
        .query('atomAccess')
        .withIndex('by_atom', (q) => q.eq('atomId', atomId))
        .unique()
      if (existing) await ctx.db.delete(existing._id)
    } else {
      if (!newOwnerUserId) {
        throw new Error('newOwnerUserId required for private/restricted recovery.')
      }
      const allowed = newAllowedUserIds ?? []
      if (newAccessMode === 'private' && allowed.length > 0) {
        throw new Error(
          'private mode must have an empty allowedUserIds — use restricted for a list.',
        )
      }
      const existing = await ctx.db
        .query('atomAccess')
        .withIndex('by_atom', (q) => q.eq('atomId', atomId))
        .unique()
      const now = Date.now()
      if (existing) {
        await ctx.db.patch(existing._id, {
          mode: newAccessMode,
          ownerUserId: newOwnerUserId,
          allowedUserIds: allowed,
          setAt: now,
          setByUserId: ownerSubject,
        })
      } else {
        await ctx.db.insert('atomAccess', {
          atomId,
          mode: newAccessMode,
          ownerUserId: newOwnerUserId,
          allowedUserIds: allowed,
          setAt: now,
          setByUserId: ownerSubject,
        })
      }
    }

    await ctx.db.patch(tomb._id, {
      recoveredAt: Date.now(),
      recoveredByOwnerUserId: ownerSubject,
    })
    return { ok: true as const }
  },
})

/** Read the access state of an atom (for the per-atom Share dialog).
 *  Returns null if the atom has no row (org-default) or the caller
 *  isn't allowed to see it. */
export const getAtomAccess = query({
  args: {
    atomId: v.id('atoms'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { atomId, activeWorkspaceId },
  ): Promise<{
    mode: 'org-default' | 'private' | 'restricted'
    ownerUserId: string | null
    allowedUserIds: string[]
  } | null> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null
    const subject = identity.subject

    // Gate the read on resolveAtomAccess: non-allowed callers see null
    // (consistent with the read-path filtering principle).
    const access = await resolveAtomAccess(ctx, atomId, subject)
    if (!access.allowed) return null

    const row = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q) => q.eq('atomId', atomId))
      .unique()
    if (!row) {
      return { mode: 'org-default', ownerUserId: null, allowedUserIds: [] }
    }
    // Defensive: the row's workspaceId should match the active one.
    const atom = await ctx.db.get(atomId)
    if (atom?.workspaceId !== workspaceId) return null
    return {
      mode: row.mode,
      ownerUserId: row.ownerUserId,
      allowedUserIds: row.allowedUserIds,
    }
  },
})

/** UI helper: resolve an atom's access by its rename-proof fileId.
 *  The Share dialog has a fileId in hand (not the Convex row id),
 *  so it doesn't need to lift atomId out of a list query before
 *  calling getAtomAccess. Mirrors the read gate of getAtomAccess. */
export const getAtomAccessByFileId = query({
  args: {
    fileId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { fileId, activeWorkspaceId },
  ): Promise<{
    mode: 'org-default' | 'private' | 'restricted'
    ownerUserId: string | null
    allowedUserIds: string[]
  } | null> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null

    // fileId → bound atomIds row → atom._id. Same chain as
    // htmlAtoms.getRenderable, with the same .take(2) defense.
    const idRows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) =>
        q.eq('workspaceId', workspaceId).eq('fileId', fileId),
      )
      .take(2)
    if (idRows.length !== 1) return null
    const idRow = idRows[0]
    if (idRow.state !== 'bound' || idRow.path === null) return null
    const atom = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', idRow.path as string),
      )
      .unique()
    if (!atom) return null

    // Same access-gated read as getAtomAccess — non-allowed callers
    // see null (the dialog won't render its access section in that
    // case, which is the right UX: you can't manage what you can't
    // see).
    const access = await resolveAtomAccess(ctx, atom._id, identity.subject)
    if (!access.allowed) return null

    const row = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q) => q.eq('atomId', atom._id))
      .unique()
    if (!row) {
      return { mode: 'org-default', ownerUserId: null, allowedUserIds: [] }
    }
    return {
      mode: row.mode,
      ownerUserId: row.ownerUserId,
      allowedUserIds: row.allowedUserIds,
    }
  },
})

/** UI helper: set access by fileId — thin wrapper that resolves
 *  fileId → atomId and forwards to setAtomAccess. The auth /
 *  owner / private-empty-allowlist checks all live in
 *  setAtomAccess; this just spares the dialog a two-step. */
export const setAtomAccessByFileId = mutation({
  args: {
    fileId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
    mode: v.union(v.literal('private'), v.literal('restricted'), v.null()),
    allowedUserIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { fileId, activeWorkspaceId, mode, allowedUserIds },
  ) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const idRows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) =>
        q.eq('workspaceId', workspaceId).eq('fileId', fileId),
      )
      .take(2)
    if (idRows.length !== 1) throw new Error('File not found.')
    const idRow = idRows[0]
    if (idRow.state !== 'bound' || idRow.path === null) {
      throw new Error('File not found.')
    }
    const atom = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', idRow.path as string),
      )
      .unique()
    if (!atom) throw new Error('File not found.')

    // Re-run the same access + owner checks setAtomAccess does, by
    // calling the same code path. Authoritative source of truth is
    // setAtomAccess — this wrapper only resolves the atomId.
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject
    const existing = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q) => q.eq('atomId', atom._id))
      .unique()
    if (existing && existing.ownerUserId !== subject) {
      throw new Error(
        "Only the current access owner can change this atom's access.",
      )
    }
    if (mode === null) {
      if (existing) await ctx.db.delete(existing._id)
      return { ok: true as const, cleared: true }
    }
    const allowed = allowedUserIds ?? []
    if (mode === 'private' && allowed.length > 0) {
      throw new Error(
        'private mode must have an empty allowedUserIds — use restricted for a list.',
      )
    }
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    } else {
      await ctx.db.insert('atomAccess', {
        atomId: atom._id,
        mode,
        ownerUserId: subject,
        allowedUserIds: allowed,
        setAt: now,
        setByUserId: subject,
      })
    }
    return { ok: true as const, cleared: false }
  },
})

/** UI helper: list every atom in the active workspace that carries a
 *  per-atom access override (private/restricted), keyed by fileId.
 *  The file tree consumes this to render lock icons. Org-default
 *  atoms are intentionally omitted — there's no row for them and
 *  the tree treats absence as "no badge needed."
 *
 *  Returns the FULL set within the workspace (the tree wants to
 *  badge every visible row). The set is bounded by #atoms with
 *  overrides — small in practice (most atoms are org-default).
 *
 *  CRITICALLY: the response only includes atoms the caller can READ.
 *  We don't return a private atom owned by a teammate even with
 *  just its mode — that'd be an existence oracle. The tree won't
 *  show that atom either (atoms.list already filters via canReadAtom
 *  from 253a386), so the lack of a badge for unreadable atoms
 *  doesn't matter — they don't appear in the tree at all. */
export const listAccessStates = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (
    ctx,
    { activeWorkspaceId },
  ): Promise<
    Array<{ fileId: string; mode: 'private' | 'restricted'; ownerUserId: string }>
  > => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return []
    const subject = identity.subject

    // Collect every atomAccess row, then per-row: fetch the atom,
    // confirm same workspace + readable to viewer, then resolve its
    // bound fileId via atomIds index.
    const accessRows = await ctx.db.query('atomAccess').collect()
    const out: Array<{
      fileId: string
      mode: 'private' | 'restricted'
      ownerUserId: string
    }> = []
    for (const row of accessRows) {
      const atom = await ctx.db.get(row.atomId)
      if (!atom || atom.workspaceId !== workspaceId) continue
      if (!(await canReadAtom(ctx, row.atomId, subject))) continue
      // Resolve bound fileId for this atom's current path.
      const idRow = await ctx.db
        .query('atomIds')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', workspaceId).eq('path', atom.path),
        )
        .unique()
      if (!idRow || idRow.state !== 'bound') continue
      out.push({
        fileId: idRow.fileId,
        mode: row.mode,
        ownerUserId: row.ownerUserId,
      })
    }
    return out
  },
})

// ── Internal helpers used by other phases (e.g. P1 cascade tombstone) ──

/** Internal: tombstone all private atoms owned by a departing member.
 *  Called from `removeMember` / `leaveOrg` mutations in `orgs.ts`
 *  (wire in a follow-up commit — this commit lands the helper but
 *  doesn't fire it from existing mutations yet so the foundation can
 *  land cleanly without behavior change to existing tests). */
export const _tombstonePrivateAtomsForDepartingMember = internalMutation({
  args: { workspaceId: v.string(), departingSubject: v.string() },
  handler: async (ctx, { workspaceId, departingSubject }) => {
    // Find every atomAccess row in this workspace owned by the departing
    // subject (private OR restricted with departing as owner).
    const accessRows = await ctx.db.query('atomAccess').collect()
    let tombstoned = 0
    for (const row of accessRows) {
      if (row.ownerUserId !== departingSubject) continue
      const atom = await ctx.db.get(row.atomId)
      if (!atom) continue
      if (atom.workspaceId !== workspaceId) continue
      // Skip if a tombstone already exists.
      const existingTomb = await ctx.db
        .query('atomTombstones')
        .withIndex('by_atom', (q) => q.eq('atomId', row.atomId))
        .unique()
      if (existingTomb) continue
      await ctx.db.insert('atomTombstones', {
        atomId: row.atomId,
        workspaceId,
        reason: 'member-departed',
        tombstonedAt: Date.now(),
        originalOwnerUserId: departingSubject,
      })
      tombstoned++
    }
    return { tombstoned }
  },
})

/** Internal: list tombstoned atoms in a workspace (for the Owner
 *  recovery admin UI). */
export const _listTombstonedAtoms = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const rows = await ctx.db
      .query('atomTombstones')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    return rows.filter((r) => !r.recoveredAt)
  },
})
