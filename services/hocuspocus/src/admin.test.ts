import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAdminHandler,
  RevocationRegistry,
  writeNodeAdminResponse,
} from './admin.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

async function requestThroughNodeBridge(
  path: string,
  handler: Parameters<typeof writeNodeAdminResponse>[2],
  init?: RequestInit,
): Promise<Response> {
  const server = createServer(async (request, response) => {
    const handled = await writeNodeAdminResponse(request, response, handler)
    if (!handled) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'unhandled' }))
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return fetch(`http://127.0.0.1:${address.port}${path}`, init)
}

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

  it('returns a structured 400 for malformed admin JSON', async () => {
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations: new RevocationRegistry(),
    })

    const response = await handler(
      new Request('http://localhost/admin/disconnect-by-workspace-user', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: '{',
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'invalid request',
    })
  })

  it('deletes persisted document state by workspace and atom id', async () => {
    const store = { deleteDocument: vi.fn(async () => {}) }
    const handler = createAdminHandler({
      adminToken: 'admin-token',
      revocations: new RevocationRegistry(),
      store,
    })

    const response = await handler(
      new Request('http://localhost/admin/delete-document', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ workspaceId: 'workspace_1', atomId: 'atom_1' }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(store.deleteDocument).toHaveBeenCalledWith(
      'workspace/workspace_1/atom/atom_1',
    )
  })

  it('bridges semantic apply requests through the node response adapter', async () => {
    const handler = vi.fn(async (request: Request) => {
      const body = await request.json()
      return new Response(
        JSON.stringify({
          ok: true,
          path: new URL(request.url).pathname,
          body,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const response = await requestThroughNodeBridge('/apply/replaceRange', handler, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'op_1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: '/apply/replaceRange',
      body: { operationId: 'op_1' },
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
