// sharing-v1 (Track-5 1a) — file-level cross-workspace sharing.
//
// SECURITY MODEL (reviewed by codex + 2 subagents before build):
//   - The canonical atom NEVER leaves the owner's workspace. An
//     `atomShares` row grants a viewer access, addressed by the
//     owner's rename-proof `fileId`.
//   - `resolveShareAccess` is the ONE door: every shared read/render/
//     write resolves through it; it re-verifies the caller is part of
//     the grant audience. Absence / wrong viewer ⇒ DENY (mirrors
//     resolveWindow). Public-link shares still require a signed-in
//     viewer; they do not expose anonymous internet reads.
//   - The owner's OWN functions (atoms.list/getByPath/upsert/…) stay
//     workspace-scoped and UNTOUCHED. This is a PARALLEL, gated read
//     path — not a widening of those queries (which would risk the
//     move/rename cascade reaching another user's atoms).
//   - Cross-workspace addressing uses the share row `_id` (shareId),
//     never a bare fileId (owner's `clients.acme` and the viewer's
//     own `clients.acme` are the same string in different namespaces).
import { v } from 'convex/values'
import { query, mutation } from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { normalizeEmail, requireWorkspace } from './auth'
import { extractFrontmatterId, deriveTitle } from './atomId'
import { isMember } from './orgs'
import { scheduleHocuspocusDisconnect } from './hocuspocusAdmin'

export type AccessContext = {
  viewerWorkspaceId: string
  viewerUserId: string
  ownerWorkspaceId: string
  fileId: string
  permission: 'view' | 'edit'
  shareId: Id<'atomShares'>
  /** every fileId the owner has shared with THIS viewer — the only
   *  set a shared atom's formulas may resolve over (no whole-desk
   *  scan ⇒ no cross-workspace exfil). */
  sharedFileIds: Set<string>
}

// THE access boundary. Returns null on any failure (absence ⇒ DENY).
export async function resolveShareAccess(
  ctx: QueryCtx | MutationCtx,
  shareId: Id<'atomShares'>,
  activeWorkspaceId?: string,
): Promise<AccessContext | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  const viewer = await requireWorkspace(ctx, activeWorkspaceId)
  const viewerUserId = identity.subject
  const row = await ctx.db.get(shareId)
  if (!row) return null
  // The dependency set (for scoped formula resolution) = the cells
  // THIS owner shared via the SAME audience as this grant — never
  // the owner's private vault. Computed per audience below.
  let sharedFileIds: Set<string>
  if (row.publicAccess === true) {
    // ── public-link share — any signed-in viewer with the shareId may
    // read it. Formula scope is still limited to this owner's public
    // shares, never the whole owner workspace.
    const grants = await ctx.db
      .query('atomShares')
      .withIndex('by_owner_fileId', (q) =>
        q.eq('ownerWorkspaceId', row.ownerWorkspaceId),
      )
      .collect()
    sharedFileIds = new Set(
      grants.filter((g) => g.publicAccess === true).map((g) => g.fileId),
    )
  } else if (row.granteeWorkspaceId) {
    // ── person-to-person share — caller must BE the grantee.
    if (row.granteeWorkspaceId !== viewer) return null
    // Legacy direct person-shares have no granteeUserId and are scoped
    // to the recipient's personal workspace only. Workspace-wide org
    // sharing must use `granteeOrgId` via shareAtomToOrg.
    if (!row.granteeUserId && viewer !== viewerUserId) return null
    if (row.granteeUserId && row.granteeUserId !== viewerUserId) return null
    const grants = await ctx.db
      .query('atomShares')
      .withIndex('by_grantee', (q) =>
        q.eq('granteeWorkspaceId', viewer),
      )
      .collect()
    sharedFileIds = new Set(
      grants
        .filter(
          (g) =>
            g.ownerWorkspaceId === row.ownerWorkspaceId &&
            (g.granteeUserId ?? null) === (row.granteeUserId ?? null),
        )
        .map((g) => g.fileId),
    )
  } else if (row.granteeOrgId) {
    // ── workspace share — caller must be a MEMBER of that workspace.
    if (!(await isMember(ctx, row.granteeOrgId, viewer))) return null
    const grants = await ctx.db
      .query('atomShares')
      .withIndex('by_org', (q) => q.eq('granteeOrgId', row.granteeOrgId))
      .collect()
    sharedFileIds = new Set(
      grants
        .filter((g) => g.ownerWorkspaceId === row.ownerWorkspaceId)
        .map((g) => g.fileId),
    )
  } else {
    return null // malformed grant (no audience)
  }
  return {
    viewerWorkspaceId: viewer,
    viewerUserId,
    ownerWorkspaceId: row.ownerWorkspaceId,
    fileId: row.fileId,
    permission: row.permission,
    shareId,
    sharedFileIds,
  }
}

