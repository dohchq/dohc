/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { MAP_PATH } from './inlineAtom'

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const GRANTEE = 'ws_grantee'
const STRANGER = 'ws_stranger'
const ADMIN_URL = 'http://hocuspocus.local:1234'
const ADMIN_TOKEN = 'admin-token'

function stubAdminEnv() {
  vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
  vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
}

type FetchCall = [string, RequestInit]
type FetchMock = ((url: string, init: RequestInit) => Promise<Response>) & {
  mock: { calls: FetchCall[] }
}

function makeFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as FetchMock
}

function firstFetchCall(fetch: FetchMock): FetchCall {
  const call = fetch.mock.calls[0]
  expect(call).toBeDefined()
  return call
}

async function seedOwnerAtom(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.atoms._upsertInternal, {
    workspaceId: OWNER,
    path: 'doc.md',
    body: '---\nid: doc\n---\n# Doc',
    source: 'user',
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Hocuspocus admin disconnect bridge', () => {
  it('posts a workspace-user disconnect to Hocuspocus admin', async () => {
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)

    await t.action(internal.hocuspocusAdmin.disconnectWorkspaceUser, {
      workspaceId: OWNER,
      userId: GRANTEE,
    })

    const [url, init] = firstFetchCall(fetch)
    expect(url).toBe(`${ADMIN_URL}/admin/disconnect-by-workspace-user`)
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: OWNER,
      userId: GRANTEE,
    })
  })

  it('skips the direct admin action when collab is not configured', async () => {
    const t = convexTest(schema, modules)
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)

    await expect(
      t.action(internal.hocuspocusAdmin.disconnectWorkspaceUser, {
        workspaceId: OWNER,
        userId: GRANTEE,
      }),
    ).resolves.toEqual({ ok: false, skipped: 'missing-env' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts document deletion to Hocuspocus admin', async () => {
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)

    await t.action(internal.hocuspocusAdmin.deleteDocument, {
      workspaceId: OWNER,
      atomId: 'doc',
    })

    const [url, init] = firstFetchCall(fetch)
    expect(url).toBe(`${ADMIN_URL}/admin/delete-document`)
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: OWNER,
      atomId: 'doc',
    })
  })

  it('fails share revocation loudly when collab tokens are configured without admin disconnect env', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_JWT_SECRET', 'jwt-secret')
    await seedOwnerAtom(t)
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })

    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.atomShares.unshareAtom, {
        shareId,
      }),
    ).rejects.toThrow(/HOCUSPOCUS_ADMIN_URL and HOCUSPOCUS_ADMIN_TOKEN/)
    await expect(
      t.withIdentity({ subject: OWNER }).query(api.atomShares.listMyShares, {}),
    ).resolves.toHaveLength(1)
  })

  it('schedules a disconnect when a person share is revoked', async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)
    await seedOwnerAtom(t)
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.unshareAtom, { shareId })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())

    const [url, init] = firstFetchCall(fetch)
    expect(url).toBe(`${ADMIN_URL}/admin/disconnect-by-workspace-user`)
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: OWNER,
      userId: GRANTEE,
    })
  })

  it('schedules persisted Y.Doc deletion when an atom is deleted', async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)
    await seedOwnerAtom(t)

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atoms.remove, { path: 'doc.md' })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())

    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string),
    )
    expect(bodies).toContainEqual({ workspaceId: OWNER, atomId: 'doc' })
  })

  it('deletes obsolete map atoms without requiring Hocuspocus admin env', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_JWT_SECRET', 'jwt-secret')
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: OWNER,
      path: MAP_PATH,
      body: '---\nid: _map\n---\n# Map',
      source: 'agent',
    })

    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.atoms.remove, {
        path: MAP_PATH,
      }),
    ).resolves.toBeNull()
  })

  it('schedules org member disconnects when an org share is revoked, excluding the owner', async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)
    const { orgId, inviteCode } = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.orgs.createOrg, { name: 'Acme Inc' })
    await t
      .withIdentity({ subject: GRANTEE })
      .mutation(api.orgs.joinOrg, { inviteCode })
    await seedOwnerAtom(t)
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtomToOrg, {
        fileId: 'doc',
        orgId,
        permission: 'view',
      })

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.unshareAtom, { shareId })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())

    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string),
    )
    expect(bodies).toContainEqual({ workspaceId: OWNER, userId: GRANTEE })
    expect(bodies).not.toContainEqual({ workspaceId: OWNER, userId: OWNER })
    expect(bodies).not.toContainEqual({ workspaceId: OWNER, userId: STRANGER })
  })

  it('schedules disconnects from each shared owner workspace when a member leaves an org', async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    stubAdminEnv()
    const fetch = makeFetch()
    vi.stubGlobal('fetch', fetch)
    const { orgId, inviteCode } = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.orgs.createOrg, { name: 'Acme Inc' })
    await t
      .withIdentity({ subject: GRANTEE })
      .mutation(api.orgs.joinOrg, { inviteCode })
    await seedOwnerAtom(t)
    await t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtomToOrg, {
      fileId: 'doc',
      orgId,
      permission: 'view',
    })

    await t.withIdentity({ subject: GRANTEE }).mutation(api.orgs.leaveOrg, { orgId })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())

    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string),
    )
    expect(bodies).toContainEqual({ workspaceId: OWNER, userId: GRANTEE })
  })
})
