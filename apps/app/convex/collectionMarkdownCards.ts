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

type Card = {
  id: string
  title: string
  start: number
  end: number
  fields: Record<string, unknown>
  bodyLines: string[]
}

function parseHeading(line: string): { id: string; title: string } | null {
  const match = line.match(/^##\s+([A-Za-z0-9_.-]+)(?:\s+(?:--|—)\s+(.+))?\s*$/)
  if (!match) return null
  return { id: match[1]!, title: (match[2] ?? '').trim() }
}

function parseCards(body: string): Card[] {
  const lines = body.split(/\r?\n/)
  const starts: Array<{ index: number; id: string; title: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index] ?? '')
    if (heading) starts.push({ index, ...heading })
  }
  return starts.map((start, cardIndex) => {
    const end = starts[cardIndex + 1]?.index ?? lines.length
    const fields: Record<string, unknown> = {}
    const bodyLines: string[] = []
    for (const line of lines.slice(start.index + 1, end)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/)
      if (match) fields[match[1]!.trim()] = match[2]!.trim()
      else if (line.trim()) bodyLines.push(line.trim())
    }
    return { ...start, start: start.index, end, fields, bodyLines }
  })
}

export function listMarkdownCardRows(
  config: CollectionAdapterConfig,
  source: CollectionSource,
): CollectionRowsResult {
  const key = keyForConfig(config)
  const rows = []
  for (const card of parseCards(source.body)) {
    const row = rowFromFields({
      fields: {
        [key]: card.id,
        ...(card.title ? { Title: card.title } : {}),
        ...card.fields,
        ...(card.bodyLines.length ? { Body: card.bodyLines.join('\n') } : {}),
      },
      key,
      sourcePath: source.path,
    })
    if (isCollectionError(row)) return row
    rows.push(row)
  }
  return rejectDuplicateRows(rows)
}

export function insertMarkdownCardRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  record: Record<string, unknown>,
): CollectionMutationPlan {
  const key = keyForConfig(config)
  const id = serializeCollectionValue(record[key]).trim()
  if (!id) return collectionError('missing-key-column', `Card is missing key "${key}".`)
  const title = serializeCollectionValue(record.Title || record.title || id)
  const rows = listMarkdownCardRows(config, source)
  if (!rows.ok) return rows
  if (rows.rows.some((row) => row.id === id)) {
    return collectionError('duplicate-id', `Duplicate collection row id "${id}".`, id)
  }
  const fields = Object.entries(record)
    .filter(([field]) => field !== key && field !== 'id' && field !== 'Title' && field !== 'title' && field !== 'Body')
    .map(([field, value]) => `${field}: ${serializeCollectionValue(value)}`)
    .join('\n')
  const expectedText = source.body.trimEnd()
  const insertion = `## ${id} -- ${title}\n\n${fields}\n`
  const body = `${expectedText}\n\n${insertion}`
  return {
    ok: true,
    sourcePath: source.path,
    body,
    expectedText,
    replacement: body,
  }
}

export function updateMarkdownCardRow(
  config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
  patch: Record<string, unknown>,
): CollectionMutationPlan {
  const cards = parseCards(source.body)
  const card = cards.find((candidate) => candidate.id === id)
  if (!card) return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)

  const lines = source.body.split(/\r?\n/)
  const segment = lines.slice(card.start, card.end)
  for (const [field, value] of Object.entries(patch)) {
    if (field === keyForConfig(config) || field === 'id' || field === 'Body') continue
    const fieldIndex = segment.findIndex((line) =>
      new RegExp(`^${field.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}:\\s*`).test(line),
    )
    const line = `${field}: ${serializeCollectionValue(value)}`
    if (fieldIndex >= 0) segment[fieldIndex] = line
    else segment.splice(1, 0, line)
  }
  const expectedText = lines.slice(card.start, card.end).join('\n')
  lines.splice(card.start, card.end - card.start, ...segment)
  return {
    ok: true,
    sourcePath: source.path,
    body: lines.join('\n'),
    expectedText,
    replacement: segment.join('\n'),
  }
}

export function deleteMarkdownCardRow(
  _config: CollectionAdapterConfig,
  source: CollectionSource,
  id: string,
): CollectionMutationPlan {
  const cards = parseCards(source.body)
  const card = cards.find((candidate) => candidate.id === id)
  if (!card) return collectionError('row-not-found', `Collection row "${id}" was not found.`, id)
  const lines = source.body.split(/\r?\n/)
  const expectedText = lines.slice(card.start, card.end).join('\n')
  lines.splice(card.start, card.end - card.start)
  return {
    ok: true,
    sourcePath: source.path,
    body: lines.join('\n'),
    expectedText,
    replacement: '',
  }
}

export const markdownCardsAdapter: CollectionAdapter = {
  format: 'markdown-cards',
  mutable: true,
  list: listMarkdownCardRows,
  insert: insertMarkdownCardRow,
  update: updateMarkdownCardRow,
  delete: deleteMarkdownCardRow,
}
