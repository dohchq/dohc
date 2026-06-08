import { v } from 'convex/values'
import { action, internalMutation, internalQuery, query as convexQuery } from './_generated/server'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import {
  canReadPathByFolderAccess,
  canWriteInFolder,
  folderPathForPath,
} from './atomAccess'
import { resolveScopeRelativePath } from './appPaths'
import { filterCollectionRows, type CollectionQuery } from './collectionAdapters'
import type { CollectionRow } from './collectionAdapterTypes'
import { pathInScope, resolveAppForSecurity } from './appSecurity'
import {
  introspectTables,
  isSQLiteLikeFile,
  normalizeWorkspacePath,
  normalizeDatabaseSnapshot,
  primaryKeyFor,
  querySnapshot,
  type DatabaseSnapshot,
  type DatabaseTable,
} from './databaseSchema'

function error(code: string, message: string) {
  return { ok: false as const, code, message }
}

type DatabaseCtx = QueryCtx | MutationCtx
const SQLITE_HEADER = 'SQLite format 3\0'
const SQLITE_WORKER_INGEST_PATH = '/ingest'
const SQLITE_WORKER_MATERIALIZE_PATH = '/materialize'

async function databaseByPath(ctx: DatabaseCtx, workspaceId: string, path: string) {
  return await ctx.db
    .query('databaseFiles')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sqliteWorkerUrl(): string | null {
  const value = process.env.SQLITE_WORKER_URL?.replace(/\/+$/g, '')
  return value && value.length > 0 ? value : null
}

function base64FromArrayBuffer(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.slice(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function arrayBufferFromBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

async function callSqliteWorker(path: string, body: Record<string, unknown>) {
  const baseUrl = sqliteWorkerUrl()
  if (!baseUrl) {
    return error('sqlite-worker-offline', 'The SQLite worker is not configured.')
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.SQLITE_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.SQLITE_WORKER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return error('sqlite-worker-failed', 'The SQLite worker rejected the request.')
  }
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== 'object') {
    return error('sqlite-worker-failed', 'The SQLite worker returned an invalid response.')
  }
  return value as Record<string, unknown>
}

async function verifiedSqliteBlob(
  ctx: ActionCtx,
  storageId: string,
): Promise<
  | { ok: true; size: number; sha256: string; tables: DatabaseSnapshot }
  | { ok: false; code: string; message: string }
> {
  const blob = await ctx.storage.get(storageId)
  if (!blob) {
    return {
      ok: false,
      code: 'invalid-sqlite-file',
      message: 'Uploaded SQLite blob was not found.',
    }
  }
  const bytes = await blob.arrayBuffer()
  const header = new TextDecoder().decode(bytes.slice(0, SQLITE_HEADER.length))
  if (header !== SQLITE_HEADER) {
    return {
      ok: false,
      code: 'invalid-sqlite-file',
      message: 'Uploaded file does not contain a SQLite database header.',
    }
  }
  const ingested = await callSqliteWorker(SQLITE_WORKER_INGEST_PATH, {
    bytesBase64: base64FromArrayBuffer(bytes),
  })
  if (ingested.ok !== true) {
    return {
      ok: false,
      code: typeof ingested.code === 'string' ? ingested.code : 'invalid-sqlite-file',
      message: typeof ingested.message === 'string' ? ingested.message : 'Uploaded SQLite file could not be parsed.',
    }
  }
  const ingestedOk = ingested as Record<string, unknown> & { ok: true }
  const tables = normalizeDatabaseSnapshot(ingestedOk.snapshot)
  if (!tables) {
    return {
      ok: false,
      code: 'invalid-sqlite-file',
      message: 'SQLite worker returned an invalid database snapshot.',
    }
  }
  return {
    ok: true,
    size: typeof ingestedOk.size === 'number' ? ingestedOk.size : blob.size,
    sha256: typeof ingestedOk.sha256 === 'string' ? ingestedOk.sha256 : await sha256Hex(bytes),
    tables,
  }
}

async function databaseReadableByCaller(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  path: string,
  userId: string,
) {
  return await canReadPathByFolderAccess(ctx, workspaceId, path, userId)
}

function appDatabasePathForRequest(
  app: {
    scopePath: string
    databases: Record<string, { path: string; write: boolean }>
  },
  requestedPath: string,
) {
  const scopeResolved = resolveScopeRelativePath(app.scopePath, requestedPath)
  for (const [name, database] of Object.entries(app.databases)) {
    if (
      name === requestedPath ||
      database.path === requestedPath ||
      (scopeResolved !== null && database.path === scopeResolved)
    ) {
      return { name, ...database }
    }
  }
  return null
}

function normalizedDatabasePath(path: string) {
  const normalized = normalizeWorkspacePath(path)
  return normalized && normalized === path ? normalized : null
}

export async function authorizeAppDatabaseRead(
  ctx: DatabaseCtx,
  args: {
    activeWorkspaceId: string | undefined
    packageRoot: string
    path: string
  },
) {
  const resolved = await resolveAppForSecurity(
    ctx,
    args.activeWorkspaceId,
    args.packageRoot,
  )
  if (!resolved.ok) return resolved
  const database = appDatabasePathForRequest(resolved.app, args.path)
  if (!database) {
    return error('database-read-not-granted', 'This app is not allowed to read that database.')
  }
  if (!(await databaseReadableByCaller(
    ctx,
    resolved.workspaceId,
    database.path,
    resolved.userId,
  ))) {
    return error('database-read-not-authorized', 'Not authorized to read this database.')
  }
  return { ...resolved, database }
}

function rowIdFor(table: DatabaseTable, key: string | undefined, row: Record<string, unknown>) {
  const primaryKey = key ?? primaryKeyFor(table)
  return String(row[primaryKey] ?? '')
}

function rowsForCollection(
  databasePath: string,
  table: DatabaseTable,
  key: string | undefined,
): CollectionRow[] {
  return table.rows.map((row) => ({
    ...row,
    id: rowIdFor(table, key, row),
    sourcePath: databasePath,
  })) as CollectionRow[]
}

async function authorizeAppCollectionDatabaseRead(
  ctx: QueryCtx,
  args: {
    activeWorkspaceId: string | undefined
    packageRoot: string
    databasePath: string
    collection: string
  },
) {
  const resolved = await authorizeAppDatabaseRead(ctx, {
    activeWorkspaceId: args.activeWorkspaceId,
    packageRoot: args.packageRoot,
    path: args.databasePath,
  })
  if (!resolved.ok) return resolved
  const collection = resolved.app.collections[args.collection]
  if (!collection || collection.format !== 'sqlite' || !collection.table) {
    return error('collection-not-found', 'SQLite-backed collection not found.')
  }
  if (!collection.source.some((scope) => pathInScope(resolved.database.path, scope))) {
    return error('database-read-not-granted', 'This collection is not backed by that database.')
  }
  return { ...resolved, collection }
}

export const _createVerified = internalMutation({
  args: {
    path: v.string(),
    storageId: v.id('_storage'),
    filename: v.string(),
    size: v.number(),
    mediaType: v.string(),
    sha256: v.optional(v.string()),
    tables: v.any(),
    workspaceId: v.string(),
    actorUserId: v.string(),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const normalizedPath = normalizeWorkspacePath(args.path)
    if (!normalizedPath || normalizedPath !== args.path) {
      return error('invalid-path', 'Database path is invalid.')
    }
    if (!(await canWriteInFolder(
      ctx,
      args.workspaceId,
      folderPathForPath(normalizedPath),
      args.actorUserId,
    ))) {
      return error('database-write-not-authorized', 'Not authorized to create this database.')
    }
    const tables = normalizeDatabaseSnapshot(args.tables)
    if (!tables) return error('invalid-sqlite-file', 'Database snapshot is invalid.')
    const existing = await databaseByPath(ctx, args.workspaceId, normalizedPath)
    if (existing) return error('database-exists', 'A database already exists at this path.')
    const now = Date.now()
    await ctx.db.insert('databaseFiles', {
      workspaceId: args.workspaceId,
      path: normalizedPath,
      storageId: args.storageId,
      filename: args.filename,
      size: args.size,
      ...(args.sha256 === undefined ? {} : { sha256: args.sha256 }),
      canonicalFormat: 'structured-snapshot',
      bytesOutOfDate: false,
      version: 1,
      tables,
      createdByUserId: args.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true as const, path: normalizedPath, version: 1 }
  },
})

export const _authorizeStorageForCreate = internalQuery({
  args: {
    workspaceId: v.string(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db
      .query('workspaceAssets')
      .withIndex('by_workspace_storage', (q) =>
        q.eq('workspaceId', args.workspaceId).eq('storageId', args.storageId),
      )
      .first()
    if (!asset) {
      return error(
        'database-storage-not-authorized',
        'Uploaded SQLite storage must belong to this workspace.',
      )
    }
    return { ok: true as const, assetId: asset._id }
  },
})

export const create = action({
  args: {
    path: v.string(),
    storageId: v.id('_storage'),
    filename: v.string(),
    size: v.number(),
    mediaType: v.string(),
    sha256: v.optional(v.string()),
    // Compatibility-only: ignored. The trusted snapshot is derived by the
    // authenticated SQLite worker from storage bytes.
    tables: v.optional(v.any()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: args.activeWorkspaceId,
    }) as string
    const normalizedPath = normalizeWorkspacePath(args.path)
    if (!normalizedPath || normalizedPath !== args.path) {
      return error('invalid-path', 'Database path is invalid.')
    }
    if (!isSQLiteLikeFile(args)) {
      return error('invalid-sqlite-file', 'Only SQLite database files are supported.')
    }
    const storageAuth = await ctx.runQuery(internal.databaseFiles._authorizeStorageForCreate, {
      workspaceId,
      storageId: args.storageId,
    }) as { ok: true; assetId: string } | ReturnType<typeof error>
    if (!storageAuth.ok) return storageAuth
    const verified = await verifiedSqliteBlob(ctx, args.storageId)
    if (!verified.ok) return verified
    if (args.sha256 !== undefined && args.sha256 !== verified.sha256) {
      return error('invalid-sqlite-file', 'Uploaded SQLite hash does not match the supplied hash.')
    }
    return await ctx.runMutation(internal.databaseFiles._createVerified, {
      path: args.path,
      storageId: args.storageId,
      filename: args.filename,
      size: verified.size,
      mediaType: args.mediaType,
      sha256: verified.sha256,
      tables: verified.tables,
      workspaceId,
      actorUserId: identity.subject,
    })
  },
})

export const _resolveForMaterialize = internalQuery({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    actorUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedPath = normalizeWorkspacePath(args.path)
    if (!normalizedPath || normalizedPath !== args.path) {
      return error('invalid-path', 'Database path is invalid.')
    }
    const database = await databaseByPath(ctx, args.workspaceId, args.path)
    if (!database) return error('database-not-found', 'Database not found.')
    if (!(await canWriteInFolder(
      ctx,
      args.workspaceId,
      folderPathForPath(database.path),
      args.actorUserId,
    ))) {
      return error('database-write-not-authorized', 'Not authorized to materialize this database.')
    }
    return { ok: true as const, database }
  },
})

export const _patchMaterialized = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    storageId: v.id('_storage'),
    size: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    const database = await databaseByPath(ctx, args.workspaceId, args.path)
    if (!database) return error('database-not-found', 'Database not found.')
    await ctx.db.patch(database._id, {
      storageId: args.storageId,
      size: args.size,
      sha256: args.sha256,
      bytesOutOfDate: false,
      updatedAt: Date.now(),
    })
    return { ok: true as const, path: args.path, version: database.version }
  },
})

