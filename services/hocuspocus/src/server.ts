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
  const adminHandler = createAdminHandler({
    adminToken: requiredEnv('HOCUSPOCUS_ADMIN_TOKEN'),
    revocations,
  })

  const hooks = createHocuspocusHooks({
    jwtSecret: requiredEnv('HOCUSPOCUS_JWT_SECRET'),
    acl: createAclFromEnv(),
    store,
    logger: console,
    revocations,
  })

  return new Server({
    ...hooks,
    name: 'dohc-hocuspocus',
    port: Number(process.env.HOCUSPOCUS_PORT ?? '1234'),
    quiet: process.env.HOCUSPOCUS_QUIET !== 'false',
    async onRequest(data) {
      const handled = await writeNodeAdminResponse(
        data.request,
        data.response,
        adminHandler,
      )
      if (handled) return Promise.reject()
    },
    async onDestroy() {
      poolEndPromise ??= pool.end()
      await poolEndPromise
    },
  })
}

export async function startServerFromEnv(): Promise<void> {
  const server = await createServerFromEnv()
  await server.listen()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startServerFromEnv()
}
