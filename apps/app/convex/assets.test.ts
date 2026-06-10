/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

describe('workspace assets', () => {
  it('registers path-bearing workspace files and supports list, resolve, rename, and delete', async () => {
    const t = convexTest(schema, modules)
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob(['a,b\n1,2\n'], { type: 'text/csv' }),
      )
    })

    const created = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerWorkspaceFile,
      {
        storageId,
        filename: 'wallet.csv',
        mediaType: 'text/csv',
        path: 'uploads/wallet.csv',
      },
    )

    expect(created).toMatchObject({
      path: 'uploads/wallet.csv',
      title: 'wallet.csv',
      source: 'user',
      kind: 'asset',
      contentType: 'text/csv',
    })

    await expect(
      t.withIdentity({ subject: 'bob' }).query(api.assets.resolveWorkspaceFile, {
        path: 'uploads/wallet.csv',
      }),
    ).resolves.toBeNull()

    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.listWorkspaceFiles, {}),
    ).resolves.toEqual([
      expect.objectContaining({ path: 'uploads/wallet.csv' }),
    ])

    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.resolveWorkspaceFile, {
        path: 'uploads/wallet.csv',
      }),
    ).resolves.toMatchObject({
      path: 'uploads/wallet.csv',
      mediaType: 'text/csv',
      url: expect.stringMatching(/^http/),
    })

    await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.renameWorkspaceFile,
      {
        fromPath: 'uploads/wallet.csv',
        toPath: 'uploads/wallet-renamed.csv',
      },
    )
    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.listWorkspaceFiles, {}),
    ).resolves.toEqual([
      expect.objectContaining({ path: 'uploads/wallet-renamed.csv' }),
    ])

    await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.removeWorkspaceFile,
      { path: 'uploads/wallet-renamed.csv' },
    )
    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.listWorkspaceFiles, {}),
    ).resolves.toEqual([])
  })

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

  it('allows filenames with embedded dot-dot but rejects traversal segments', async () => {
    const t = convexTest(schema, modules)
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(['ok'], { type: 'text/plain' }))
    })

    await expect(
      t.withIdentity({ subject: 'alice' }).mutation(
        api.assets.registerWorkspaceFile,
        {
          storageId,
          filename: 'my..file.txt',
          mediaType: 'text/plain',
          path: 'uploads/my..file.txt',
        },
      ),
    ).resolves.toMatchObject({
      path: 'uploads/my..file.txt',
    })

    const traversalStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(['bad'], { type: 'text/plain' }))
    })
    await expect(
      t.withIdentity({ subject: 'alice' }).mutation(
        api.assets.registerWorkspaceFile,
        {
          storageId: traversalStorageId,
          filename: 'bad.txt',
          mediaType: 'text/plain',
          path: 'uploads/../bad.txt',
        },
      ),
    ).rejects.toThrow(/invalid workspace file path/)
  })

  it('returns the existing asset when the same storage object is registered twice in a workspace', async () => {
    const t = convexTest(schema, modules)
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob(['retry me'], { type: 'text/plain' }),
      )
    })

    const first = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerUploadedAsset,
      {
        storageId,
        filename: 'first.txt',
        mediaType: 'text/plain',
        purpose: 'chat',
      },
    )
    const retry = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerUploadedAsset,
      {
        storageId,
        filename: 'retry.txt',
        mediaType: 'application/octet-stream',
        purpose: 'workspace',
      },
    )

    expect(retry.assetId).toBe(first.assetId)
    expect(retry.filename).toBe('first.txt')

    const rows = await t.run(async (ctx) => {
      return await ctx.db.query('workspaceAssets').collect()
    })
    expect(rows).toHaveLength(1)
  })

  it('resolves app assets only when referenced by an app-readable source', async () => {
    const t = convexTest(schema, modules)
    const referencedStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(['visible'], { type: 'text/plain' }))
    })
    const hiddenStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(['hidden'], { type: 'text/plain' }))
    })

    const referenced = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerUploadedAsset,
      {
        storageId: referencedStorageId,
        filename: 'visible.txt',
        mediaType: 'text/plain',
        purpose: 'workspace',
      },
    )
    const hidden = await t.withIdentity({ subject: 'alice' }).mutation(
      api.assets.registerUploadedAsset,
      {
        storageId: hiddenStorageId,
        filename: 'hidden.txt',
        mediaType: 'text/plain',
        purpose: 'workspace',
      },
    )

    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: 'alice',
        path: 'finance/.apps/tracker/src/App.tsx',
        body: 'app code',
        updatedAt: 1,
      })
      await ctx.db.insert('atoms', {
        workspaceId: 'alice',
        path: 'finance/.apps/tracker/app.json',
        body: JSON.stringify({ read: ['docs.md'], write: [] }),
        updatedAt: 2,
      })
      await ctx.db.insert('atoms', {
        workspaceId: 'alice',
        path: 'finance/docs.md',
        body: `[Visible](dohc-asset:file/${referenced.assetId})`,
        updatedAt: 3,
      })
      await ctx.db.insert('atoms', {
        workspaceId: 'alice',
        path: 'finance/private.md',
        body: `[Hidden](dohc-asset:file/${hidden.assetId})`,
        updatedAt: 4,
      })
    })

    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.resolveAppAsset, {
        packageRoot: 'finance/.apps/tracker',
        assetId: referenced.assetId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      asset: { filename: 'visible.txt' },
      url: expect.stringMatching(/^http/),
      sourcePath: 'finance/docs.md',
    })

    await expect(
      t.withIdentity({ subject: 'alice' }).query(api.assets.resolveAppAsset, {
        packageRoot: 'finance/.apps/tracker',
        assetId: hidden.assetId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'asset-not-authorized',
    })
  })
})