export const materialize = action({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<unknown> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: args.activeWorkspaceId,
    }) as string
    const resolved = await ctx.runQuery(internal.databaseFiles._resolveForMaterialize, {
      workspaceId,
      path: args.path,
      actorUserId: identity.subject,
    }) as { ok: true; database: { path: string; version: number; tables: unknown } } | ReturnType<typeof error>
    if (!resolved.ok) return resolved
    const materialized = await callSqliteWorker(SQLITE_WORKER_MATERIALIZE_PATH, {
      snapshot: resolved.database.tables,
    })
    if (materialized.ok !== true) {
      return error(
        typeof materialized.code === 'string' ? materialized.code : 'sqlite-worker-failed',
        typeof materialized.message === 'string' ? materialized.message : 'SQLite worker could not materialize this database.',
      )
    }
    const materializedOk = materialized as Record<string, unknown> & { ok: true }
    if (typeof materializedOk.bytesBase64 !== 'string') {
      return error('sqlite-worker-failed', 'SQLite worker returned invalid materialized bytes.')
    }
    const storageId = await ctx.storage.store(new Blob([arrayBufferFromBase64(materializedOk.bytesBase64)]))
    return await ctx.runMutation(internal.databaseFiles._patchMaterialized, {
      workspaceId,
      path: resolved.database.path,
      storageId,
      size: typeof materializedOk.size === 'number' ? materializedOk.size : 0,
      sha256: typeof materializedOk.sha256 === 'string' ? materializedOk.sha256 : '',
    })
  },
})

