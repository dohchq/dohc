import {
  collectionError,
  keyForConfig,
  isCollectionError,
  rejectDuplicateRows,
  rowFromFields,
  serializeCollectionValue,
  type CollectionAdapter,
  type CollectionAdapterConfig,
  type CollectionMutationPlan,
  type CollectionRowsResult,
  type CollectionSource,
} from './collectionAdapterTypes'

type ParsedTable = {
  headers: string[]
  headerLine: number
  dividerLine: number
  rowLines: number[]
  rows: string[][]
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function isDivider(line: string): boolean {
  const parts = cells(line)
  return parts.length > 0 && parts.every((part) => /^:?-{3,}:?$/.test(part))
}

function parseTable(body: string): ParsedTable | null {
  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? ''
    const next = lines[index + 1] ?? ''
    if (!line.trim().startsWith('|') || !isDivider(next)) continue
    const headers = cells(line)
    const rowLines: number[] = []
    const rows: string[][] = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? ''
      if (!rowLine.trim().startsWith('|')) break
      rowLines.push(rowIndex)
      rows.push(cells(rowLine))
    }
    return { headers, headerLine: index, dividerLine: index + 1, rowLines, rows }
  }
  return null
}

function rowFields(headers: string[], values: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (let index = 0; index < headers.length; index += 1) {
    fields[headers[index]!] = values[index] ?? ''
  }
  return fields
}

function formatCell(value: unknown): string {
  return serializeCollectionValue(value).replace(/\|/g, '\\|')
}

function formatRow(headers: string[], fields: Record<string, unknown>): string {
  return `| ${headers.map((header) => formatCell(fields[header])).join(' | ')} |`
}

function tableRows(config: CollectionAdapterConfig, source: CollectionSource) {
  const table = parseTable(source.body)
  if (!table) return collectionError('invalid-table', 'No markdown table found.')
  const key = keyForConfig(config)
  if (!table.headers.includes(key)) {
    return collectionError('missing-key-column', `Markdown table is missing key column "${key}".`)
  }
  const rows = []
  for (const values of table.rows) {
    const row = rowFromFields({
      fields: rowFields(table.headers, values),
      key,
      sourcePath: source.path,
    })
    if (isCollectionError(row)) return row
    rows.push(row)
  }
  const deduped = rejectDuplicateRows(rows)
  if (!deduped.ok) return deduped
  return { ok: true as const, table, rows: deduped.rows }
}

export function listMarkdownTableRows(
  config: CollectionAdapterConfig,
  source: CollectionSource,
): CollectionRowsResult {
  const result = tableRows(config, source)
  if (!result.ok) return result
  return { ok: true, rows: result.rows }
}

export function insertMarkdownTableRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  record: Record<string, unknown>,
): CollectionMutationPlan {
  const result = tableRows(config, source)
  if (!result.ok) return result
  const key = keyForConfig(config)
  const row = rowFromFields({ fields: record, key, sourcePath: source.path })
  if (isCollectionError(row)) return row
  if (result.rows.some((existing) => existing.id === row.id)) {
    return collectionError('duplicate-id', `Duplicate collection row id "${row.id}".`, row.id)
  }
  const lines = source.body.split(/\r?\n/)
  const insertAfter = result.table.rowLines.at(-1) ?? result.table.dividerLine
  const newRow = formatRow(result.table.headers, row)
  const expectedText = lines[insertAfter] ?? ''
  const replacement = `${expectedText}\n${newRow}`
  lines.splice(insertAfter + 1, 0, newRow)
  return { ok: true, sourcePath: source.path, body: lines.join('\n'), expectedText, replacement }
}

export function updateMarkdownTableRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
  patch: Record<string, unknown>,
): CollectionMutationPlan {
  const result = tableRows(config, source)
  if (!result.ok) return result
  const rowIndex = result.rows.findIndex((row) => row.id === id)
  if (rowIndex < 0) {
    return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)
  }
  const next = { ...result.rows[rowIndex], ...patch }
  const lines = source.body.split(/\r?\n/)
  const lineIndex = result.table.rowLines[rowIndex]!
  const expectedText = lines[lineIndex] ?? ''
  const replacement = formatRow(result.table.headers, next)
  lines[lineIndex] = replacement
  return { ok: true, sourcePath: source.path, body: lines.join('\n'), expectedText, replacement }
}

export function deleteMarkdownTableRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
): CollectionMutationPlan {
  const result = tableRows(config, source)
  if (!result.ok) return result
  const rowIndex = result.rows.findIndex((row) => row.id === id)
  if (rowIndex < 0) {
    return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)
  }
  const lines = source.body.split(/\r?\n/)
  const lineIndex = result.table.rowLines[rowIndex]!
  const expectedText = lines[lineIndex] ?? ''
  lines.splice(lineIndex, 1)
  return { ok: true, sourcePath: source.path, body: lines.join('\n'), expectedText, replacement: '' }
}

export const markdownTableAdapter: CollectionAdapter = {
  format: 'markdown-table',
  mutable: true,
  list: listMarkdownTableRows,
  insert: insertMarkdownTableRow,
  update: updateMarkdownTableRow,
  delete: deleteMarkdownTableRow,
}
