import { splitFrontmatter } from './atomId'
import { resolveScopeRelativePath, titleFromAppName } from './appPaths'
import { scopeAllowsPath } from './appScopes'
import type { CollectionFormat } from './collectionAdapterTypes'

export type ConfigStatus =
  | { ok: true }
  | { ok: false; reason: 'invalid-json' | 'invalid-config' }

export type ResolvedCollectionConfig = {
  source: string[]
  write: string[]
  format: CollectionFormat
  key?: string
  table?: string
}

export type ResolvedDatabaseConfig = {
  path: string
  write: boolean
}

export type AppAgentCapability = 'run' | 'patch.propose'

export type ResolvedAppManifest = {
  title: string
  entry: string
  read: string[]
  write: string[]
  actions: AppActionConfig[]
  collections: Record<string, ResolvedCollectionConfig>
  databases: Record<string, ResolvedDatabaseConfig>
  network: boolean
  agent: string[]
  tests: unknown[]
  status: ConfigStatus
  writeTargets: string[]
  trustKey: string | null
}

export type AppActionKind = 'field.increment' | 'field.set'

export type AppActionConfig = {
  name: string
  kind: AppActionKind
  path: string
  field: string
  by?: number
  valueType?: 'string' | 'number' | 'boolean' | 'date'
}

const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const ACTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const COLLECTION_KEY_RE = /^[A-Za-z_][A-Za-z0-9_ -]{0,127}$/
const COLLECTION_FORMATS = new Set<CollectionFormat>([
  'markdown-table',
  'markdown-cards',
  'csv',
  'jsonl',
  'yaml',
  'sqlite',
])
const APP_AGENT_CAPABILITIES = new Set<AppAgentCapability>(['run', 'patch.propose'])

function stripDohcFrontmatter(body: string): string {
  return splitFrontmatter(body).rest
}

function manifestObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
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

function stringOrStringArray(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const clean = value.trim()
    return clean ? [clean] : null
  }
  return stringArray(value)
}

function parseAgentCapabilities(value: unknown): AppAgentCapability[] | null {
  const raw = stringArray(value)
  if (!raw) return null
  const out: AppAgentCapability[] = []
  for (const capability of raw) {
    if (!APP_AGENT_CAPABILITIES.has(capability as AppAgentCapability)) return null
    out.push(capability as AppAgentCapability)
  }
  return sortedUnique(out) as AppAgentCapability[]
}

function optionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collectionFormat(value: unknown, source: string[]): CollectionFormat | null {
  if (value !== undefined) {
    return typeof value === 'string' && COLLECTION_FORMATS.has(value as CollectionFormat)
      ? value as CollectionFormat
      : null
  }
  const first = source[0] ?? ''
  if (/\.csv$/i.test(first)) return 'csv'
  if (/\.jsonl$/i.test(first)) return 'jsonl'
  if (/\.ya?ml$/i.test(first)) return 'yaml'
  return 'markdown-table'
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

function resolveScopeList(scopePath: string, entries: string[]): string[] | null {
  const out: string[] = []
  for (const entry of entries) {
    const resolved = resolveScopeRelativePath(scopePath, entry)
    if (resolved === null) return null
    out.push(resolved)
  }
  return out
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function invalidManifest(appName: string, reason: 'invalid-json' | 'invalid-config'): ResolvedAppManifest {
  const fallback = defaultAppManifest(appName, '')
  return {
    ...fallback,
    status: { ok: false, reason },
    read: [],
    write: [],
    actions: [],
    collections: {},
    databases: {},
    agent: [],
    tests: [],
    writeTargets: [],
    trustKey: null,
  }
}

export function defaultAppManifest(appName: string, scopePath: string): ResolvedAppManifest {
  const read = resolveScopeList(scopePath, ['.']) ?? []
  return {
    title: titleFromAppName(appName),
    entry: 'src/App.tsx',
    read,
    write: [],
    actions: [],
    collections: {},
    databases: {},
    network: false,
    agent: [],
    tests: [],
    status: { ok: true },
    writeTargets: [],
    trustKey: null,
  }
}

function trustKeyForApp(
  packageRoot: string,
  write: string[],
  actions: AppActionConfig[],
  collections: Record<string, ResolvedCollectionConfig>,
  databases: Record<string, ResolvedDatabaseConfig>,
  agent: string[],
): string | null {
  const actionEntries = actions
    .map((action) => [
      action.name,
      action.kind,
      action.path,
      action.field,
      action.by ?? null,
      action.valueType ?? null,
    ] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  const collectionEntries = Object.entries(collections)
    .map(([name, config]) => [name, sortedUnique(config.write)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  const databaseEntries = Object.entries(databases)
    .map(([name, config]) => [name, config.write ? [config.path] : []] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  const writeScopes = sortedUnique(write)
  const agentCapabilities = sortedUnique(agent)
  const hasPrivilegedCapabilities =
    writeScopes.length > 0 ||
    actionEntries.length > 0 ||
    collectionEntries.some(([, targets]) => targets.length > 0) ||
    databaseEntries.some(([, targets]) => targets.length > 0) ||
    agentCapabilities.length > 0
  if (!hasPrivilegedCapabilities) return null
  return JSON.stringify({
    packageRoot,
    write: writeScopes,
    actions: actionEntries,
    collections: Object.fromEntries(collectionEntries),
    databases: Object.fromEntries(databaseEntries),
    agent: agentCapabilities,
  })
}

export function parseAppManifest({
  appName,
  scopePath,
  packageRoot,
  body,
}: {
  appName: string
  scopePath: string
  packageRoot: string
  body: string | null
}): ResolvedAppManifest {
  if (body === null) return defaultAppManifest(appName, scopePath)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripDohcFrontmatter(body))
  } catch {
    return invalidManifest(appName, 'invalid-json')
  }

  const object = manifestObject(parsed)
  if (!object) return invalidManifest(appName, 'invalid-config')

  const fallback = defaultAppManifest(appName, scopePath)
  const title =
    typeof object.title === 'string' && object.title.trim()
      ? object.title.trim()
      : fallback.title
  const entry =
    typeof object.entry === 'string' && object.entry.trim()
      ? object.entry.trim()
      : fallback.entry
  const readRaw = object.read === undefined ? ['.'] : stringArray(object.read)
  const writeRaw = object.write === undefined ? [] : stringArray(object.write)
  const actionsRaw = parseActions(object.actions)
  const agent = object.agent === undefined ? [] : parseAgentCapabilities(object.agent)
  const network =
    object.network === undefined
      ? false
      : typeof object.network === 'boolean'
        ? object.network
        : null
  const tests = object.tests === undefined ? [] : Array.isArray(object.tests) ? object.tests : null

  if (!readRaw || !writeRaw || !actionsRaw || !agent || network !== false || !tests) {
    return invalidManifest(appName, 'invalid-config')
  }
  const read = resolveScopeList(scopePath, readRaw)
  const write = resolveScopeList(scopePath, writeRaw)
  if (!read || !write) return invalidManifest(appName, 'invalid-config')

  const actions: AppActionConfig[] = []
  for (const action of actionsRaw) {
    const path = resolveScopeRelativePath(scopePath, action.path)
    if (path === null) return invalidManifest(appName, 'invalid-config')
    actions.push({ ...action, path })
  }

  const collections: Record<string, ResolvedCollectionConfig> = {}
  if (object.collections !== undefined) {
    const rawCollections = manifestObject(object.collections)
    if (!rawCollections) return invalidManifest(appName, 'invalid-config')
    for (const [name, raw] of Object.entries(rawCollections)) {
      if (!COLLECTION_NAME_RE.test(name)) return invalidManifest(appName, 'invalid-config')
      const collection = manifestObject(raw)
      if (!collection) return invalidManifest(appName, 'invalid-config')
      const sourceRaw = stringOrStringArray(collection.source)
      const writeTargetsRaw = collection.write === undefined ? [] : stringOrStringArray(collection.write)
      if (!sourceRaw || !writeTargetsRaw) return invalidManifest(appName, 'invalid-config')
      const source = resolveScopeList(scopePath, sourceRaw)
      const collectionWrite = resolveScopeList(scopePath, writeTargetsRaw)
      if (!source || !collectionWrite) return invalidManifest(appName, 'invalid-config')
      const format = collectionFormat(collection.format, sourceRaw)
      const key =
        collection.key === undefined
          ? undefined
          : typeof collection.key === 'string' && COLLECTION_KEY_RE.test(collection.key.trim())
            ? collection.key.trim()
            : null
      const table =
        collection.table === undefined
          ? undefined
          : typeof collection.table === 'string' && COLLECTION_KEY_RE.test(collection.table.trim())
            ? collection.table.trim()
            : null
      if (!format || key === null || table === null) return invalidManifest(appName, 'invalid-config')
      if (format === 'sqlite' && !table) return invalidManifest(appName, 'invalid-config')
      if (!source.every((path) => scopeAllowsPath(read, path))) {
        return invalidManifest(appName, 'invalid-config')
      }
      if (!collectionWrite.every((path) => scopeAllowsPath(write, path))) {
        return invalidManifest(appName, 'invalid-config')
      }
      collections[name] = {
        source,
        write: collectionWrite,
        format,
        ...(key === undefined ? {} : { key }),
        ...(table === undefined ? {} : { table }),
      }
    }
  }

  const databases: Record<string, ResolvedDatabaseConfig> = {}
  if (object.databases !== undefined) {
    const rawDatabases = manifestObject(object.databases)
    if (!rawDatabases) return invalidManifest(appName, 'invalid-config')
    for (const [name, raw] of Object.entries(rawDatabases)) {
      if (!COLLECTION_NAME_RE.test(name)) return invalidManifest(appName, 'invalid-config')
      const database = manifestObject(raw)
      if (!database) return invalidManifest(appName, 'invalid-config')
      const path = typeof database.path === 'string'
        ? resolveScopeRelativePath(scopePath, database.path)
        : null
      if (!path || !scopeAllowsPath(read, path)) {
        return invalidManifest(appName, 'invalid-config')
      }
      const canWrite = database.write === undefined ? false : database.write === true
      if (database.write !== undefined && database.write !== true && database.write !== false) {
        return invalidManifest(appName, 'invalid-config')
      }
      if (canWrite && !scopeAllowsPath(write, path)) {
        return invalidManifest(appName, 'invalid-config')
      }
      databases[name] = { path, write: canWrite }
    }
  }

  const writeTargets = sortedUnique([
    ...write,
    ...Object.values(collections).flatMap((collection) => collection.write),
    ...Object.values(databases).flatMap((database) => database.write ? [database.path] : []),
  ])
  return {
    title,
    entry,
    read,
    write,
    actions,
    collections,
    databases,
    network,
    agent,
    tests,
    status: { ok: true },
    writeTargets,
    trustKey: trustKeyForApp(packageRoot, write, actions, collections, databases, agent),
  }
}
