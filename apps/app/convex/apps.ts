import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import { splitFrontmatter } from './atomId'
import {
  isAppPackageRoot,
  parseAppPath,
  resolveScopeRelativePath,
  titleFromAppName,
} from './appPaths'
import { parseViewPath } from './viewPaths'
import {
  defaultAppManifest,
  parseAppManifest,
  type ResolvedCollectionConfig,
  type ResolvedDatabaseConfig,
} from './appManifest'

const ATOM_SCAN_CAP = 5000
const APP_LIST_CAP = 500
const SOURCE_FILE_CAP = 100
const SOURCE_BYTE_CAP = 512 * 1024
const TEXT_ENCODER = new TextEncoder()

type ConfigStatus =
  | { ok: true }
  | {
      ok: false
      reason: 'invalid-json' | 'invalid-config'
    }

type AppConfig = {
  title: string | null
  entry: string
  read: string[]
  write: string[]
  actions: AppActionConfig[]
  network: boolean
  agent: string[]
  status: ConfigStatus
}

export type AppActionKind = 'field.increment' | 'field.set'

type AppActionConfig = {
  name: string
  kind: AppActionKind
  path: string
  field: string
  by?: number
  valueType?: 'string' | 'number' | 'boolean' | 'date'
}

export type AppActionDescriptor = Omit<AppActionConfig, 'path'> & {
  path: string
}

export type AppDescriptor = {
  packageRoot: string
  scopePath: string
  appName: string
  title: string
  entryPath: string
  entryExists: boolean
  hasConfig: boolean
  configStatus: ConfigStatus
  read: string[]
  write: string[]
  actions: AppActionDescriptor[]
  collections: Record<string, ResolvedCollectionConfig>
  databases: Record<string, ResolvedDatabaseConfig>
  network: boolean
  agent: string[]
  writeTargets: string[]
  trustKey: string | null
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
      code: 'app-not-found' | 'invalid-config' | 'source-too-large' | 'too-many-files' | 'source-scan-truncated'
      message: string
    }

type MigrationTarget =
  | {
      ok: true
      packageRoot: string
      targetPackageRoot: string
      targetPath: string
    }
  | {
      ok: false
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

function migrationTargetForLegacyViewPath(path: string): MigrationTarget {
  const info = parseViewPath(path)
  if (!info) return { ok: false }
  const targetPackageRoot = `${info.scopePath ? `${info.scopePath}/` : ''}.apps/${info.viewName}`
  const targetRelativePath = info.relativePath === 'view.json' ? 'app.json' : info.relativePath
  return {
    ok: true,
    packageRoot: info.packageRoot,
    targetPackageRoot,
    targetPath: `${targetPackageRoot}/${targetRelativePath}`,
  }
}

async function workspaceAtoms(ctx: QueryCtx | MutationCtx, workspaceId: string) {
  return await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(ATOM_SCAN_CAP + 1)
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

const ACTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function optionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseActions(value: unknown): AppActionConfig[] | null {
  if (value === undefined) return []
  const actionsObject = manifestObject(value)
  if (!actionsObject) return null

  const out: AppActionConfig[] = []
  for (const [name, raw] of Object.entries(actionsObject)) {
    if (!ACTION_NAME_RE.test(name)) return null
    const action = manifestObject(raw)
    if (!action) return null
    const kind = action.kind
    const path = typeof action.path === 'string' ? action.path.trim() : ''
    const field = typeof action.field === 'string' ? action.field.trim() : ''
    if (kind !== 'field.increment' && kind !== 'field.set') return null
    if (!path || !FIELD_NAME_RE.test(field)) return null

    const by = optionalNumber(action.by)
    if (by === null) return null
    const valueType =
      action.valueType === undefined ||
      action.valueType === 'string' ||
      action.valueType === 'number' ||
      action.valueType === 'boolean' ||
      action.valueType === 'date'
        ? action.valueType
        : null
    if (valueType === null) return null
    if (kind === 'field.increment' && valueType !== undefined) return null

    out.push({
      name,
      kind,
      path,
      field,
      ...(by === undefined ? {} : { by }),
      ...(valueType === undefined ? {} : { valueType }),
    })
  }
  return out
}

function stripDohcFrontmatter(body: string): string {
  return splitFrontmatter(body).rest
}

function defaultConfig(appName: string): AppConfig {
  return {
    title: titleFromAppName(appName),
    entry: 'src/App.tsx',
    read: ['.'],
    write: [],
    actions: [],
    network: false,
    agent: [],
    status: { ok: true },
  }
}

function parseConfig(body: string, appName: string): AppConfig {
  const fallback = defaultConfig(appName)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripDohcFrontmatter(body))
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
  const actions = parseActions(object.actions)
  const agent = object.agent === undefined ? fallback.agent : stringArray(object.agent)
  const network =
    object.network === undefined
      ? fallback.network
      : typeof object.network === 'boolean'
        ? object.network
        : null

  if (!read || !write || !actions || !agent || network === null) {
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
    actions,
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

function resolveActionList(
  scopePath: string,
  actions: AppActionConfig[],
): AppActionDescriptor[] | null {
  const out: AppActionDescriptor[] = []
  for (const action of actions) {
    const path = resolveScopeRelativePath(scopePath, action.path)
    if (path === null) return null
    out.push({ ...action, path })
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
    console.warn('[apps.visibleAtomsForPackage] workspace atom scan truncated', {
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
): AppDescriptor | null {
  const rootInfo = parseAppPath(`${packageRoot}/__probe__.tsx`)
  if (!rootInfo) return null

  const configPath = `${packageRoot}/app.json`
  const configAtom = atomsByPath.get(configPath)
  const manifest = configAtom
    ? parseAppManifest({
        appName: rootInfo.appName,
        scopePath: rootInfo.scopePath,
        packageRoot,
        body: configAtom.body,
      })
    : defaultAppManifest(rootInfo.appName, rootInfo.scopePath)
  const entryPath = packageRelativePath(packageRoot, manifest.entry)

  if (!entryPath) {
    const fallback = defaultAppManifest(rootInfo.appName, rootInfo.scopePath)
    const fallbackEntryPath = `${packageRoot}/${fallback.entry}`
    return {
      packageRoot,
      scopePath: rootInfo.scopePath,
      appName: rootInfo.appName,
      title: fallback.title,
      entryPath: fallbackEntryPath,
      entryExists: atomsByPath.has(fallbackEntryPath),
      hasConfig: Boolean(configAtom),
      configStatus: { ok: false, reason: 'invalid-config' },
      read: [],
      write: [],
      actions: [],
      collections: {},
      databases: {},
      network: false,
      agent: [],
      writeTargets: [],
      trustKey: null,
    }
  }

  return {
    packageRoot,
    scopePath: rootInfo.scopePath,
    appName: rootInfo.appName,
    title: manifest.title,
    entryPath,
    entryExists: atomsByPath.has(entryPath),
    hasConfig: Boolean(configAtom),
    configStatus: manifest.status,
    read: manifest.read,
    write: manifest.write,
    actions: manifest.actions,
    collections: manifest.collections,
    databases: manifest.databases,
    network: manifest.network,
    agent: manifest.agent,
    writeTargets: manifest.writeTargets,
    trustKey: manifest.trustKey,
  }
}

export async function discoverApps(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
): Promise<{ apps: AppDescriptor[]; truncated: boolean }> {
  const { atoms, truncated } = await visibleAtoms(ctx, workspaceId, viewerSubject)
  const atomsByPath = new Map(atoms.map((atom) => [atom.path, atom]))
  const packageRoots = new Set<string>()

  for (const atom of atoms) {
    const info = parseAppPath(atom.path)
    if (info) packageRoots.add(info.packageRoot)
  }

  const apps: AppDescriptor[] = []
  for (const packageRoot of [...packageRoots].sort((a, b) => a.localeCompare(b))) {
    const descriptor = descriptorForRoot(packageRoot, atomsByPath)
    if (descriptor) apps.push(descriptor)
  }

  const appTruncated = apps.length > APP_LIST_CAP
  return {
    apps: appTruncated ? apps.slice(0, APP_LIST_CAP) : apps,
    truncated: truncated || appTruncated,
  }
}

export async function resolveAppDescriptor(
  ctx: QueryCtx,
  workspaceId: string,
  viewerSubject: string,
  packageRoot: string,
): Promise<AppDescriptor | null> {
  if (!isAppPackageRoot(packageRoot)) return null
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
    return await discoverApps(ctx, workspaceId, viewerSubject)
  },
})

export const get = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }) => {
    if (!isAppPackageRoot(packageRoot)) return null

    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    return await resolveAppDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
  },
})

