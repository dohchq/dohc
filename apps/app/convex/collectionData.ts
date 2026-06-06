import { v } from 'convex/values'
import { query } from './_generated/server'
import { canReadAtom } from './atomAccess'
import {
  getCollectionRow,
  listCollectionRows,
  type CollectionQuery,
} from './collectionAdapters'
import {
  globMatchesPath,
  resolveAppForSecurity,
  scopeAllowsPath,
} from './appSecurity'

const SOURCE_SCAN_CAP = 5000

type CollectionDataError = {
  ok: false
  code:
    | 'app-not-found'
    | 'invalid-manifest'
    | 'collection-not-found'
    | 'unsupported-format'
    | 'source-read-not-granted'
    | 'collection-scan-truncated'
  message: string
}

function error(code: CollectionDataError['code'], message: string): CollectionDataError {
  return { ok: false, code, message }
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
    .take(SOURCE_SCAN_CAP + 1)
  if (atoms.length > SOURCE_SCAN_CAP) {
    return {
      ok: false as const,
      code: 'collection-scan-truncated' as const,
      message: 'This collection has too many source files to scan safely.',
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

export const list = query({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    query: v.optional(v.any()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, collection, query: appQuery, activeWorkspaceId }) => {
    const resolved = await resolveAppForSecurity(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved
    const config = resolved.app.collections[collection]
    if (!config) return error('collection-not-found', 'Collection not found.')
    if (config.format === 'sqlite') {
      return error('unsupported-format', 'SQLite collections are handled by database APIs.')
    }

    const sourcesResult = await visibleCollectionSources(
      ctx,
      resolved.workspaceId,
      resolved.userId,
      resolved.app.read,
      config.source,
    )
    if (!sourcesResult.ok) return sourcesResult
    const { visible, deniedSources } = sourcesResult
    const result = listCollectionRows(
      { name: collection, format: config.format, key: config.key, table: config.table },
      visible,
      queryObject(appQuery),
    )
    if (!result.ok) return result
    return { ok: true as const, rows: result.rows, deniedSources }
  },
})

export const get = query({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    id: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, collection, id, activeWorkspaceId }) => {
    const resolved = await resolveAppForSecurity(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved
    const config = resolved.app.collections[collection]
    if (!config) return error('collection-not-found', 'Collection not found.')
    if (config.format === 'sqlite') {
      return error('unsupported-format', 'SQLite collections are handled by database APIs.')
    }
    const sourcesResult = await visibleCollectionSources(
      ctx,
      resolved.workspaceId,
      resolved.userId,
      resolved.app.read,
      config.source,
    )
    if (!sourcesResult.ok) return sourcesResult
    const { visible, deniedSources } = sourcesResult
    const result = getCollectionRow(
      { name: collection, format: config.format, key: config.key, table: config.table },
      visible,
      id,
    )
    if (!result.ok) return result
    return { ok: true as const, row: result.row, deniedSources }
  },
})
