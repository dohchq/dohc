import type { JsonScalar, JsonValue } from './appSdkTypes'

export type AppRpcOp =
  | 'dohc.collection.list'
  | 'dohc.collection.get'
  | 'dohc.collection.insert'
  | 'dohc.collection.update'
  | 'dohc.collection.upsert'
  | 'dohc.collection.delete'
  | 'dohc.doc.get'
  | 'dohc.doc.set'
  | 'dohc.doc.append'
  | 'dohc.doc.replaceText'
  | 'dohc.doc.section.append'
  | 'dohc.doc.section.replace'
  | 'dohc.database.tables'
  | 'dohc.database.query'
  | 'dohc.database.table.list'
  | 'dohc.database.table.get'
  | 'dohc.database.table.insert'
  | 'dohc.database.table.update'
  | 'dohc.database.table.upsert'
  | 'dohc.database.table.delete'
  | 'dohc.asset.resolve'
  | 'dohc.presence.list'
  | 'dohc.sources.list'
  | 'dohc.atom.get'
  | 'dohc.fields.query'
  | 'dohc.imports.list'
  | 'dohc.exports.list'
  | 'dohc.source.open'
  | 'dohc.agent.run'
  | 'dohc.actions.run'
  | 'dohc.patch.propose'

export type AppRpcRequest =
  | { id: string; op: 'dohc.collection.list'; args: { name: string; query?: Record<string, JsonValue>; database?: string } }
  | { id: string; op: 'dohc.collection.get'; args: { name: string; id: string; database?: string } }
  | { id: string; op: 'dohc.collection.insert'; args: { name: string; record: Record<string, JsonValue>; database?: string; expectedVersion?: number } }
  | { id: string; op: 'dohc.collection.update'; args: { name: string; id: string; patch: Record<string, JsonValue>; database?: string; expectedVersion?: number } }
  | { id: string; op: 'dohc.collection.upsert'; args: { name: string; id: string; record: Record<string, JsonValue>; database?: string; expectedVersion?: number } }
  | { id: string; op: 'dohc.collection.delete'; args: { name: string; id: string; database?: string; expectedVersion?: number } }
  | { id: string; op: 'dohc.doc.get'; args: { path: string } }
  | { id: string; op: 'dohc.doc.set'; args: { path: string; key: string; value: JsonScalar } }
  | { id: string; op: 'dohc.doc.append'; args: { path: string; markdown: string } }
  | { id: string; op: 'dohc.doc.replaceText'; args: { path: string; find: string; with: string; occurrence?: number } }
  | { id: string; op: 'dohc.doc.section.append'; args: { path: string; heading: string; markdown: string } }
  | { id: string; op: 'dohc.doc.section.replace'; args: { path: string; heading: string; markdown: string } }
  | { id: string; op: 'dohc.database.tables'; args: { path: string } }
  | { id: string; op: 'dohc.database.query'; args: { path: string; sql: string; params?: JsonValue[] } }
  | { id: string; op: 'dohc.database.table.list'; args: { path: string; table: string; query?: Record<string, JsonValue> } }
  | { id: string; op: 'dohc.database.table.get'; args: { path: string; table: string; id: string } }
  | { id: string; op: 'dohc.database.table.insert'; args: { path: string; table: string; record: Record<string, JsonValue>; expectedVersion?: number } }
  | { id: string; op: 'dohc.database.table.update'; args: { path: string; table: string; id: string; patch: Record<string, JsonValue>; expectedVersion?: number } }
  | { id: string; op: 'dohc.database.table.upsert'; args: { path: string; table: string; id: string; record: Record<string, JsonValue>; expectedVersion?: number } }
  | { id: string; op: 'dohc.database.table.delete'; args: { path: string; table: string; id: string; expectedVersion?: number } }
  | { id: string; op: 'dohc.asset.resolve'; args: { assetId: string } }
  | { id: string; op: 'dohc.presence.list'; args: Record<string, never> }
  | { id: string; op: 'dohc.sources.list'; args: { source?: string } }
  | { id: string; op: 'dohc.atom.get'; args: { path: string } }
  | { id: string; op: 'dohc.fields.query'; args: { source?: string; keys?: string[] } }
  | { id: string; op: 'dohc.imports.list'; args: Record<string, never> }
  | { id: string; op: 'dohc.exports.list'; args: Record<string, never> }
  | { id: string; op: 'dohc.source.open'; args: { path: string } }
  | { id: string; op: 'dohc.agent.run'; args: { prompt: string; sources?: string[] } }
  | { id: string; op: 'dohc.actions.run'; args: { name: string; input?: Record<string, JsonValue> } }
  | { id: string; op: 'dohc.patch.propose'; args: { path: string; summary: string; patch: Record<string, JsonValue> } }

export type AppRpcResponse =
  | { id: string; ok: true; value: unknown }
  | {
      id: string
      ok: false
      error: { code: string; message: string }
    }

