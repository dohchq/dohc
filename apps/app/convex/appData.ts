import { v } from 'convex/values'
import { action, internalMutation, internalQuery, query } from './_generated/server'
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
import { resolveScopeRelativePath } from './appPaths'
import { isAppDescriptorError, resolveAppDescriptor } from './apps'
import type { AppActionDescriptor } from './apps'
import { previewWindowImpl, resolveWindowForViewer } from './windows'
import {
  getCollectionRow,
  listCollectionRows,
  planCollectionMutation,
} from './collectionAdapters'
import {
  authorizeCollectionWrite,
  globMatchesPath,
  pathInScope,
  scopeAllowsPath,
  scopeAllowsPath as appScopeAllowsPath,
} from './appSecurity'
import { isTrustedForKey } from './appTrust'

const SOURCE_SCAN_CAP = 5000
const RESULT_ROW_CAP = 500

type AppDataErrorCode =
  | 'app-not-found'
  | 'invalid-path'
  | 'not-found'
  | 'forbidden'
  | 'source-scan-truncated'

type AppDataError = {
  ok: false
  code: AppDataErrorCode
  message: string
}

const APP_NOT_FOUND: AppDataError = {
  ok: false,
  code: 'app-not-found',
  message: 'App not found.',
}

const INVALID_PATH: AppDataError = {
  ok: false,
  code: 'invalid-path',
  message: 'This path is not available to this app.',
}

function descriptorErrorToAppData(error: { code: 'source-scan-truncated'; message: string }): AppDataError {
  return { ok: false, code: error.code, message: error.message }
}

type AppActionErrorCode =
  | 'app-not-found'
  | 'action-not-found'
  | 'write-not-granted'
  | 'not-found'
  | 'forbidden'
  | 'invalid-field'
  | 'invalid-input'
  | 'missing-atom-id'
  | 'semantic-backend-offline'
  | 'semantic-apply-failed'
  | 'collection-not-found'
  | 'collection-write-not-granted'
  | 'collection-row-not-found'
  | 'collection-duplicate-id'
  | 'invalid-manifest'
  | 'source-read-not-granted'
  | 'source-read-not-authorized'
  | 'source-write-not-authorized'
  | 'source-version-conflict'
  | 'app-trust-required'
  | 'collection-scan-truncated'
  | 'source-scan-truncated'
  | 'unsupported-format'

type AppActionError = {
  ok: false
  code: AppActionErrorCode
  message: string
}

type ResolvedAppAction = {
  ok: true
  action: string
  path: string
  workspaceId: string
  atomId: string
  expectedText: string
  replacement: string
  actorUserId: string
}

type AppActionResult =
  | {
      ok: true
      action: string
      path: string
      operationId: string
    }
  | AppActionError

type CollectionMutationOp = 'insert' | 'update' | 'upsert' | 'delete'

type ResolvedCollectionMutation = {
  ok: true
  operation: `collection.${CollectionMutationOp}`
  collection: string
  path: string
  workspaceId: string
  atomId: string
  expectedText: string
  replacement: string
  actorUserId: string
  targetId?: string
  sourceRevision: string
}

type CollectionMutationResult =
  | {
      ok: true
      operation: `collection.${CollectionMutationOp}`
      path: string
      operationId: string
      sourceRevision: string
    }
  | AppActionError

function leafTitle(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
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
  code: AppActionErrorCode,
  message: string,
): AppActionError {
  return { ok: false, code, message }
}

function collectionActionError(code: AppActionErrorCode, message: string): AppActionError {
  return actionError(code, message)
}