export const get = convexQuery({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const databasePath = normalizedDatabasePath(path)
    if (!databasePath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const database = await databaseByPath(ctx, workspaceId, databasePath)
    if (!database) return error('database-not-found', 'Database not found.')
    if (!(await databaseReadableByCaller(ctx, workspaceId, database.path, identity.subject))) {
      return error('database-read-not-authorized', 'Not authorized to read this database.')
    }
    return { ok: true as const, database }
  },
})

export const list = convexQuery({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const databases = await ctx.db
      .query('databaseFiles')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    const visible = []
    for (const database of databases) {
      if (await databaseReadableByCaller(ctx, workspaceId, database.path, identity.subject)) {
        visible.push(database)
      }
    }
    return { ok: true as const, databases: visible.sort((a, b) => a.path.localeCompare(b.path)) }
  },
})

export const tables = convexQuery({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const databasePath = normalizedDatabasePath(path)
    if (!databasePath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const database = await databaseByPath(ctx, workspaceId, databasePath)
    if (!database) return error('database-not-found', 'Database not found.')
    if (!(await databaseReadableByCaller(ctx, workspaceId, database.path, identity.subject))) {
      return error('database-read-not-authorized', 'Not authorized to read this database.')
    }
    return { ok: true as const, tables: introspectTables(database.tables as DatabaseSnapshot) }
  },
})