// Resolve an owner's atom by its rename-proof fileId (via the
// atomIds index → current path → atom). STRICT: returns null unless
// the resolved atom's body STILL carries that fileId — the index is
// a derived cache, so a stale binding (path whose body now has a
// different id) must never serve the wrong atom. refuse-on-missing,
// never guess. (Codex 1a review P2 — strict by default so
// listSharedWithMe + shareAtom can't be fooled by a stale index.)
export async function ownerAtomByFileId(
  ctx: QueryCtx | MutationCtx,
  ownerWorkspaceId: string,
  fileId: string,
) {
  const idRows = await ctx.db
    .query('atomIds')
    .withIndex('by_workspace_fileId', (q) =>
      q.eq('workspaceId', ownerWorkspaceId).eq('fileId', fileId),
    )
    .collect()
  const bound = idRows.find((r) => r.state === 'bound' && r.path)
  if (!bound || !bound.path) return null
  const atom = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', ownerWorkspaceId).eq('path', bound.path as string),
    )
    .first()
  if (!atom) return null
  if (extractFrontmatterId(atom.body) !== fileId) return null // stale index
  return atom
}

async function userProfileByWorkspaceId(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
) {
  return await ctx.db
    .query('userProfiles')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .first()
}

async function addressRouteByEmail(ctx: QueryCtx | MutationCtx, email: string) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Enter an email address.')
  }
  const route = await ctx.db
    .query('workspaceAddressRoutes')
    .withIndex('by_normalizedEmail', (q) =>
      q.eq('normalizedEmail', normalizedEmail),
    )
    .first()
  return route?.status === 'verified' ? route : null
}

async function upsertPendingShareByEmail(
  ctx: MutationCtx,
  {
    owner,
    fileId,
    email,
    permission,
  }: {
    owner: string
    fileId: string
    email: string
    permission: 'view' | 'edit'
  },
) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Enter an email address.')
  }
  const mine = await ownerAtomByFileId(ctx, owner, fileId)
  if (!mine) {
    throw new Error(`You don't own a file with id "${fileId}".`)
  }
  const now = Date.now()
  const existing = await ctx.db
    .query('pendingAtomShares')
    .withIndex('by_owner_fileId_email_status', (q) =>
      q
        .eq('ownerWorkspaceId', owner)
        .eq('fileId', fileId)
        .eq('normalizedEmail', normalizedEmail)
        .eq('status', 'pending'),
    )
    .first()
  if (existing) {
    if (
      existing.permission !== permission ||
      existing.email !== normalizedEmail
    ) {
      await ctx.db.patch(existing._id, {
        email: normalizedEmail,
        permission,
        updatedAt: now,
      })
    }
    return existing._id
  }
  return await ctx.db.insert('pendingAtomShares', {
    ownerWorkspaceId: owner,
    fileId,
    email: normalizedEmail,
    normalizedEmail,
    permission,
    status: 'pending',
    createdBy: owner,
    createdAt: now,
    updatedAt: now,
  })
}

