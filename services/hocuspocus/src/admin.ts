import type { IncomingMessage, ServerResponse } from 'node:http'

export type RevocableConnection = {
  socketId: string
  close(options?: { code?: number; reason?: string }): void
}

export class RevocationRegistry {
  private readonly revokedWorkspaceUsers = new Set<string>()
  private readonly connectionsByWorkspaceUser = new Map<
    string,
    Map<string, RevocableConnection>
  >()
  private readonly workspaceUserBySocket = new Map<string, string>()

  revokeWorkspaceUser(workspaceId: string, userId: string): number {
    const key = this.key(workspaceId, userId)
    this.revokedWorkspaceUsers.add(key)

    const connections = this.connectionsByWorkspaceUser.get(key)
    if (!connections) return 0

    let disconnected = 0
    for (const [socketId, connection] of connections) {
      connection.close({ code: 4001, reason: 'access_revoked' })
      this.workspaceUserBySocket.delete(socketId)
      disconnected += 1
    }
    this.connectionsByWorkspaceUser.delete(key)
    return disconnected
  }

  isRevoked(workspaceId: string, userId: string): boolean {
    return this.revokedWorkspaceUsers.has(this.key(workspaceId, userId))
  }

  registerConnection(input: {
    workspaceId: string
    userId: string
    connection: RevocableConnection
  }): void {
    const key = this.key(input.workspaceId, input.userId)
    if (this.isRevoked(input.workspaceId, input.userId)) {
      input.connection.close({ code: 4001, reason: 'access_revoked' })
      return
    }

    const connections = this.connectionsByWorkspaceUser.get(key) ?? new Map()
    connections.set(input.connection.socketId, input.connection)
    this.connectionsByWorkspaceUser.set(key, connections)
    this.workspaceUserBySocket.set(input.connection.socketId, key)
  }

  unregisterSocket(socketId: string): void {
    const key = this.workspaceUserBySocket.get(socketId)
    if (!key) return

    this.workspaceUserBySocket.delete(socketId)
    const connections = this.connectionsByWorkspaceUser.get(key)
    connections?.delete(socketId)
    if (connections?.size === 0) {
      this.connectionsByWorkspaceUser.delete(key)
    }
  }

  private key(workspaceId: string, userId: string): string {
    return `${workspaceId}\0${userId}`
  }
}

export type AdminHandlerOptions = {
  adminToken: string
  revocations: RevocationRegistry
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function hasAdminToken(request: Request, adminToken: string): boolean {
  return request.headers.get('authorization') === `Bearer ${adminToken}`
}

export function createAdminHandler({
  adminToken,
  revocations,
}: AdminHandlerOptions): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'dohc-hocuspocus' })
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/admin/disconnect-by-workspace-user'
    ) {
      if (!hasAdminToken(request, adminToken)) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, { status: 401 })
      }

      const body = (await request.json()) as {
        workspaceId?: unknown
        userId?: unknown
      }
      if (typeof body.workspaceId !== 'string' || typeof body.userId !== 'string') {
        return jsonResponse({ ok: false, error: 'invalid request' }, { status: 400 })
      }

      const disconnected = revocations.revokeWorkspaceUser(
        body.workspaceId,
        body.userId,
      )
      return jsonResponse({ ok: true, disconnected })
    }

    return jsonResponse({ ok: false, error: 'not found' }, { status: 404 })
  }
}

export async function writeNodeAdminResponse(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<boolean> {
  if (!request.url?.startsWith('/healthz') && !request.url?.startsWith('/admin/')) {
    return false
  }

  const webRequest = await toWebRequest(request)
  const webResponse = await handler(webRequest)
  response.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers.entries()),
  )
  response.end(await webResponse.text())
  return true
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const origin = `http://${request.headers.host ?? 'localhost'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    if (Array.isArray(value)) headers.set(key, value.join(', '))
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await readBody(request)

  return new Request(new URL(request.url ?? '/', origin), {
    method: request.method,
    headers,
    body: body ? bufferToArrayBuffer(body) : undefined,
  })
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(copy).set(buffer)
  return copy
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('error', reject)
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })
}