function mapCollectionAdapterError(result: { code: string; message: string }): AppActionError {
  if (result.code === 'duplicate-id') {
    return collectionActionError('collection-duplicate-id', result.message)
  }
  if (result.code === 'row-not-found') {
    return collectionActionError('collection-row-not-found', result.message)
  }
  if (result.code === 'unsupported-format' || result.code === 'read-only-adapter') {
    return collectionActionError('unsupported-format', result.message)
  }
  return collectionActionError('invalid-input', result.message)
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
  action: AppActionDescriptor,
  body: string,
  input: Record<string, unknown> | undefined,
): { ok: true; expectedText: string; replacement: string } | AppActionError {
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
      'This app action requires an input value.',
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

async function resolveApp(
  ctx: QueryCtx,
  activeWorkspaceId: string | undefined,
  packageRoot: string,
) {
  const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
  const identity = await ctx.auth.getUserIdentity()
  const viewerSubject = identity?.subject ?? ''
  const app = await resolveAppDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
  if (isAppDescriptorError(app)) return descriptorErrorToAppData(app)
  if (!app) return APP_NOT_FOUND
  return { ok: true as const, workspaceId, viewerSubject, app }
}

function resolveSource(app: { scopePath: string; read: string[] }, source?: string): string | null {
  const requested = source?.trim() || '.'
  const resolved = resolveScopeRelativePath(app.scopePath, requested)
  if (resolved === null) return null
  if (!scopeAllowsPath(app.read, resolved)) return null
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
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

    const sourceScope = resolveSource(resolved.app, source)
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
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

    const atomPath = resolveScopeRelativePath(resolved.app.scopePath, path)
    if (atomPath === null) return INVALID_PATH
    if (!scopeAllowsPath(resolved.app.read, atomPath)) {
      return {
        ok: false as const,
        code: 'source-read-not-granted' as const,
        message: 'This app is not allowed to read that source.',
      }
    }

    const atom = await atomByPath(ctx, resolved.workspaceId, atomPath)
    if (!atom) {
      return { ok: false as const, code: 'not-found' as const, message: 'Atom not found.' }
    }
    if (!(await canReadAtom(ctx, atom._id, resolved.viewerSubject))) {
      return {
        ok: false as const,
        code: 'source-read-not-authorized' as const,
        message: 'Not authorized to read this source.',
      }
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
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

    const sourceScope = resolveSource(resolved.app, source)
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
  ): Promise<ResolvedAppAction | AppActionError> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity || identity.subject !== subject) {
      return actionError('forbidden', 'Not authenticated.')
    }
    const app = await resolveAppDescriptor(ctx, workspaceId, subject, packageRoot)
    if (isAppDescriptorError(app)) return actionError(app.code, app.message)
    if (!app) {
      return actionError('app-not-found', 'App not found.')
    }
    if (!app.trustKey || !(await isTrustedForKey(
      ctx,
      workspaceId,
      subject,
      packageRoot,
      app.trustKey,
    ))) {
      return actionError('app-trust-required', 'This user has not trusted the current app manifest.')
    }
    const declaredAction = app.actions.find((action) => action.name === name)
    if (!declaredAction) {
      return actionError('action-not-found', 'This app action is not declared.')
    }
    if (!scopeAllowsPath(app.write, declaredAction.path)) {
      return actionError(
        'write-not-granted',
        'This app action is not allowed to edit that source.',
      )
    }

    const atom = await atomByPath(ctx, workspaceId, declaredAction.path)
    if (!atom) {
      return actionError('not-found', 'Target atom not found.')
    }
    if (isNonDataAtom(atom.path, atom.body ?? '')) {
      return actionError('invalid-field', 'App source files cannot be edited by actions.')
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
  ): Promise<AppActionResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId,
    })
    const resolved = await ctx.runQuery(internal.appData._resolveActionForRun, {
      packageRoot,
      name,
      input,
      activeWorkspaceId: workspaceId,
      subject: identity.subject,
    })
    if (!resolved.ok) return resolved

    const actor = {
      userId: resolved.actorUserId,
      actorKind: 'app',
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

    const operationId = `appAction:${packageRoot}:${resolved.action}:${clientMutationId}`
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
          : `Could not apply the app action (${String(reason ?? 'unknown')}).`,
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

type DocMutationOp =
  | 'set'
  | 'append'
  | 'replaceText'
  | 'section.append'
  | 'section.replace'

type ResolvedDocMutation = {
  ok: true
  operation: string
  workspaceId: string
  atomId: string
  path: string
  expectedText: string
  replacement: string
  actorUserId: string
}

type DocMutationResult =
  | {
      ok: true
      operation: string
      path: string
      operationId: string
    }
  | AppActionError

function valueToFrontmatter(value: unknown): string | null {
  if (value === null) return ''
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value)
  }
  return null
}

