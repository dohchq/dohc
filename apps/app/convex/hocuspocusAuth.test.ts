/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const GRANTEE = 'ws_grantee'
const STRANGER = 'ws_stranger'
const SERVER_TOKEN = 'test-hocuspocus-server-token'

function stubServerToken() {
  vi.stubEnv('HOCUSPOCUS_CONVEX_SERVER_TOKEN', SERVER_TOKEN)
}

async function seedOwnerAtom(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: string,
) {
  await t.mutation(internal.atoms._upsertInternal, {
    workspaceId: OWNER,
    path,
    body,
    source: 'user',
  })
}

async function checkAccess(
  t: ReturnType<typeof convexTest>,
  args: {
    serverToken?: string
    userId: string
    workspaceId?: string
    atomId?: string
    actorKind?: 'user' | 'agent'
    authzVersion?: number
  },
) {
  return await t.query(api.hocuspocusAuth.checkAtomAccess, {
    serverToken: args.serverToken ?? SERVER_TOKEN,
    userId: args.userId,
    workspaceId: args.workspaceId ?? OWNER,
    atomId: args.atomId ?? 'doc',
    actorKind: args.actorKind ?? 'user',
    authzVersion: args.authzVersion ?? 1,
  })
}

async function loadBootstrap(
  t: ReturnType<typeof convexTest>,
  args: {
    serverToken?: string
    userId?: string
    workspaceId?: string
    atomId?: string
    actorKind?: 'user' | 'agent'
    authzVersion?: number
  } = {},
) {
  return await t.query(api.hocuspocusAuth.loadAtomBootstrap, {
    serverToken: args.serverToken ?? SERVER_TOKEN,
    userId: args.userId ?? OWNER,
    workspaceId: args.workspaceId ?? OWNER,
    atomId: args.atomId ?? 'doc',
    actorKind: args.actorKind ?? 'user',
    authzVersion: args.authzVersion ?? 1,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('hocuspocus Convex ACL bridge', () => {
  it('rejects requests without the server token', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()

    await expect(
      checkAccess(t, { serverToken: 'wrong-token', userId: OWNER }),
    ).rejects.toThrow(/server token/i)
  })

  it('allows the owner to read and write an unlocked atom by fileId', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc')

    await expect(checkAccess(t, { userId: OWNER })).resolves.toEqual({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: true,
    })
  })

  it('lets the owner read but not write a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await t.mutation(internal.atoms._upsertSystem, {
      workspaceId: OWNER,
      path: '_map.md',
      body: '---\nid: _map\n---\nSystem map',
      source: 'agent',
    })

    await expect(
      checkAccess(t, { userId: OWNER, atomId: '_map' }),
    ).resolves.toEqual({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: false,
    })
  })

  it('lets a human owner write userLocked atoms but blocks owner agent writes', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc')
    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atoms.setLock, { path: 'doc.md', locked: true })

    await expect(
      checkAccess(t, { userId: OWNER, actorKind: 'user' }),
    ).resolves.toMatchObject({
      canRead: true,
      canWrite: true,
    })
    await expect(
      checkAccess(t, { userId: OWNER, actorKind: 'agent' }),
    ).resolves.toMatchObject({
      canRead: true,
      canWrite: false,
    })
  })

  it('allows a person view share to read but not write', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc')
    await t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtom, {
      fileId: 'doc',
      granteeWorkspaceId: GRANTEE,
      permission: 'view',
    })

    await expect(checkAccess(t, { userId: GRANTEE })).resolves.toEqual({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: false,
    })
  })

  it('allows a person edit share to write only while the atom is not owner-locked', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc')
    await t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtom, {
      fileId: 'doc',
      granteeWorkspaceId: GRANTEE,
      permission: 'edit',
    })

    await expect(checkAccess(t, { userId: GRANTEE })).resolves.toEqual({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: true,
    })

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atoms.setLock, { path: 'doc.md', locked: true })

    await expect(checkAccess(t, { userId: GRANTEE })).resolves.toEqual({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: false,
    })
  })

  it('allows org members to read org shares and denies strangers', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    const { orgId, inviteCode } = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.orgs.createOrg, { name: 'Acme Inc' })
    await t
      .withIdentity({ subject: GRANTEE })
      .mutation(api.orgs.joinOrg, { inviteCode })
    await seedOwnerAtom(t, 'roadmap.md', '---\nid: roadmap\n---\nQ3')
    await t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtomToOrg, {
      fileId: 'roadmap',
      orgId,
      permission: 'view',
    })

    await expect(
      checkAccess(t, { userId: GRANTEE, atomId: 'roadmap' }),
    ).resolves.toMatchObject({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: false,
    })
    await expect(
      checkAccess(t, { userId: STRANGER, atomId: 'roadmap' }),
    ).resolves.toMatchObject({
      workspaceAuthzVersion: 1,
      canRead: false,
      canWrite: false,
    })
  })

  it('rejects bootstrap reads without the server token', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()

    await expect(
      loadBootstrap(t, { serverToken: 'wrong-token' }),
    ).rejects.toThrow(/server token/i)
  })

  it('loads bootstrap markdown for an owner atom by fileId', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    const body = '---\nid: doc\n---\n# Doc\n\nBody'
    await seedOwnerAtom(t, 'doc.md', body)

    await expect(loadBootstrap(t)).resolves.toEqual({ markdown: body })
  })

  it('denies bootstrap markdown when the actor cannot read the atom', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc')

    await expect(loadBootstrap(t, { userId: STRANGER })).resolves.toBeNull()
  })

  it('returns null when bootstrap atom lookup misses', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()

    await expect(loadBootstrap(t, { atomId: 'missing' })).resolves.toBeNull()
  })
})
