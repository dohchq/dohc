/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

describe('workspace assets', () => {
  it('registers storage metadata in the caller workspace and resolves only inside that workspace', async () => {
    const t = convexTest(schema, modules)
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob(['hello'], { type: 'text/plain' }),
      )
    })

    const asset = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerUploadedAsset,
      {
        storageId,
        filename: 'notes.txt',
        mediaType: 'text/plain',
        purpose: 'chat',
      },
    )

    expect(asset).toMatchObject({
      workspaceId: 'alice',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      kind: 'file',
      purpose: 'chat',
    })

    const resolved = await t.withIdentity({ subject: 'alice' }).query(
      api.assets.resolveAsset,
      { assetId: asset.assetId },
    )
    expect(resolved?.filename).toBe('notes.txt')
    expect(resolved?.url).toMatch(/^http/)

    await expect(
      t.withIdentity({ subject: 'bob' }).query(api.assets.resolveAsset, {
        assetId: asset.assetId,
      }),
    ).rejects.toThrow(/asset not found/)
  })
})