function replaceFrontmatterValue(body: string, key: string, value: unknown) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return actionError('invalid-input', 'Invalid document key.')
  }
  const serialized = valueToFrontmatter(value)
  if (serialized === null) return actionError('invalid-input', 'Document values must be scalar.')
  if (!body.startsWith('---\n')) {
    return {
      ok: true as const,
      expectedText: body,
      replacement: `---\n${key}: ${serialized}\n---\n${body}`,
    }
  }
  const end = body.indexOf('\n---', 4)
  if (end < 0) {
    return {
      ok: true as const,
      expectedText: body,
      replacement: `---\n${key}: ${serialized}\n---\n${body}`,
    }
  }
  const head = body.slice(4, end).split('\n')
  let replaced = false
  const next = head.map((line) => {
    const index = line.indexOf(':')
    if (index <= 0 || line.slice(0, index).trim() !== key) return line
    replaced = true
    return `${key}: ${serialized}`
  })
  if (!replaced) next.push(`${key}: ${serialized}`)
  return {
    ok: true as const,
    expectedText: body,
    replacement: `---\n${next.join('\n')}\n---${body.slice(end + 4)}`,
  }
}

function appendMarkdown(body: string, markdown: string) {
  const spacer = body.endsWith('\n') ? '\n' : '\n\n'
  return { ok: true as const, expectedText: body, replacement: `${body}${spacer}${markdown}` }
}

function findOccurrence(body: string, text: string, occurrence: number): number {
  let from = 0
  for (let seen = 1; seen <= occurrence; seen += 1) {
    const found = body.indexOf(text, from)
    if (found < 0) return -1
    if (seen === occurrence) return found
    from = found + text.length
  }
  return -1
}

function replaceTextPlan(
  body: string,
  find: string | undefined,
  replacement: string | undefined,
  occurrence: number | undefined,
) {
  if (!find || replacement === undefined) {
    return actionError('invalid-input', 'Document replaceText requires find and with.')
  }
  const count = occurrence ?? 1
  const index = findOccurrence(body, find, count)
  if (index < 0) return actionError('not-found', 'Target text was not found.')
  return { ok: true as const, expectedText: find, replacement }
}

function headingRegExp(heading: string) {
  return new RegExp(`^(#{1,6})\\s+${heading.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\s*$`, 'm')
}

function sectionPlan(
  body: string,
  op: 'section.append' | 'section.replace',
  heading: string | undefined,
  markdown: string | undefined,
) {
  if (!heading || markdown === undefined) {
    return actionError('invalid-input', 'Document section mutation requires heading and markdown.')
  }
  const match = headingRegExp(heading).exec(body)
  if (!match || match.index === undefined) {
    const suffix = body.endsWith('\n') ? '\n' : '\n\n'
    return {
      ok: true as const,
      expectedText: body,
      replacement: `${body}${suffix}## ${heading}\n\n${markdown}`,
    }
  }
  const level = match[1]!.length
  const start = match.index
  const afterHeading = start + match[0].length
  const rest = body.slice(afterHeading)
  const nextMatch = new RegExp(`^#{1,${level}}\\s+`, 'm').exec(rest)
  const end = nextMatch?.index === undefined ? body.length : afterHeading + nextMatch.index
  const current = body.slice(start, end)
  const replacement =
    op === 'section.replace'
      ? `${match[0]}\n\n${markdown}\n`
      : `${current.replace(/\s*$/g, '')}\n${markdown}\n`
  return { ok: true as const, expectedText: current, replacement }
}

function docMutationPlan(
  body: string,
  args: {
    op: DocMutationOp
    key?: string
    value?: unknown
    markdown?: string
    find?: string
    with?: string
    occurrence?: number
    heading?: string
  },
) {
  if (args.op === 'set') return replaceFrontmatterValue(body, args.key ?? '', args.value)
  if (args.op === 'append') {
    if (args.markdown === undefined) return actionError('invalid-input', 'Document append requires markdown.')
    return appendMarkdown(body, args.markdown)
  }
  if (args.op === 'replaceText') {
    return replaceTextPlan(body, args.find, args.with, args.occurrence)
  }
  return sectionPlan(body, args.op, args.heading, args.markdown)
}

