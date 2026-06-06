import {
  collectionError,
  isCollectionError,
  keyForConfig,
  rejectDuplicateRows,
  rowFromFields,
  type CollectionAdapter,
  type CollectionAdapterConfig,
  type CollectionRowsResult,
  type CollectionSource,
} from './collectionAdapterTypes'

function parseYamlScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed.replace(/^["']|["']$/g, '')
}

export function listYamlRows(
  config: CollectionAdapterConfig,
  source: CollectionSource,
): CollectionRowsResult {
  const key = keyForConfig(config)
  const records: Array<Record<string, unknown>> = []
  let current: Record<string, unknown> | null = null
  for (const line of source.body.split(/\r?\n/)) {
    const item = line.match(/^-\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (item) {
      current = { [item[1]!]: parseYamlScalar(item[2] ?? '') }
      records.push(current)
      continue
    }
    const field = line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (field && current) {
      current[field[1]!] = parseYamlScalar(field[2] ?? '')
      continue
    }
    if (line.trim()) return collectionError('invalid-yaml', 'Only simple YAML list records are supported.')
  }
  const rows = []
  for (const record of records) {
    const row = rowFromFields({ fields: record, key, sourcePath: source.path })
    if (isCollectionError(row)) return row
    rows.push(row)
  }
  return rejectDuplicateRows(rows)
}

export const yamlAdapter: CollectionAdapter = {
  format: 'yaml',
  mutable: false,
  list: listYamlRows,
}
