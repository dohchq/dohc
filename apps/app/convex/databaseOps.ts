import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadPathByFolderAccess, canWriteInFolder, folderPathForPath } from './atomAccess'
import { normalizeWorkspacePath, primaryKeyFor, type DatabaseSnapshot } from './databaseSchema'
import { authorizeAppDatabaseRead } from './databaseFiles'
import { isTrustedForKey } from './appTrust'
import { pathInScope } from './appSecurity'

function error(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, message, ...extra }
}

type DatabaseCtx = QueryCtx | MutationCtx
type DatabaseOp = 'insert' | 'update' | 'upsert' | 'delete'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

async function databaseByPath(ctx: DatabaseCtx, workspaceId: string, path: string) {
  return await ctx.db
    .query('databaseFiles')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
}

function normalizedDatabasePath(path: string) {
  const normalized = normalizeWorkspacePath(path)
  return normalized && normalized === path ? normalized : null
}

async function applyDatabaseOperation(
  ctx: MutationCtx,
  args: {
    workspaceId: string
    actorUserId: string
    databasePath: string
    operationId: string
    expectedVersion?: number
    op: DatabaseOp
    table: string
    rowId?: string
    payload: unknown
  },
) {
  const existingOperation = await ctx.db
    .query('databaseOps')
    .withIndex('by_database_operation', (q) =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('databasePath', args.databasePath)
        .eq('operationId', args.operationId),
    )
    .unique()
  if (existingOperation) {
    const sameOperation =
      existingOperation.op === args.op &&
      existingOperation.table === args.table &&
      (existingOperation.rowId ?? undefined) === (args.rowId ?? undefined) &&
      stableJson(existingOperation.payload) === stableJson(args.payload)
    if (!sameOperation) {
      return error('database-operation-conflict', 'Operation id was already used for a different database write.')
    }
    return { ok: true as const, version: existingOperation.version, idempotent: true as const }
  }
  const database = await databaseByPath(ctx, args.workspaceId, args.databasePath)
  if (!database) return error('database-not-found', 'Database not found.')
  if (database.systemLocked || database.userLocked) {
    return error('database-locked', 'This database is locked.')
  }
  if (database.reviewRequired) {
    return error('database-review-required', 'This database requires review before app writes.')
  }
  if (args.expectedVersion !== undefined && database.version !== args.expectedVersion) {
    return error('database-version-conflict', 'Database version changed.', {
      currentVersion: database.version,
    })
  }
  const snapshot = structuredClone(database.tables as DatabaseSnapshot)
  const table = snapshot[args.table]
  if (!table) return error('table-not-found', 'Table not found.')
  const key = primaryKeyFor(table)
  const payload = args.payload && typeof args.payload === 'object'
    ? args.payload as Record<string, unknown>
    : {}
  const columnNames = new Set(table.columns.map((column) => column.name))
  for (const field of Object.keys(payload)) {
    if (!columnNames.has(field)) {
      return error('database-column-not-found', `Column "${field}" does not exist in table "${args.table}".`)
    }
  }
  const rowId = args.rowId ?? String(payload[key] ?? '')
  if (!rowId) return error('invalid-row-id', 'Row id is required.')
  const existingIndex = table.rows.findIndex((row) => String(row[key]) === rowId)

  if (args.op === 'insert') {
    if (existingIndex >= 0) return error('database-row-conflict', 'Row already exists.')
    table.rows.push({ ...payload, [key]: rowId })
  } else if (args.op === 'update') {
    if (existingIndex < 0) return error('database-row-not-found', 'Row not found.')
    table.rows[existingIndex] = {
      ...table.rows[existingIndex],
      ...payload,
      [key]: rowId,
    }
  } else if (args.op === 'upsert') {
    if (existingIndex < 0) {
      table.rows.push({ ...payload, [key]: rowId })
    } else {
      table.rows[existingIndex] = {
        ...table.rows[existingIndex],
        ...payload,
        [key]: rowId,
      }
    }
  } else {
    if (existingIndex < 0) return error('database-row-not-found', 'Row not found.')
    table.rows.splice(existingIndex, 1)
  }

  const version = database.version + 1
  const now = Date.now()
  await ctx.db.patch(database._id, { tables: snapshot, version, updatedAt: now, bytesOutOfDate: true })
  await ctx.db.insert('databaseOps', {
    workspaceId: args.workspaceId,
    databasePath: args.databasePath,
    operationId: args.operationId,
    actorUserId: args.actorUserId,
    op: args.op,
    table: args.table,
    rowId,
    payload,
    version,
    appliedAt: now,
  })
  return { ok: true as const, version }
}

