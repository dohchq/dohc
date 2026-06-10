import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createSqliteEngine, type SqliteEngine } from './sqliteEngine'

type HandlerOptions = {
  engine: SqliteEngine
  adminToken?: string
  allowInsecureLocal?: boolean
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function authorized(
  request: Request,
  adminToken: string | undefined,
  allowInsecureLocal: boolean | undefined,
): boolean {
  if (!adminToken) return allowInsecureLocal === true
  return request.headers.get('authorization') === `Bearer ${adminToken}`
}

export function createSqliteWorkerHandler({ engine, adminToken, allowInsecureLocal }: HandlerOptions) {
  return async function sqliteWorkerHandler(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (!authorized(request, adminToken, allowInsecureLocal)) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' })
    }

    if (request.method === 'GET' && pathname === '/preflight') {
      return jsonResponse(200, engine.preflight())
    }

    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method-not-allowed' })
    }

    const body = await readJson(request)
    if (!body) return jsonResponse(400, { ok: false, error: 'invalid-json' })

    if (pathname === '/query') {
      return jsonResponse(
        200,
        await engine.query({
          snapshot: body.snapshot as never,
          sql: String(body.sql ?? ''),
          params: Array.isArray(body.params) ? body.params : [],
        }),
      )
    }

    if (pathname === '/ingest') {
      return jsonResponse(
        200,
        await engine.ingest({
          bytesBase64: String(body.bytesBase64 ?? ''),
        }),
      )
    }

    if (pathname === '/materialize') {
      return jsonResponse(
        200,
        await engine.materialize({
          snapshot: body.snapshot as never,
        }),
      )
    }

    if (pathname === '/import-data') {
      return jsonResponse(
        200,
        await engine.importData({
          name: String(body.name ?? ''),
          mediaType: String(body.mediaType ?? 'text/plain'),
          body: String(body.body ?? ''),
          tableName: String(body.tableName ?? 'rows'),
          mode: body.mode === 'provided-schema' ? 'provided-schema' : 'infer-schema',
          schema:
            body.schema && typeof body.schema === 'object' && !Array.isArray(body.schema)
              ? body.schema as never
              : undefined,
        }),
      )
    }

    if (pathname === '/transaction') {
      return jsonResponse(
        200,
        await engine.apply({
          snapshot: body.snapshot as never,
          version: Number(body.version),
          expectedVersion:
            body.expectedVersion === undefined ? undefined : Number(body.expectedVersion),
          operationId: String(body.operationId ?? ''),
          op: body.op as never,
          table: String(body.table ?? ''),
          rowId: body.rowId === undefined ? undefined : String(body.rowId),
          payload:
            body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
              ? body.payload as Record<string, unknown>
              : {},
        }),
      )
    }

    if (pathname === '/indexes/rebuild') {
      return jsonResponse(
        200,
        await engine.rebuildIndex({
          indexId: String(body.indexId ?? ''),
          rows: Array.isArray(body.rows) ? body.rows as Array<Record<string, unknown>> : [],
        }),
      )
    }

    if (pathname === '/indexes/query') {
      return jsonResponse(
        200,
        await engine.queryIndex(body.index as never, body.query as never),
      )
    }

    return jsonResponse(404, { ok: false, error: 'not-found' })
  }
}

export async function createServerFromEnv() {
  const engine = await createSqliteEngine()
  const handler = createSqliteWorkerHandler({
    engine,
    adminToken: process.env.SQLITE_WORKER_TOKEN,
    allowInsecureLocal: process.env.SQLITE_WORKER_ALLOW_INSECURE_LOCAL === '1',
  })
  return createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const webRequest = new Request(url, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
      })
      void handler(webRequest)
        .then(async (webResponse) => {
          response.statusCode = webResponse.status
          for (const [key, value] of webResponse.headers) response.setHeader(key, value)
          response.end(Buffer.from(await webResponse.arrayBuffer()))
        })
        .catch((cause) => {
          response.statusCode = 500
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            ok: false,
            error: cause instanceof Error ? cause.message : 'internal-error',
          }))
        })
    })
  })
}

export async function startServerFromEnv() {
  const server = await createServerFromEnv()
  const port = Number(process.env.SQLITE_WORKER_PORT ?? '1787')
  server.listen(port)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startServerFromEnv()
}
