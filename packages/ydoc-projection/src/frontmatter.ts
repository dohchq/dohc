// Markdown frontmatter: how a document's YAML block reads as values, how
// values write back as YAML, and how a settle keeps the text a person wrote.
// The engine applies the same rules (crates/dohc-engine-domain/src/collections.rs
// and crates/dohc-engine-collab/src/ydoc/frontmatter_yaml.rs); the shared
// fixtures in crates/dohc-engine-domain/tests/fixtures/collection-frontmatter.json
// and crates/dohc-engine-collab/tests/live-bootstrap-fixtures pin both sides.
// This module imports only js-yaml, so the desktop can read frontmatter
// without loading the editor.
import { exceedsLiveMarkdownLimit } from '@dohc/live-session-contract/limits'
import * as yaml from 'js-yaml'
import {
  boolCoreTag,
  COLLECTION_STYLE_BLOCK,
  CORE_SCHEMA,
  defineMappingTag,
  defineScalarTag,
  defineSequenceTag,
  EVENT_ALIAS,
  EVENT_DOCUMENT,
  EVENT_MAPPING,
  EVENT_POP,
  EVENT_SCALAR,
  EVENT_SEQUENCE,
  floatCoreTag,
  intCoreTag,
  NOT_RESOLVED,
  nullCoreTag,
  type ScalarTagDefinition,
} from 'js-yaml'

const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const
// The opening delimiter line, the YAML lines, the closing delimiter line, and
// the rest of the document. A delimiter is `---` then only spaces or tabs.
const FRONTMATTER_RE = /^(---[ \t]*\r?\n)((?:[\s\S]*?\r?\n)?)(---[ \t]*(?:\r?\n|$))([\s\S]*)$/
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_YDOC_INTEGER = -(1n << 63n)
const MAX_YDOC_INTEGER = (1n << 63n) - 1n
// Collection nesting a frontmatter block may reach, the root mapping included:
// the root and the 129 levels (0 to 128) a public value may hold.
const MAX_FRONTMATTER_DEPTH = 130
// Value nodes a frontmatter block may hold once aliases are expanded.
const MAX_FRONTMATTER_NODES = 262_144
const MAX_FRONTMATTER_ALIASES = 256
// js-yaml counts nesting differently for block and flow collections, so its
// own limit sits above MAX_FRONTMATTER_DEPTH for every form and the walk
// below applies the shared limit.
const PARSER_MAX_DEPTH = 140

function hasValidIntegerSeparators(source: string): boolean {
  for (
    let index = source.indexOf('_');
    index !== -1;
    index = source.indexOf('_', index + 1)
  ) {
    const previous = source[index - 1]
    const next = source[index + 1]
    if (
      previous === undefined
      || next === undefined
      || !/[\dA-Fa-f]/u.test(previous)
      || !/[\dA-Fa-f]/u.test(next)
    ) {
      return false
    }
  }
  return true
}

// A scalar the frontmatter value model cannot hold keeps its text: a
// non-finite float, an integer outside int64, or a value its explicit tag
// cannot resolve.
const losslessIntegerTag = defineScalarTag('tag:yaml.org,2002:int', {
  implicit: true,
  implicitFirstChars: ['-', '+', ...'0123456789'],
  resolve: (source, isExplicit, tagName) => {
    if (!hasValidIntegerSeparators(source)) return NOT_RESOLVED
    const normalizedSource = source.replaceAll('_', '')
    if (
      intCoreTag.resolve(normalizedSource, isExplicit, tagName) === NOT_RESOLVED
    ) {
      return NOT_RESOLVED
    }
    let magnitude = normalizedSource
    let sign = 1n
    if (magnitude[0] === '-' || magnitude[0] === '+') {
      if (magnitude[0] === '-') sign = -1n
      magnitude = magnitude.slice(1)
    }
    const integer = sign * BigInt(magnitude)
    if (integer < MIN_YDOC_INTEGER || integer > MAX_YDOC_INTEGER) return source
    if (integer >= -MAX_SAFE_INTEGER && integer <= MAX_SAFE_INTEGER) {
      return Number(integer)
    }
    return integer
  },
  identify: value =>
    typeof value === 'bigint'
    || (typeof value === 'number'
      && Number.isSafeInteger(value)
      && !Object.is(value, -0)),
  represent: value => value.toString(),
})
const losslessFloatTag = defineScalarTag('tag:yaml.org,2002:float', {
  implicit: true,
  implicitFirstChars: floatCoreTag.implicitFirstChars,
  resolve: (source, isExplicit, tagName) => {
    const value = floatCoreTag.resolve(source, isExplicit, tagName)
    return value === NOT_RESOLVED || Number.isFinite(value) ? value : source
  },
  identify: value =>
    typeof value === 'number'
    && (!Number.isSafeInteger(value) || Object.is(value, -0)),
  represent: value => {
    const represented = floatCoreTag.represent(value)
    return Number.isInteger(value) && !represented.includes('.')
      ? `${represented}.0`
      : represented
  },
})
// An explicit core tag its value does not satisfy, such as `!!bool yes`,
// keeps the text instead of failing the whole frontmatter.
function keepingTextWhenExplicit(
  tag: ScalarTagDefinition,
): ScalarTagDefinition {
  return {
    ...tag,
    resolve: (source, isExplicit, tagName) => {
      const value = tag.resolve(source, isExplicit, tagName)
      return value === NOT_RESOLVED && isExplicit ? source : value
    },
  }
}
const losslessFrontmatterSchema = CORE_SCHEMA.withTags(
  keepingTextWhenExplicit(nullCoreTag),
  keepingTextWhenExplicit(boolCoreTag),
  keepingTextWhenExplicit(losslessIntegerTag),
  keepingTextWhenExplicit(losslessFloatTag),
)

