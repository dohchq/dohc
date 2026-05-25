import { pathToFileURL } from 'node:url'
import { Server } from '@hocuspocus/server'
import pg from 'pg'
import {
  createAdminHandler,
  RevocationRegistry,
  writeNodeAdminResponse,
} from './admin'
import { createHocuspocusHooks, type HocuspocusAcl } from './hooks'
import {
  PostgresYDocPersistenceBackend,
  PostgresYDocStore,
} from './persistence'

const { Pool } = pg

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function createDevAllowAllAcl(): HocuspocusAcl {
  if (process.env.HOCUSPOCUS_ALLOW_DEV_ACL !== 'true') {
    throw new Error(
      'HOCUSPOCUS_ALLOW_DEV_ACL=true is required until the Convex ACL adapter is wired',
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

export async function createServerFromEnv(): Promise<Server> {
  const pool = new Pool({
    connectionString: requiredEnv('HOCUSPOCUS_DATABASE_URL'),
  })
  const store = new PostgresYDocStore(new PostgresYDocPersistenceBackend(pool))
  await store.ensureSchema()

  const revocations = new RevocationRegistry()
  const adminHandler = createAdminHandler({
    adminToken: requiredEnv('HOCUSPOCUS_ADMIN_TOKEN'),
    revocations,
  })

  const hooks = createHocuspocusHooks({
    jwtSecret: requiredEnv('HOCUSPOCUS_JWT_SECRET'),
    acl: createDevAllowAllAcl(),
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
      await pool.end()
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