async function shareAtomWithWorkspace(
  ctx: MutationCtx,
  {
    owner,
    fileId,
    granteeWorkspaceId,
    granteeUserId,
    permission,
  }: {
    owner: string
    fileId: string
    granteeWorkspaceId: string
    granteeUserId?: string
    permission: 'view' | 'edit'
  },
): Promise<Id<'atomShares'>> {
  if (
    granteeWorkspaceId === owner &&
    (!granteeUserId || granteeUserId === owner)
  ) {
    throw new Error('Cannot share a file with yourself.')
  }
  // The caller must actually OWN the fileId (a bound index row).
  const mine = await ownerAtomByFileId(ctx, owner, fileId)
  if (!mine) {
    throw new Error(`You don't own a file with id "${fileId}".`)
  }
  const existing = granteeUserId
    ? await ctx.db
        .query('atomShares')
        .withIndex('by_owner_grantee_user_fileId', (q) =>
          q
            .eq('ownerWorkspaceId', owner)
            .eq('granteeWorkspaceId', granteeWorkspaceId)
            .eq('granteeUserId', granteeUserId)
            .eq('fileId', fileId),
        )
        .first()
    : await ctx.db
        .query('atomShares')
        .withIndex('by_owner_grantee_fileId', (q) =>
          q
            .eq('ownerWorkspaceId', owner)
            .eq('granteeWorkspaceId', granteeWorkspaceId)
            .eq('fileId', fileId),
        )
        .first()
  if (existing) {
    if (existing.permission !== permission) {
      await ctx.db.patch(existing._id, { permission })
    }
    return existing._id
  }
  return await ctx.db.insert('atomShares', {
    ownerWorkspaceId: owner,
    fileId,
    granteeWorkspaceId,
    ...(granteeUserId ? { granteeUserId } : {}),
    permission,
    createdBy: owner,
    createdAt: Date.now(),
  })
}

async function scheduleShareAudienceDisconnect(
  ctx: MutationCtx,
  row: {
    ownerWorkspaceId: string
    granteeWorkspaceId?: string
    granteeUserId?: string
    granteeOrgId?: string
    publicAccess?: boolean
  },
): Promise<void> {
  if (row.granteeWorkspaceId) {
    await scheduleHocuspocusDisconnect(ctx, {
      workspaceId: row.ownerWorkspaceId,
      userId: row.granteeUserId ?? row.granteeWorkspaceId,
    })
    return
  }

  if (row.publicAccess === true) return

  const granteeOrgId = row.granteeOrgId
  if (!granteeOrgId) return
  const members = await ctx.db
    .query('memberships')
    .withIndex('by_org', (q) => q.eq('orgId', granteeOrgId))
    .collect()
  for (const member of members) {
    if (member.workspaceId === row.ownerWorkspaceId) continue
    await scheduleHocuspocusDisconnect(ctx, {
      workspaceId: row.ownerWorkspaceId,
      userId: member.workspaceId,
    })
  }
}

// ── Owner: share / revoke ───────────────────────────────────────────
// Share one of MY files (by fileId) with another workspace. Only the
// owner of the fileId may share it; grantee must differ from owner;
// idempotent per (owner, grantee, fileId) — re-share updates the
// permission instead of duplicating.
export const shareAtom = mutation({
  args: {
    fileId: v.string(),
    granteeWorkspaceId: v.string(),
    permission: v.union(v.literal('view'), v.literal('edit')),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { fileId, granteeWorkspaceId, permission, activeWorkspaceId },
  ) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    return await shareAtomWithWorkspace(ctx, {
      owner,
      fileId,
      granteeWorkspaceId,
      permission,
    })
  },
})

