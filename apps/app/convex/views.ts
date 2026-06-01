import { v } from 'convex/values'
import { query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import {
  isViewPackageRoot,
  parseViewPath,
  resolveScopeRelativePath,
  titleFromViewName,
} from './viewPaths'

const ATOM_SCAN_CAP = 5000
const VIEW_LIST_CAP = 500
const SOURCE_FILE_CAP = 100
const SOURCE_BYTE_CAP = 512 * 1024
const TEXT_ENCODER = new TextEncoder()

type ConfigStatus =
  | { ok: true }
  | {
      ok: false
      reason: 'invalid-json' | 'invalid-config'
    }

type ViewConfig = {
  title: string | null
  entry: string
  read: string[]
  write: string[]
  network: boolean
  agent: string[]
  status: ConfigStatus
}

export type ViewDescriptor = {
  packageRoot: string
  scopePath: string
  viewName: string
  title: string
  entryPath: string
  entryExists: boolean
  hasConfig: boolean
  configStatus: ConfigStatus
  read: string[]
  write: string[]
  network: boolean
  agent: string[]
}

type SourceFileResult =
  | {
      ok: true
      entry: string
      files: Array<{ relativePath: string; body: string }>
      truncated: boolean
    }
  | {
      ok: false
      code: 'view-not-found' | 'source-too-large' | 'too-many-files'
      message: string
    }

function packageRelativePath(packageRoot: string, relativePath: string): string | null {
  const raw = (relativePath ?? '').trim()
  if (!raw || raw.startsWith('/')) return null
  const segments = raw.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').split('/')
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }
  return `${packageRoot}/${segments.join('/')}`
}

function packageRelativeFromFullPath(packageRoot: string, path: string): string | null {
  if (path === packageRoot) return null
  const prefix = `${packageRoot}/`
  if (!path.startsWith(prefix)) return null
  return path.slice(prefix.length)
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const clean = item.trim()
    if (!clean) return null
    out.push(clean)
  }
  return out
}

function manifestObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function defaultConfig(viewName: string): ViewConfig {
  return {
    title: titleFromViewName(viewName),
    entry: 'src/App.tsx',
    read: ['.'],
    write: [],
    network: false,
    agent: [],
    status: { ok: true },
  }
}

function parseConfig(body: string, viewName: string): ViewConfig {
  const fallback = defaultConfig(viewName)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      ...fallback,
      status: { ok: false, reason: 'invalid-json' },
    }
  }

  const object = manifestObject(parsed)
  if (!object) {
    return {
      ...fallback,
      status: { ok: false, reason: 'invalid-config' },
    }
  }

  const title =
    typeof object.title === 'string' && object.title.trim()
      ? object.title.trim()
      : fallback.title
  const entry =
    typeof object.entry === 'string' && object.entry.trim()
      ? object.entry.trim()
      : fallback.entry
  const read = object.read === undefined ? fallback.read : stringArray(object.read)
  const write = object.write === undefined ? fallback.write : stringArray(object.write)
  const agent = object.agent === undefined ? fallback.agent : stringArray(object.agent)
  const network =
    object.network === undefined
      ? fallback.network
      : typeof object.network === 'boolean'
        ? object.network
        : null

  if (!read || !write || !agent || network === null) {
    return {
      ...fallback,
      status: { ok: false, reason: 'invalid-config' },
    }
  }

  return {
    title,
    entry,
    read,
    write,
    network,
    agent,
    status: { ok: true },
  }
}

function resolveScopeList(scopePath: string, entries: string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const resolved = resolveScopeRelativePath(scopePath, entry)
    if (resolved === null) continue
    out.push(resolved)
  }
  return out
}

async function visibleAtoms(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
): Promise<{ atoms: Doc<'atoms'>[]; truncated: boolean }> {
  const raw = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(ATOM_SCAN_CAP + 1)
  const truncated = raw.length > ATOM_SCAN_CAP
  const bounded = truncated ? raw.slice(0, ATOM_SCAN_CAP) : raw

  const atoms: Doc<'atoms'>[] = []
  for (const atom of bounded) {
    if (await canReadAtom(ctx, atom._id, viewerSubject)) atoms.push(atom)
  }

  return { atoms, truncated }
}

async function visibleAtomsForPackage(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
  packageRoot: string,
): Promise<Doc<'atoms'>[]> {
  const raw = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(ATOM_SCAN_CAP + 1)
  if (raw.length > ATOM_SCAN_CAP) {
    // TODO: replace this bounded workspace scan with a prefix-aware index
    // or paginated scan so resolveViewDescriptor cannot miss late package files.
    console.warn('[views.visibleAtomsForPackage] workspace atom scan truncated', {
      workspaceId,
      packageRoot,
      atomScanCap: ATOM_SCAN_CAP,
    })
  }
  const bounded = raw.length > ATOM_SCAN_CAP ? raw.slice(0, ATOM_SCAN_CAP) : raw
  const prefix = `${packageRoot}/`
  const atoms: Doc<'atoms'>[] = []

  for (const atom of bounded) {
    if (!atom.path.startsWith(prefix)) continue
    if (await canReadAtom(ctx, atom._id, viewerSubject)) atoms.push(atom)
  }

  return atoms
}

