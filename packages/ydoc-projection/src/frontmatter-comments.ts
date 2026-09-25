// The text in a Markdown file's frontmatter that no property value shows:
// comments, anchors, aliases, and tags. An agent reading the file receives
// this text, so every view a person uses must show it too.
import {
  EVENT_ALIAS,
  EVENT_MAPPING,
  EVENT_SCALAR,
  EVENT_SEQUENCE,
  load,
  parseEvents,
} from 'js-yaml'

// The opening delimiter line, the YAML lines, and the closing delimiter line.
const FRONTMATTER_RE = /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/
// A line that looks like a property: `?`, or a key then `:`, each followed
// by a space, a tab, or the end of the line.
const PROPERTY_LINE = /^(?:\?|[^ \t#%-].*?:)(?:[ \t]|$)/u
// Characters outside a value that only give YAML its structure.
const STRUCTURE = /[\s:?\-[\]{},"'|>+.0-9]/u

export type FrontmatterLine = {
  /** The line as written, without its line break. */
  text: string
  /** Where on the line each piece of text no property value shows starts and ends. */
  spans: Array<{ start: number; end: number }>
}

export type FrontmatterText = {
  /** The block from its opening delimiter through its closing delimiter line. */
  block: string
  /** Whether the block reads as properties. */
  readable: boolean
  /** Each line between the delimiters. An unreadable block marks no spans, because none of it shows as a value. */
  lines: FrontmatterLine[]
}

/**
 * The document's leading frontmatter block with the text no property value
 * shows. Undefined without a block, or when the block does not read and its
 * first entry does not look like a property: that block is Markdown.
 */
export function frontmatterText(markdown: string): FrontmatterText | undefined {
  const match = FRONTMATTER_RE.exec(markdown)
  if (!match) return undefined
  const yaml = match[1] ?? ''
  const texts = yaml === '' ? [] : yaml.replace(/\r?\n$/u, '').split(/\r?\n/u)
  const hidden = readable(yaml) ? hiddenOffsets(yaml) : undefined
  const entry = texts.find(text => !/^[ \t]*(?:#|$)/u.test(text))
  if (!hidden && (entry === undefined || !PROPERTY_LINE.test(entry))) return undefined
  let offset = 0
  const lines = texts.map((text) => {
    const start = offset
    offset += text.length + (yaml.startsWith('\r\n', start + text.length) ? 2 : 1)
    return { text, spans: hidden ? spansOn(hidden, start, text.length) : [] }
  })
  return { block: match[0], readable: hidden !== undefined, lines }
}

/** Whether the lines between the delimiters hold no properties, or a mapping of them. */
function readable(yaml: string): boolean {
  if (/^(?:[ \t]*(?:#.*)?\r?\n)*$/u.test(yaml)) return true
  try {
    const value = load(yaml)
    if (value === null || value === undefined) return true
    if (typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

/** Each offset in `yaml` whose character no property value shows. */
function hiddenOffsets(yaml: string): boolean[] {
  const inValue = new Array<boolean>(yaml.length).fill(false)
  const hidden = new Array<boolean>(yaml.length).fill(false)
  const mark = (start: number, end: number) => {
    for (let index = Math.max(start, 0); index < end; index += 1) hidden[index] = true
  }
  for (const event of parseEvents(yaml, {})) {
    if (event.type === EVENT_SCALAR) {
      for (let index = event.valueStart; index < event.valueEnd; index += 1) inValue[index] = true
    }
    if (event.type === EVENT_ALIAS) {
      mark(event.anchorStart - 1, event.anchorEnd)
      continue
    }
    if (event.type === EVENT_SCALAR || event.type === EVENT_MAPPING || event.type === EVENT_SEQUENCE) {
      if (event.anchorStart >= 0) mark(event.anchorStart - 1, event.anchorEnd)
      if (event.tagStart >= 0) mark(event.tagStart, event.tagEnd)
    }
  }
  // A comment starts with `#` at the start of a line or after a space or tab,
  // outside every value, and runs to the end of its line.
  for (let index = 0; index < yaml.length; index += 1) {
    if (inValue[index] || hidden[index]) continue
    const character = yaml[index] ?? ''
    if (character === '#' && (index === 0 || /[ \t\r\n]/u.test(yaml[index - 1] ?? ''))) {
      const end = yaml.slice(index).search(/\r?\n/u)
      mark(index, end === -1 ? yaml.length : index + end)
      continue
    }
    // Any other character outside a value that is not structure is text a
    // person could not otherwise see.
    if (!STRUCTURE.test(character)) hidden[index] = true
  }
  return hidden
}

function spansOn(hidden: boolean[], lineStart: number, length: number): FrontmatterLine['spans'] {
  const spans: FrontmatterLine['spans'] = []
  for (let column = 0; column < length; column += 1) {
    if (!hidden[lineStart + column]) continue
    const last = spans.at(-1)
    if (last && last.end === column) last.end = column + 1
    else spans.push({ start: column, end: column + 1 })
  }
  return spans
}
