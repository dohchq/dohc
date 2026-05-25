import { describe, expect, it } from 'vitest'
import { createAdminHandler, RevocationRegistry } from './admin'

describe('hocuspocus admin handler', () => {
  it('returns a health response', async () => {
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations: new RevocationRegistry(),
    })

    const response = await handler(new Request('http://localhost/healthz'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'dohc-hocuspocus',
    })
  })

  it('records a workspace-user disconnect request', async () => {
    const revocations = new RevocationRegistry()
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations,
    })

    const response = await handler(
      new Request('http://localhost/admin/disconnect-by-workspace-user', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ workspaceId: 'workspace_1', userId: 'user_1' }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      disconnected: 0,
    })
    expect(revocations.isRevoked('workspace_1', 'user_1')).toBe(true)
  })

  it('rejects admin mutations without the admin token', async () => {
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations: new RevocationRegistry(),
    })

    const response = await handler(
      new Request('http://localhost/admin/disconnect-by-workspace-user', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'workspace_1', userId: 'user_1' }),
      }),
    )

    expect(response.status).toBe(401)
  })
})