export const _resolveDocMutationForRun = internalQuery({
  args: {
    packageRoot: v.string(),
    op: v.union(
      v.literal('set'),
      v.literal('append'),
      v.literal('replaceText'),
      v.literal('section.append'),
      v.literal('section.replace'),
    ),
    path: v.string(),
    key: v.optional(v.string()),
    value: v.optional(v.any()),
    markdown: v.optional(v.string()),
    find: v.optional(v.string()),
    with: v.optional(v.string()),
    occurrence: v.optional(v.number()),
    heading: v.optional(v.string()),
    activeWorkspaceId: v.optional(v.string()),
    subject: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<ResolvedDocMutation | AppActionError> => {
    const workspaceId = await requireWorkspace(ctx, args.activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity || identity.subject !== args.subject) {
      return actionError('forbidden', 'Not authenticated.')
    }
    const app = await resolveAppDescriptor(ctx, workspaceId, args.subject, args.packageRoot)
    if (isAppDescriptorError(app)) return actionError(app.code, app.message)
    if (!app) return actionError('app-not-found', 'App not found.')
    if (!app.configStatus.ok) return actionError('invalid-manifest', 'The app manifest is invalid.')
    const atomPath = resolveScopeRelativePath(app.scopePath, args.path)
    if (atomPath === null || !scopeAllowsPath(app.read, atomPath)) {
      return actionError('source-read-not-granted', 'This app is not allowed to read that source.')
    }
    if (!scopeAllowsPath(app.write, atomPath)) {
      return actionError('write-not-granted', 'This app is not allowed to write that source.')
    }
    if (!app.trustKey || !(await isTrustedForKey(
      ctx,
      workspaceId,
      args.subject,
      args.packageRoot,
      app.trustKey,
    ))) {
      return actionError('app-trust-required', 'This user has not trusted the current app manifest.')
    }
    const atom = await atomByPath(ctx, workspaceId, atomPath)
    if (!atom) return actionError('not-found', 'Target atom not found.')
    if (!(await canReadAtom(ctx, atom._id, args.subject))) {
      return actionError('source-read-not-authorized', 'Not authorized to read this source.')
    }
    if (!(await canWriteAtomPath(ctx, workspaceId, atom.path, args.subject))) {
      return actionError('source-write-not-authorized', 'Not authorized to write this source.')
    }
    if (atom.systemLocked || atom.userLocked) {
      return actionError('source-write-not-authorized', 'This source is locked.')
    }
    if (isNonDataAtom(atom.path, atom.body ?? '')) {
      return actionError('invalid-field', 'App source files cannot be edited by doc mutations.')
    }
    const atomId = extractFrontmatterId(atom.body ?? '')
    if (!atomId) {
      return actionError('missing-atom-id', 'The target atom is missing a stable frontmatter id.')
    }
    const plan = docMutationPlan(atom.body ?? '', args)
    if (!plan.ok) return plan
    return {
      ok: true,
      operation: `doc.${args.op}`,
      workspaceId,
      atomId,
      path: atom.path,
      expectedText: plan.expectedText,
      replacement: plan.replacement,
      actorUserId: args.subject,
    }
  },
})

export const runDocMutation = action({
  args: {
    packageRoot: v.string(),
    op: v.union(
      v.literal('set'),
      v.literal('append'),
      v.literal('replaceText'),
      v.literal('section.append'),
      v.literal('section.replace'),
    ),
    path: v.string(),
    key: v.optional(v.string()),
    value: v.optional(v.any()),
    markdown: v.optional(v.string()),
    find: v.optional(v.string()),
    with: v.optional(v.string()),
    occurrence: v.optional(v.number()),
    heading: v.optional(v.string()),
    clientMutationId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DocMutationResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: args.activeWorkspaceId,
    })
    const resolved = await ctx.runQuery(internal.appData._resolveDocMutationForRun, {
      packageRoot: args.packageRoot,
      op: args.op,
      path: args.path,
      ...(args.key === undefined ? {} : { key: args.key }),
      ...(args.value === undefined ? {} : { value: args.value }),
      ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
      ...(args.find === undefined ? {} : { find: args.find }),
      ...(args.with === undefined ? {} : { with: args.with }),
      ...(args.occurrence === undefined ? {} : { occurrence: args.occurrence }),
      ...(args.heading === undefined ? {} : { heading: args.heading }),
      activeWorkspaceId: workspaceId,
      subject: identity.subject,
    })
    if (!resolved.ok) return resolved
    const actor = {
      userId: resolved.actorUserId,
      actorKind: 'app',
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
          : `Could not anchor the document change (${String(reason ?? 'unknown')}).`,
      )
    }
    const operationId = `appDoc:${args.packageRoot}:${args.op}:${args.clientMutationId}`
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
          : `Could not apply the document mutation (${String(reason ?? 'unknown')}).`,
      )
    }
    return {
      ok: true,
      operation: resolved.operation,
      path: resolved.path,
      operationId,
    }
  },
})

