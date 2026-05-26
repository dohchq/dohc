import type { IncomingMessage, ServerResponse } from 'node:http'
import { encodeDocName } from './doc-name.js'
import type { PostgresYDocStore } from './persistence.js'

export type RevocableConnection = {
  socketId: string
  close(options?: { code?: number; reason?: string }): void
}

export class RevocationRegistry {
  private readonly connectionsByWorkspaceUser = new Map<
    string,
    Map<string, RevocableConnection>
  >()
  private readonly workspaceUserBySocket = new Map<string, string>()

  revokeWorkspaceUser(workspaceId: string, userId: string): number {
    const key = this.key(workspaceId, userId)

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

  registerConnection(input: {
    workspaceId: string
    userId: string
    connection: RevocableConnection
  }): void {
    const key = this.key(input.workspaceId, input.userId)

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
  store?: Pick<PostgresYDocStore, 'deleteDocument'>
  capabilities?: {
    atomBootstrap?: boolean
  }
}

const MAX_ADMIN_BODY_BYTES = 64 * 1024

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'access-control-allow-origin': '*',
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function hasAdminToken(request: Request, adminToken: string): boolean {
  return request.headers.get('authorization') === `Bearer ${adminToken}`
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null
    }
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

export function createAdminHandler({
  adminToken,
  revocations,
  store,
  capabilities,
}: AdminHandlerOptions): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'dohc-hocuspocus' })
    }

    if (request.method === 'GET' && url.pathname === '/capabilities') {
      return jsonResponse({
        ok: true,
        service: 'dohc-hocuspocus',
        capabilities: {
          atomBootstrap: capabilities?.atomBootstrap === true,
        },
      })
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/admin/disconnect-by-workspace-user'
    ) {
      if (!hasAdminToken(request, adminToken)) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, { status: 401 })
      }

      const body = await readJsonObject(request)
      if (
        !body ||
        typeof body.workspaceId !== 'string' ||
        typeof body.userId !== 'string'
      ) {
        return jsonResponse({ ok: false, error: 'invalid request' }, { status: 400 })
      }

      const disconnected = revocations.revokeWorkspaceUser(
        body.workspaceId,
        body.userId,
      )
      return jsonResponse({ ok: true, disconnected })
    }

    if (request.method === 'POST' && url.pathname === '/admin/delete-document') {
      if (!hasAdminToken(request, adminToken)) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, { status: 401 })
      }
      if (!store) {
        return jsonResponse(
          { ok: false, error: 'store unavailable' },
          { status: 503 },
        )
      }

      const body = await readJsonObject(request)
      if (
        !body ||
        typeof body.workspaceId !== 'string' ||
        typeof body.atomId !== 'string'
      ) {
        return jsonResponse({ ok: false, error: 'invalid request' }, { status: 400 })
      }

      const documentName = encodeDocName({
        workspaceId: body.workspaceId,
        atomId: body.atomId,
      })
      await store.deleteDocument(documentName)
      const disconnected = revocations.revokeWorkspaceUser(
        body.workspaceId,
        body.workspaceId,
      )
      return jsonResponse({ ok: true, deleted: documentName, disconnected })
    }

    return jsonResponse({ ok: false, error: 'not found' }, { status: 404 })
  }
}

export async function writeNodeAdminResponse(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<boolean> {
  if (
    !request.url?.startsWith('/healthz') &&
    !request.url?.startsWith('/capabilities') &&
    !request.url?.startsWith('/admin/') &&
    !request.url?.startsWith('/apply/')
  ) {
    return false
  }

  if (request.url?.startsWith('/admin/') || request.url?.startsWith('/apply/')) {
    const contentLength = Number(request.headers['content-length'] ?? 0)
    if (contentLength > MAX_ADMIN_BODY_BYTES) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'request too large' }))
      return true
    }
  }

  let webRequest: Request
  try {
    webRequest = await toWebRequest(request)
  } catch (error) {
    if ((error as Error).message === 'request too large') {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'request too large' }))
      return true
    }
    throw error
  }
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
    let total = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.from(chunk)
      total += buffer.byteLength
      if (total > MAX_ADMIN_BODY_BYTES) {
        reject(new Error('request too large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('error', reject)
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })
}
