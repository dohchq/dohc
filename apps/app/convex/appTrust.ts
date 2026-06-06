import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireWorkspace } from './auth'
import { isAppDescriptorError, resolveAppDescriptor } from './apps'

function trustPrompt(title: string, writeTargets: string[]): string {
  return [
    `${title} wants to write to:`,
    ...writeTargets.map((target) => `- ${target}`),
    '',
    'This app can only write inside these scopes. Changing app.json resets this permission.',
  ].join('\n')
}

async function trustRows(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  userId: string,
  packageRoot: string,
) {
  return await ctx.db
    .query('appTrust')
    .withIndex('by_user_app', (q) =>
      q.eq('workspaceId', workspaceId).eq('userId', userId).eq('packageRoot', packageRoot),
    )
    .collect()
}

export async function isTrustedForKey(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  userId: string,
  packageRoot: string,
  trustKey: string | null,
): Promise<boolean> {
  if (trustKey === null) return true
  const rows = await trustRows(ctx, workspaceId, userId, packageRoot)
  return rows.some((row) => row.trustKey === trustKey)
}

async function resolveTrustState(
  ctx: QueryCtx | MutationCtx,
  activeWorkspaceId: string | undefined,
  packageRoot: string,
) {
  const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  const app = await resolveAppDescriptor(ctx, workspaceId, identity.subject, packageRoot)
  if (isAppDescriptorError(app)) return app
  if (!app) {
    return {
      ok: false as const,
      code: 'app-not-found' as const,
      message: 'App not found.',
    }
  }
  if (!app.configStatus.ok || app.trustKey === null) {
    return {
      ok: true as const,
      trusted: app.trustKey === null && app.configStatus.ok,
      title: app.title,
      trustKey: app.trustKey,
      writeTargets: app.writeTargets,
      prompt: app.trustKey === null ? '' : trustPrompt(app.title, app.writeTargets),
    }
  }
  const trusted = await isTrustedForKey(
    ctx,
    workspaceId,
    identity.subject,
    packageRoot,
    app.trustKey,
  )
  return {
    ok: true as const,
    trusted,
    title: app.title,
    trustKey: app.trustKey,
    writeTargets: app.writeTargets,
    prompt: trustPrompt(app.title, app.writeTargets),
  }
}

export const state = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    return await resolveTrustState(ctx, activeWorkspaceId, packageRoot)
  },
})

export const grant = mutation({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    const resolved = await resolveTrustState(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved
    if (resolved.trustKey === null) {
      return {
        ok: false as const,
        code: 'no-write-capability' as const,
        message: 'This app does not request write trust.',
      }
    }

    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const rows = await trustRows(ctx, workspaceId, identity.subject, packageRoot)
    if (!rows.some((row) => row.trustKey === resolved.trustKey)) {
      await ctx.db.insert('appTrust', {
        workspaceId,
        userId: identity.subject,
        packageRoot,
        trustKey: resolved.trustKey,
        grantedAt: Date.now(),
      })
    }
    return { ok: true as const, trustKey: resolved.trustKey }
  },
})