const OPS = new Set<AppRpcOp>([
  'dohc.collection.list',
  'dohc.collection.get',
  'dohc.collection.insert',
  'dohc.collection.update',
  'dohc.collection.upsert',
  'dohc.collection.delete',
  'dohc.doc.get',
  'dohc.doc.set',
  'dohc.doc.append',
  'dohc.doc.replaceText',
  'dohc.doc.section.append',
  'dohc.doc.section.replace',
  'dohc.database.tables',
  'dohc.database.query',
  'dohc.database.table.list',
  'dohc.database.table.get',
  'dohc.database.table.insert',
  'dohc.database.table.update',
  'dohc.database.table.upsert',
  'dohc.database.table.delete',
  'dohc.asset.resolve',
  'dohc.presence.list',
  'dohc.sources.list',
  'dohc.atom.get',
  'dohc.fields.query',
  'dohc.imports.list',
  'dohc.exports.list',
  'dohc.source.open',
  'dohc.agent.run',
  'dohc.actions.run',
  'dohc.patch.propose',
])

const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const MAX_PAYLOAD_BYTES = 64 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function stringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

function hasOnlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(args).every((key) => allowedKeys.has(key))
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const path = value.trim()
  if (!path || path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((part) => part !== '.' && part !== '..')
}

function validCollectionName(value: unknown): value is string {
  return typeof value === 'string' && COLLECTION_NAME_RE.test(value)
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function validId(value: unknown): value is string {
  return validNonEmptyString(value)
}

function validScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  )
}

function validJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) return false
  if (validScalar(value)) return true
  if (Array.isArray(value)) return value.every((item) => validJsonValue(item, depth + 1))
  if (!isPlainObject(value)) return false
  return Object.values(value).every((item) => validJsonValue(item, depth + 1))
}

function validJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!isPlainObject(value)) return false
  if (!Object.values(value).every((item) => validJsonValue(item))) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PAYLOAD_BYTES
  } catch {
    return false
  }
}

function validJsonArray(value: unknown): value is JsonValue[] {
  if (!Array.isArray(value)) return false
  if (!value.every((item) => validJsonValue(item))) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PAYLOAD_BYTES
  } catch {
    return false
  }
}

function validOptionalDatabase(args: Record<string, unknown>): boolean {
  return args.database === undefined || validRelativePath(args.database)
}

function validOptionalExpectedVersion(args: Record<string, unknown>): boolean {
  return (
    args.expectedVersion === undefined ||
    (Number.isInteger(args.expectedVersion) && Number(args.expectedVersion) > 0)
  )
}

function validateCollectionArgs(
  args: Record<string, unknown>,
  kind: 'list' | 'get' | 'insert' | 'update' | 'upsert' | 'delete',
): boolean {
  const allowed = {
    list: ['name', 'query', 'database'],
    get: ['name', 'id', 'database'],
    insert: ['name', 'record', 'database', 'expectedVersion'],
    update: ['name', 'id', 'patch', 'database', 'expectedVersion'],
    upsert: ['name', 'id', 'record', 'database', 'expectedVersion'],
    delete: ['name', 'id', 'database', 'expectedVersion'],
  }[kind]
  if (!hasOnlyKeys(args, allowed) || !validCollectionName(args.name)) return false
  if (!validOptionalDatabase(args)) return false
  if (!validOptionalExpectedVersion(args)) return false
  if ((kind === 'get' || kind === 'update' || kind === 'upsert' || kind === 'delete') && !validId(args.id)) {
    return false
  }
  if (kind === 'list') return args.query === undefined || validJsonObject(args.query)
  if (kind === 'insert' || kind === 'upsert') return validJsonObject(args.record)
  if (kind === 'update') return validJsonObject(args.patch)
  return true
}

function validateDocArgs(
  args: Record<string, unknown>,
  kind: 'get' | 'set' | 'append' | 'replaceText' | 'section.append' | 'section.replace',
): boolean {
  const allowed = {
    get: ['path'],
    set: ['path', 'key', 'value'],
    append: ['path', 'markdown'],
    replaceText: ['path', 'find', 'with', 'occurrence'],
    'section.append': ['path', 'heading', 'markdown'],
    'section.replace': ['path', 'heading', 'markdown'],
  }[kind]
  if (!hasOnlyKeys(args, allowed) || !validRelativePath(args.path)) return false
  if (kind === 'get') return true
  if (kind === 'set') return typeof args.key === 'string' && KEY_RE.test(args.key) && validScalar(args.value)
  if (kind === 'append') return typeof args.markdown === 'string'
  if (kind === 'replaceText') {
    return (
      validNonEmptyString(args.find) &&
      typeof args.with === 'string' &&
      (args.occurrence === undefined ||
        (Number.isInteger(args.occurrence) && Number(args.occurrence) > 0))
    )
  }
  return validNonEmptyString(args.heading) && typeof args.markdown === 'string'
}