async function collectionSourceAtoms(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
  appRead: string[],
  sources: string[],
) {
  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(SOURCE_SCAN_CAP + 1)
  if (atoms.length > SOURCE_SCAN_CAP) {
    return collectionActionError(
      'collection-scan-truncated',
      'This collection has too many source files to scan safely.',
    )
  }
  const visible = []
  for (const atom of atoms) {
    if (!sources.some((source) => globMatchesPath(source, atom.path))) continue
    if (!appScopeAllowsPath(appRead, atom.path)) continue
    if (!(await canReadAtom(ctx, atom._id, viewerSubject))) continue
    visible.push(atom)
  }
  return { ok: true as const, atoms: visible.sort((a, b) => a.path.localeCompare(b.path)) }
}

function collectionConfigForPlan(config: {
  format: 'markdown-table' | 'markdown-cards' | 'csv' | 'jsonl' | 'yaml' | 'sqlite'
  key?: string
  table?: string
}) {
  return { format: config.format, key: config.key, table: config.table }
}

export const _resolveCollectionMutationForRun = internalQuery({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    op: v.union(v.literal('insert'), v.literal('update'), v.literal('upsert'), v.literal('delete')),
    id: v.optional(v.string()),
    record: v.optional(v.record(v.string(), v.any())),
    patch: v.optional(v.record(v.string(), v.any())),
    activeWorkspaceId: v.optional(v.string()),
    subject: v.string(),
    expectedSourceRevision: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      packageRoot,
      collection,
      op,
      id,
      record,
      patch,
      activeWorkspaceId,
      subject,
      expectedSourceRevision,
    },
  ): Promise<ResolvedCollectionMutation | AppActionError> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const app = await resolveAppDescriptor(ctx, workspaceId, subject, packageRoot)
    if (isAppDescriptorError(app)) return actionError(app.code, app.message)
    if (!app) return actionError('app-not-found', 'App not found.')
    if (!app.configStatus.ok) {
      return collectionActionError('app-not-found', 'The app manifest is invalid.')
    }
    const config = app.collections[collection]
    if (!config) {
      return collectionActionError('collection-not-found', 'Collection not found.')
    }
    if (config.format === 'sqlite') {
      return collectionActionError('unsupported-format', 'SQLite collections are handled by database APIs.')
    }
    const sourcesResult = await collectionSourceAtoms(
      ctx,
      workspaceId,
      subject,
      app.read,
      config.source,
    )
    if (!sourcesResult.ok) return sourcesResult
    const sources = sourcesResult.atoms
    if (sources.length === 0) {
      return collectionActionError('not-found', 'No writable collection source was found.')
    }

    const adapterConfig = collectionConfigForPlan(config)
    let source = sources[0]!
    if (op === 'update' || op === 'delete' || op === 'upsert') {
      if (!id) return collectionActionError('invalid-input', 'Collection mutation requires an id.')
      const matching = sources.find((candidate) => {
        const row = getCollectionRow(adapterConfig, [{ path: candidate.path, body: candidate.body ?? '' }], id)
        return row.ok && row.row !== null
      })
      if (matching) source = matching
      else if (op !== 'upsert') {
        return collectionActionError('collection-row-not-found', `Collection row "${id}" was not found.`)
      }
    }

    if (expectedSourceRevision !== undefined && expectedSourceRevision !== String(source.updatedAt)) {
      return collectionActionError(
        'source-version-conflict',
        'This source changed since the app loaded it.',
      )
    }

    const authorized = await authorizeCollectionWrite(ctx, {
      activeWorkspaceId,
      packageRoot,
      collection,
      targetPath: source.path,
    })
    if (!authorized.ok) return authorized

    if (op === 'insert') {
      if (!record) return collectionActionError('invalid-input', 'Collection insert requires a record.')
      const listed = listCollectionRows(
        adapterConfig,
        sources.map((atom) => ({ path: atom.path, body: atom.body ?? '' })),
      )
      if (!listed.ok) return mapCollectionAdapterError(listed)
      const key = config.key ?? 'ID'
      const recordId = String(record[key] ?? record.id ?? '').trim()
      if (recordId && listed.rows.some((row) => row.id === recordId)) {
        return collectionActionError('collection-duplicate-id', `Duplicate collection row id "${recordId}".`)
      }
    }

    const plan = planCollectionMutation(
      adapterConfig,
      { path: source.path, body: source.body ?? '' },
      op === 'insert'
        ? { op, record: record ?? {} }
        : op === 'update'
          ? { op, id: id ?? '', patch: patch ?? {} }
          : op === 'delete'
            ? { op, id: id ?? '' }
            : { op, id: id ?? '', record: record ?? {} },
    )
    if (!plan.ok) return mapCollectionAdapterError(plan)
    if (plan.expectedText === undefined || plan.replacement === undefined) {
      return collectionActionError('semantic-apply-failed', 'Collection adapter did not produce a semantic replacement.')
    }

    return {
      ok: true,
      operation: `collection.${op}` as `collection.${CollectionMutationOp}`,
      collection,
      path: source.path,
      workspaceId,
      atomId: source._id,
      expectedText: plan.expectedText,
      replacement: plan.replacement,
      actorUserId: subject,
      ...(id === undefined ? {} : { targetId: id }),
      sourceRevision: String(source.updatedAt),
    }
  },
})