export const shareAtomByEmail = mutation({
  args: {
    fileId: v.string(),
    email: v.string(),
    permission: v.union(v.literal('view'), v.literal('edit')),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, email, permission, activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Enter an email address.')
    }
    const route = await addressRouteByEmail(ctx, normalizedEmail)
    if (route) {
      const shareId = await shareAtomWithWorkspace(ctx, {
        owner,
        fileId,
        granteeWorkspaceId: route.targetWorkspaceId,
        granteeUserId: route.accountWorkspaceId,
        permission,
      })
      return {
        kind: 'share' as const,
        shareId,
        granteeWorkspaceId: route.targetWorkspaceId,
        granteeUserId: route.accountWorkspaceId,
        email: route.email,
        permission,
      }
    }

    const pendingShareId = await upsertPendingShareByEmail(ctx, {
      owner,
      fileId,
      email: normalizedEmail,
      permission,
    })
    return {
      kind: 'pending' as const,
      pendingShareId,
      email: normalizedEmail,
      permission,
    }
  },
})

// sharing-v1 1c — share one of MY files with a whole ORG/"company".
// Caller must own the fileId AND be a member of the org. Every member
// of that org can then read it (the company graph). Idempotent per
// (owner, org, fileId).
export const shareAtomToOrg = mutation({
  args: {
    fileId: v.string(),
    orgId: v.id('orgs'),
    permission: v.union(v.literal('view'), v.literal('edit')),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, orgId, permission, activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    if (!(await isMember(ctx, orgId, owner))) {
      throw new Error('You are not a member of that workspace.')
    }
    const mine = await ownerAtomByFileId(ctx, owner, fileId)
    if (!mine) throw new Error(`You don't own a file with id "${fileId}".`)
    const existing = await ctx.db
      .query('atomShares')
      .withIndex('by_owner_org_fileId', (q) =>
        q
          .eq('ownerWorkspaceId', owner)
          .eq('granteeOrgId', orgId)
          .eq('fileId', fileId),
      )
      .first()
    if (existing) {
      if (existing.permission !== permission) {
        await ctx.db.patch(existing._id, { permission })
      }
      return existing._id
    }
    return await ctx.db.insert('atomShares', {
      ownerWorkspaceId: owner,
      fileId,
      granteeOrgId: orgId,
      permission,
      createdBy: owner,
      createdAt: Date.now(),
    })
  },
})

// Share one of MY files as an "Anyone with the link" grant. The link
// is still a shareId, and readers must be signed in, but no specific
// workspace/person membership is required once they have the link.
export const shareAtomPublic = mutation({
  args: {
    fileId: v.string(),
    permission: v.union(v.literal('view'), v.literal('edit')),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, permission, activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const mine = await ownerAtomByFileId(ctx, owner, fileId)
    if (!mine) throw new Error(`You don't own a file with id "${fileId}".`)
    const existing = (
      await ctx.db
        .query('atomShares')
        .withIndex('by_owner_fileId', (q) =>
          q.eq('ownerWorkspaceId', owner).eq('fileId', fileId),
        )
        .collect()
    ).find((row) => row.publicAccess === true)
    if (existing) {
      if (existing.permission !== permission) {
        await ctx.db.patch(existing._id, { permission })
      }
      return existing._id
    }
    return await ctx.db.insert('atomShares', {
      ownerWorkspaceId: owner,
      fileId,
      publicAccess: true,
      permission,
      createdBy: owner,
      createdAt: Date.now(),
    })
  },
})

