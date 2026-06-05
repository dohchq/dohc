import { v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'

const assetPurposeValidator = v.union(v.literal('chat'), v.literal('workspace'))

type AssetKind = 'image' | 'video' | 'audio' | 'file'

export const generateUploadUrl = mutation({
  args: {
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { activeWorkspaceId }) => {
    await requireWorkspace(ctx, activeWorkspaceId)
    return await ctx.storage.generateUploadUrl()
  },
})

export const registerUploadedAsset = mutation({
  args: {
    activeWorkspaceId: v.optional(v.string()),
    storageId: v.id('_storage'),
    filename: v.string(),
    mediaType: v.optional(v.string()),
    purpose: assetPurposeValidator,
  },
  handler: async (
    ctx,
    { activeWorkspaceId, storageId, filename, mediaType, purpose },
  ) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const metadata = await ctx.db.system.get('_storage', storageId)
    if (!metadata) throw new Error('uploaded file not found')

    const normalizedMediaType =
      normalizeMediaType(mediaType) ??
      normalizeMediaType(metadata.contentType) ??
      'application/octet-stream'
    const existing = await ctx.db
      .query('workspaceAssets')
      .withIndex('by_workspace_storage', (q) =>
        q.eq('workspaceId', workspaceId).eq('storageId', storageId),
      )
      .first()
    if (existing) return toClientAsset(existing)

    const now = Date.now()
    const assetId = await ctx.db.insert('workspaceAssets', {
      workspaceId,
      storageId,
      filename: normalizeFilename(filename),
      mediaType: normalizedMediaType,
      kind: kindForMediaType(normalizedMediaType),
      size: metadata.size,
      sha256: metadata.sha256,
      purpose,
      createdByUserId: identity.subject,
      createdAt: now,
    })

    const asset = await ctx.db.get(assetId)
    if (!asset) throw new Error('asset registration failed')
    return toClientAsset(asset)
  },
})

export const resolveAsset = query({
  args: {
    activeWorkspaceId: v.optional(v.string()),
    assetId: v.id('workspaceAssets'),
  },
  handler: async (ctx, { activeWorkspaceId, assetId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const asset = await ctx.db.get(assetId)
    if (!asset || asset.workspaceId !== workspaceId) {
      throw new Error('asset not found')
    }
    const url = await ctx.storage.getUrl(asset.storageId)
    if (!url) throw new Error('asset blob not found')
    return {
      ...toClientAsset(asset),
      url,
    }
  },
})

export const _resolveForAgent = internalQuery({
  args: {
    workspaceId: v.string(),
    assetIds: v.array(v.id('workspaceAssets')),
  },
  handler: async (ctx, { workspaceId, assetIds }) => {
    const assets = []
    for (const assetId of assetIds) {
      const asset = await ctx.db.get(assetId)
      if (!asset || asset.workspaceId !== workspaceId) {
        throw new Error('asset not found')
      }
      assets.push(toClientAsset(asset))
    }
    return assets
  },
})

export const _markUsedInMessage = internalMutation({
  args: {
    workspaceId: v.string(),
    assetIds: v.array(v.id('workspaceAssets')),
    threadId: v.string(),
    messageId: v.string(),
  },
  handler: async (ctx, { workspaceId, assetIds, threadId, messageId }) => {
    const usedAt = Date.now()
    for (const assetId of assetIds) {
      const asset = await ctx.db.get(assetId)
      if (!asset || asset.workspaceId !== workspaceId) continue
      await ctx.db.patch(assetId, {
        threadId,
        messageId,
        usedAt,
      })
    }
  },
})

function kindForMediaType(mediaType: string): AssetKind {
  const normalized = mediaType.toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  return 'file'
}

function normalizeFilename(filename: string): string {
  const trimmed = filename.trim()
  return trimmed.length > 0 ? trimmed : 'untitled attachment'
}

function normalizeMediaType(value?: string | null): string | null {
  const trimmed = value?.trim().toLowerCase()
  return trimmed || null
}

function toClientAsset(asset: {
  _id: Id<'workspaceAssets'>
  workspaceId: string
  storageId: Id<'_storage'>
  filename: string
  mediaType: string
  kind: AssetKind
  size: number
  sha256?: string
  purpose: 'chat' | 'workspace'
  createdByUserId: string
  createdAt: number
  threadId?: string
  messageId?: string
  usedAt?: number
}) {
  return {
    assetId: asset._id,
    workspaceId: asset.workspaceId,
    storageId: asset.storageId,
    filename: asset.filename,
    mediaType: asset.mediaType,
    kind: asset.kind,
    size: asset.size,
    sha256: asset.sha256,
    purpose: asset.purpose,
    createdByUserId: asset.createdByUserId,
    createdAt: asset.createdAt,
    threadId: asset.threadId,
    messageId: asset.messageId,
    usedAt: asset.usedAt,
  }
}