// The root mapping of the load in progress, with its keys in document order.
let loadingRoot: { mapping?: Record<string, unknown>; keys: string[] } | undefined

// A mapping with a key that is a collection does not read; any other key is
// its text. The core map and every other mapping tag behave the same way.
function frontmatterMappingTag(tagName: string, matchByTagPrefix: boolean) {
  return defineMappingTag(tagName, {
    matchByTagPrefix,
    create: () => {
      const mapping = nullPrototypeRecord()
      if (loadingRoot && loadingRoot.mapping === undefined) loadingRoot.mapping = mapping
      return mapping
    },
    addPair: (mapping, key, value) => {
      if (key !== null && typeof key === 'object') {
        return 'object-based map does not support complex keys'
      }
      const text = String(key)
      mapping[text] = value
      if (loadingRoot?.mapping === mapping) loadingRoot.keys.push(text)
      return ''
    },
    has: (mapping, key) => Object.hasOwn(mapping, String(key)),
    keys: mapping => Object.keys(mapping),
    get: (mapping, key) => mapping[String(key)],
  })
}

// Any other tag keeps its node: a scalar its text, a collection its items.
const frontmatterLoadSchema = losslessFrontmatterSchema.withTags(
  frontmatterMappingTag('tag:yaml.org,2002:map', false),
  defineScalarTag('', {
    matchByTagPrefix: true,
    resolve: source => source,
  }),
  defineSequenceTag('', {
    matchByTagPrefix: true,
    create: () => [] as unknown[],
    addItem: (values, value) => {
      values.push(value)
    },
  }),
  frontmatterMappingTag('', true),
)

type LoadedFrontmatter = { value: unknown; keys: string[] }

/** Load frontmatter YAML within the depth, node, and alias budgets. Throws when it does not read. */
function loadFrontmatterYaml(text: string): LoadedFrontmatter {
  const root: NonNullable<typeof loadingRoot> = { keys: [] }
  loadingRoot = root
  let loaded: unknown
  try {
    loaded = yaml.load(text, {
      schema: frontmatterLoadSchema,
      maxDepth: PARSER_MAX_DEPTH,
      maxAliases: MAX_FRONTMATTER_ALIASES,
    })
  } finally {
    loadingRoot = undefined
  }
  return { value: budgetedFrontmatterValue(loaded, 0, { nodes: 0 }), keys: root.keys }
}

// Aliases share one object, so this walk is where an alias ladder would
// multiply; the node budget stops it.
function budgetedFrontmatterValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_FRONTMATTER_NODES) throw new Error('frontmatter holds too many values')
  const collection = Array.isArray(value) || isFrontmatterMap(value)
  if (collection && depth + 1 > MAX_FRONTMATTER_DEPTH) throw new Error('frontmatter nests too deeply')
  if (Array.isArray(value)) {
    return value.map(child => budgetedFrontmatterValue(child, depth + 1, budget))
  }
  if (!isFrontmatterMap(value)) return value
  const normalized = nullPrototypeRecord()
  for (const key of Object.keys(value).sort()) {
    normalized[key] = budgetedFrontmatterValue(value[key], depth + 1, budget)
  }
  return normalized
}

export function nullPrototypeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/** A plain value with its mapping keys sorted, as the Y.Doc projection reads it. */
export function normalizeFrontmatterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFrontmatterValue)
  if (!isFrontmatterMap(value)) return value

  const normalized = nullPrototypeRecord()
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeFrontmatterValue(value[key])
  }
  return normalized
}

export function isFrontmatterMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEmptyFrontmatter(text: string): boolean {
  return text.split(/\r?\n/).every((line) => {
    const trimmed = line.trim()
    return !trimmed || trimmed.startsWith('#')
  })
}

