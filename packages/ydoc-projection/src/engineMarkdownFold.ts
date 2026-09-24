import * as Y from 'yjs'
import { parseFrontmatterYaml, setDohcYDocFrontmatter, yDocToMarkdown } from './import-export.js'

// A mirror of the engine's rich `rewrite_content_to_markdown`
// (crates/dohc-engine-collab/src/ydoc.rs). The engine settle keeps exact
// Markdown source only when this parser rebuilds it into the canonical
// projection (`Ydoc::preserved_markdown_source`), so a projection that must
// equal the settle decides with the same parser. It reads only the block syntax
// the projector writes; everything else stays paragraph text.

const QUOTE_FOLD_MAX_DEPTH = 120
const TABLE_ROW_HEIGHTS_PREFIX = '<!-- dohc:table row-heights='
const TABLE_ROW_HEIGHTS_SUFFIX = ' -->'
const MAX_I64 = (1n << 63n) - 1n
const MAX_USIZE = (1n << 64n) - 1n
const TAGGED_PREFIX = 'dohcTaggedFrontmatterPrefix'
const TAGGED_BASELINE = 'dohcTaggedFrontmatterBaseline'

type Align = 'left' | 'right' | 'center' | null
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'bulletList'; items: string[] }
  | { kind: 'orderedList'; start: bigint; items: string[] }
  | { kind: 'taskList'; items: [boolean, string][] }
  | { kind: 'codeBlock'; language: string; content: string }
  | { kind: 'rule' }
  | { kind: 'table'; rows: string[][]; alignments: Align[]; rowHeights: Map<number, number> }

function splitInclusive(value: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let end = value.indexOf('\n'); end !== -1; end = value.indexOf('\n', start)) {
    lines.push(value.slice(start, end + 1))
    start = end + 1
  }
  if (start < value.length) lines.push(value.slice(start))
  return lines
}

function isFrontmatterDelimiter(line: string): boolean {
  const content = line.replace(/[\r\n]+$/, '')
  return content.startsWith('---') && /^[ \t]*$/.test(content.slice(3))
}

function stripOneNewline(body: string): string {
  if (body.startsWith('\r\n')) return body.slice(2)
  return body.startsWith('\n') ? body.slice(1) : body
}

// `split_markdown_frontmatter` over `markdown_frontmatter_json_with_body`.
function splitFrontmatter(markdown: string): { values: Record<string, unknown>; body: string } {
  const unsplit = { values: {}, body: markdown }
  const lines = splitInclusive(markdown)
  const first = lines[0]
  if (first === undefined) return unsplit
  if (!first.endsWith('\n') || !isFrontmatterDelimiter(first)) return { values: {}, body: stripOneNewline(markdown) }
  let yamlEnd = first.length
  let bodyStart: number | undefined
  for (const line of lines.slice(1)) {
    if (isFrontmatterDelimiter(line)) {
      bodyStart = yamlEnd + line.length
      break
    }
    yamlEnd += line.length
  }
  if (bodyStart === undefined) return unsplit
  const yaml = markdown.slice(first.length, yamlEnd)
  const body = stripOneNewline(markdown.slice(bodyStart))
  const empty = yaml.split('\n').every(line => {
    const content = line.replace(/^[ \t\r]+/, '')
    return content === '' || content.startsWith('#')
  })
  if (empty) return { values: {}, body }
  const values = parseFrontmatterYaml(yaml)
  return values === undefined ? unsplit : { values, body }
}

function parseHeading(line: string): [number, string] | undefined {
  const hashes = /^#*/.exec(line)![0].length
  if (hashes < 1 || hashes > 6 || line[hashes] !== ' ') return undefined
  const rest = line.slice(hashes + 1)
  return rest === '' ? undefined : [hashes, rest]
}

function parseTaskItem(line: string | undefined): [boolean, string] | undefined {
  if (line?.startsWith('- [x] ')) return [true, line.slice(6)]
  if (line?.startsWith('- [ ] ')) return [false, line.slice(6)]
  return undefined
}

// Rust's `str::parse::<i64>`: an optional sign, then ASCII digits.
function parseI64(value: string): bigint | undefined {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed > MAX_I64 || parsed < -MAX_I64 - 1n ? undefined : parsed
}

function parseOrderedItem(line: string | undefined): [bigint, string] | undefined {
  const split = line?.indexOf('. ') ?? -1
  if (line === undefined || split === -1) return undefined
  const ordinal = parseI64(line.slice(0, split))
  const rest = line.slice(split + 2)
  return ordinal === undefined || ordinal < 0n || rest === '' ? undefined : [ordinal, rest]
}

