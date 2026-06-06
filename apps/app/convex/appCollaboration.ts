import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { canReadAtom } from './atomAccess'
import { parseInlineAtomsFromMarkdown } from './inlineAtom'
import {
  globMatchesPath,
  resolveAppForSecurity,
  scopeAllowsPath,
} from './appSecurity'

const SOURCE_SCAN_CAP = 5000

function rowsFromAtom(path: string, body: string) {
  const rows = []
  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const fields = parseInlineAtomsFromMarkdown(lines[index] ?? '')
      .filter((inline) => inline.kind === 'value')
    if (fields.length === 0) continue
    const row: Record<string, unknown> = {
      id: `${path}#${index + 1}`,
      sourcePath: path,
    }
    for (const field of fields) {
      if (field.kind === 'value') row[field.key] = field.value
    }
    rows.push(row)
  }
  return rows
}

export const collectionRows = query({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, collection, activeWorkspaceId }) => {
    const resolved = await resolveAppForSecurity(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved
    const config = resolved.app.collections[collection]
    if (!config) {
      return {
        ok: false as const,
        code: 'collection-not-found' as const,
        message: 'Collection not found.',
      }
    }
    const raw = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', resolved.workspaceId))
      .take(SOURCE_SCAN_CAP + 1)
    if (raw.length > SOURCE_SCAN_CAP) {
      return {
        ok: false as const,
        code: 'collection-scan-truncated' as const,
        message: 'This collection has too many source files to scan safely.',
      }
    }
    const rows = []
    for (const atom of raw) {
      if (!config.source.some((source) => globMatchesPath(source, atom.path))) continue
      if (!scopeAllowsPath(resolved.app.read, atom.path)) continue
      // Avoid exposing rows the actor cannot normally read.
      if (!(await canReadAtom(ctx, atom._id, resolved.userId))) continue
      rows.push(...rowsFromAtom(atom.path, atom.body ?? ''))
    }
    return { ok: true as const, rows }
  },
})

export const insertCollectionRow = mutation({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    record: v.record(v.string(), v.any()),
    clientMutationId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { packageRoot, collection, activeWorkspaceId },
  ) => {
    const app = await resolveAppForSecurity(ctx, activeWorkspaceId, packageRoot)
    if (!app.ok) return app
    const config = app.app.collections[collection]
    if (!config) {
      return {
        ok: false as const,
        code: 'collection-not-found' as const,
        message: 'Collection not found.',
      }
    }
    return {
      ok: false as const,
      code: 'canonical-write-required' as const,
      message: 'Collection writes must go through source-backed semantic collaboration.',
    }
  },
})
