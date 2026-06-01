import { v } from 'convex/values'
import { query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import { deriveTitle, isNonDataAtom, normalizeFileId } from './atomId'
import { parseInlineAtomsFromMarkdown } from './inlineAtom'
import { resolveScopeRelativePath } from './viewPaths'
import { resolveViewDescriptor } from './views'
import { previewWindowImpl, resolveWindowForViewer } from './windows'

const SOURCE_SCAN_CAP = 5000
const RESULT_ROW_CAP = 500

type ViewDataErrorCode = 'view-not-found' | 'invalid-path' | 'not-found' | 'forbidden'

type ViewDataError = {
  ok: false
  code: ViewDataErrorCode
  message: string
}

const VIEW_NOT_FOUND: ViewDataError = {
  ok: false,
  code: 'view-not-found',
  message: 'View not found.',
}

const INVALID_PATH: ViewDataError = {
  ok: false,
  code: 'invalid-path',
  message: 'This path is not available to this view.',
}

function leafTitle(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
}

function pathInScope(path: string, scopePath: string): boolean {
  if (scopePath === '') return true
  return path === scopePath || path.startsWith(`${scopePath}/`)
}

function scopeAllowsPath(scopes: string[], path: string): boolean {
  return scopes.some((scope) => pathInScope(path, scope))
}

async function resolveView(
  ctx: QueryCtx,
  activeWorkspaceId: string | undefined,
  packageRoot: string,
) {
  const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
  const identity = await ctx.auth.getUserIdentity()
  const viewerSubject = identity?.subject ?? ''
  const view = await resolveViewDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
  if (!view) return null
  return { workspaceId, viewerSubject, view }
}

function resolveSource(view: { scopePath: string; read: string[] }, source?: string): string | null {
  const requested = source?.trim() || '.'
  const resolved = resolveScopeRelativePath(view.scopePath, requested)
  if (resolved === null) return null
  if (!scopeAllowsPath(view.read, resolved)) return null
  return resolved
}

function resolveAtomRequest(
  view: { scopePath: string; read: string[] },
  requestedPath: string,
): string | null {
  const resolved = resolveScopeRelativePath(view.scopePath, requestedPath)
  if (resolved === null) return null
  if (!scopeAllowsPath(view.read, resolved)) return null
  return resolved
}

async function visibleAtomsInScope(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
  sourceScope: string,
): Promise<{ atoms: Doc<'atoms'>[]; truncated: boolean }> {
  const raw = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(SOURCE_SCAN_CAP + 1)
  const truncated = raw.length > SOURCE_SCAN_CAP
  const bounded = truncated ? raw.slice(0, SOURCE_SCAN_CAP) : raw
  const atoms: Doc<'atoms'>[] = []

  for (const atom of bounded) {
    if (!pathInScope(atom.path, sourceScope)) continue
    if (isNonDataAtom(atom.path, atom.body ?? '')) continue
    if (!(await canReadAtom(ctx, atom._id, viewerSubject))) continue
    atoms.push(atom)
  }

  atoms.sort((a, b) => a.path.localeCompare(b.path))
  return { atoms, truncated }
}

async function atomByPath(
  ctx: QueryCtx,
  workspaceId: string,
  path: string,
): Promise<Doc<'atoms'> | null> {
  return await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
}

export const listSources = query({
  args: {
    packageRoot: v.string(),
    source: v.optional(v.string()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, source, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const sourceScope = resolveSource(resolved.view, source)
    if (sourceScope === null) return INVALID_PATH

    const { atoms, truncated } = await visibleAtomsInScope(
      ctx,
      resolved.workspaceId,
      resolved.viewerSubject,
      sourceScope,
    )

    return {
      ok: true as const,
      truncated,
      rows: atoms.slice(0, RESULT_ROW_CAP).map((atom) => ({
        kind: 'atom' as const,
        path: atom.path,
        fileId: normalizeFileId(atom.path),
        title: deriveTitle(atom.body ?? '', atom.path) ?? leafTitle(atom.path),
        updatedAt: atom.updatedAt,
        sourceRef: { kind: 'atom' as const, path: atom.path },
      })),
    }
  },
})

export const getAtom = query({
  args: {
    packageRoot: v.string(),
    path: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, path, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const atomPath = resolveAtomRequest(resolved.view, path)
    if (atomPath === null) return INVALID_PATH

    const atom = await atomByPath(ctx, resolved.workspaceId, atomPath)
    if (!atom) {
      return { ok: false as const, code: 'not-found' as const, message: 'Atom not found.' }
    }
    if (!(await canReadAtom(ctx, atom._id, resolved.viewerSubject))) {
      return { ok: false as const, code: 'forbidden' as const, message: 'Atom not found.' }
    }
    if (isNonDataAtom(atom.path, atom.body ?? '')) return INVALID_PATH

    return {
      ok: true as const,
      atom: {
        path: atom.path,
        fileId: normalizeFileId(atom.path),
        title: deriveTitle(atom.body ?? '', atom.path) ?? leafTitle(atom.path),
        body: atom.body,
        updatedAt: atom.updatedAt,
        sourceRef: { kind: 'atom' as const, path: atom.path },
      },
    }
  },
})

export const queryFields = query({
  args: {
    packageRoot: v.string(),
    source: v.optional(v.string()),
    keys: v.optional(v.array(v.string())),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, source, keys, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const sourceScope = resolveSource(resolved.view, source)
    if (sourceScope === null) return INVALID_PATH
    const keySet = keys && keys.length > 0 ? new Set(keys) : null

    const { atoms, truncated } = await visibleAtomsInScope(
      ctx,
      resolved.workspaceId,
      resolved.viewerSubject,
      sourceScope,
    )
    const rows = []
    for (const atom of atoms) {
      for (const inline of parseInlineAtomsFromMarkdown(atom.body ?? '')) {
        if (inline.kind !== 'value') continue
        if (keySet && !keySet.has(inline.key)) continue
        rows.push({
          kind: 'field' as const,
          path: atom.path,
          key: inline.key,
          value: inline.value,
          valueType: inline.valueType,
          sourceRef: {
            kind: 'atom' as const,
            path: atom.path,
            key: inline.key,
          },
        })
        if (rows.length >= RESULT_ROW_CAP) {
          return { ok: true as const, truncated: true, rows }
        }
      }
    }

    return { ok: true as const, truncated, rows }
  },
})

export const listImports = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const grants = await ctx.db
      .query('windowGrants')
      .withIndex('by_viewer', (q) => q.eq('viewerWorkspaceId', resolved.workspaceId))
      .take(200)
    const seen = new Set<string>()
    const rows: Array<{
      kind: 'import'
      windowId: Id<'windows'>
      name: string
      ownerWorkspaceId: string
      view: Record<string, string | number | boolean> | null
    }> = []
    for (const grant of grants) {
      if (seen.has(grant.windowId)) continue
      seen.add(grant.windowId)
      const win = await ctx.db.get(grant.windowId)
      if (!win) continue
      const { result } = await resolveWindowForViewer(
        ctx,
        grant.windowId,
        resolved.workspaceId,
      )
      rows.push({
        kind: 'import',
        windowId: grant.windowId,
        name: win.name,
        ownerWorkspaceId: win.ownerWorkspaceId,
        view: result.ok ? result.view : null,
      })
    }
    return { ok: true as const, rows }
  },
})

