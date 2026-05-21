import { v } from 'convex/values'
import { action } from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'

// Public mutation surface that plugin iframes call via the postMessage
// bridge. workspaceId is derived from the authed caller.

export const mutate = action({
  args: {
    op: v.union(
      v.literal('upsert'),
      v.literal('patch'),
      v.literal('delete'),
    ),
    type: v.string(),
    slug: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, { op, type, slug, data }) => {
    const workspaceId = await requireWorkspace(ctx)
    if (op === 'upsert') {
      await ctx.runMutation(internal.entities._upsertMany, {
        workspaceId,
        items: [{ type, slug, data: data ?? {} }],
      })
      return { ok: true as const }
    }
    if (op === 'patch') {
      await ctx.runMutation(internal.entities._patch, {
        workspaceId,
        type,
        slug,
        data: data ?? {},
      })
      return { ok: true as const }
    }
    if (op === 'delete') {
      await ctx.runMutation(internal.entities._delete, {
        workspaceId,
        type,
        slug,
      })
      return { ok: true as const }
    }
    return { ok: false as const, error: `unknown op: ${String(op)}` }
  },
})

export const fetchEntities = action({
  args: { type: v.string() },
  handler: async (
    ctx,
    { type },
  ): Promise<Array<{ type: string; slug: string; data: unknown; updatedAt: number }>> => {
    const workspaceId = await requireWorkspace(ctx)
    return await ctx.runQuery(internal.entities._listByType, {
      workspaceId,
      type,
    })
  },
})
