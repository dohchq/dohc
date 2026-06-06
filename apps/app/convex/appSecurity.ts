import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import { resolveAppDescriptor } from './apps'
import { isTrustedForKey } from './appTrust'
export {
  globBase,
  globMatchesPath,
  pathInScope,
  scopeAllowsPath,
} from './appScopes'
import { pathInScope, scopeAllowsPath } from './appScopes'

export type AppSecurityError = {
  ok: false
  code:
    | 'app-not-found'
    | 'invalid-manifest'
    | 'collection-not-found'
    | 'source-read-not-granted'
    | 'source-read-not-authorized'
    | 'collection-write-not-granted'
    | 'source-write-not-authorized'
    | 'app-trust-required'
  message: string
}

function error(code: AppSecurityError['code'], message: string): AppSecurityError {
  return { ok: false, code, message }
}

export async function atomByPath(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  path: string,
): Promise<Doc<'atoms'> | null> {
  return await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
}

export async function resolveAppForSecurity(
  ctx: QueryCtx | MutationCtx,
  activeWorkspaceId: string | undefined,
  packageRoot: string,
) {
  const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  const app = await resolveAppDescriptor(ctx, workspaceId, identity.subject, packageRoot)
  if (!app) return error('app-not-found', 'App not found.')
  if (!app.configStatus.ok) {
    return error('invalid-manifest', 'The app manifest is invalid.')
  }
  return { ok: true as const, workspaceId, userId: identity.subject, app }
}

export async function authorizeAppRead(
  ctx: QueryCtx | MutationCtx,
  args: {
    activeWorkspaceId: string | undefined
    packageRoot: string
    path: string
  },
) {
  const resolved = await resolveAppForSecurity(
    ctx,
    args.activeWorkspaceId,
    args.packageRoot,
  )
  if (!resolved.ok) return resolved
  if (!scopeAllowsPath(resolved.app.read, args.path)) {
    return error('source-read-not-granted', 'This app is not allowed to read that source.')
  }
  const atom = await atomByPath(ctx, resolved.workspaceId, args.path)
  if (!atom) return error('source-read-not-authorized', 'Source not found.')
  if (!(await canReadAtom(ctx, atom._id, resolved.userId))) {
    return error('source-read-not-authorized', 'Not authorized to read this source.')
  }
  return { ...resolved, atom }
}

export async function authorizeCollectionWrite(
  ctx: QueryCtx | MutationCtx,
  args: {
    activeWorkspaceId: string | undefined
    packageRoot: string
    collection: string
    targetPath: string
  },
) {
  const resolved = await resolveAppForSecurity(
    ctx,
    args.activeWorkspaceId,
    args.packageRoot,
  )
  if (!resolved.ok) return resolved
  if (!resolved.app.trustKey || !(await isTrustedForKey(
    ctx,
    resolved.workspaceId,
    resolved.userId,
    args.packageRoot,
    resolved.app.trustKey,
  ))) {
    return error('app-trust-required', 'This user has not trusted the current app manifest.')
  }
  const collection = resolved.app.collections[args.collection]
  if (!collection) return error('collection-not-found', 'Collection not found.')
  if (!collection.write.some((scope) => pathInScope(args.targetPath, scope))) {
    return error('collection-write-not-granted', 'This app is not allowed to write that collection target.')
  }
  if (!(await canWriteAtomPath(ctx, resolved.workspaceId, args.targetPath, resolved.userId))) {
    return error('source-write-not-authorized', 'Not authorized to write this source.')
  }
  const existing = await atomByPath(ctx, resolved.workspaceId, args.targetPath)
  if (existing?.systemLocked || existing?.userLocked) {
    return error('source-write-not-authorized', 'This source is locked.')
  }
  return { ...resolved, collection, existing }
}