export const listExports = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const windows = await ctx.db
      .query('windows')
      .withIndex('by_owner', (q) => q.eq('ownerWorkspaceId', resolved.workspaceId))
      .take(500)
    const rows = []
    for (const win of windows) {
      const grants = await ctx.db
        .query('windowGrants')
        .withIndex('by_window', (q) => q.eq('windowId', win._id))
        .take(200)
      rows.push({
        kind: 'export' as const,
        windowId: win._id,
        name: win.name,
        selector: win.selector,
        shape: win.shape,
        grantees: Array.from(new Set(grants.map((grant) => grant.viewerWorkspaceId))).sort(),
      })
    }
    return { ok: true as const, rows }
  },
})

export const previewExport = query({
  args: {
    packageRoot: v.string(),
    windowId: v.id('windows'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, windowId, activeWorkspaceId }) => {
    const resolved = await resolveView(ctx, activeWorkspaceId, packageRoot)
    if (!resolved) return VIEW_NOT_FOUND

    const win = await ctx.db.get(windowId)
    if (!win || win.ownerWorkspaceId !== resolved.workspaceId) {
      return {
        ok: false as const,
        code: 'not-found' as const,
        message: 'Export not found.',
      }
    }

    return {
      ok: true as const,
      result: await previewWindowImpl(ctx, windowId, resolved.workspaceId),
    }
  },
})
