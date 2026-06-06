import {
  type CollectionAdapter,
  type CollectionAdapterConfig,
  type CollectionFormat,
  type CollectionQuery,
  type CollectionMutationPlan,
  type CollectionRow,
  type CollectionRowResult,
  type CollectionRowsResult,
  type CollectionSource,
  collectionError,
} from './collectionAdapterTypes'
export type { CollectionQuery } from './collectionAdapterTypes'
import { csvAdapter } from './collectionCsv'
import { jsonlAdapter } from './collectionJsonl'
import { markdownCardsAdapter } from './collectionMarkdownCards'
import { markdownTableAdapter } from './collectionMarkdownTable'
import { yamlAdapter } from './collectionYaml'

const ADAPTERS: Record<Exclude<CollectionFormat, 'sqlite'>, CollectionAdapter> = {
  'markdown-table': markdownTableAdapter,
  'markdown-cards': markdownCardsAdapter,
  csv: csvAdapter,
  jsonl: jsonlAdapter,
  yaml: yamlAdapter,
}

export function getCollectionAdapter(format: string | undefined): CollectionAdapter {
  const resolved = (format ?? 'markdown-table') as CollectionFormat
  if (resolved === 'sqlite') {
    throw new Error('Unsupported collection format: sqlite')
  }
  const adapter = ADAPTERS[resolved]
  if (!adapter) throw new Error(`Unsupported collection format: ${String(format)}`)
  return adapter
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''))
}

export function filterCollectionRows(
  rows: CollectionRow[],
  query?: CollectionQuery,
): CollectionRow[] {
  let out = rows
  if (query?.where && typeof query.where === 'object') {
    out = out.filter((row) =>
      Object.entries(query.where ?? {}).every(([field, value]) => row[field] === value),
    )
  }
  if (Array.isArray(query?.orderBy)) {
    const order = query.orderBy
    out = [...out].sort((a, b) => {
      for (const item of order) {
        const direction = item.direction === 'desc' ? -1 : 1
        const delta = compareValues(a[item.field], b[item.field])
        if (delta !== 0) return delta * direction
      }
      return 0
    })
  }
  if (Number.isInteger(query?.limit) && Number(query?.limit) >= 0) {
    out = out.slice(0, Number(query?.limit))
  }
  return out
}

export function listCollectionRows(
  config: CollectionAdapterConfig,
  sources: CollectionSource[],
  query?: CollectionQuery,
): CollectionRowsResult {
  let adapter: CollectionAdapter
  try {
    adapter = getCollectionAdapter(config.format)
  } catch {
    return collectionError('unsupported-format', `Unsupported collection format: ${String(config.format)}.`)
  }
  const rows: CollectionRow[] = []
  for (const source of sources) {
    const result = adapter.list(config, source)
    if (!result.ok) return result
    rows.push(...result.rows)
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) {
      return collectionError('duplicate-id', `Duplicate collection row id "${row.id}".`, row.id)
    }
    seen.add(row.id)
  }
  return { ok: true, rows: filterCollectionRows(rows, query) }
}

export function getCollectionRow(
  config: CollectionAdapterConfig,
  sources: CollectionSource[],
  id: string,
): CollectionRowResult {
  const result = listCollectionRows(config, sources)
  if (!result.ok) return result
  return { ok: true, row: result.rows.find((row) => row.id === id) ?? null }
}

export function planCollectionMutation(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  args:
    | { op: 'insert'; record: Record<string, unknown> }
    | { op: 'update'; id: string; patch: Record<string, unknown> }
    | { op: 'upsert'; id: string; record: Record<string, unknown> }
    | { op: 'delete'; id: string },
): CollectionMutationPlan {
  let adapter: CollectionAdapter
  try {
    adapter = getCollectionAdapter(config.format)
  } catch {
    return collectionError('unsupported-format', `Unsupported collection format: ${String(config.format)}.`)
  }
  if (!adapter.mutable) {
    return collectionError('read-only-adapter', `Collection format "${adapter.format}" is read-only.`)
  }
  if (args.op === 'insert') {
    if (!adapter.insert) return collectionError('read-only-adapter', 'Collection insert is not supported.')
    return adapter.insert(config, source, args.record)
  }
  if (args.op === 'update') {
    if (!adapter.update) return collectionError('read-only-adapter', 'Collection update is not supported.')
    return adapter.update(config, source, args.id, args.patch)
  }
  if (args.op === 'delete') {
    if (!adapter.delete) return collectionError('read-only-adapter', 'Collection delete is not supported.')
    return adapter.delete(config, source, args.id)
  }
  const existing = getCollectionRow(config, [source], args.id)
  if (!existing.ok) return existing
  if (existing.row) {
    if (!adapter.update) return collectionError('read-only-adapter', 'Collection update is not supported.')
    return adapter.update(config, source, args.id, args.record)
  }
  if (!adapter.insert) return collectionError('read-only-adapter', 'Collection insert is not supported.')
  return adapter.insert(config, source, { ...args.record, [config.key ?? 'ID']: args.id })
}
