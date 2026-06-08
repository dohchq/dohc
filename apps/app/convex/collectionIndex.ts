import { v } from 'convex/values'
import { action, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { canReadAtom } from './atomAccess'
import { listCollectionRows, type CollectionQuery } from './collectionAdapters'
import {
  globMatchesPath,
  resolveAppForSecurity,
  scopeAllowsPath,
} from './appSecurity'

type WorkerErrorCode =
  | 'app-not-found'
  | 'invalid-manifest'
  | 'collection-not-found'
  | 'unsupported-format'
  | 'source-read-not-granted'
  | 'source-read-not-authorized'
  | 'collection-scan-truncated'
  | 'sqlite-worker-offline'
  | 'sqlite-worker-failed'

function error(
  code: WorkerErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return { ok: false as const, code, message, ...extra }
}

function sqliteWorkerUrl(): string | null {
  const value = process.env.SQLITE_WORKER_URL?.replace(/\/+$/g, '')
  return value && value.length > 0 ? value : null
}

function queryObject(value: unknown): CollectionQuery | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CollectionQuery
    : undefined
}

async function visibleCollectionSources(
  ctx: Parameters<typeof canReadAtom>[0],
  workspaceId: string,
  userId: string,
  appRead: string[],
  sources: string[],
) {
  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(5001)
  if (atoms.length > 5000) {
    return {
      ok: false as const,
      code: 'collection-scan-truncated' as const,
      message: 'This collection has too many source files to index safely.',
    }
  }
  const visible = []
  const deniedSources = []
  for (const atom of atoms) {
    if (!sources.some((source) => globMatchesPath(source, atom.path))) continue
    if (!scopeAllowsPath(appRead, atom.path)) {
      deniedSources.push(atom.path)
      continue
    }
    if (!(await canReadAtom(ctx, atom._id, userId))) {
      deniedSources.push(atom.path)
      continue
    }
    visible.push({ path: atom.path, body: atom.body ?? '' })
  }
  return {
    ok: true as const,
    visible: visible.sort((a, b) => a.path.localeCompare(b.path)),
    deniedSources: Array.from(new Set(deniedSources)).sort((a, b) => a.localeCompare(b)),
  }
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
    return error('sqlite-worker-failed', 'The SQLite worker rejected the request.', {
      status: response.status,
    })
  }
  const value = await response.json()
  if (!value || typeof value !== 'object') {
    return error('sqlite-worker-failed', 'The SQLite worker returned an invalid response.')
  }
    return value as Record<string, unknown>
}

type RowsForRebuild =
  | {
      ok: true
      workspaceId: string
      rows: Array<Record<string, unknown>>
      deniedSources: string[]
    }
  | {
      ok: false
      code: string
      message: string
      deniedSources?: string[]
    }

export const _resolveRowsForRebuild = internalQuery({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RowsForRebuild> => {
    const resolved = await resolveAppForSecurity(
      ctx,
      args.activeWorkspaceId,
      args.packageRoot,
    )
    if (!resolved.ok) return resolved
    const config = resolved.app.collections[args.collection]
    if (!config) return error('collection-not-found', 'Collection not found.')
    if (config.format === 'sqlite') {
      return error('unsupported-format', 'SQLite collections are already database-backed.')
    }
    const sources = await visibleCollectionSources(
      ctx,
      resolved.workspaceId,
      resolved.userId,
      resolved.app.read,
      config.source,
    )
    if (!sources.ok) return sources
    const result = listCollectionRows(
      { name: args.collection, format: config.format, key: config.key, table: config.table },
      sources.visible,
      queryObject(undefined),
    )
    if (!result.ok) return result
    return { ok: true as const, workspaceId: resolved.workspaceId, rows: result.rows, deniedSources: sources.deniedSources }
  },
})

export const rebuild = action({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: args.activeWorkspaceId,
    }) as string
    const listed = await ctx.runQuery(internal.collectionIndex._resolveRowsForRebuild, {
      activeWorkspaceId: workspaceId,
      packageRoot: args.packageRoot,
      collection: args.collection,
    }) as RowsForRebuild
    if (!listed.ok) return listed
    if (listed.deniedSources.length > 0) {
      return error(
        'source-read-not-authorized',
        'Cannot rebuild a complete collection index because some sources are private.',
        { deniedSources: listed.deniedSources },
      )
    }
    return await callSqliteWorker('/indexes/rebuild', {
      indexId: `${workspaceId}:${args.packageRoot}:${args.collection}`,
      rows: listed.rows,
    })
  },
})
