import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encodeDocName } from './doc-name.js'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import {
  createSemanticApiHandler,
  semanticOperationKey,
} from './semantic-api.js'
import { createAnchorsForText } from './suggestions.js'
import {
  MemoryYDocPersistenceBackend,
  PostgresYDocStore,
} from './persistence.js'

const documentName = encodeDocName({
  workspaceId: 'workspace_1',
  atomId: 'atom_1',
})

function makeAcl(
  canWrite = true,
  options: { createAtom?: boolean; loadAtomBootstrap?: boolean } = {},
) {
  const acl = {
    getWorkspaceAuthzVersion: vi.fn(async () => 1),
    canReadAtom: vi.fn(async () => true),
    canWriteAtom: vi.fn(async () => canWrite),
    ...(options.loadAtomBootstrap
      ? { loadAtomBootstrap: vi.fn(async () => ({ markdown: 'Bootstrapped.' })) }
      : {}),
  }
  return {
    ...acl,
    ...(options.createAtom === false
      ? {}
      : {
          createAtom: vi.fn(async (input: { content: string }) => ({
            ok: true as const,
            atomId: 'created_atom',
            markdown: `---\nid: created_atom\n---\n${input.content}`,
          })),
        }),
  }
}

function makeHandler(
  canWrite = true,
  liveDocuments = new Map<string, Y.Doc>(),
  aclOptions: { createAtom?: boolean; loadAtomBootstrap?: boolean } = {},
) {
  const backend = new MemoryYDocPersistenceBackend()
  const store = new PostgresYDocStore(backend)
  const acl = makeAcl(canWrite, aclOptions)
  const handler = createSemanticApiHandler({
    adminToken: 'admin-token',
    acl,
    store,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getLiveDocument: (name) => liveDocuments.get(name) ?? null,
  })
  return { acl, backend, handler, store }
}

