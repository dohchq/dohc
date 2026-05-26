import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RevocationRegistry } from './admin.js'
import { mintCollabToken } from './auth.js'
import { encodeDocName } from './doc-name.js'
import { createHocuspocusHooks } from './hooks.js'
import {
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  yDocToMarkdown,
} from './import-export.js'
import { MemoryYDocPersistenceBackend, PostgresYDocStore } from './persistence.js'

const secret = 'test-secret-with-enough-entropy-for-hs256'
const documentName = encodeDocName({
  workspaceId: 'workspace_1',
  atomId: 'atom_1',
})
const messageYjsUpdate = 2
const messageYjsSyncStep1 = 0

function makeAcl(options: {
  canRead: boolean
  canWrite: boolean
  version?: number
  bootstrapMarkdown?: string | null
}) {
  return {
    getWorkspaceAuthzVersion: vi.fn(async () => options.version ?? 1),
    canReadAtom: vi.fn(async () => options.canRead),
    canWriteAtom: vi.fn(async () => options.canWrite),
    loadAtomBootstrap: vi.fn(async () =>
      options.bootstrapMarkdown === undefined
        ? null
        : options.bootstrapMarkdown === null
          ? null
          : { markdown: options.bootstrapMarkdown },
    ),
  }
}

function makeHooks(options: {
  canRead: boolean
  canWrite: boolean
  version?: number
  bootstrapMarkdown?: string | null
  revocations?: RevocationRegistry
}) {
  const backend = new MemoryYDocPersistenceBackend()
  const store = new PostgresYDocStore(backend)
  const acl = makeAcl(options)
  const hooks = createHocuspocusHooks({
    jwtSecret: secret,
    acl,
    store,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    revocations: options.revocations,
  })
  return { backend, store, acl, hooks }
}

