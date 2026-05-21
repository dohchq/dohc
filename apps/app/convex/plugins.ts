import { v } from 'convex/values'
import {
  query,
  mutation,
  internalMutation,
} from './_generated/server'
import { requireWorkspace } from './auth'

export const discover = query({
  args: {},
  handler: async (ctx) => {
    const workspaceId = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    return rows
      .filter((r) => r.path.startsWith('plugins/'))
      .map((r) => ({ path: r.path, body: r.body }))
  },
})

export const listEnabled = query({
  args: {},
  handler: async (ctx) => {
    const workspaceId = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('pluginSettings')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    return rows.filter((r) => r.enabled).map((r) => r.pluginId)
  },
})

export const setEnabled = mutation({
  args: { pluginId: v.string(), enabled: v.boolean() },
  handler: async (ctx, { pluginId, enabled }) => {
    const workspaceId = await requireWorkspace(ctx)
    const existing = await ctx.db
      .query('pluginSettings')
      .withIndex('by_workspace_plugin', (q) =>
        q.eq('workspaceId', workspaceId).eq('pluginId', pluginId),
      )
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { enabled })
      return existing._id
    }
    return await ctx.db.insert('pluginSettings', {
      workspaceId,
      pluginId,
      enabled,
    })
  },
})

// Internal version called by the catalog install action and any other
// authed Convex code that already has a workspaceId in hand.
export const _setEnabledInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    pluginId: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { workspaceId, pluginId, enabled }) => {
    const existing = await ctx.db
      .query('pluginSettings')
      .withIndex('by_workspace_plugin', (q) =>
        q.eq('workspaceId', workspaceId).eq('pluginId', pluginId),
      )
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { enabled })
      return existing._id
    }
    return await ctx.db.insert('pluginSettings', {
      workspaceId,
      pluginId,
      enabled,
    })
  },
})