export const getSourceFiles = query({
  args: {
    packageRoot: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { packageRoot, activeWorkspaceId }): Promise<SourceFileResult> => {
    if (!isAppPackageRoot(packageRoot)) {
      return {
        ok: false,
        code: 'app-not-found',
        message: 'App not found.',
      }
    }

    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const raw = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .take(ATOM_SCAN_CAP + 1)
    if (raw.length > ATOM_SCAN_CAP) {
      return {
        ok: false,
        code: 'source-scan-truncated',
        message: 'This workspace has too many files to load app source safely.',
      }
    }
    const app = await resolveAppDescriptor(ctx, workspaceId, viewerSubject, packageRoot)
    if (!app) {
      return {
        ok: false,
        code: 'app-not-found',
        message: 'App not found.',
      }
    }
    if (!app.configStatus.ok) {
      return {
        ok: false,
        code: 'invalid-config',
        message: 'This app manifest is invalid.',
      }
    }

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
          message: 'This app has too many source files to render safely.',
        }
      }
      if (totalBytes > SOURCE_BYTE_CAP) {
        return {
          ok: false,
          code: 'source-too-large',
          message: 'This app source is too large to render safely.',
        }
      }
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    const entry = packageRelativeFromFullPath(packageRoot, app.entryPath) ?? 'src/App.tsx'
    return { ok: true, entry, files, truncated }
  },
})

export const migrateLegacyViewsToApps = mutation({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const raw = await workspaceAtoms(ctx, workspaceId)
    if (raw.length > ATOM_SCAN_CAP) {
      return {
        ok: false as const,
        code: 'too-many-atoms' as const,
        message: 'Cannot migrate legacy view packages because the workspace is too large for this helper.',
      }
    }

    const existingPaths = new Set(raw.map((atom) => atom.path))
    const plans: Array<{
      atom: Doc<'atoms'>
      packageRoot: string
      targetPackageRoot: string
      targetPath: string
    }> = []

    for (const atom of raw) {
      const target = migrationTargetForLegacyViewPath(atom.path)
      if (!target.ok) continue
      if (existingPaths.has(target.targetPath)) {
        return {
          ok: false as const,
          code: 'target-exists' as const,
          message: 'Cannot migrate legacy view package because the target app path already exists.',
          packageRoot: target.packageRoot,
          targetPackageRoot: target.targetPackageRoot,
          targetPath: target.targetPath,
        }
      }
      plans.push({ atom, ...target })
    }

    const now = Date.now()
    for (const plan of plans) {
      await ctx.db.patch(plan.atom._id, {
        path: plan.targetPath,
        updatedAt: now,
      })
    }

    return {
      ok: true as const,
      migratedPackages: new Set(plans.map((plan) => plan.packageRoot)).size,
      migratedAtoms: plans.length,
    }
  },
})
