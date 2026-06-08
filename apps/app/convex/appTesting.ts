import { v } from 'convex/values'
import { action, internalMutation, internalQuery, query } from './_generated/server'
import { internal } from './_generated/api'
import { canReadAtom, canReadPathByFolderAccess } from './atomAccess'
import { requireWorkspace } from './auth'
import { listCollectionRows } from './collectionAdapters'
import type { CollectionRow } from './collectionAdapterTypes'
import { parseAppManifest } from './appManifest'
import { splitFrontmatter } from './atomId'
import {
  globMatchesPath,
  resolveAppForSecurity,
  scopeAllowsPath,
} from './appSecurity'
import { primaryKeyFor, type DatabaseSnapshot, type DatabaseTable } from './databaseSchema'
import { computeAppSourceDigest } from './appSourceDigest'

const ATOM_SCAN_CAP = 5000
const SOURCE_FILE_CAP = 100
const SOURCE_BYTE_CAP = 512 * 1024
const TEXT_ENCODER = new TextEncoder()

type AppTestMode = 'static' | 'browser' | 'integration'

type AppTestErrorCode =
  | 'app-not-found'
  | 'invalid-manifest'
  | 'collection-not-found'
  | 'source-too-large'
  | 'too-many-files'
  | 'source-read-not-authorized'
  | 'source-read-not-granted'
  | 'source-scan-truncated'
  | 'collection-write-not-granted'
  | 'source-write-not-authorized'
  | 'app-trust-required'
  | 'collection-read-failed'
  | 'database-not-found'
  | 'app-tester-offline'
  | 'app-tester-failed'

type AppTestingError = {
  ok: false
  code: AppTestErrorCode
  message: string
  deniedSources?: string[]
  status?: number
}

type AppTestPayload = {
  packageRoot: string
  mode: AppTestMode
  files: Array<{ relativePath: string; body: string }>
  manifest: {
    collections: Record<string, unknown>
    databases: Record<string, unknown>
    tests: unknown[]
  }
  seed: {
    collections: Record<string, CollectionRow[]>
    docs: Record<string, string>
    databases: Record<string, Record<string, CollectionRow[]>>
  }
}

type ResolvedAppTestPayload =
  | {
      ok: true
      workspaceId: string
      actorUserId: string
      manifestTrustKey?: string
      sourceDigest: string
      payload: AppTestPayload
    }
  | AppTestingError

function error(
  code: AppTestErrorCode,
  message: string,
  extra: Omit<AppTestingError, 'ok' | 'code' | 'message'> = {},
): AppTestingError {
  return { ok: false, code, message, ...extra }
}

function stripDohcFrontmatter(body: string): string {
  return splitFrontmatter(body).rest
}

function packageRelativeFromFullPath(packageRoot: string, path: string): string | null {
  const prefix = `${packageRoot}/`
  if (!path.startsWith(prefix)) return null
  const relativePath = path.slice(prefix.length)
  return relativePath && !relativePath.includes('..') ? relativePath : null
}

function rowIdFor(table: DatabaseTable, key: string | undefined, row: Record<string, unknown>) {
  const primaryKey = key ?? primaryKeyFor(table)
  return String(row[primaryKey] ?? row.id ?? row.ID ?? '')
}