export const appTables = convexQuery({
  args: {
    packageRoot: v.string(),
    path: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, path, activeWorkspaceId }) => {
    const access = await authorizeAppDatabaseRead(ctx, {
      activeWorkspaceId,
      packageRoot,
      path,
    })
    if (!access.ok) return access
    const database = await databaseByPath(ctx, access.workspaceId, access.database.path)
    if (!database) return error('database-not-found', 'Database not found.')
    return { ok: true as const, tables: introspectTables(database.tables as DatabaseSnapshot) }
  },
})

export const query = convexQuery({
  args: {
    path: v.string(),
    sql: v.string(),
    params: v.optional(v.array(v.any())),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, sql, params, activeWorkspaceId }) => {
    const databasePath = normalizedDatabasePath(path)
    if (!databasePath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const database = await databaseByPath(ctx, workspaceId, databasePath)
    if (!database) return error('database-not-found', 'Database not found.')
    if (!(await databaseReadableByCaller(ctx, workspaceId, database.path, identity.subject))) {
      return error('database-read-not-authorized', 'Not authorized to read this database.')
    }
    return querySnapshot(database.tables as DatabaseSnapshot, sql, params ?? [])
  },
})

export const appQuery = convexQuery({
  args: {
    packageRoot: v.string(),
    path: v.string(),
    sql: v.string(),
    params: v.optional(v.array(v.any())),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, path, sql, params, activeWorkspaceId }) => {
    const access = await authorizeAppDatabaseRead(ctx, {
      activeWorkspaceId,
      packageRoot,
      path,
    })
    if (!access.ok) return access
    const database = await databaseByPath(ctx, access.workspaceId, access.database.path)
    if (!database) return error('database-not-found', 'Database not found.')
    return querySnapshot(database.tables as DatabaseSnapshot, sql, params ?? [])
  },
})

export const tableRows = convexQuery({
  args: {
    path: v.string(),
    table: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, table, activeWorkspaceId }) => {
    const databasePath = normalizedDatabasePath(path)
    if (!databasePath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const database = await databaseByPath(ctx, workspaceId, databasePath)
    if (!database) return error('database-not-found', 'Database not found.')
    if (!(await databaseReadableByCaller(ctx, workspaceId, database.path, identity.subject))) {
      return error('database-read-not-authorized', 'Not authorized to read this database.')
    }
    const snapshot = database.tables as DatabaseSnapshot
    const found = snapshot[table]
    if (!found) return error('table-not-found', 'Table not found.')
    return { ok: true as const, rows: found.rows }
  },
})

export const appCollectionRows = convexQuery({
  args: {
    packageRoot: v.string(),
    databasePath: v.string(),
    collection: v.string(),
    query: v.optional(v.any()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, databasePath, collection, query, activeWorkspaceId }) => {
    const access = await authorizeAppCollectionDatabaseRead(ctx, {
      activeWorkspaceId,
      packageRoot,
      databasePath,
      collection,
    })
    if (!access.ok) return access
    const database = await databaseByPath(ctx, access.workspaceId, access.database.path)
    if (!database) return error('database-not-found', 'Database not found.')
    const snapshot = database.tables as DatabaseSnapshot
    const table = snapshot[access.collection.table!]
    if (!table) return error('table-not-found', 'Table not found.')
    return {
      ok: true as const,
      rows: filterCollectionRows(
        rowsForCollection(access.database.path, table, access.collection.key),
        query as CollectionQuery | undefined,
      ),
    }
  },
})

export const appCollectionRow = convexQuery({
  args: {
    packageRoot: v.string(),
    databasePath: v.string(),
    collection: v.string(),
    id: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, databasePath, collection, id, activeWorkspaceId }) => {
    const access = await authorizeAppCollectionDatabaseRead(ctx, {
      activeWorkspaceId,
      packageRoot,
      databasePath,
      collection,
    })
    if (!access.ok) return access
    const database = await databaseByPath(ctx, access.workspaceId, access.database.path)
    if (!database) return error('database-not-found', 'Database not found.')
    const snapshot = database.tables as DatabaseSnapshot
    const table = snapshot[access.collection.table!]
    if (!table) return error('table-not-found', 'Table not found.')
    const rows = rowsForCollection(access.database.path, table, access.collection.key)
    return { ok: true as const, row: rows.find((row) => row.id === id) ?? null }
  },
})
