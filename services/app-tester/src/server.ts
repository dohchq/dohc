import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { runAppTest } from './runAppTest'

type HandlerOptions = {
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

export function createAppTesterHandler(options: HandlerOptions = {}) {
  return async function appTesterHandler(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (!authorized(request, options.adminToken, options.allowInsecureLocal)) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' })
    }

    if (request.method === 'GET' && pathname === '/preflight') {
      return jsonResponse(200, {
        ok: true,
        service: 'dohc-app-tester',
        checks: ['static', 'sdk-simulation', 'browser'],
      })
    }

    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method-not-allowed' })
    }

    const body = await readJson(request)
    if (!body) return jsonResponse(400, { ok: false, error: 'invalid-json' })

    if (pathname === '/test_app') {
      return jsonResponse(200, await runAppTest(body as never))
    }

    return jsonResponse(404, { ok: false, error: 'not-found' })
  }
}

export async function createServerFromEnv() {
  const handler = createAppTesterHandler({
    adminToken: process.env.APP_TESTER_TOKEN,
    allowInsecureLocal: process.env.APP_TESTER_ALLOW_INSECURE_LOCAL === '1',
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
  const port = Number(process.env.APP_TESTER_PORT ?? '1788')
  server.listen(port)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startServerFromEnv()
}
