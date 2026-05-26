import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { ownerAtomByFileId } from './atomShares'
import { extractFrontmatterId } from './atomId'
import { isMember } from './orgs'

const WORKSPACE_AUTHZ_VERSION = 1

type AtomAccessResult = {
  workspaceAuthzVersion: number
  canRead: boolean
  canWrite: boolean
}

type AtomBootstrapResult = {
  markdown: string
}

type BodyCacheProjectionResult =
  | { ok: true }
  | { ok: false; reason: 'missing-atom' | 'frontmatter-id-mismatch' }

type AtomCreateResult =
  | { ok: true; atomId: string; markdown: string }
  | {
      ok: false
      reason:
        | 'already-exists'
        | 'forbidden'
        | 'stale-authz'
        | 'missing-frontmatter-id'
    }

type ActorKind = 'user' | 'agent'

function deny(): AtomAccessResult {
  return {
    workspaceAuthzVersion: WORKSPACE_AUTHZ_VERSION,
    canRead: false,
    canWrite: false,
  }
}

function requireServerToken(serverToken: string): void {
  const expected = process.env.HOCUSPOCUS_CONVEX_SERVER_TOKEN
  if (!expected) {
    throw new Error('HOCUSPOCUS_CONVEX_SERVER_TOKEN is required')
  }
  if (serverToken !== expected) {
    throw new Error('Invalid Hocuspocus server token')
  }
}

function mergeGrant(
  current: { canRead: boolean; canWrite: boolean },
  permission: 'view' | 'edit',
  atom: { systemLocked?: boolean; userLocked?: boolean },
): { canRead: boolean; canWrite: boolean } {
  return {
    canRead: true,
    canWrite:
      current.canWrite ||
      (permission === 'edit' &&
        atom.systemLocked !== true &&
        atom.userLocked !== true),
  }
}

function canOwnerWrite(
  atom: { systemLocked?: boolean; userLocked?: boolean },
  actorKind: ActorKind,
): boolean {
  if (atom.systemLocked === true) return false
  if (actorKind === 'agent' && atom.userLocked === true) return false
  return true
}

async function computeAtomAccess(
  ctx: QueryCtx,
  {
    userId,
    workspaceId,
    atomId,
    actorKind,
    authzVersion,
  }: {
    userId: string
    workspaceId: string
    atomId: string
    actorKind: ActorKind
    authzVersion: number
  },
): Promise<AtomAccessResult> {
  if (authzVersion !== WORKSPACE_AUTHZ_VERSION) {
    return deny()
  }

  const atom = await ownerAtomByFileId(ctx, workspaceId, atomId)
  if (!atom) return deny()

  if (userId === workspaceId) {
    return {
      workspaceAuthzVersion: WORKSPACE_AUTHZ_VERSION,
      canRead: true,
      canWrite: canOwnerWrite(atom, actorKind),
    }
  }

  let access = { canRead: false, canWrite: false }
  const personGrant = await ctx.db
    .query('atomShares')
    .withIndex('by_owner_grantee_fileId', (q) =>
      q
        .eq('ownerWorkspaceId', workspaceId)
        .eq('granteeWorkspaceId', userId)
        .eq('fileId', atomId),
    )
    .first()
  if (personGrant) {
    access = mergeGrant(access, personGrant.permission, atom)
  }

  const ownerGrants = await ctx.db
    .query('atomShares')
    .withIndex('by_owner_fileId', (q) =>
      q.eq('ownerWorkspaceId', workspaceId).eq('fileId', atomId),
    )
    .collect()
  for (const grant of ownerGrants) {
    if (!grant.granteeOrgId) continue
    if (await isMember(ctx, grant.granteeOrgId, userId)) {
      access = mergeGrant(access, grant.permission, atom)
    }
  }

  return {
    workspaceAuthzVersion: WORKSPACE_AUTHZ_VERSION,
    canRead: access.canRead,
    canWrite: access.canWrite,
  }
}

export const checkAtomAccess = query({
  args: {
    serverToken: v.string(),
    userId: v.string(),
    workspaceId: v.string(),
    atomId: v.string(),
    actorKind: v.union(v.literal('user'), v.literal('agent')),
    authzVersion: v.number(),
  },
  handler: async (
    ctx,
    { serverToken, userId, workspaceId, atomId, actorKind, authzVersion },
  ): Promise<AtomAccessResult> => {
    requireServerToken(serverToken)
    return computeAtomAccess(ctx, {
      userId,
      workspaceId,
      atomId,
      actorKind,
      authzVersion,
    })
  },
})

export const loadAtomBootstrap = query({
  args: {
    serverToken: v.string(),
    workspaceId: v.string(),
    userId: v.string(),
    atomId: v.string(),
    actorKind: v.union(v.literal('user'), v.literal('agent')),
    authzVersion: v.number(),
  },
  handler: async (
    ctx,
    { serverToken, workspaceId, userId, atomId, actorKind, authzVersion },
  ): Promise<AtomBootstrapResult | null> => {
    requireServerToken(serverToken)

    const access = await computeAtomAccess(ctx, {
      userId,
      workspaceId,
      atomId,
      actorKind,
      authzVersion,
    })
    if (!access.canRead) return null

    const atom = await ownerAtomByFileId(ctx, workspaceId, atomId)
    if (!atom) return null

    return { markdown: atom.body }
  },
})

export const setBodyCache = mutation({
  args: {
    serverToken: v.string(),
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
      serverToken,
      workspaceId,
      atomId,
      markdown,
      projectionHash,
      schemaVersion,
      ydocStateVector,
      lastEditedByUserId,
      projectedAt,
    },
  ): Promise<BodyCacheProjectionResult> => {
    requireServerToken(serverToken)

    return await ctx.runMutation(internal.atoms._setBodyCache, {
      workspaceId,
      atomId,
      markdown,
      projectionHash,
      schemaVersion,
      ydocStateVector,
      lastEditedByUserId,
      projectedAt,
    })
  },
})

export const createAtom = mutation({
  args: {
    serverToken: v.string(),
    workspaceId: v.string(),
    path: v.string(),
    content: v.string(),
    userId: v.string(),
    actorKind: v.union(v.literal('user'), v.literal('agent')),
    authzVersion: v.number(),
  },
  handler: async (
    ctx,
    {
      serverToken,
      workspaceId,
      path,
      content,
      userId,
      actorKind,
      authzVersion,
    },
  ): Promise<AtomCreateResult> => {
    requireServerToken(serverToken)
    if (authzVersion !== WORKSPACE_AUTHZ_VERSION) {
      return { ok: false, reason: 'stale-authz' }
    }

    const existing = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (existing) {
      return { ok: false, reason: 'already-exists' }
    }

    let id: Id<'atoms'>
    try {
      id = (await ctx.runMutation(internal.atoms._upsertInternal, {
        workspaceId,
        path,
        body: content,
        source: actorKind === 'agent' ? 'agent' : 'user',
        viewerSubject: userId,
      })) as Id<'atoms'>
    } catch (error) {
      if (/access to write/.test((error as Error).message)) {
        return { ok: false, reason: 'forbidden' }
      }
      throw error
    }

    const atom = await ctx.db.get(id)
    const atomId = atom ? extractFrontmatterId(atom.body) : null
    if (!atom || !atomId) {
      return { ok: false, reason: 'missing-frontmatter-id' }
    }
    return { ok: true, atomId, markdown: atom.body }
  },
})