export const _recordCollectionMutationProvenance = internalMutation({
  args: {
    workspaceId: v.string(),
    actorUserId: v.string(),
    packageRoot: v.string(),
    operation: v.string(),
    targetPath: v.string(),
    targetId: v.optional(v.string()),
    sourceRevision: v.optional(v.string()),
    clientMutationId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('appProvenance', {
      ...args,
      createdAt: Date.now(),
    })
    return { ok: true as const }
  },
})

export const runCollectionMutation = action({
  args: {
    packageRoot: v.string(),
    collection: v.string(),
    op: v.union(v.literal('insert'), v.literal('update'), v.literal('upsert'), v.literal('delete')),
    id: v.optional(v.string()),
    record: v.optional(v.record(v.string(), v.any())),
    patch: v.optional(v.record(v.string(), v.any())),
    clientMutationId: v.string(),
    expectedSourceRevision: v.optional(v.string()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      packageRoot,
      collection,
      op,
      id,
      record,
      patch,
      clientMutationId,
      expectedSourceRevision,
      activeWorkspaceId,
    },
  ): Promise<CollectionMutationResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const workspaceId = await ctx.runQuery(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId,
    })
    const resolved = await ctx.runQuery(internal.appData._resolveCollectionMutationForRun, {
      packageRoot,
      collection,
      op,
      ...(id === undefined ? {} : { id }),
      ...(record === undefined ? {} : { record }),
      ...(patch === undefined ? {} : { patch }),
      ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }),
      activeWorkspaceId: workspaceId,
      subject: identity.subject,
    })
    if (!resolved.ok) return resolved

    const actor = {
      userId: resolved.actorUserId,
      actorKind: 'app',
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
          : `Could not anchor the target row (${String(reason ?? 'unknown')}).`,
      )
    }

    const operationId = `appCollection:${packageRoot}:${collection}:${op}:${clientMutationId}`
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
          : `Could not apply the collection mutation (${String(reason ?? 'unknown')}).`,
      )
    }

    await ctx.runMutation(internal.appData._recordCollectionMutationProvenance, {
      workspaceId: resolved.workspaceId,
      actorUserId: resolved.actorUserId,
      packageRoot,
      operation: resolved.operation,
      targetPath: resolved.path,
      ...(resolved.targetId === undefined ? {} : { targetId: resolved.targetId }),
      sourceRevision: resolved.sourceRevision,
      clientMutationId,
    })

    return {
      ok: true,
      operation: resolved.operation,
      path: resolved.path,
      operationId,
      sourceRevision: resolved.sourceRevision,
    }
  },
})

export const listImports = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

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
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

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
    const resolved = await resolveApp(ctx, activeWorkspaceId, packageRoot)
    if (!resolved.ok) return resolved

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
