import { getFunctionName, type FunctionReference } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import { createConvexAcl } from './convex-acl.js'

type FakeConvexClient = {
  query: ReturnType<typeof vi.fn>
}

function fakeClient(result: unknown): FakeConvexClient {
  return {
    query: vi.fn(async () => result),
  }
}

function fakeAclClient(result: {
  workspaceAuthzVersion: number
  canRead: boolean
  canWrite: boolean
}): FakeConvexClient {
  return fakeClient(result)
}

describe('Convex ACL adapter', () => {
  it('queries the secret-protected Convex ACL function for workspace version', async () => {
    const client = fakeAclClient({
      workspaceAuthzVersion: 7,
      canRead: true,
      canWrite: false,
    })
    const acl = createConvexAcl({
      convexUrl: 'https://example.convex.cloud',
      serverToken: 'server-token',
      client,
    })

    await expect(
      acl.getWorkspaceAuthzVersion({
        workspaceId: 'workspace_1',
        userId: 'user_1',
        atomId: 'atom_1',
        actorKind: 'agent',
        authzVersion: 7,
      }),
    ).resolves.toBe(7)

    const [fn, args] = client.query.mock.calls[0] as [
      FunctionReference<'query'>,
      Record<string, unknown>,
    ]
    expect(getFunctionName(fn)).toBe('hocuspocusAuth:checkAtomAccess')
    expect(args).toEqual({
      serverToken: 'server-token',
      workspaceId: 'workspace_1',
      userId: 'user_1',
      atomId: 'atom_1',
      actorKind: 'agent',
      authzVersion: 7,
    })
  })

  it('maps Convex canRead/canWrite responses without caching', async () => {
    const client = fakeAclClient({
      workspaceAuthzVersion: 1,
      canRead: true,
      canWrite: false,
    })
    const acl = createConvexAcl({
      convexUrl: 'https://example.convex.cloud',
      serverToken: 'server-token',
      client,
    })
    const input = {
      workspaceId: 'workspace_1',
      userId: 'user_1',
      atomId: 'atom_1',
      actorKind: 'user' as const,
      authzVersion: 1,
    }

    await expect(acl.canReadAtom(input)).resolves.toBe(true)
    await expect(acl.canWriteAtom(input)).resolves.toBe(false)

    expect(client.query).toHaveBeenCalledTimes(2)
  })

  it('loads bootstrap markdown through the secret-protected Convex function', async () => {
    const client = fakeClient({ markdown: '---\nid: atom_1\n---\n# Atom' })
    const acl = createConvexAcl({
      convexUrl: 'https://example.convex.cloud',
      serverToken: 'server-token',
      client,
    })

    await expect(
      acl.loadAtomBootstrap?.({
        workspaceId: 'workspace_1',
        userId: 'user_1',
        atomId: 'atom_1',
        actorKind: 'user',
        authzVersion: 1,
      }),
    ).resolves.toEqual({ markdown: '---\nid: atom_1\n---\n# Atom' })

    const [fn, args] = client.query.mock.calls[0] as [
      FunctionReference<'query'>,
      Record<string, unknown>,
    ]
    expect(getFunctionName(fn)).toBe('hocuspocusAuth:loadAtomBootstrap')
    expect(args).toEqual({
      serverToken: 'server-token',
      workspaceId: 'workspace_1',
      atomId: 'atom_1',
    })
  })

  it('maps missing bootstrap markdown to null', async () => {
    const client = fakeClient(null)
    const acl = createConvexAcl({
      convexUrl: 'https://example.convex.cloud',
      serverToken: 'server-token',
      client,
    })

    await expect(
      acl.loadAtomBootstrap?.({
        workspaceId: 'workspace_1',
        userId: 'user_1',
        atomId: 'missing',
        actorKind: 'user',
        authzVersion: 1,
      }),
    ).resolves.toBeNull()
  })
})