const opValidator = v.union(
  v.literal('insert'),
  v.literal('update'),
  v.literal('upsert'),
  v.literal('delete'),
)

export const apply = mutation({
  args: {
    databasePath: v.string(),
    operationId: v.string(),
    expectedVersion: v.number(),
    op: v.union(v.literal('insert'), v.literal('update'), v.literal('delete')),
    table: v.string(),
    rowId: v.optional(v.string()),
    payload: v.any(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const databasePath = normalizedDatabasePath(args.databasePath)
    if (!databasePath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, args.activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    if (!(await canWriteInFolder(
      ctx,
      workspaceId,
      folderPathForPath(databasePath),
      identity.subject,
    ))) {
      return error('database-write-not-authorized', 'Not authorized to write this database.')
    }
    return await applyDatabaseOperation(ctx, {
      workspaceId,
      actorUserId: identity.subject,
      databasePath,
      operationId: args.operationId,
      expectedVersion: args.expectedVersion,
      op: args.op,
      table: args.table,
      rowId: args.rowId,
      payload: args.payload,
    })
  },
})

export const appApply = mutation({
  args: {
    packageRoot: v.string(),
    databasePath: v.string(),
    operationId: v.string(),
    expectedVersion: v.optional(v.number()),
    op: opValidator,
    table: v.string(),
    collection: v.optional(v.string()),
    rowId: v.optional(v.string()),
    payload: v.any(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await authorizeAppDatabaseRead(ctx, {
      activeWorkspaceId: args.activeWorkspaceId,
      packageRoot: args.packageRoot,
      path: args.databasePath,
    })
    if (!access.ok) return access
    if (!access.database.write) {
      return error('database-write-not-granted', 'This app is not allowed to write that database.')
    }
    if (!(await canWriteInFolder(
      ctx,
      access.workspaceId,
      folderPathForPath(access.database.path),
      access.userId,
    ))) {
      return error('database-write-not-authorized', 'Not authorized to write this database.')
    }
    if (!access.app.trustKey || !(await isTrustedForKey(
      ctx,
      access.workspaceId,
      access.userId,
      args.packageRoot,
      access.app.trustKey,
    ))) {
      return error('app-trust-required', 'This user has not trusted the current app manifest.')
    }
    let table = args.table
    if (args.collection !== undefined) {
      const collection = access.app.collections[args.collection]
      if (
        !collection ||
        collection.format !== 'sqlite' ||
        !collection.table ||
        !collection.write.some((scope) => pathInScope(access.database.path, scope))
      ) {
        return error('database-write-not-granted', 'This collection is not allowed to write that database.')
      }
      table = collection.table
    }
    return await applyDatabaseOperation(ctx, {
      workspaceId: access.workspaceId,
      actorUserId: access.userId,
      databasePath: access.database.path,
      operationId: args.operationId,
      expectedVersion: args.expectedVersion,
      op: args.op,
      table,
      rowId: args.rowId,
      payload: args.payload,
    })
  },
})

export const list = query({
  args: { databasePath: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { databasePath, activeWorkspaceId }) => {
    const normalizedPath = normalizedDatabasePath(databasePath)
    if (!normalizedPath) return error('invalid-path', 'Database path is invalid.')
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    if (!(await canReadPathByFolderAccess(ctx, workspaceId, normalizedPath, identity.subject))) {
      return error('database-read-not-authorized', 'Not authorized to read this database operations log.')
    }
    const ops = await ctx.db
      .query('databaseOps')
      .withIndex('by_database', (q) =>
        q.eq('workspaceId', workspaceId).eq('databasePath', normalizedPath),
      )
      .collect()
    return { ok: true as const, ops: ops.sort((a, b) => a.appliedAt - b.appliedAt) }
  },
})
