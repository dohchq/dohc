import { v } from 'convex/values'
import { query } from './_generated/server'
import { ownerAtomByFileId } from './atomShares'
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
  },
})

export const loadAtomBootstrap = query({
  args: {
    serverToken: v.string(),
    workspaceId: v.string(),
    atomId: v.string(),
  },
  handler: async (
    ctx,
    { serverToken, workspaceId, atomId },
  ): Promise<AtomBootstrapResult | null> => {
    requireServerToken(serverToken)

    const atom = await ownerAtomByFileId(ctx, workspaceId, atomId)
    if (!atom) return null

    return { markdown: atom.body }
  },
})