function descriptorForRoot(
  packageRoot: string,
  atomsByPath: Map<string, Doc<'atoms'>>,
): ViewDescriptor | null {
  const rootInfo = parseViewPath(`${packageRoot}/__probe__.tsx`)
  if (!rootInfo) return null

  const configPath = `${packageRoot}/view.json`
  const configAtom = atomsByPath.get(configPath)
  const config = configAtom
    ? parseConfig(configAtom.body, rootInfo.viewName)
    : defaultConfig(rootInfo.viewName)
  const entryPath = packageRelativePath(packageRoot, config.entry)

  if (!entryPath) {
    const fallback = defaultConfig(rootInfo.viewName)
    const fallbackEntryPath = `${packageRoot}/${fallback.entry}`
    return {
      packageRoot,
      scopePath: rootInfo.scopePath,
      viewName: rootInfo.viewName,
      title: fallback.title ?? titleFromViewName(rootInfo.viewName),
      entryPath: fallbackEntryPath,
      entryExists: atomsByPath.has(fallbackEntryPath),
      hasConfig: Boolean(configAtom),
      configStatus: { ok: false, reason: 'invalid-config' },
      read: resolveScopeList(rootInfo.scopePath, fallback.read),
      write: [],
      network: false,
      agent: [],
    }
  }

  return {
    packageRoot,
    scopePath: rootInfo.scopePath,
    viewName: rootInfo.viewName,
    title: config.title ?? titleFromViewName(rootInfo.viewName),
    entryPath,
    entryExists: atomsByPath.has(entryPath),
    hasConfig: Boolean(configAtom),
    configStatus: config.status,
    read: resolveScopeList(rootInfo.scopePath, config.read),
    write: resolveScopeList(rootInfo.scopePath, config.write),
    network: config.network,
    agent: config.agent,
  }
}

export async function discoverViews(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
): Promise<{ views: ViewDescriptor[]; truncated: boolean }> {
  const { atoms, truncated } = await visibleAtoms(ctx, workspaceId, viewerSubject)
  const atomsByPath = new Map(atoms.map((atom) => [atom.path, atom]))
  const packageRoots = new Set<string>()

  for (const atom of atoms) {
    const info = parseViewPath(atom.path)
    if (info) packageRoots.add(info.packageRoot)
  }

  const views: ViewDescriptor[] = []
  for (const packageRoot of [...packageRoots].sort((a, b) => a.localeCompare(b))) {
    const descriptor = descriptorForRoot(packageRoot, atomsByPath)
    if (descriptor) views.push(descriptor)
  }

  const viewTruncated = views.length > VIEW_LIST_CAP
  return {
    views: viewTruncated ? views.slice(0, VIEW_LIST_CAP) : views,
    truncated: truncated || viewTruncated,
  }
}

export async function resolveViewDescriptor(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
  packageRoot: string,
): Promise<ViewDescriptor | null> {
  if (!isViewPackageRoot(packageRoot)) return null
  const atoms = await visibleAtomsForPackage(ctx, workspaceId, viewerSubject, packageRoot)
  if (atoms.length === 0) return null
  return descriptorForRoot(
    packageRoot,
    new Map(atoms.map((atom) => [atom.path, atom])),
  )
}

export const list = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    return await discoverViews(ctx, workspaceId, viewerSubject)
  },
})

export const get = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    if (!isViewPackageRoot(packageRoot)) return null

    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    return await resolveViewDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
  },
})

export const getSourceFiles = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }): Promise<SourceFileResult> => {
    if (!isViewPackageRoot(packageRoot)) {
      return {
        ok: false,
        code: 'view-not-found',
        message: 'View not found.',
      }
    }

    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const view = await resolveViewDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
    if (!view) {
      return {
        ok: false,
        code: 'view-not-found',
        message: 'View not found.',
      }
    }

    const raw = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .take(ATOM_SCAN_CAP + 1)
    const bounded = raw.length > ATOM_SCAN_CAP ? raw.slice(0, ATOM_SCAN_CAP) : raw
    const files: Array<{ relativePath: string; body: string }> = []
    let totalBytes = 0
    let truncated = raw.length > ATOM_SCAN_CAP

    for (const atom of bounded) {
      const relativePath = packageRelativeFromFullPath(packageRoot, atom.path)
      if (!relativePath) continue
      if (!(await canReadAtom(ctx, atom._id, viewerSubject))) continue
      files.push({ relativePath, body: atom.body ?? '' })
      totalBytes += TEXT_ENCODER.encode(atom.body ?? '').length
      if (files.length > SOURCE_FILE_CAP) {
        return {
          ok: false,
          code: 'too-many-files',
          message: 'This view has too many source files to render safely.',
        }
      }
      if (totalBytes > SOURCE_BYTE_CAP) {
        return {
          ok: false,
          code: 'source-too-large',
          message: 'This view source is too large to render safely.',
        }
      }
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    const entry = packageRelativeFromFullPath(packageRoot, view.entryPath) ?? 'src/App.tsx'
    return { ok: true, entry, files, truncated }
  },
})
