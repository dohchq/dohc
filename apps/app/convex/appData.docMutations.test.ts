/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const ADMIN_URL = 'http://hocuspocus.local'
const ADMIN_TOKEN = 'admin-token'
const ALICE = 'ws_doc_mutations_alice'
const BOB = 'ws_doc_mutations_bob'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Finance Team' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now() })
  })
}

async function seedTracker(t: ReturnType<typeof convexTest>, workspaceId: string) {
  await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    JSON.stringify({
      title: 'Finance Tracker',
      read: ['notes.md'],
      write: ['notes.md'],
    }),
  )
  await seedAtom(
    t,
    workspaceId,
    'finance/notes.md',
    ['---', 'id: note_1', '---', 'Review cadence: monthly'].join('\n'),
  )
}

function stubSemanticFetch() {
  vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
  vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(url).endsWith('/createAnchorsForText')) {
      return new Response(JSON.stringify({
        ok: true,
        anchorStart: `start:${body.expectedText}`,
        anchorEnd: `end:${body.expectedText}`,
      }))
    }
    if (String(url).endsWith('/replaceRange')) {
      return new Response(JSON.stringify({
        ok: true,
        operationId: body.operationId,
        atomId: body.atomId,
      }))
    }
    return new Response(JSON.stringify({ ok: false, reason: 'unexpected-route' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('appData document mutations', () => {
  it('applies app doc replaceText through Hocuspocus semantic writes', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: workspaceId,
      packageRoot: 'finance/.apps/tracker',
    })
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.appData.runDocMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        op: 'replaceText',
        path: 'notes.md',
        find: 'Review cadence: monthly',
        with: 'Review cadence: weekly',
        clientMutationId: 'doc-replace-1',
      },
    )

    expect(result).toMatchObject({
      ok: true,
      operation: 'doc.replaceText',
      path: 'finance/notes.md',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      actor: { userId: ALICE, actorKind: 'app' },
    })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      operationId: 'appDoc:finance/.apps/tracker:replaceText:doc-replace-1',
      actor: { userId: ALICE, actorKind: 'app' },
      expectedText: 'Review cadence: monthly',
      replacement: 'Review cadence: weekly',
    })
  })

  it('requires per-user trust before app document writes', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: workspaceId,
      packageRoot: 'finance/.apps/tracker',
    })
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: BOB }).action(
      api.appData.runDocMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        op: 'append',
        path: 'notes.md',
        markdown: '- New note',
        clientMutationId: 'bob-doc-append',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'app-trust-required' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