describe('hocuspocus hook factory', () => {
  it('authenticates readable docs and marks denied writes as read-only', async () => {
    const { acl, hooks } = makeHooks({ canRead: true, canWrite: false })
    const token = await mintCollabToken(
      {
        sub: 'user_1',
        ws: 'workspace_1',
        actorKind: 'user',
        authzVersion: 1,
      },
      secret,
    )
    const connection = { readOnly: false }

    const context = await hooks.onAuthenticate({
      documentName,
      token,
      connection,
    } as never)

    expect(context).toMatchObject({
      userId: 'user_1',
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      actorKind: 'user',
      authzVersion: 1,
    })
    expect(connection.readOnly).toBe(true)
    expect(acl.getWorkspaceAuthzVersion).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      userId: 'user_1',
      actorKind: 'user',
      authzVersion: 1,
    })
    expect(acl.canReadAtom).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      userId: 'user_1',
      actorKind: 'user',
      authzVersion: 1,
    })
  })

  it('rejects unreadable docs during authentication', async () => {
    const { hooks } = makeHooks({ canRead: false, canWrite: false })
    const token = await mintCollabToken(
      {
        sub: 'user_1',
        ws: 'workspace_1',
        actorKind: 'user',
        authzVersion: 1,
      },
      secret,
    )

    await expect(
      hooks.onAuthenticate({
        documentName,
        token,
        connection: { readOnly: false },
      } as never),
    ).rejects.toThrow(/read access/)
  })

  it('loads Y.Docs from the persistence store', async () => {
    const { hooks, store } = makeHooks({ canRead: true, canWrite: true })
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'persisted')
    await store.appendUpdate({
      documentName,
      update: Y.encodeStateAsUpdate(doc),
      actorId: 'user_1',
      socketId: 'socket_1',
    })

    const loaded = await hooks.onLoadDocument({
      documentName,
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(loaded.getText('body').toString()).toBe('persisted')
  })

  it('bootstraps missing Y.Docs from Convex markdown and stores a sequence-zero snapshot', async () => {
    const markdown = '---\nid: atom_1\ntitle: Boot\n---\n# Bootstrapped\n\nBody'
    const { acl, backend, hooks } = makeHooks({
      canRead: true,
      canWrite: true,
      bootstrapMarkdown: markdown,
    })

    const loaded = await hooks.onLoadDocument({
      documentName,
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(acl.loadAtomBootstrap).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      userId: 'user_1',
      actorKind: 'user',
      authzVersion: 1,
    })
    expect(getDohcYDocFrontmatter(loaded)).toMatchObject({
      id: 'atom_1',
      title: 'Boot',
    })
    expect(getDohcYDocMeta(loaded).schemaVersion).toBe(1)
    expect(yDocToMarkdown(loaded)).toContain('# Bootstrapped')
    await expect(backend.getLatestSnapshot(documentName)).resolves.toMatchObject({
      lastSeq: 0,
    })
  })

  it('loads persisted state when concurrent writes win the bootstrap race', async () => {
    const markdown = '---\nid: atom_1\n---\n# From Convex'
    const { hooks, store } = makeHooks({
      canRead: true,
      canWrite: true,
      bootstrapMarkdown: markdown,
    })
    const persisted = new Y.Doc()
    persisted.getText('body').insert(0, 'concurrent persisted')
    await store.storeSnapshot(documentName, persisted, { lastSeq: 0 })
    vi.spyOn(store, 'hasDocumentState').mockResolvedValueOnce(false)
    vi.spyOn(store, 'storeSnapshotIfMissing').mockResolvedValueOnce(null)

    const loaded = await hooks.onLoadDocument({
      documentName,
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(loaded.getText('body').toString()).toBe('concurrent persisted')
  })

  it('re-authenticates refreshed tokens and can downgrade live sockets to read-only', async () => {
    const { hooks } = makeHooks({ canRead: true, canWrite: false })
    const token = await mintCollabToken(
      {
        sub: 'user_1',
        ws: 'workspace_1',
        actorKind: 'user',
        authzVersion: 1,
      },
      secret,
    )
    const connection = { readOnly: false }
    const connectionConfig = { readOnly: false, isAuthenticated: true }

    const context = await hooks.onTokenSync({
      documentName,
      token,
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
      connection,
      connectionConfig,
    } as never)

    expect(context).toMatchObject({ userId: 'user_1', atomId: 'atom_1' })
    expect(connection.readOnly).toBe(true)
    expect(connectionConfig.readOnly).toBe(true)
  })

  it('rejects refreshed tokens that change the live socket identity', async () => {
    const { hooks } = makeHooks({ canRead: true, canWrite: true })
    const token = await mintCollabToken(
      {
        sub: 'user_2',
        ws: 'workspace_1',
        actorKind: 'user',
        authzVersion: 1,
      },
      secret,
    )

    await expect(
      hooks.onTokenSync({
        documentName,
        token,
        context: {
          userId: 'user_1',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actorKind: 'user',
          authzVersion: 1,
        },
        connection: { readOnly: false },
        connectionConfig: { readOnly: false, isAuthenticated: true },
      } as never),
    ).rejects.toThrow(/identity changed/)
  })

  it('does not bootstrap when persisted state already exists', async () => {
    const { acl, hooks, store } = makeHooks({
      canRead: true,
      canWrite: true,
      bootstrapMarkdown: '---\nid: atom_1\n---\n# From Convex',
    })
    const persisted = new Y.Doc()
    persisted.getText('body').insert(0, 'already persisted')
    await store.storeSnapshot(documentName, persisted, { lastSeq: 0 })

    const loaded = await hooks.onLoadDocument({
      documentName,
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(acl.loadAtomBootstrap).not.toHaveBeenCalled()
    expect(loaded.getText('body').toString()).toBe('already persisted')
  })

  it('rejects document loads when context is missing', async () => {
    const { hooks } = makeHooks({ canRead: true, canWrite: true })

    await expect(
      hooks.onLoadDocument({ documentName } as never),
    ).rejects.toThrow(/context/)
  })

  it('does not persist raw beforeHandleMessage transport envelopes', async () => {
    const { backend, hooks } = makeHooks({ canRead: true, canWrite: true })

    await hooks.beforeHandleMessage({
      documentName,
      update: new Uint8Array([1, 2, 3]),
      socketId: 'socket_1',
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(backend.updatesFor(documentName)).toHaveLength(0)
  })

  it('rechecks write ACL and appends Yjs sync payloads before applying them', async () => {
    const { backend, hooks } = makeHooks({ canRead: true, canWrite: true })
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'persist me before ack')
    const update = Y.encodeStateAsUpdate(doc)

    await hooks.beforeSync({
      documentName,
      type: messageYjsUpdate,
      payload: update,
      connection: { readOnly: false, socketId: 'socket_1' },
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    expect(backend.updatesFor(documentName)).toHaveLength(1)
    expect(backend.updatesFor(documentName)[0]).toMatchObject({
      actorId: 'user_1',
      socketId: 'socket_1',
    })
  })

  it('rechecks read ACL before replying to initial sync requests', async () => {
    const { hooks } = makeHooks({ canRead: false, canWrite: true })

    await expect(
      hooks.beforeSync({
        documentName,
        type: messageYjsSyncStep1,
        payload: new Uint8Array([1, 2, 3]),
        connection: { readOnly: false, socketId: 'socket_1' },
        context: {
          userId: 'user_1',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actorKind: 'user',
          authzVersion: 1,
        },
      } as never),
    ).rejects.toThrow(/read access/)
  })

  it('rejects sync messages after the live connection token expires', async () => {
    const { hooks } = makeHooks({ canRead: true, canWrite: true })

    await expect(
      hooks.beforeSync({
        documentName,
        type: messageYjsSyncStep1,
        payload: new Uint8Array([1, 2, 3]),
        connection: { readOnly: false, socketId: 'socket_1' },
        context: {
          userId: 'user_1',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actorKind: 'user',
          authzVersion: 1,
          tokenExpiresAt: Math.floor(Date.now() / 1000) - 1,
        },
      } as never),
    ).rejects.toThrow(/token expired/)
  })

  it('throws before applying updates when persistence fails', async () => {
    const { hooks, store } = makeHooks({ canRead: true, canWrite: true })
    vi.spyOn(store, 'appendUpdate').mockRejectedValueOnce(new Error('database down'))
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'will fail')

    await expect(
      hooks.beforeSync({
        documentName,
        type: messageYjsUpdate,
        payload: Y.encodeStateAsUpdate(doc),
        connection: { readOnly: false, socketId: 'socket_1' },
        context: {
          userId: 'user_1',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actorKind: 'user',
          authzVersion: 1,
        },
      } as never),
    ).rejects.toThrow(/database down/)
  })

  it('rejects malformed sync payloads before appending them', async () => {
    const { backend, hooks } = makeHooks({ canRead: true, canWrite: true })

    await expect(
      hooks.beforeSync({
        documentName,
        type: messageYjsUpdate,
        payload: new Uint8Array([255, 255, 255]),
        connection: { readOnly: false, socketId: 'socket_1' },
        context: {
          userId: 'user_1',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actorKind: 'user',
          authzVersion: 1,
        },
      } as never),
    ).rejects.toThrow(/invalid yjs update/i)
    expect(backend.updatesFor(documentName)).toHaveLength(0)
  })

  it('stores snapshots only through the highest contiguous applied update sequence', async () => {
    const { backend, hooks } = makeHooks({ canRead: true, canWrite: true })
    const firstDoc = new Y.Doc()
    firstDoc.getText('body').insert(0, 'first')
    const firstUpdate = Y.encodeStateAsUpdate(firstDoc)
    const secondDoc = new Y.Doc()
    secondDoc.getText('body').insert(0, 'second')
    const secondUpdate = Y.encodeStateAsUpdate(secondDoc)

    await hooks.beforeSync({
      documentName,
      type: messageYjsUpdate,
      payload: firstUpdate,
      connection: { readOnly: false, socketId: 'socket_1' },
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)
    await hooks.onChange({
      documentName,
      update: firstUpdate,
      socketId: 'socket_1',
      context: {
        userId: 'user_1',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)
    await hooks.beforeSync({
      documentName,
      type: messageYjsUpdate,
      payload: secondUpdate,
      connection: { readOnly: false, socketId: 'socket_2' },
      context: {
        userId: 'user_2',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      },
    } as never)

    await hooks.onStoreDocument({
      documentName,
      document: firstDoc,
    } as never)

    await expect(backend.getLatestSnapshot(documentName)).resolves.toMatchObject({
      lastSeq: 1,
    })
  })

  it('disconnects registered workspace users through the revocation registry', async () => {
    const revocations = new RevocationRegistry()
    const { hooks } = makeHooks({
      canRead: true,
      canWrite: true,
      revocations,
    })
    const connection = { readOnly: false, socketId: 'socket_1', close: vi.fn() }
    const context = {
      userId: 'user_1',
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      actorKind: 'user' as const,
      authzVersion: 1,
    }

    await hooks.connected({
      documentName,
      context,
      connection,
      socketId: 'socket_1',
    } as never)

    expect(revocations.revokeWorkspaceUser('workspace_1', 'user_1')).toBe(1)
    expect(connection.close).toHaveBeenCalledOnce()
  })
})
