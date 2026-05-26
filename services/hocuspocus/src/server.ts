import { pathToFileURL } from 'node:url'
import { Server } from '@hocuspocus/server'
import pg from 'pg'
import {
  createAdminHandler,
  RevocationRegistry,
  writeNodeAdminResponse,
} from './admin.js'
import { createConvexAcl } from './convex-acl.js'
import { createHocuspocusHooks, type HocuspocusAcl } from './hooks.js'
import {
  PostgresYDocPersistenceBackend,
  PostgresYDocStore,
} from './persistence.js'
import { createProjectionWorker } from './projection.js'
import { createSemanticApiHandler } from './semantic-api.js'

const { Pool } = pg

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function createDevAllowAllAcl(): HocuspocusAcl {
  if (process.env.HOCUSPOCUS_ALLOW_DEV_ACL !== 'true') {
    throw new Error(
      'Configure HOCUSPOCUS_CONVEX_URL and HOCUSPOCUS_CONVEX_SERVER_TOKEN, or set HOCUSPOCUS_ALLOW_DEV_ACL=true for local development only',
    )
  }

  return {
    async getWorkspaceAuthzVersion() {
      return 1
    },
    async canReadAtom() {
      return true
    },
    async canWriteAtom() {
      return true
    },
  }
}

function createAclFromEnv(): HocuspocusAcl {
  const convexUrl = process.env.HOCUSPOCUS_CONVEX_URL
  const serverToken = process.env.HOCUSPOCUS_CONVEX_SERVER_TOKEN
  if (convexUrl || serverToken) {
    if (!convexUrl || !serverToken) {
      throw new Error(
        'Both HOCUSPOCUS_CONVEX_URL and HOCUSPOCUS_CONVEX_SERVER_TOKEN are required for Convex ACL',
      )
    }
    return createConvexAcl({ convexUrl, serverToken })
  }
  return createDevAllowAllAcl()
}

export async function createServerFromEnv(): Promise<Server> {
  const pool = new Pool({
    connectionString: requiredEnv('HOCUSPOCUS_DATABASE_URL'),
  })
  const store = new PostgresYDocStore(new PostgresYDocPersistenceBackend(pool))
  await store.ensureSchema()
  let poolEndPromise: Promise<void> | undefined

  const revocations = new RevocationRegistry()
  const acl = createAclFromEnv()
  const projectionWorker = createProjectionWorker({
    store,
    acl,
    logger: console,
  })
  await projectionWorker.flushPending()
  const projectionRetryInterval = setInterval(() => {
    void projectionWorker.flushPending()
  }, Number(process.env.HOCUSPOCUS_PROJECTION_RETRY_MS ?? '2000'))
  projectionRetryInterval.unref?.()
  const adminHandler = createAdminHandler({
    adminToken: requiredEnv('HOCUSPOCUS_ADMIN_TOKEN'),
    revocations,
    store,
    capabilities: {
      atomBootstrap: typeof acl.loadAtomBootstrap === 'function',
    },
  })
  let server: Server | undefined
  const semanticHandler = createSemanticApiHandler({
    adminToken: requiredEnv('HOCUSPOCUS_ADMIN_TOKEN'),
    acl,
    store,
    logger: console,
    getLiveDocument: (documentName) =>
      server?.hocuspocus.documents.get(documentName) ?? null,
  })

  const hooks = createHocuspocusHooks({
    jwtSecret: requiredEnv('HOCUSPOCUS_JWT_SECRET'),
    acl,
    store,
    logger: console,
    revocations,
    projectionWorker,
  })

  server = new Server({
    ...hooks,
    name: 'dohc-hocuspocus',
    port: Number(process.env.HOCUSPOCUS_PORT ?? '1234'),
    quiet: process.env.HOCUSPOCUS_QUIET !== 'false',
    async onRequest(data) {
      const handled = await writeNodeAdminResponse(
        data.request,
        data.response,
        (request) => {
          const { pathname } = new URL(request.url)
          if (pathname.startsWith('/apply/')) {
            return semanticHandler(request)
          }
          return adminHandler(request)
        },
      )
      if (handled) return Promise.reject()
    },
    async onDestroy() {
      clearInterval(projectionRetryInterval)
      projectionWorker.stop()
      poolEndPromise ??= pool.end()
      await poolEndPromise
    },
  })
  return server
}

export async function startServerFromEnv(): Promise<void> {
  const server = await createServerFromEnv()
  await server.listen()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startServerFromEnv()
}
