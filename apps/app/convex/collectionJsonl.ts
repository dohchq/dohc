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

export function listJsonlRows(
  config: CollectionAdapterConfig,
  source: CollectionSource,
): CollectionRowsResult {
  const key = keyForConfig(config)
  const rows = []
  const lines = source.body.split(/\r?\n/).filter((line) => line.trim())
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return collectionError('invalid-jsonl', 'JSONL source contains malformed JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return collectionError('invalid-jsonl', 'JSONL rows must be objects.')
    }
    const row = rowFromFields({ fields: parsed as Record<string, unknown>, key, sourcePath: source.path })
    if (isCollectionError(row)) return row
    rows.push(row)
  }
  return rejectDuplicateRows(rows)
}

export const jsonlAdapter: CollectionAdapter = {
  format: 'jsonl',
  mutable: false,
  list: listJsonlRows,
}