// Revoke a share. Only the OWNER may revoke. Revoke-to-exhaustion:
// delete the row by id (one row per shareId). Works for person- and
// org-shares alike (the row _id is the share handle either way).
export const unshareAtom = mutation({
  args: {
    shareId: v.id('atomShares'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { shareId, activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const row = await ctx.db.get(shareId)
    if (!row) return { ok: true as const } // already gone — idempotent
    if (row.ownerWorkspaceId !== owner) {
      throw new Error('Only the owner can revoke a share.')
    }
    await scheduleShareAudienceDisconnect(ctx, row)
    await ctx.db.delete(shareId)
    return { ok: true as const }
  },
})

// Cascade helper (called by removeAtomImpl on owner delete): drop
// every grant for (owner, fileId). On restore we do NOT re-create
// them — a re-share is required (so deleting a file genuinely
// revokes access).
export async function cascadeDeleteSharesForFileId(
  ctx: MutationCtx,
  ownerWorkspaceId: string,
  fileId: string,
): Promise<void> {
  const rows = await ctx.db
    .query('atomShares')
    .withIndex('by_owner_fileId', (q) =>
      q.eq('ownerWorkspaceId', ownerWorkspaceId).eq('fileId', fileId),
    )
    .collect()
  for (const r of rows) {
    await scheduleShareAudienceDisconnect(ctx, r)
    await ctx.db.delete(r._id)
  }
}

export const listPendingSharesForCurrentEmail = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const normalizedEmail = normalizeEmail(identity.email ?? '')
    if (!normalizedEmail || !normalizedEmail.includes('@')) return []
    const rows = await ctx.db
      .query('pendingAtomShares')
      .withIndex('by_normalizedEmail_status', (q) =>
        q.eq('normalizedEmail', normalizedEmail).eq('status', 'pending'),
      )
      .collect()
    const out: Array<{
      pendingShareId: Id<'pendingAtomShares'>
      ownerWorkspaceId: string
      fileId: string
      email: string
      path: string
      title: string | null
      permission: 'view' | 'edit'
      available: boolean
      createdAt: number
    }> = []
    for (const row of rows) {
      const atom = await ownerAtomByFileId(ctx, row.ownerWorkspaceId, row.fileId)
      out.push({
        pendingShareId: row._id,
        ownerWorkspaceId: row.ownerWorkspaceId,
        fileId: row.fileId,
        email: row.email,
        path: atom?.path ?? row.fileId,
        title: atom ? deriveTitle(atom.body, atom.path) : null,
        permission: row.permission,
        available: atom !== null,
        createdAt: row.createdAt,
      })
    }
    return out
  },
})

export const listMyPendingShares = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const rows = await ctx.db
      .query('pendingAtomShares')
      .withIndex('by_owner_fileId', (q) => q.eq('ownerWorkspaceId', owner))
      .collect()
    return rows
      .filter((row) => row.status === 'pending')
      .map((row) => ({
        pendingShareId: row._id,
        fileId: row.fileId,
        email: row.email,
        permission: row.permission,
        createdAt: row.createdAt,
      }))
  },
})

export const acceptPendingShare = mutation({
  args: {
    pendingShareId: v.id('pendingAtomShares'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { pendingShareId, activeWorkspaceId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const normalizedEmail = normalizeEmail(identity.email ?? '')
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Sign in with the email this share was sent to.')
    }

    const row = await ctx.db.get(pendingShareId)
    if (!row || row.status !== 'pending') {
      throw new Error('This pending share is no longer available.')
    }
    if (row.normalizedEmail !== normalizedEmail) {
      throw new Error('Sign in with the email this share was sent to.')
    }

    const targetWorkspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const shareId = await shareAtomWithWorkspace(ctx, {
      owner: row.ownerWorkspaceId,
      fileId: row.fileId,
      granteeWorkspaceId: targetWorkspaceId,
      granteeUserId: identity.subject,
      permission: row.permission,
    })
    await ctx.db.patch(row._id, {
      status: 'accepted',
      acceptedByWorkspaceId: targetWorkspaceId,
      acceptedByUserId: identity.subject,
      acceptedShareId: shareId,
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    })
    return {
      kind: 'share' as const,
      shareId,
      pendingShareId,
      granteeWorkspaceId: targetWorkspaceId,
      granteeUserId: identity.subject,
      email: row.email,
      permission: row.permission,
    }
  },
})

// ── Viewer: what's shared with me ───────────────────────────────────
// SEPARATE from atoms.list (never widen that query). Returns metadata
// for each file shared TO the caller, resolving each owner atom's
// current path + display title through the gated path.
export const listSharedWithMe = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const viewer = await requireWorkspace(ctx, activeWorkspaceId)
    const grants = (await ctx.db
      .query('atomShares')
      .withIndex('by_grantee', (q) => q.eq('granteeWorkspaceId', viewer))
      .collect()).filter(
      (g) =>
        g.granteeUserId === identity.subject ||
        (!g.granteeUserId && viewer === identity.subject),
    )
    const out: Array<{
      shareId: Id<'atomShares'>
      ownerWorkspaceId: string
      fileId: string
      path: string
      title: string | null
      permission: 'view' | 'edit'
      available: boolean
      granteeUserId: string | null
    }> = []
    for (const g of grants) {
      const atom = await ownerAtomByFileId(ctx, g.ownerWorkspaceId, g.fileId)
      out.push({
        shareId: g._id,
        ownerWorkspaceId: g.ownerWorkspaceId,
        fileId: g.fileId,
        path: atom?.path ?? g.fileId,
        title: atom ? deriveTitle(atom.body, atom.path) : null,
        permission: g.permission,
        available: atom !== null, // owner may have deleted/renamed-away
        granteeUserId: g.granteeUserId ?? null,
      })
    }
    return out
  },
})

