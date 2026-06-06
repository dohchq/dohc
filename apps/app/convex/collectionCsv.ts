import {
  collectionError,
  isCollectionError,
  keyForConfig,
  rejectDuplicateRows,
  rowFromFields,
  serializeCollectionValue,
  type CollectionAdapter,
  type CollectionAdapterConfig,
  type CollectionMutationPlan,
  type CollectionRowsResult,
  type CollectionSource,
} from './collectionAdapterTypes'

function parseCsvLine(line: string): string[] | null {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (quoted) return null
  out.push(current)
  return out
}

function parseCsv(body: string) {
  const lines = body.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length === 0) return collectionError('invalid-csv', 'CSV source is empty.')
  const headers = parseCsvLine(lines[0]!)
  if (!headers) return collectionError('invalid-csv', 'CSV header is malformed.')
  const rows: string[][] = []
  for (const line of lines.slice(1)) {
    const parsed = parseCsvLine(line)
    if (!parsed) return collectionError('invalid-csv', 'CSV row is malformed.')
    rows.push(parsed)
  }
  return { ok: true as const, headers, rows }
}

function formatCsvCell(value: unknown): string {
  const text = serializeCollectionValue(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function formatCsvLine(headers: string[], fields: Record<string, unknown>): string {
  return headers.map((header) => formatCsvCell(fields[header])).join(',')
}

function fields(headers: string[], values: string[]): Record<string, unknown> {
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
}

export function listCsvRows(
  config: CollectionAdapterConfig,
  source: CollectionSource,
): CollectionRowsResult {
  const parsed = parseCsv(source.body)
  if (!parsed.ok) return parsed
  const key = keyForConfig(config)
  if (!parsed.headers.includes(key)) {
    return collectionError('missing-key-column', `CSV is missing key column "${key}".`)
  }
  const rows = []
  for (const values of parsed.rows) {
    const row = rowFromFields({ fields: fields(parsed.headers, values), key, sourcePath: source.path })
    if (isCollectionError(row)) return row
    rows.push(row)
  }
  return rejectDuplicateRows(rows)
}

export function insertCsvRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  record: Record<string, unknown>,
): CollectionMutationPlan {
  const parsed = parseCsv(source.body)
  if (!parsed.ok) return parsed
  const rows = listCsvRows(config, source)
  if (!rows.ok) return rows
  const key = keyForConfig(config)
  const row = rowFromFields({ fields: record, key, sourcePath: source.path })
  if (isCollectionError(row)) return row
  if (rows.rows.some((existing) => existing.id === row.id)) {
    return collectionError('duplicate-id', `Duplicate collection row id "${row.id}".`, row.id)
  }
  const newLine = formatCsvLine(parsed.headers, row)
  const expectedText = source.body.trimEnd()
  return {
    ok: true,
    sourcePath: source.path,
    body: `${expectedText}\n${newLine}`,
    expectedText,
    replacement: `${expectedText}\n${newLine}`,
  }
}

export function updateCsvRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
  patch: Record<string, unknown>,
): CollectionMutationPlan {
  const parsed = parseCsv(source.body)
  if (!parsed.ok) return parsed
  const rows = listCsvRows(config, source)
  if (!rows.ok) return rows
  const index = rows.rows.findIndex((row) => row.id === id)
  if (index < 0) return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)
  const nextRows = rows.rows.map((row) => row.id === id ? { ...row, ...patch } : row)
  const originalLine = source.body.split(/\r?\n/).filter((line) => line.length > 0)[index + 1] ?? ''
  const replacement = formatCsvLine(parsed.headers, nextRows[index]!)
  return {
    ok: true,
    sourcePath: source.path,
    body: [
      parsed.headers.join(','),
      ...nextRows.map((row) => formatCsvLine(parsed.headers, row)),
    ].join('\n'),
    expectedText: originalLine,
    replacement,
  }
}

export function deleteCsvRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
): CollectionMutationPlan {
  const parsed = parseCsv(source.body)
  if (!parsed.ok) return parsed
  const rows = listCsvRows(config, source)
  if (!rows.ok) return rows
  const index = rows.rows.findIndex((row) => row.id === id)
  if (index < 0) return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)
  const originalLine = source.body.split(/\r?\n/).filter((line) => line.length > 0)[index + 1] ?? ''
  const nextRows = rows.rows.filter((row) => row.id !== id)
  return {
    ok: true,
    sourcePath: source.path,
    body: [
      parsed.headers.join(','),
      ...nextRows.map((row) => formatCsvLine(parsed.headers, row)),
    ].join('\n'),
    expectedText: originalLine,
    replacement: '',
  }
}

export const csvAdapter: CollectionAdapter = {
  format: 'csv',
  mutable: true,
  list: listCsvRows,
  insert: insertCsvRow,
  update: updateCsvRow,
  delete: deleteCsvRow,
}