function validateDatabaseTableArgs(
  args: Record<string, unknown>,
  kind: 'list' | 'get' | 'insert' | 'update' | 'upsert' | 'delete',
): boolean {
  if (!validRelativePath(args.path)) return false
  const collectionArgs: Record<string, unknown> = {
    ...args,
    name: args.table,
    database: args.path,
  }
  delete collectionArgs.path
  delete collectionArgs.table
  return validateCollectionArgs(collectionArgs, kind)
}

function validateArgs(op: AppRpcOp, args: Record<string, unknown>): boolean {
  switch (op) {
    case 'dohc.collection.list':
      return validateCollectionArgs(args, 'list')
    case 'dohc.collection.get':
      return validateCollectionArgs(args, 'get')
    case 'dohc.collection.insert':
      return validateCollectionArgs(args, 'insert')
    case 'dohc.collection.update':
      return validateCollectionArgs(args, 'update')
    case 'dohc.collection.upsert':
      return validateCollectionArgs(args, 'upsert')
    case 'dohc.collection.delete':
      return validateCollectionArgs(args, 'delete')
    case 'dohc.doc.get':
      return validateDocArgs(args, 'get')
    case 'dohc.doc.set':
      return validateDocArgs(args, 'set')
    case 'dohc.doc.append':
      return validateDocArgs(args, 'append')
    case 'dohc.doc.replaceText':
      return validateDocArgs(args, 'replaceText')
    case 'dohc.doc.section.append':
      return validateDocArgs(args, 'section.append')
    case 'dohc.doc.section.replace':
      return validateDocArgs(args, 'section.replace')
    case 'dohc.database.tables':
      return hasOnlyKeys(args, ['path']) && validRelativePath(args.path)
    case 'dohc.database.query':
      return (
        hasOnlyKeys(args, ['path', 'sql', 'params']) &&
        validRelativePath(args.path) &&
        validNonEmptyString(args.sql) &&
        (args.params === undefined || validJsonArray(args.params))
      )
    case 'dohc.database.table.list':
      return validateDatabaseTableArgs(args, 'list')
    case 'dohc.database.table.get':
      return validateDatabaseTableArgs(args, 'get')
    case 'dohc.database.table.insert':
      return validateDatabaseTableArgs(args, 'insert')
    case 'dohc.database.table.update':
      return validateDatabaseTableArgs(args, 'update')
    case 'dohc.database.table.upsert':
      return validateDatabaseTableArgs(args, 'upsert')
    case 'dohc.database.table.delete':
      return validateDatabaseTableArgs(args, 'delete')
    case 'dohc.asset.resolve':
      return hasOnlyKeys(args, ['assetId']) && validId(args.assetId)
    case 'dohc.presence.list':
      return Object.keys(args).length === 0
    case 'dohc.sources.list':
      return hasOnlyKeys(args, ['source']) && optionalString(args.source)
    case 'dohc.atom.get':
    case 'dohc.source.open':
      return hasOnlyKeys(args, ['path']) && validRelativePath(args.path)
    case 'dohc.fields.query':
      return (
        hasOnlyKeys(args, ['source', 'keys']) &&
        optionalString(args.source) &&
        stringArray(args.keys)
      )
    case 'dohc.imports.list':
    case 'dohc.exports.list':
      return Object.keys(args).length === 0
    case 'dohc.agent.run':
      return (
        hasOnlyKeys(args, ['prompt', 'sources']) &&
        validNonEmptyString(args.prompt) &&
        stringArray(args.sources)
      )
    case 'dohc.actions.run':
      return (
        hasOnlyKeys(args, ['name', 'input']) &&
        validNonEmptyString(args.name) &&
        (args.input === undefined || validJsonObject(args.input))
      )
    case 'dohc.patch.propose':
      return (
        hasOnlyKeys(args, ['path', 'summary', 'patch']) &&
        validRelativePath(args.path) &&
        validNonEmptyString(args.summary) &&
        validJsonObject(args.patch)
      )
  }
}

export function parseAppRpcRequest(value: unknown): AppRpcRequest | null {
  if (!isPlainObject(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.op !== 'string' || !OPS.has(value.op as AppRpcOp)) {
    return null
  }
  if (!isPlainObject(value.args)) return null

  const op = value.op as AppRpcOp
  if (!validateArgs(op, value.args)) return null
  return {
    id: value.id,
    op,
    args: value.args,
  } as AppRpcRequest
}

export function isAppRpcRequest(value: unknown): value is AppRpcRequest {
  return parseAppRpcRequest(value) !== null
}

export function makeAppRpcSuccess(id: string, value: unknown): AppRpcResponse {
  return { id, ok: true, value }
}

export function makeAppRpcError(
  id: string,
  code: string,
  message: string,
): AppRpcResponse {
  return { id, ok: false, error: { code, message } }
}