function sqliteRows(
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

function scopeRelativeSeedPath(scopePath: string, path: string): string {
  if (!scopePath) return path
  const prefix = `${scopePath}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function appTesterUrl(): string | null {
  const value = process.env.APP_TESTER_URL?.replace(/\/+$/g, '')
  return value && value.length > 0 ? value : null
}

async function callAppTester(body: AppTestPayload) {
  const baseUrl = appTesterUrl()
  if (!baseUrl) {
    return error('app-tester-offline', 'The app tester service is not configured.')
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/test_app`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.APP_TESTER_TOKEN
          ? { authorization: `Bearer ${process.env.APP_TESTER_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    return error('app-tester-offline', 'The app tester service is not reachable.')
  }
  if (!response.ok) {
    return error('app-tester-failed', 'The app tester service rejected the request.', {
      status: response.status,
    })
  }
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== 'object') {
    return error('app-tester-failed', 'The app tester service returned an invalid response.')
  }
  return value as Record<string, unknown>
}

export const _resolveAppTestPayload = internalQuery({
  args: {
    packageRoot: v.string(),
    mode: v.optional(v.union(v.literal('static'), v.literal('browser'), v.literal('integration'))),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolvedAppTestPayload> => {
    const resolved = await resolveAppForSecurity(ctx, args.activeWorkspaceId, args.packageRoot)
    if (!resolved.ok) return resolved

    const raw = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', resolved.workspaceId))
      .take(ATOM_SCAN_CAP + 1)
    if (raw.length > ATOM_SCAN_CAP) {
      return error('source-scan-truncated', 'This workspace has too many source files to test safely.')
    }
    const bounded = raw.length > ATOM_SCAN_CAP ? raw.slice(0, ATOM_SCAN_CAP) : raw
    const files: Array<{ relativePath: string; body: string }> = []
    let totalBytes = 0

    for (const atom of bounded) {
      const relativePath = packageRelativeFromFullPath(args.packageRoot, atom.path)
      if (!relativePath) continue
      if (!(await canReadAtom(ctx, atom._id, resolved.userId))) continue
      files.push({ relativePath, body: stripDohcFrontmatter(atom.body ?? '') })
      totalBytes += TEXT_ENCODER.encode(atom.body ?? '').length
      if (files.length > SOURCE_FILE_CAP) {
        return error('too-many-files', 'This app has too many source files to test safely.')
      }
      if (totalBytes > SOURCE_BYTE_CAP) {
        return error('source-too-large', 'This app source is too large to test safely.')
      }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    const manifestFile = files.find((file) => file.relativePath === 'app.json')
    const manifest = parseAppManifest({
      appName: resolved.app.appName,
      scopePath: resolved.app.scopePath,
      packageRoot: args.packageRoot,
      body: manifestFile?.body ?? null,
    })
    if (!manifest.status.ok) {
      return error('invalid-manifest', 'The app manifest is invalid.')
    }

    const seed: AppTestPayload['seed'] = {
      collections: {},
      docs: {},
      databases: {},
    }
    const deniedSources = new Set<string>()

    for (const atom of bounded) {
      if (packageRelativeFromFullPath(args.packageRoot, atom.path)) continue
      if (!scopeAllowsPath(manifest.read, atom.path)) continue
      if (!(await canReadAtom(ctx, atom._id, resolved.userId))) {
        deniedSources.add(atom.path)
        continue
      }
      seed.docs[scopeRelativeSeedPath(resolved.app.scopePath, atom.path)] = atom.body ?? ''
    }

    for (const [name, config] of Object.entries(manifest.collections)) {
      if (config.format === 'sqlite') {
        const databasePath = config.source[0]
        if (!databasePath || !scopeAllowsPath(manifest.read, databasePath)) {
          return error('source-read-not-granted', 'This app is not allowed to read that database source.')
        }
        const database = await ctx.db
          .query('databaseFiles')
          .withIndex('by_workspace_path', (q) =>
            q.eq('workspaceId', resolved.workspaceId).eq('path', databasePath),
          )
          .unique()
        if (!database) return error('database-not-found', 'Database source not found.')
        if (!(await canReadPathByFolderAccess(
          ctx,
          resolved.workspaceId,
          database.path,
          resolved.userId,
        ))) {
          deniedSources.add(database.path)
          continue
        }
        const table = (database.tables as DatabaseSnapshot)[config.table ?? name]
        if (table) {
          const rows = sqliteRows(databasePath, table, config.key)
          seed.collections[name] = rows
          seed.databases[databasePath] = {
            ...(seed.databases[databasePath] ?? {}),
            [config.table ?? name]: rows,
          }
          const relativeDatabasePath = scopeRelativeSeedPath(resolved.app.scopePath, databasePath)
          if (relativeDatabasePath !== databasePath) {
            seed.databases[relativeDatabasePath] = {
              ...(seed.databases[relativeDatabasePath] ?? {}),
              [config.table ?? name]: rows,
            }
          }
        }
        continue
      }

      const visibleSources = []
      for (const atom of bounded) {
        if (!config.source.some((source) => globMatchesPath(source, atom.path))) continue
        if (!scopeAllowsPath(manifest.read, atom.path)) {
          deniedSources.add(atom.path)
          continue
        }
        if (!(await canReadAtom(ctx, atom._id, resolved.userId))) {
          deniedSources.add(atom.path)
          continue
        }
        visibleSources.push({ path: atom.path, body: atom.body ?? '' })
      }
      const rows = listCollectionRows(
        { name, format: config.format, key: config.key, table: config.table },
        visibleSources.sort((a, b) => a.path.localeCompare(b.path)),
        undefined,
      )
      if (!rows.ok) {
        return error('collection-read-failed', rows.message)
      }
      seed.collections[name] = rows.rows
    }

    if (deniedSources.size > 0) {
      return error(
        'source-read-not-authorized',
        'Cannot test this app with partial source-backed data because some sources are private.',
        { deniedSources: [...deniedSources].sort((a, b) => a.localeCompare(b)) },
      )
    }

    return {
      ok: true,
      workspaceId: resolved.workspaceId,
      actorUserId: resolved.userId,
      ...(manifest.trustKey === null ? {} : { manifestTrustKey: manifest.trustKey }),
      sourceDigest: await computeAppSourceDigest({
        files,
        manifestTrustKey: manifest.trustKey ?? undefined,
        seed,
      }),
      payload: {
        packageRoot: args.packageRoot,
        mode: args.mode ?? 'browser',
        files,
        manifest: {
          collections: manifest.collections,
          databases: manifest.databases,
          tests: manifest.tests,
        },
        seed,
      },
    }
  },
})

export const _recordResult = internalMutation({
  args: {
    workspaceId: v.string(),
    actorUserId: v.string(),
    packageRoot: v.string(),
    manifestTrustKey: v.optional(v.string()),
    sourceDigest: v.string(),
    mode: v.union(v.literal('static'), v.literal('browser'), v.literal('integration')),
    ok: v.boolean(),
    result: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('appTestResults', {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      packageRoot: args.packageRoot,
      ...(args.manifestTrustKey === undefined ? {} : { manifestTrustKey: args.manifestTrustKey }),
      sourceDigest: args.sourceDigest,
      mode: args.mode,
      ok: args.ok,
      result: args.result,
      createdAt: Date.now(),
    })
    return { ok: true as const }
  },
})

export const testApp = action({
  args: {
    packageRoot: v.string(),
    mode: v.optional(v.union(v.literal('static'), v.literal('browser'), v.literal('integration'))),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: args.activeWorkspaceId,
    }) as string
    const resolved = await ctx.runQuery(internal.appTesting._resolveAppTestPayload, {
      activeWorkspaceId: workspaceId,
      packageRoot: args.packageRoot,
      mode: args.mode,
    }) as ResolvedAppTestPayload
    if (!resolved.ok) return resolved

    const result = await callAppTester(resolved.payload)
    await ctx.runMutation(internal.appTesting._recordResult, {
      workspaceId: resolved.workspaceId,
      actorUserId: resolved.actorUserId,
      packageRoot: args.packageRoot,
      manifestTrustKey: resolved.manifestTrustKey,
      sourceDigest: resolved.sourceDigest,
      mode: resolved.payload.mode,
      ok: result.ok === true,
      result,
    })
    return result
  },
})

export const latestResult = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspaceId = await requireWorkspace(ctx, args.activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const resolved = await ctx.runQuery(internal.appTesting._resolveAppTestPayload, {
      activeWorkspaceId: workspaceId,
      packageRoot: args.packageRoot,
      mode: 'browser',
    }) as ResolvedAppTestPayload
    if (!resolved.ok) return null
    const rows = await ctx.db
      .query('appTestResults')
      .withIndex('by_workspace_app', (q) =>
        q.eq('workspaceId', workspaceId).eq('packageRoot', args.packageRoot),
      )
      .order('desc')
      .take(20)
    const currentTrustKey = resolved.manifestTrustKey
    const currentSourceDigest = resolved.sourceDigest
    const row = rows.find((candidate) =>
      candidate.manifestTrustKey === currentTrustKey &&
      candidate.sourceDigest === currentSourceDigest
    )
    if (!row) return null
    return {
      ok: row.ok,
      packageRoot: row.packageRoot,
      mode: row.mode,
      result: row.result,
      createdAt: row.createdAt,
    }
  },
})