export function orderFrontmatter(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const ordered = nullPrototypeRecord()

  for (const key of FRONTMATTER_PRIORITY_KEYS) {
    if (Object.hasOwn(frontmatter, key)) ordered[key] = frontmatter[key]
  }

  for (const key of Object.keys(frontmatter).sort()) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = frontmatter[key]
  }

  return ordered
}

/** Frontmatter values as canonical YAML, one line break after each entry. */
export function frontmatterYaml(frontmatter: Record<string, unknown>): string {
  return yaml.dump(orderFrontmatter(frontmatter), {
    schema: losslessFrontmatterSchema,
    lineWidth: -1,
    sortKeys: false,
  })
}

type FrontmatterBlock = {
  open: string
  /** The lines between the delimiters, each with its line break. */
  yaml: string
  /** The closing delimiter line and everything after it. */
  closing: string
  /** Everything after the closing delimiter line. */
  rest: string
  value: Record<string, unknown>
  /** The top-level keys in document order. */
  keys: string[]
}

/** The document's frontmatter block: `undefined` when it has none, `null` when it does not read as a mapping. */
function readFrontmatterBlock(markdown: string): FrontmatterBlock | null | undefined {
  const match = FRONTMATTER_RE.exec(markdown)
  if (!match) return undefined
  const [, open = '', text = '', closeLine = '', rest = ''] = match
  const block = { open, yaml: text, closing: `${closeLine}${rest}`, rest }
  if (isEmptyFrontmatter(text)) return { ...block, value: nullPrototypeRecord(), keys: [] }
  try {
    const loaded = loadFrontmatterYaml(text)
    return isFrontmatterMap(loaded.value)
      ? { ...block, value: loaded.value, keys: loaded.keys }
      : null
  } catch {
    return null
  }
}

/**
 * Frontmatter values with top-level keys in document order, and the text after
 * the block. `undefined` when the document has no readable block.
 */
export function loadMarkdownFrontmatter(
  markdown: string,
): { meta: Record<string, unknown>; rest: string } | undefined {
  const block = readFrontmatterBlock(markdown)
  if (!block) return undefined
  const meta = nullPrototypeRecord()
  for (const key of block.keys) meta[key] = block.value[key]
  return { meta, rest: block.rest }
}

/**
 * Split a document into frontmatter values and body. The block and the blank
 * lines after it come back as `frontmatterSource` when canonical frontmatter
 * would be written differently, so a settle can keep them.
 */
export function parseFrontmatter(src: string, usesCrlf: boolean): {
  meta: Record<string, unknown>
  body: string
  frontmatterSource?: string
} {
  const block = readFrontmatterBlock(src)
  if (!block) return { meta: {}, body: src }
  const separator = /^(?:\r?\n)*/u.exec(block.rest)?.[0] ?? ''
  const source = src.slice(0, src.length - block.rest.length + separator.length)
  const canonical = Object.keys(block.value).length === 0
    ? ''
    : `---\n${frontmatterYaml(block.value)}---\n\n`
  return {
    meta: block.value,
    body: block.rest.slice(separator.length),
    ...(source === (usesCrlf ? canonical.replaceAll('\n', '\r\n') : canonical)
      ? {}
      : { frontmatterSource: source }),
  }
}

/**
 * The frontmatter a person wrote, kept through a settle. While it still
 * reads as `current`, the text comes back unchanged. Otherwise a key whose
 * value did not change keeps its lines and the comments above them, a
 * changed key gets its canonical entry in place, a removed key loses its
 * lines, and a new key is added after the others. When one key is removed and
 * one added, the new key takes the removed key's place. Undefined when the source
 * is too large or unreadable, when no key or comment is left, or when the
 * result would not read back as `current`; the caller then writes canonical
 * frontmatter. The engine keeps frontmatter the same way (`kept` in
 * crates/dohc-engine-collab/src/ydoc/frontmatter_yaml.rs).
 */