function request(
  body: Record<string, unknown>,
  token = 'admin-token',
): Request {
  return new Request('http://localhost/apply/replaceRange', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('semantic apply API', () => {
  it('authenticates a non-mutating semantic write preflight route', async () => {
    const { acl, handler } = makeHandler()

    const response = await handler(
      new Request('http://localhost/apply/preflight', {
        method: 'GET',
        headers: { authorization: 'Bearer admin-token' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      semanticWrites: true,
      createAtom: true,
      atomBootstrap: false,
    })
    expect(acl.canWriteAtom).not.toHaveBeenCalled()
    expect(acl.createAtom).not.toHaveBeenCalled()
  })

  it('reports when preflight cannot create brand-new atoms', async () => {
    const { handler } = makeHandler(true, new Map(), { createAtom: false })

    const response = await handler(
      new Request('http://localhost/apply/preflight', {
        method: 'GET',
        headers: { authorization: 'Bearer admin-token' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      semanticWrites: true,
      createAtom: false,
    })
  })

  it('rejects semantic write preflight without the admin token', async () => {
    const { acl, handler } = makeHandler()

    const response = await handler(
      new Request('http://localhost/apply/preflight', {
        method: 'GET',
        headers: { authorization: 'Bearer wrong-token' },
      }),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    })
    expect(acl.canWriteAtom).not.toHaveBeenCalled()
    expect(acl.createAtom).not.toHaveBeenCalled()
  })

  it('rejects semantic writes without the admin token', async () => {
    const { handler } = makeHandler()

    const response = await handler(request({}, 'wrong-token'))

    expect(response.status).toBe(401)
  })

  it('applies anchored replacements to the canonical Y.Doc and dedupes retries', async () => {
    const { backend, handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const body = {
      operationId: 'op_1',
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      actor: {
        userId: 'agent_1',
        actorKind: 'agent',
        authzVersion: 1,
      },
      anchorStart: anchors!.anchorStart,
      anchorEnd: anchors!.anchorEnd,
      replacement: 'earth',
      expectedText: 'world',
    }

    const first = await handler(request(body))
    const second = await handler(request(body))

    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      operationId: 'op_1',
      atomId: 'atom_1',
    })
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      operationId: 'op_1',
      deduped: true,
    })
    expect(backend.updatesFor(documentName)).toHaveLength(1)
    await expect(
      store.loadDocument(documentName).then(yDocToMarkdown),
    ).resolves.toContain('Hello earth.')
  })

  it('returns stale-intent without appending an update', async () => {
    const { backend, handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const response = await handler(
      request({
        operationId: 'op_stale',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actor: {
          userId: 'agent_1',
          actorKind: 'agent',
          authzVersion: 1,
        },
        anchorStart: anchors!.anchorStart,
        anchorEnd: anchors!.anchorEnd,
        replacement: 'earth',
        expectedText: 'planet',
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: 'stale-intent',
    })
    expect(backend.updatesFor(documentName)).toHaveLength(0)
    await expect(
      store.getSemanticOperation(
        semanticOperationKey(documentName, 'op_stale'),
      ),
    ).resolves.toBeNull()
  })

  it('uses Postgres-safe semantic operation keys', () => {
    const key = semanticOperationKey(
      'create:workspace_1:notes/new.md',
      'op:1/2',
    )

    expect(key).not.toContain('\0')
    expect(key).toBe('create%3Aworkspace_1%3Anotes%2Fnew.md::op%3A1%2F2')
  })

  it('serializes duplicate operationIds through the persistence layer', async () => {
    const { backend, handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const body = {
      operationId: 'op_race',
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      actor: {
        userId: 'agent_1',
        actorKind: 'agent',
        authzVersion: 1,
      },
      anchorStart: anchors!.anchorStart,
      anchorEnd: anchors!.anchorEnd,
      replacement: 'earth',
      expectedText: 'world',
    }

    const responses = await Promise.all([
      handler(request(body)),
      handler(request(body)),
    ])

    expect(responses.every((response) => response.status === 200)).toBe(true)
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    )
    expect(payloads.filter((payload) => payload.deduped === true)).toHaveLength(
      1,
    )
    expect(backend.updatesFor(documentName)).toHaveLength(1)
  })

  it('applies anchored replacements to the live Y.Doc before returning', async () => {
    const liveDocuments = new Map<string, Y.Doc>()
    const liveDoc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    liveDocuments.set(documentName, liveDoc)
    const { backend, handler, store } = makeHandler(true, liveDocuments)
    await store.storeSnapshot(documentName, liveDoc, { lastSeq: 0 })
    const anchors = createAnchorsForText(liveDoc, 'world')
    expect(anchors).not.toBeNull()

    const response = await handler(
      request({
        operationId: 'op_live',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actor: {
          userId: 'agent_1',
          actorKind: 'agent',
          authzVersion: 1,
        },
        anchorStart: anchors!.anchorStart,
        anchorEnd: anchors!.anchorEnd,
        replacement: 'earth',
        expectedText: 'world',
      }),
    )

    expect(response.status).toBe(200)
    expect(backend.updatesFor(documentName)).toHaveLength(1)
    expect(yDocToMarkdown(liveDoc)).toContain('Hello earth.')
    await expect(
      store.loadDocument(documentName).then(yDocToMarkdown),
    ).resolves.toContain('Hello earth.')
  })

  it('inserts text at a resolved Y.RelativePosition anchor', async () => {
    const { backend, handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const response = await handler(
      new Request('http://localhost/apply/insertText', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'op_insert_text',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actor: {
            userId: 'agent_1',
            actorKind: 'agent',
            authzVersion: 1,
          },
          anchor: anchors!.anchorStart,
          text: 'brave ',
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(backend.updatesFor(documentName)).toHaveLength(1)
    await expect(
      store.loadDocument(documentName).then(yDocToMarkdown),
    ).resolves.toContain('Hello brave world.')
  })

  it('creates Y.RelativePosition anchors from live document text', async () => {
    const { handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const response = await handler(
      new Request('http://localhost/apply/createAnchorsForText', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actor: {
            userId: 'agent_1',
            actorKind: 'agent',
            authzVersion: 1,
          },
          expectedText: 'world',
        }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      anchorStart: expect.any(String),
      anchorEnd: expect.any(String),
    })
  })

  it('inserts markdown content after a heading', async () => {
    const { backend, handler, store } = makeHandler()
    const doc = markdownToYDoc('---\nid: atom_1\n---\n# Intro\n\nOld body.')
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const response = await handler(
      new Request('http://localhost/apply/insertAfterHeading', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'op_insert_heading',
          workspaceId: 'workspace_1',
          atomId: 'atom_1',
          actor: {
            userId: 'agent_1',
            actorKind: 'agent',
            authzVersion: 1,
          },
          headingText: 'Intro',
          content: 'Inserted note.',
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(backend.updatesFor(documentName)).toHaveLength(1)
    await expect(
      store.loadDocument(documentName).then(yDocToMarkdown),
    ).resolves.toMatch(/# Intro\s+Inserted note\.\s+Old body\./)
  })

  it('creates a backend atom and initializes its canonical Y.Doc snapshot', async () => {
    const { acl, handler, store } = makeHandler()

    const response = await handler(
      new Request('http://localhost/apply/createAtom', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'op_create_atom',
          workspaceId: 'workspace_1',
          path: 'new.md',
          content: 'Created body.',
          actor: {
            userId: 'agent_1',
            actorKind: 'agent',
            authzVersion: 1,
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operation: 'createAtom',
      atomId: 'created_atom',
      path: 'new.md',
    })
    expect(acl.createAtom).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      path: 'new.md',
      content: 'Created body.',
      userId: 'agent_1',
      actorKind: 'agent',
      authzVersion: 1,
    })
    await expect(
      store
        .loadDocument(
          encodeDocName({ workspaceId: 'workspace_1', atomId: 'created_atom' }),
        )
        .then(yDocToMarkdown),
    ).resolves.toContain('Created body.')
  })

  it('creates site source atoms as plain-text Y.Docs so source code survives', async () => {
    const { handler, store } = makeHandler()
    const source = [
      'import React from "react"',
      '',
      'export default function App() {',
      '  return <main>{items.map((item) => <span>{item}</span>)}</main>',
      '}',
    ].join('\n')

    const response = await handler(
      new Request('http://localhost/apply/createAtom', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'op_create_view_source',
          workspaceId: 'workspace_1',
          path: 'sites/workspace/src/App.tsx',
          content: source,
          actor: {
            userId: 'agent_1',
            actorKind: 'agent',
            authzVersion: 1,
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(
      store
        .loadDocument(
          encodeDocName({ workspaceId: 'workspace_1', atomId: 'created_atom' }),
        )
        .then(yDocToMarkdown),
    ).resolves.toContain('return <main>{items.map')
  })

  it('rechecks write access for the actor before applying', async () => {
    const { handler } = makeHandler(false)

    const response = await handler(
      request({
        operationId: 'op_denied',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actor: {
          userId: 'agent_1',
          actorKind: 'agent',
          authzVersion: 1,
        },
        anchorStart: 'a',
        anchorEnd: 'b',
        replacement: 'earth',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('treats app-origin semantic writes as a distinct final ACL actor', async () => {
    const { acl, backend, handler, store } = makeHandler(false)
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const response = await handler(
      request({
        operationId: 'op_app_locked',
        workspaceId: 'workspace_1',
        atomId: 'atom_1',
        actor: {
          userId: 'workspace_1',
          actorKind: 'app',
          authzVersion: 1,
        },
        anchorStart: anchors!.anchorStart,
        anchorEnd: anchors!.anchorEnd,
        replacement: 'earth',
        expectedText: 'world',
      }),
    )

    expect(response.status).toBe(403)
    expect(acl.canWriteAtom).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
      userId: 'workspace_1',
      actorKind: 'app',
      authzVersion: 1,
    })
    expect(backend.updatesFor(documentName)).toHaveLength(0)
  })
})