function parseTableRowHeights(line: string | undefined): [bigint, number][] | undefined {
  if (!line?.startsWith(TABLE_ROW_HEIGHTS_PREFIX) || !line.endsWith(TABLE_ROW_HEIGHTS_SUFFIX)) return undefined
  const heights: [bigint, number][] = []
  for (const pair of line.slice(TABLE_ROW_HEIGHTS_PREFIX.length, -TABLE_ROW_HEIGHTS_SUFFIX.length).split(',')) {
    const colon = pair.indexOf(':')
    const row = pair.slice(0, colon), height = pair.slice(colon + 1)
    if (colon === -1 || !/^[0-9]+$/.test(row) || !/^[0-9]+$/.test(height)) return undefined
    // A usize or i64 overflow refuses the whole annotation.
    if (BigInt(row) > MAX_USIZE || BigInt(height) > MAX_I64) return undefined
    if (BigInt(height) >= 1n && BigInt(height) <= BigInt(Number.MAX_SAFE_INTEGER)) heights.push([BigInt(row), Number(height)])
  }
  return heights
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(/&(amp;|lt;|gt;)?/g, (_match, entity: string | undefined) =>
    entity === 'lt;' ? '<' : entity === 'gt;' ? '>' : '&')
}

function parseTableRow(line: string | undefined): string[] | undefined {
  if (line === undefined || line.length < 2 || !line.startsWith('|') || !line.endsWith('|')) return undefined
  const cells: string[] = []
  let cell = '', backslashes = 0
  for (const character of line.slice(1, -1)) {
    if (character === '|' && backslashes % 2 === 0) {
      cells.push(cell)
      cell = ''
    } else cell += character
    backslashes = character === '\\' ? backslashes + 1 : 0
  }
  cells.push(cell)
  return cells.map(value => decodeHtmlEntitiesOnce(value.trim().replaceAll('\\|', '|')))
}

function parseTableDelimiter(line: string | undefined): Align[] | undefined {
  const cells = parseTableRow(line)
  if (cells === undefined) return undefined
  const alignments: Align[] = []
  for (const cell of cells) {
    const dashes = cell.replace(/^:+|:+$/g, '')
    if (!/^-+$/.test(dashes)) return undefined
    const left = cell.startsWith(':'), right = cell.endsWith(':')
    alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null)
  }
  return alignments
}

function parseAnnotatedTable(lines: readonly string[], start: number): [Block, number] | undefined {
  const heights = parseTableRowHeights(lines[start])
  const header = heights && parseTableRow(lines[start + 1])
  const alignments = header && parseTableDelimiter(lines[start + 2])
  if (!heights || !header || !alignments) return undefined
  const rows = [header]
  for (let row = parseTableRow(lines[start + 3]); row !== undefined; row = parseTableRow(lines[start + rows.length + 2])) {
    rows.push(row)
  }
  const rowHeights = new Map<number, number>()
  for (const [row, height] of heights) if (row < BigInt(rows.length)) rowHeights.set(Number(row), height)
  return [{ kind: 'table', rows, alignments, rowHeights }, rows.length + 2]
}

function breaksParagraph(line: string): boolean {
  return line === '' || line === '---' || line.startsWith('```') || line === '>' || line.startsWith('> ')
    || line.startsWith('- ') || parseHeading(line) !== undefined || parseOrderedItem(line) !== undefined
}

function parseBlocks(body: string, depth: number): Block[] {
  const lines = body.split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line === '') { index += 1; continue }
    if (line.startsWith('```')) {
      const close = lines.indexOf('```', index + 1)
      if (close !== -1) {
        blocks.push({ kind: 'codeBlock', language: line.slice(3), content: lines.slice(index + 1, close).join('\n') })
        index = close + 1
        continue
      }
      // An unclosed fence is not a code block.
    }
    if (line === '---') { blocks.push({ kind: 'rule' }); index += 1; continue }
    const heading = parseHeading(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[0], text: heading[1] }); index += 1; continue }
    if (line === '>' || line.startsWith('> ')) {
      const start = index, inner: string[] = []
      for (; index < lines.length; index += 1) {
        const quoted = lines[index]!
        if (quoted === '>') inner.push('')
        else if (quoted.startsWith('> ')) inner.push(quoted.slice(2))
        else break
      }
      blocks.push(depth >= QUOTE_FOLD_MAX_DEPTH
        ? { kind: 'paragraph', text: lines.slice(start, index).join('\n') }
        : { kind: 'quote', children: parseBlocks(inner.join('\n'), depth + 1) })
      continue
    }
    if (parseTaskItem(line)) {
      const items: [boolean, string][] = []
      for (let item = parseTaskItem(line); item; item = parseTaskItem(lines[index])) {
        items.push(item)
        index += 1
      }
      blocks.push({ kind: 'taskList', items })
      continue
    }
    if (line.startsWith('- ')) {
      const items = [line.slice(2)]
      for (index += 1; index < lines.length && !parseTaskItem(lines[index]) && lines[index]!.startsWith('- '); index += 1) {
        items.push(lines[index]!.slice(2))
      }
      blocks.push({ kind: 'bulletList', items })
      continue
    }
    const ordered = parseOrderedItem(line)
    if (ordered) {
      const [start, first] = ordered
      const items = [first]
      index += 1
      for (let expected = start + 1n; expected <= MAX_I64; expected += 1n) {
        const next = parseOrderedItem(lines[index])
        if (!next || next[0] !== expected) break
        items.push(next[1])
        index += 1
      }
      blocks.push({ kind: 'orderedList', start, items })
      continue
    }
    const table = parseAnnotatedTable(lines, index)
    if (table) {
      blocks.push(table[0])
      index += table[1]
      continue
    }
    const paragraph = [line]
    for (index += 1; index < lines.length && !breaksParagraph(lines[index]!); index += 1) paragraph.push(lines[index]!)
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