export function keptFrontmatter(
  source: string,
  current: Record<string, unknown>,
): string | undefined {
  if (exceedsLiveMarkdownLimit(source)) return undefined
  try {
    const block = readFrontmatterBlock(source)
    if (!block || !/^(?:\r?\n)*$/u.test(block.rest)) return undefined
    const expected = frontmatterYaml(current)
    if (frontmatterYaml(block.value) === expected) return source
    const lines = rootKeyLines(block.yaml)
    if (lines === undefined || lines.length !== block.keys.length) return undefined
    const canonical = (values: Record<string, unknown>): string => {
      const text = frontmatterYaml(values)
      return block.open.endsWith('\r\n') ? text.replaceAll('\n', '\r\n') : text
    }
    const added = Object.fromEntries(
      Object.entries(current).filter(([key]) => !Object.hasOwn(block.value, key)),
    )
    const removed = block.keys.filter(key => !Object.hasOwn(current, key))
    // One key removed and one added is a rename: the new key keeps the place.
    const renamed = removed.length === 1 && Object.keys(added).length === 1
      ? { from: removed[0], to: Object.keys(added)[0]! }
      : undefined
    let kept = block.yaml.slice(0, lines[0] ?? block.yaml.length)
    let lead = ''
    block.keys.forEach((key, index) => {
      // Blank lines and column-0 comments at the end of an entry belong to
      // the entry below it.
      const region = block.yaml.slice(lines[index], lines[index + 1] ?? block.yaml.length)
      const split = trailingTriviaStart(region)
      if (key === renamed?.from) {
        kept += `${lead}${canonical({ [renamed.to]: current[renamed.to] })}`
      } else if (Object.hasOwn(current, key)) {
        kept += lead
        kept += frontmatterYaml({ [key]: block.value[key] }) === frontmatterYaml({ [key]: current[key] })
          ? region.slice(0, split)
          : canonical({ [key]: current[key] })
      }
      lead = region.slice(split)
    })
    if (renamed === undefined && Object.keys(added).length > 0) kept += canonical(added)
    kept += lead
    if (kept === '') return undefined
    const candidate = `${block.open}${kept}${block.closing}`
    const reread = readFrontmatterBlock(candidate)
    return reread && /^(?:\r?\n)*$/u.test(reread.rest) && frontmatterYaml(reread.value) === expected
      ? candidate
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The offset of the line each top-level key starts on, in document order.
 * Undefined unless the root is a block mapping with one key per line.
 */
function rootKeyLines(text: string): number[] | undefined {
  const events = yaml.parseEvents(text, { maxDepth: PARSER_MAX_DEPTH })
  const frames: { mapping: boolean; keyNext: boolean }[] = []
  const lines: number[] = []
  for (const event of events) {
    if (event.type === EVENT_POP) {
      frames.pop()
      continue
    }
    if (event.type === EVENT_DOCUMENT) {
      frames.push({ mapping: false, keyNext: false })
      continue
    }
    const parent = frames.at(-1)
    const isRootKey = frames.length === 2 && parent?.mapping === true && parent.keyNext
    if (parent?.mapping) parent.keyNext = !parent.keyNext
    if (event.type === EVENT_MAPPING || event.type === EVENT_SEQUENCE) {
      if (frames.length === 1 && event.style !== COLLECTION_STYLE_BLOCK) return undefined
      frames.push({ mapping: event.type === EVENT_MAPPING, keyNext: true })
    }
    if (!isRootKey) continue
    const position = event.type === EVENT_SCALAR
      ? Math.min(...[event.tagStart, event.anchorStart, event.valueStart].filter(at => at >= 0))
      : event.type === EVENT_ALIAS ? event.anchorStart : -1
    if (!Number.isFinite(position) || position < 0) return undefined
    const line = text.lastIndexOf('\n', position - 1) + 1
    if (line <= (lines.at(-1) ?? -1)) return undefined
    lines.push(line)
  }
  return lines
}

/** Where the trailing blank lines and column-0 comments of an entry start. */
function trailingTriviaStart(region: string): number {
  let start = region.length
  while (start > 0) {
    const lineStart = region.lastIndexOf('\n', start - 2) + 1
    const line = region.slice(lineStart, start).replace(/\r?\n$/u, '')
    if (lineStart === 0 || !(line.trim() === '' || line.startsWith('#'))) break
    start = lineStart
  }
  return start
}

/**
 * The frontmatter block a projection writes before `body`: the kept text of
 * `source` when it still reads as `frontmatter`, canonical YAML otherwise,
 * and nothing when there are no values to write.
 */
export function frontmatterBlockFor(
  frontmatter: Record<string, unknown>,
  source: unknown,
  body: string,
  lineEnding: '\n' | '\r\n',
): string {
  const kept = typeof source === 'string' ? keptFrontmatter(source, frontmatter) : undefined
  if (kept !== undefined) {
    // A closing delimiter at the end of the file needs a line break before
    // the body a person adds under it.
    return body !== '' && !kept.endsWith('\n') ? `${kept}${lineEnding}${lineEnding}` : kept
  }
  if (Object.keys(frontmatter).length === 0) return ''
  const block = `---\n${frontmatterYaml(frontmatter)}---${body.startsWith('\n') ? '\n' : '\n\n'}`
  return lineEnding === '\n' ? block : block.replaceAll('\n', '\r\n')
}

/**
 * Write frontmatter values into a Markdown document, keeping the text of every
 * entry whose value did not change.
 */
export function writeMarkdownFrontmatter(
  markdown: string,
  frontmatter: Record<string, unknown>,
): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n'
  const { body, frontmatterSource } = parseFrontmatter(markdown, lineEnding === '\r\n')
  return `${frontmatterBlockFor(frontmatter, frontmatterSource, body, lineEnding)}${body}`
}
