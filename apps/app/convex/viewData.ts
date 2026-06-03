import { v } from 'convex/values'
import { action, internalQuery, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import {
  deriveTitle,
  extractFrontmatterId,
  isNonDataAtom,
  normalizeFileId,
} from './atomId'
import {
  parseInlineAtomsFromMarkdown,
  parseInlineAtomsFromMarkdownWithStatus,
} from './inlineAtom'
import { resolveScopeRelativePath } from './viewPaths'
import { resolveViewDescriptor } from './views'
import type { ViewActionDescriptor } from './views'
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

type ViewActionErrorCode =
  | 'view-not-found'
  | 'action-not-found'
  | 'write-not-granted'
  | 'not-found'
  | 'forbidden'
  | 'invalid-field'
  | 'invalid-input'
  | 'missing-atom-id'
  | 'semantic-backend-offline'
  | 'semantic-apply-failed'

type ViewActionError = {
  ok: false
  code: ViewActionErrorCode
  message: string
}

type ResolvedViewAction = {
  ok: true
  action: string
  path: string
  workspaceId: string
  atomId: string
  expectedText: string
  replacement: string
  actorUserId: string
}

type ViewActionResult =
  | {
      ok: true
      action: string
      path: string
      operationId: string
    }
  | ViewActionError

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

function hocuspocusSemanticEnv(): { url: string; token: string } | null {
  const url = process.env.HOCUSPOCUS_ADMIN_URL
  const token = process.env.HOCUSPOCUS_ADMIN_TOKEN
  if (!url || !token) return null
  return { url, token }
}

async function callHocuspocusSemantic(
  route: 'createAnchorsForText' | 'replaceRange',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> & { ok?: boolean; reason?: string; error?: string }> {
  const env = hocuspocusSemanticEnv()
  if (!env) {
    return { ok: false, reason: 'semantic-backend-offline' }
  }
  let response: Response
  try {
    response = await fetch(new URL(`/apply/${route}`, env.url).toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, reason: 'semantic-backend-offline' }
  }
  const body = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { ok?: boolean; reason?: string; error?: string })
    | null
  if (!response.ok) {
    return {
      ok: false,
      reason: body?.reason ?? body?.error ?? `http-${response.status}`,
    }
  }
  return body ?? { ok: false, reason: 'empty-response' }
}

function actionError(
  code: ViewActionErrorCode,
  message: string,
): ViewActionError {
  return { ok: false, code, message }
}

function inputScalar(
  input: Record<string, unknown> | undefined,
): string | number | boolean | null {
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'value')) return null
  const value = input.value
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    ? value
    : null
}

function formatInlineAtomReplacement(
  field: string,
  value: string | number | boolean,
  valueType?: 'string' | 'number' | 'boolean' | 'date',
): string | null {
  if (valueType === 'number' || typeof value === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? `{${field}: ${String(Math.round(value * 100) / 100)}}`
      : null
  }
  if (valueType === 'boolean' || typeof value === 'boolean') {
    return typeof value === 'boolean' ? `{${field}: ${value ? 'true' : 'false'}}` : null
  }
  if (valueType === 'date') {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `{${field}: ${value}}`
      : null
  }
  if (typeof value !== 'string') return null
  if (value.includes('\n') || value.includes('\r') || value.includes('{') || value.includes('}')) {
    return null
  }
  return `{${field}: ${JSON.stringify(value)}}`
}