// What I have shared (owner's manage/revoke view).
export const listMyShares = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const rows = await ctx.db
      .query('atomShares')
      .withIndex('by_owner_fileId', (q) => q.eq('ownerWorkspaceId', owner))
      .collect()
    const out = []
    for (const r of rows) {
      const profileWorkspaceId = r.granteeUserId ?? r.granteeWorkspaceId
      const profile = profileWorkspaceId
        ? await userProfileByWorkspaceId(ctx, profileWorkspaceId)
        : null
      out.push({
        shareId: r._id,
        fileId: r.fileId,
        // exactly one is set — the owner's manage view labels the
        // audience (person vs workspace vs public link) from these.
        granteeWorkspaceId: r.granteeWorkspaceId ?? null,
        granteeUserId: r.granteeUserId ?? null,
        granteeEmail: profile?.email ?? null,
        granteeName: profile?.name ?? null,
        granteeOrgId: r.granteeOrgId ?? null,
        publicAccess: r.publicAccess === true,
        permission: r.permission,
        createdAt: r.createdAt,
      })
    }
    return out
  },
})

// Lightweight owner projection for persistent UI chrome. The Share dialog
// needs audience labels; the sidebar only needs to know whether a file has
// at least one active grant.
export const listSharedFileIds = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const owner = await requireWorkspace(ctx, activeWorkspaceId)
    const rows = await ctx.db
      .query('atomShares')
      .withIndex('by_owner_fileId', (q) => q.eq('ownerWorkspaceId', owner))
      .collect()
    return [...new Set(rows.map((r) => r.fileId))].sort()
  },
})

// Read a shared atom's RAW body (the editor resolves formulas
// separately via evalFormulasShared, which is scoped). Gated.
export const getSharedAtom = query({
  args: {
    shareId: v.id('atomShares'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { shareId, activeWorkspaceId }) => {
    const access = await resolveShareAccess(ctx, shareId, activeWorkspaceId)
    if (!access) return null
    const atom = await ownerAtomByFileId(
      ctx,
      access.ownerWorkspaceId,
      access.fileId,
    )
    if (!atom) return null // refuse-on-missing
    // Defensive id-match (mirror htmlAtoms): the resolved atom's body
    // must still carry the granted fileId.
    if (extractFrontmatterId(atom.body) !== access.fileId) return null
    return {
      shareId,
      ownerWorkspaceId: access.ownerWorkspaceId,
      fileId: access.fileId,
      path: atom.path,
      body: atom.body,
      permission: access.permission,
      updatedAt: atom.updatedAt,
    }
  },
})
