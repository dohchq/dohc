/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi, afterEach } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const SERVER_SECRET = 'test-agent-secret'
const ADMIN_URL = 'http://hocuspocus.local:1234'
const ADMIN_TOKEN = 'admin-token'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function seedAtom(t: ReturnType<typeof convexTest>): Promise<Id<'atoms'>> {
  return (await t.mutation(internal.atoms._upsertInternal, {
    workspaceId: OWNER,
    path: 'docs/intro.md',
    body: '---\nid: intro\n---\nHello world.',
    source: 'user',
  })) as Id<'atoms'>
}

async function createSuggestion(
  t: ReturnType<typeof convexTest>,
  atomId: Id<'atoms'>,
) {
  vi.stubEnv('DOHC_AGENT_SECRET', SERVER_SECRET)
  return await t.mutation(internal.atomSuggestions._createSuggestion, {
    atomId,
    workspaceId: OWNER,
    anchorStart: 'anchor-start',
    anchorEnd: 'anchor-end',
    proposedText: 'earth',
    instruction: 'tighten wording',
    authorUserId: OWNER,
    authorUserName: 'Ice',
    agentSecret: SERVER_SECRET,
    expectedText: 'world',
    expectedPrefix: 'Hello ',
    expectedSuffix: '.',
    createdFromProjectionHash: 'sha256:projection',
  })
}

function suggestionId(
  result: Awaited<ReturnType<typeof createSuggestion>>,
): Id<'atomSuggestions'> {
  expect(result).toMatchObject({ ok: true })
  return (result as { ok: true; id: Id<'atomSuggestions'> }).id
}

describe('v2 atomSuggestions anchors', () => {
  it('stores Y.RelativePosition anchors and semantic witnesses', async () => {
    const t = convexTest(schema, modules)
    const atomId = await seedAtom(t)

    const result = await createSuggestion(t, atomId)

    const id = suggestionId(result)
    const row = (await t.run(async (ctx) => ctx.db.get(id))) as any
    expect(row).toMatchObject({
      atomId,
      workspaceId: OWNER,
      anchorStart: 'anchor-start',
      anchorEnd: 'anchor-end',
      proposedText: 'earth',
      expectedText: 'world',
      expectedPrefix: 'Hello ',
      expectedSuffix: '.',
      createdFromProjectionHash: 'sha256:projection',
      authorIsAgent: true,
      status: 'pending',
    })
    expect(row?.rangeFrom).toBeUndefined()
    expect(row?.rangeTo).toBeUndefined()
  })

  it('lists pending suggestions with anchors instead of markdown offsets', async () => {
    const t = convexTest(schema, modules)
    const atomId = await seedAtom(t)
    const result = await createSuggestion(t, atomId)
    const id = suggestionId(result)

    const rows = (await t
      .withIdentity({ subject: OWNER, name: 'Ice' })
      .query(api.atomSuggestions.listPending, { atomId })) as any[]

    expect(rows).toEqual([
      expect.objectContaining({
        _id: id,
        anchorStart: 'anchor-start',
        anchorEnd: 'anchor-end',
        expectedText: 'world',
        expectedPrefix: 'Hello ',
        expectedSuffix: '.',
        createdFromProjectionHash: 'sha256:projection',
      }),
    ])
    expect(rows[0]?.rangeFrom).toBeUndefined()
    expect(rows[0]?.rangeTo).toBeUndefined()
  })

  it('rejects suggestions without mutating document content', async () => {
    const t = convexTest(schema, modules)
    const atomId = await seedAtom(t)
    const result = await createSuggestion(t, atomId)
    const id = suggestionId(result)

    await expect(
      t
        .withIdentity({ subject: OWNER, name: 'Ice' })
        .mutation(api.atomSuggestions.rejectSuggestion, {
          suggestionId: id,
        }),
    ).resolves.toEqual({ ok: true, alreadyResolved: false })

    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    const row = await t.run(async (ctx) => ctx.db.get(id))
    expect(atom?.body).toContain('Hello world.')
    expect(row).toMatchObject({
      status: 'rejected',
      resolvedByUserId: OWNER,
      resolvedByUserName: 'Ice',
    })
  })

  it('accepts suggestions through Hocuspocus without splicing the markdown cache', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ ok: true, operationId: 'accept-suggestion' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const atomId = await seedAtom(t)
    const result = await createSuggestion(t, atomId)
    const id = suggestionId(result)

    await expect(
      t
        .withIdentity({ subject: OWNER, name: 'Ice' })
        .action(api.atomSuggestions.acceptSuggestion, {
          suggestionId: id,
        }),
    ).resolves.toEqual({ ok: true, alreadyResolved: false })

    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    const row = (await t.run(async (ctx) => ctx.db.get(id))) as any
    expect(atom?.body).toContain('Hello world.')
    expect(row).toMatchObject({
      status: 'accepted',
      resolvedByUserId: OWNER,
      resolvedByUserName: 'Ice',
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${ADMIN_URL}/apply/replaceRange`)
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(init.body as string)).toMatchObject({
      operationId: `acceptSuggestion:${id}`,
      workspaceId: OWNER,
      atomId: 'intro',
      replacement: 'earth',
      expectedText: 'world',
      expectedPrefix: 'Hello ',
      expectedSuffix: '.',
      actor: {
        userId: OWNER,
        actorKind: 'user',
        authzVersion: 1,
      },
    })
  })
})
