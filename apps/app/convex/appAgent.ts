import { v } from 'convex/values'
import { query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import { isNonDataAtom } from './atomId'
import { resolveScopeRelativePath } from './appPaths'
import { scopeAllowsPath } from './appScopes'
import { isAppDescriptorError, resolveAppDescriptor } from './apps'
import { isTrustedForKey } from './appTrust'

type AppAgentCapability = 'run' | 'patch.propose'

type AppAgentErrorCode =
  | 'app-not-found'
  | 'invalid-manifest'
  | 'app-agent-not-authorized'
  | 'app-trust-required'
  | 'source-read-not-granted'
  | 'source-read-not-authorized'
  | 'write-not-granted'
  | 'source-write-not-authorized'
  | 'source-scan-truncated'

type AppAgentError = {
  ok: false
  code: AppAgentErrorCode
  message: string
}

type AppAgentAuthorizedHandoff = {
  ok: true
  operation: 'dohc.agent.run' | 'dohc.patch.propose'
  prompt: string
  sources: string[]
  requiresConfirmation: true
}

function error(code: AppAgentErrorCode, message: string): AppAgentError {
  return { ok: false, code, message }
}

async function atomByPath(ctx: QueryCtx, workspaceId: string, path: string) {
  return await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
}

async function resolveAppForAgent(
  ctx: QueryCtx,
  activeWorkspaceId: string | undefined,
  packageRoot: string,
  capability: AppAgentCapability,
) {
  const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  const app = await resolveAppDescriptor(ctx, workspaceId, identity.subject, packageRoot)
  if (isAppDescriptorError(app)) return error(app.code, app.message)
  if (!app) return error('app-not-found', 'App not found.')
  if (!app.configStatus.ok) return error('invalid-manifest', 'The app manifest is invalid.')
  if (!app.agent.includes(capability)) {
    return error(
      'app-agent-not-authorized',
      `This app manifest does not declare ${capability}.`,
    )
  }
  if (!app.trustKey || !(await isTrustedForKey(
    ctx,
    workspaceId,
    identity.subject,
    packageRoot,
    app.trustKey,
  ))) {
    return error('app-trust-required', 'This user has not trusted the current app manifest.')
  }
  return { ok: true as const, workspaceId, userId: identity.subject, app }
}

async function authorizeReadSource(
  ctx: QueryCtx,
  workspaceId: string,
  userId: string,
  app: { scopePath: string; read: string[] },
  source: string,
) {
  const sourcePath = resolveScopeRelativePath(app.scopePath, source)
  if (sourcePath === null || !scopeAllowsPath(app.read, sourcePath)) {
    return error('source-read-not-granted', 'This app is not allowed to use that source.')
  }
  const atom = await atomByPath(ctx, workspaceId, sourcePath)
  if (!atom || isNonDataAtom(atom.path, atom.body ?? '')) {
    return error('source-read-not-authorized', 'Source not found.')
  }
  if (!(await canReadAtom(ctx, atom._id, userId))) {
    return error('source-read-not-authorized', 'Not authorized to read this source.')
  }
  return { ok: true as const, path: atom.path, atom }
}

async function authorizeSources(
  ctx: QueryCtx,
  workspaceId: string,
  userId: string,
  app: { scopePath: string; read: string[] },
  sources: string[],
): Promise<{ ok: true; sources: string[] } | AppAgentError> {
  const out: string[] = []
  for (const source of sources) {
    const authorized = await authorizeReadSource(ctx, workspaceId, userId, app, source)
    if (!authorized.ok) return authorized
    out.push(authorized.path)
  }
  return { ok: true, sources: Array.from(new Set(out)) }
}

export const authorizeRun = query({
  args: {
    packageRoot: v.string(),
    prompt: v.string(),
    sources: v.optional(v.array(v.string())),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { packageRoot, prompt, sources, activeWorkspaceId },
  ): Promise<AppAgentAuthorizedHandoff | AppAgentError> => {
    const resolved = await resolveAppForAgent(ctx, activeWorkspaceId, packageRoot, 'run')
    if (!resolved.ok) return resolved
    const authorizedSources = await authorizeSources(
      ctx,
      resolved.workspaceId,
      resolved.userId,
      resolved.app,
      sources ?? [],
    )
    if (!authorizedSources.ok) return authorizedSources
    return {
      ok: true,
      operation: 'dohc.agent.run',
      prompt,
      sources: authorizedSources.sources,
      requiresConfirmation: true,
    }
  },
})

export const authorizePatch = query({
  args: {
    packageRoot: v.string(),
    path: v.string(),
    summary: v.string(),
    patch: v.any(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { packageRoot, path, summary, patch, activeWorkspaceId },
  ): Promise<AppAgentAuthorizedHandoff | AppAgentError> => {
    const resolved = await resolveAppForAgent(ctx, activeWorkspaceId, packageRoot, 'patch.propose')
    if (!resolved.ok) return resolved
    const authorized = await authorizeReadSource(
      ctx,
      resolved.workspaceId,
      resolved.userId,
      resolved.app,
      path,
    )
    if (!authorized.ok) return authorized
    if (!scopeAllowsPath(resolved.app.write, authorized.path)) {
      return error('write-not-granted', 'This app is not allowed to propose changes to that source.')
    }
    if (!(await canWriteAtomPath(ctx, resolved.workspaceId, authorized.path, resolved.userId))) {
      return error('source-write-not-authorized', 'Not authorized to write this source.')
    }
    if (authorized.atom.systemLocked || authorized.atom.userLocked) {
      return error('source-write-not-authorized', 'This source is locked.')
    }
    const prompt = [
      `Review this proposed change from the app at ${packageRoot}.`,
      `Target: ${authorized.path}`,
      `Summary: ${summary}`,
      '',
      'Proposed patch:',
      JSON.stringify(patch, null, 2),
    ].join('\n')
    return {
      ok: true,
      operation: 'dohc.patch.propose',
      prompt,
      sources: [authorized.path],
      requiresConfirmation: true,
    }
  },
})