function replacementForAction(
  action: ViewActionDescriptor,
  body: string,
  input: Record<string, unknown> | undefined,
): { ok: true; expectedText: string; replacement: string } | ViewActionError {
  const parsed = parseInlineAtomsFromMarkdownWithStatus(body)
  if (!parsed.ok) {
    return actionError(
      'invalid-field',
      'The target atom could not be parsed safely.',
    )
  }
  const matches = parsed.atoms.filter(
    (inline) => inline.kind === 'value' && inline.key === action.field,
  )
  if (matches.length === 0) {
    return actionError(
      'invalid-field',
      `The field "${action.field}" was not found in the target atom.`,
    )
  }
  if (matches.length > 1) {
    return actionError(
      'invalid-field',
      `The field "${action.field}" appears more than once in the target atom.`,
    )
  }
  const inline = matches[0]!
  if (inline.kind !== 'value') {
    return actionError('invalid-field', 'The target field is not editable.')
  }

  if (action.kind === 'field.increment') {
    if (inline.valueType !== 'number' || typeof inline.value !== 'number') {
      return actionError(
        'invalid-field',
        `The field "${action.field}" is not numeric.`,
      )
    }
    const by = action.by ?? 1
    const next = inline.value + by
    if (!Number.isFinite(next)) {
      return actionError('invalid-input', 'The increment result is not finite.')
    }
    return {
      ok: true,
      expectedText: inline.raw,
      replacement: `{${action.field}: ${String(Math.round(next * 100) / 100)}}`,
    }
  }

  const value = inputScalar(input)
  if (value === null) {
    return actionError(
      'invalid-input',
      'This view action requires an input value.',
    )
  }
  const replacement = formatInlineAtomReplacement(
    action.field,
    value,
    action.valueType,
  )
  if (replacement === null) {
    return actionError(
      'invalid-input',
      'The input value does not match this action.',
    )
  }
  return { ok: true, expectedText: inline.raw, replacement }
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

export const _resolveActionForRun = internalQuery({
  args: {
    packageRoot: v.string(),
    name: v.string(),
    input: v.optional(v.record(v.string(), v.any())),
    activeWorkspaceId: v.optional(v.string()),
    subject: v.string(),
  },
  handler: async (
    ctx,
    { packageRoot, name, input, activeWorkspaceId, subject },
  ): Promise<ResolvedViewAction | ViewActionError> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity || identity.subject !== subject) {
      return actionError('forbidden', 'Not authenticated.')
    }
    const view = await resolveViewDescriptor(ctx, workspaceId, subject, packageRoot)
    if (!view) {
      return actionError('view-not-found', 'View not found.')
    }
    const declaredAction = view.actions.find((action) => action.name === name)
    if (!declaredAction) {
      return actionError('action-not-found', 'This view action is not declared.')
    }
    if (!scopeAllowsPath(view.write, declaredAction.path)) {
      return actionError(
        'write-not-granted',
        'This view action is not allowed to edit that source.',
      )
    }

    const atom = await atomByPath(ctx, workspaceId, declaredAction.path)
    if (!atom) {
      return actionError('not-found', 'Target atom not found.')
    }
    if (isNonDataAtom(atom.path, atom.body ?? '')) {
      return actionError('invalid-field', 'View source files cannot be edited by actions.')
    }
    if (!(await canWriteAtomPath(ctx, workspaceId, atom.path, subject))) {
      return actionError('forbidden', 'Not authorized to edit this atom.')
    }
    const atomId = extractFrontmatterId(atom.body ?? '')
    if (!atomId) {
      return actionError(
        'missing-atom-id',
        'The target atom is missing a stable frontmatter id.',
      )
    }
    const replacement = replacementForAction(declaredAction, atom.body ?? '', input)
    if (!replacement.ok) return replacement

    return {
      ok: true,
      action: declaredAction.name,
      path: atom.path,
      workspaceId,
      atomId,
      expectedText: replacement.expectedText,
      replacement: replacement.replacement,
      actorUserId: subject,
    }
  },
})

export const runAction = action({
  args: {
    packageRoot: v.string(),
    name: v.string(),
    input: v.optional(v.record(v.string(), v.any())),
    clientMutationId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { packageRoot, name, input, clientMutationId, activeWorkspaceId },
  ): Promise<ViewActionResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId,
    })
    const resolved = await ctx.runQuery(internal.viewData._resolveActionForRun, {
      packageRoot,
      name,
      input,
      activeWorkspaceId: workspaceId,
      subject: identity.subject,
    })
    if (!resolved.ok) return resolved

    const actor = {
      userId: resolved.actorUserId,
      actorKind: 'user',
      authzVersion: 1,
    }
    const anchors = await callHocuspocusSemantic('createAnchorsForText', {
      workspaceId: resolved.workspaceId,
      atomId: resolved.atomId,
      actor,
      expectedText: resolved.expectedText,
    })
    if (
      anchors.ok !== true ||
      typeof anchors.anchorStart !== 'string' ||
      typeof anchors.anchorEnd !== 'string'
    ) {
      const reason = anchors.reason ?? anchors.error
      return actionError(
        reason === 'semantic-backend-offline'
          ? 'semantic-backend-offline'
          : 'semantic-apply-failed',
        reason === 'semantic-backend-offline'
          ? 'The collaboration write backend is offline.'
          : `Could not anchor the target field (${String(reason ?? 'unknown')}).`,
      )
    }

    const operationId = `viewAction:${packageRoot}:${resolved.action}:${clientMutationId}`
    const applied = await callHocuspocusSemantic('replaceRange', {
      operationId,
      workspaceId: resolved.workspaceId,
      atomId: resolved.atomId,
      actor,
      anchorStart: anchors.anchorStart,
      anchorEnd: anchors.anchorEnd,
      expectedText: resolved.expectedText,
      replacement: resolved.replacement,
    })
    if (applied.ok !== true) {
      const reason = applied.reason ?? applied.error
      return actionError(
        reason === 'semantic-backend-offline'
          ? 'semantic-backend-offline'
          : 'semantic-apply-failed',
        reason === 'semantic-backend-offline'
          ? 'The collaboration write backend is offline.'
          : `Could not apply the view action (${String(reason ?? 'unknown')}).`,
      )
    }

    return {
      ok: true,
      action: resolved.action,
      path: resolved.path,
      operationId,
    }
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
