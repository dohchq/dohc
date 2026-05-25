import { describe, expect, it, vi } from 'vitest'
import { createAdminHandler, RevocationRegistry } from './admin.js'

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

  it('reports whether this server can bootstrap atoms from Convex', async () => {
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations: new RevocationRegistry(),
      capabilities: { atomBootstrap: true },
    })

    const response = await handler(new Request('http://localhost/capabilities'))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      capabilities: { atomBootstrap: true },
    })
  })

  it('disconnects registered workspace-user sockets without sticky denial', async () => {
    const revocations = new RevocationRegistry()
    const connection = { socketId: 'socket_1', close: vi.fn() }
    revocations.registerConnection({
      workspaceId: 'workspace_1',
      userId: 'user_1',
      connection,
    })
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
      disconnected: 1,
    })
    expect(connection.close).toHaveBeenCalledWith({
      code: 4001,
      reason: 'access_revoked',
    })

    const reconnected = { socketId: 'socket_2', close: vi.fn() }
    revocations.registerConnection({
      workspaceId: 'workspace_1',
      userId: 'user_1',
      connection: reconnected,
    })
    expect(reconnected.close).not.toHaveBeenCalled()
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