// Y.XmlElement attributes are typed as strings but hold any JSON value.
function setAttribute(element: Y.XmlElement, name: string, value: string | number | bigint | boolean): void {
  element.setAttribute(name, value as string)
}

// yrs stores an i64 attribute as a number when it is a safe integer.
function integer(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
}

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph')
  if (text !== '') element.insert(0, [new Y.XmlText(text)])
  return element
}

function listItem(name: 'listItem' | 'taskItem', text: string): Y.XmlElement {
  const item = new Y.XmlElement(name)
  item.insert(0, [paragraph(text)])
  return item
}

function element(block: Block): Y.XmlElement {
  switch (block.kind) {
    case 'paragraph': return paragraph(block.text)
    case 'heading': {
      const heading = new Y.XmlElement('heading')
      setAttribute(heading, 'level', block.level)
      heading.insert(0, [new Y.XmlText(block.text)])
      return heading
    }
    case 'quote': {
      const quote = new Y.XmlElement('blockquote')
      quote.insert(0, block.children.map(element))
      return quote
    }
    case 'bulletList': {
      const list = new Y.XmlElement('bulletList')
      list.insert(0, block.items.map(item => listItem('listItem', item)))
      return list
    }
    case 'orderedList': {
      const list = new Y.XmlElement('orderedList')
      if (block.start !== 1n) setAttribute(list, 'start', integer(block.start))
      list.insert(0, block.items.map(item => listItem('listItem', item)))
      return list
    }
    case 'taskList': {
      const list = new Y.XmlElement('taskList')
      list.insert(0, block.items.map(([checked, text]) => {
        const item = listItem('taskItem', text)
        setAttribute(item, 'checked', checked)
        return item
      }))
      return list
    }
    case 'codeBlock': {
      const code = new Y.XmlElement('codeBlock')
      if (block.language !== '') setAttribute(code, 'language', block.language)
      if (block.content !== '') code.insert(0, [new Y.XmlText(block.content)])
      return code
    }
    case 'rule': return new Y.XmlElement('horizontalRule')
    case 'table': {
      const table = new Y.XmlElement('table')
      table.insert(0, block.rows.map((cells, rowIndex) => {
        const row = new Y.XmlElement('tableRow')
        const height = block.rowHeights.get(rowIndex)
        if (height !== undefined) setAttribute(row, 'height', height)
        row.insert(0, cells.map((text, cellIndex) => {
          const cell = new Y.XmlElement(rowIndex === 0 ? 'tableHeader' : 'tableCell')
          const align = block.alignments[cellIndex]
          if (align) setAttribute(cell, 'align', align)
          cell.insert(0, [paragraph(text)])
          return cell
        }))
        return row
      }))
      return table
    }
  }
}

/**
 * Rebuild `source` with the engine's parser, keeping the document's tagged
 * frontmatter prefix as the engine does, and project it. Undefined when the
 * projector refuses the rebuilt document.
 */
export function engineReprojection(source: string, meta: Y.Map<unknown>): string | undefined {
  const staged = new Y.Doc()
  try {
    const { values, body } = splitFrontmatter(source)
    const usesCrlf = source.includes('\r\n')
    const prefix = meta.get(TAGGED_PREFIX), baseline = meta.get(TAGGED_BASELINE)
    staged.transact(() => {
      const stagedMeta = staged.getMap('meta')
      if (typeof prefix === 'string' && source.startsWith(prefix)) {
        stagedMeta.set(TAGGED_PREFIX, prefix)
        if (typeof baseline === 'string') stagedMeta.set(TAGGED_BASELINE, baseline)
      }
      if (usesCrlf) stagedMeta.set('dohcMarkdownCrlf', true)
      setDohcYDocFrontmatter(staged, values)
      staged.getXmlFragment('body').insert(0, parseBlocks(usesCrlf ? body.replaceAll('\r\n', '\n') : body, 0).map(element))
    })
    return yDocToMarkdown(staged)
  } catch {
    return undefined
  } finally {
    staged.destroy()
  }
}
