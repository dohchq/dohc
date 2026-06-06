export type CollectionFormat =
  | 'markdown-table'
  | 'markdown-cards'
  | 'csv'
  | 'jsonl'
  | 'yaml'
  | 'sqlite'

export type CollectionScalar = string | number | boolean | null
export type CollectionRow = Record<string, CollectionScalar> & {
  id: string
  sourcePath: string
}

export type CollectionSource = {
  path: string
  body: string
}

export type CollectionAdapterConfig = {
  name?: string
  format?: CollectionFormat
  key?: string
  table?: string
}

export type CollectionQuery = {
  where?: Record<string, unknown>
  orderBy?: Array<{ field: string; direction?: 'asc' | 'desc' }>
  limit?: number
}

export type CollectionRowsResult =
  | { ok: true; rows: CollectionRow[] }
  | CollectionAdapterError

export type CollectionRowResult =
  | { ok: true; row: CollectionRow | null }
  | CollectionAdapterError

export type CollectionMutationPlan =
  | {
      ok: true
      sourcePath: string
      body: string
      expectedText?: string
      replacement?: string
    }
  | CollectionAdapterError

export type CollectionAdapterError = {
  ok: false
  code:
    | 'missing-key-column'
    | 'duplicate-id'
    | 'row-not-found'
    | 'invalid-table'
    | 'invalid-csv'
    | 'invalid-jsonl'
    | 'invalid-yaml'
    | 'invalid-record'
    | 'read-only-adapter'
    | 'unsupported-format'
  message: string
  id?: string
}

export type CollectionAdapter = {
  format: CollectionFormat
  mutable: boolean
  list(config: CollectionAdapterConfig, source: CollectionSource): CollectionRowsResult
  insert?(
    config: CollectionAdapterConfig,
    source: CollectionSource,
    record: Record<string, unknown>,
  ): CollectionMutationPlan
  update?(
    config: CollectionAdapterConfig,
    source: CollectionSource,
    id: string,
    patch: Record<string, unknown>,
  ): CollectionMutationPlan
  delete?(
    config: CollectionAdapterConfig,
    source: CollectionSource,
    id: string,
  ): CollectionMutationPlan
}

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function collectionError(
  code: CollectionAdapterError['code'],
  message: string,
  id?: string,
): CollectionAdapterError {
  return id === undefined ? { ok: false, code, message } : { ok: false, code, message, id }
}

export function isCollectionError(value: unknown): value is CollectionAdapterError {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false)
}

export function keyForConfig(config: CollectionAdapterConfig): string {
  return config.key ?? 'ID'
}

export function coerceCollectionValue(
  value: unknown,
  key?: string,
  column?: string,
): CollectionScalar {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  const text = String(value ?? '').trim()
  if (column && key && column === key) return text
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (DATE_RE.test(text)) return text
  if (NUMBER_RE.test(text)) {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) return numeric
  }
  return text
}

export function serializeCollectionValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : ''
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export function rowFromFields({
  fields,
  key,
  sourcePath,
}: {
  fields: Record<string, unknown>
  key: string
  sourcePath: string
}): CollectionRow | CollectionAdapterError {
  const id = serializeCollectionValue(fields[key]).trim()
  if (!id) {
    return collectionError(
      'missing-key-column',
      `Collection row is missing key column "${key}".`,
    )
  }
  const row: CollectionRow = { id, sourcePath }
  for (const [field, value] of Object.entries(fields)) {
    row[field] = coerceCollectionValue(value, key, field)
  }
  row[key] = id
  return row
}

export function rejectDuplicateRows(rows: CollectionRow[]): CollectionRowsResult {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) {
      return collectionError('duplicate-id', `Duplicate collection row id "${row.id}".`, row.id)
    }
    seen.add(row.id)
  }
  return { ok: true, rows }
}
