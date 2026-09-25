// Markdown frontmatter: how a document's YAML block reads as values, how
// values write back as YAML, and how a settle keeps the text a person wrote.
// The engine applies the same rules (crates/dohc-engine-domain/src/collections.rs
// and crates/dohc-engine-collab/src/ydoc/frontmatter_yaml.rs); the shared
// fixtures in crates/dohc-engine-domain/tests/fixtures/collection-frontmatter.json
// and crates/dohc-engine-collab/tests/live-bootstrap-fixtures pin both sides.
// At run time this module imports only js-yaml, so the desktop can read
// frontmatter without loading the editor.
import { exceedsLiveMarkdownLimit, utf8ByteLength } from '@dohc/live-session-contract/limits'
import * as yaml from 'js-yaml'
import type * as Y from 'yjs'
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
  getScalarValue,
  intCoreTag,
  NOT_RESOLVED,
  nullCoreTag,
  SCALAR_STYLE_FOLDED_BLOCK,
  SCALAR_STYLE_LITERAL_BLOCK,
  type ScalarTagDefinition,
} from 'js-yaml'

const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const
export const FRONTMATTER_EDIT_REFUSED_MESSAGE =
  "dohc can't change one property in this file without rewriting the others. Edit the file's text instead."
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
// UTF-8 bytes of string values and mapping keys once aliases are expanded.
// Above the largest text file, so only aliases can reach it.
const MAX_FRONTMATTER_STRING_BYTES = 16 * 1024 * 1024
const MAX_FRONTMATTER_ALIASES = 256
// Text both loaders refuse before parsing: a `%TAG` directive, which would
// copy its prefix into every tagged node, a second document's start marker,
// or a carriage return that does not end a line.
const REFUSED_FRONTMATTER_TEXT = /\r(?!\n)|^(?:%TAG|---)(?:[ \t\r\n]|$)/mu
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
  return {
    value: budgetedFrontmatterValue(loaded, 0, { nodes: 0, bytes: 0 }),
    keys: root.keys,
  }
}

// Aliases share one object, so this walk is where an alias ladder would
// multiply; the node and string byte budgets stop it.
function budgetedFrontmatterValue(
  value: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
): unknown {
  budget.nodes += 1
  if (typeof value === 'string') budget.bytes += utf8ByteLength(value)
  if (budget.nodes > MAX_FRONTMATTER_NODES || budget.bytes > MAX_FRONTMATTER_STRING_BYTES) {
    throw new Error('frontmatter holds too much')
  }
  const collection = Array.isArray(value) || isFrontmatterMap(value)
  if (collection && depth + 1 > MAX_FRONTMATTER_DEPTH) throw new Error('frontmatter nests too deeply')
  if (Array.isArray(value)) {
    return value.map(child => budgetedFrontmatterValue(child, depth + 1, budget))
  }
  if (!isFrontmatterMap(value)) return value
  const normalized = nullPrototypeRecord()
  for (const key of Object.keys(value).sort()) {
    budget.bytes += utf8ByteLength(key)
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
  if (REFUSED_FRONTMATTER_TEXT.test(text)) return null
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
 * A frontmatter block that neither loader reads, up to and including its
 * closing delimiter line, when its first entry looks like a mapping key:
 * `key:` or `?` at the start of a line, or the block contains a lone carriage
 * return. A settle keeps such a block byte for byte instead of reading it
 * as body Markdown. The engine applies the
 * same rule (`unreadable_frontmatter_prefix` in
 * crates/dohc-engine-domain/src/collections.rs).
 */
function unreadableFrontmatterPrefix(markdown: string): string | undefined {
  const match = FRONTMATTER_RE.exec(markdown)
  if (!match || readFrontmatterBlock(markdown) !== null) return undefined
  const [, open = '', text = '', closeLine = ''] = match
  const entry = (text.match(/[^\n]*\n/gu) ?? [])
    .map(line => line.replace(/\r?\n$/u, ''))
    .find(line => !/^[ \t]*(?:#|$)/u.test(line))
  return (entry !== undefined && looksLikeMappingEntry(entry)) || /\r(?!\n)/u.test(text)
    ? open + text + closeLine
    : undefined
}

// A frontmatter line that looks like a mapping entry: `?` then a space, tab, or
// the end; or a first character other than space, tab, `#`, `%`, or `-`, then a
// colon followed by a space, tab, or the end. The engine uses the same rule
// (`looks_like_mapping_entry` in crates/dohc-engine-domain/src/collections.rs).
function looksLikeMappingEntry(line: string): boolean {
  const separator = (rest: string): boolean => rest === '' || rest.startsWith(' ') || rest.startsWith('\t')
  if (line.startsWith('?') && separator(line.slice(1))) return true
  if (line === '' || /^[ \t#%-]/u.test(line)) return false
  for (let index = line.indexOf(':', 1); index !== -1; index = line.indexOf(':', index + 1)) {
    if (separator(line.slice(index + 1))) return true
  }
  return false
}

/** Whether the entry splitter cannot preserve this block through property edits. */
export function markdownFrontmatterEditsRefused(markdown: unknown): boolean {
  if (typeof markdown !== 'string') return false
  const block = readFrontmatterBlock(markdown)
  if (!block) return false
  try {
    const entries = rootKeyEntries(block.yaml)
    return entries === undefined || entries.length !== block.keys.length
  } catch {
    return true
  }
}

/** Whether edits to a live document's properties would rewrite other entries. */
export function frontmatterEditsRefused(doc: Y.Doc): boolean {
  return markdownFrontmatterEditsRefused(doc.getMap('meta').get(FRONTMATTER_SOURCE_META_KEY))
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
  if (!block) {
    // A block neither loader reads stays as written, with no values.
    const prefix = unreadableFrontmatterPrefix(src)
    if (prefix === undefined) return { meta: {}, body: src }
    const rest = src.slice(prefix.length)
    const separator = /^(?:\r?\n)*/u.exec(rest)?.[0] ?? ''
    return { meta: {}, body: rest.slice(separator.length), frontmatterSource: prefix + separator }
  }
  const separator = /^(?:\r?\n)*/u.exec(block.rest)?.[0] ?? ''
  const source = src.slice(0, src.length - block.rest.length + separator.length)
  let canonical: string
  try {
    canonical = Object.keys(block.value).length === 0
      ? ''
      : `---\n${frontmatterYaml(block.value)}---\n\n`
  } catch {
    return { meta: {}, body: src }
  }
  return {
    meta: block.value,
    body: block.rest.slice(separator.length),
    ...(source === (usesCrlf ? canonical.replaceAll('\n', '\r\n') : canonical)
      ? {}
      : { frontmatterSource: source }),
  }
}

/**
 * The frontmatter a person wrote, kept through a settle. `written` names the
 * keys still held by the items the text was written for; without it, every
 * current key counts, as for a file's own text. While the text still reads as
 * `current` and every key is written, it comes back unchanged. Otherwise a
 * written key whose value did not change keeps its lines and the comments
 * above them, and a changed written key gets its canonical entry in place. A
 * key written again since, by any writer, gets its canonical entry in place
 * without the comments above it, so a deleted and re-added key never brings
 * back old text. A removed key loses its lines and comments, and a new key is
 * added after the others. Empty when no key or comment is left. Undefined
 * when the source is too large or unreadable, or when the candidate cannot
 * preserve the values; callers refuse the edit. The
 * engine keeps frontmatter the same way (`kept` in
 * crates/dohc-engine-collab/src/ydoc/frontmatter_yaml.rs).
 */
export function keptFrontmatter(
  source: string,
  current: Record<string, unknown>,
  written?: ReadonlySet<string>,
): string | undefined {
  if (exceedsLiveMarkdownLimit(source)) return undefined
  try {
    const block = readFrontmatterBlock(source)
    if (!block) {
      // A block neither loader reads is kept as written while no key is set.
      const prefix = unreadableFrontmatterPrefix(source)
      return prefix !== undefined && Object.keys(current).length === 0
        && /^(?:\r?\n)*$/u.test(source.slice(prefix.length))
        ? source
        : undefined
    }
    if (!/^(?:\r?\n)*$/u.test(block.rest)) return undefined
    // Each value renders once and compares as its canonical entry.
    const rendered = renderedEntries(current)
    const readsAsCurrent = (parsed: Map<string, string>): boolean =>
      parsed.size === rendered.size
      && [...rendered].every(([key, entry]) => parsed.get(key) === entry)
    const parsed = renderedEntries(block.value)
    const isWritten = (key: string): boolean => written === undefined || written.has(key)
    if (readsAsCurrent(parsed) && block.keys.every(isWritten)) return source
    const entries = rootKeyEntries(block.yaml)
    if (entries === undefined || entries.length !== block.keys.length) return undefined
    const indent = mappingIndent(block.yaml, entries)
    const render = (entry: string): string => renderEntry(entry, indent, block.open.endsWith('\r\n'))
    // Comments above the first key belong to it, like those above any other.
    let kept = entries.length === 0 ? block.yaml : ''
    let lead = entries.length === 0 ? '' : block.yaml.slice(0, entries[0]!.line)
    block.keys.forEach((key, index) => {
      const entry = entries[index]!
      const region = block.yaml.slice(entry.line, entries[index + 1]?.line ?? block.yaml.length)
      const split = entryTextEnd(region, entry.keptBlankLines, indent.length)
      if (Object.hasOwn(current, key) && !isWritten(key)) {
        kept += (lead.match(/[^\n]*\n/gu) ?? []).filter(line => line.trim() === '').join('')
        kept += render(rendered.get(key)!)
      } else if (Object.hasOwn(current, key)) {
        kept += lead
        kept += parsed.get(key) === rendered.get(key)
          ? region.slice(0, split)
          : render(rendered.get(key)!)
      }
      lead = region.slice(split)
    })
    for (const key of Object.keys(orderFrontmatter(current))) {
      if (!Object.hasOwn(block.value, key)) kept += render(rendered.get(key)!)
    }
    kept += lead
    if (kept === '') return ''
    const candidate = `${block.open}${kept}${block.closing}`
    const reread = readFrontmatterBlock(candidate)
    const untouched = block.keys.filter(key => isWritten(key) && parsed.get(key) === rendered.get(key))
    return reread && /^(?:\r?\n)*$/u.test(reread.rest) && readsAsCurrent(renderedEntries(reread.value))
      && preservesYamlValues(block, reread, untouched)
      ? candidate
      : undefined
  } catch {
    return undefined
  }
}

// Compare resolved YAML nodes as well as projected values: `.nan` and
// `'.nan'` have the same projection, but an alias must not switch between them.
function preservesYamlValues(before: FrontmatterBlock, after: FrontmatterBlock, keys: string[]): boolean {
  const values = (block: FrontmatterBlock): Map<string, unknown> => {
    const root = yaml.eventsToAst(yaml.parseEvents(block.yaml, { maxDepth: PARSER_MAX_DEPTH }), {
      source: block.yaml, schema: frontmatterLoadSchema,
    })[0]?.contents
    if (!root || root.kind !== 'mapping') return new Map()
    const anchors = new Map<string, unknown>()
    const resolve = (node: yaml.Node): unknown => {
      if (node.kind === 'alias') {
        if (!anchors.has(node.anchor)) throw new Error('unresolved alias')
        return anchors.get(node.anchor)
      }
      const value: unknown = node.kind === 'scalar'
        ? [node.kind, node.tag, node.value]
        : [node.kind, node.tag, node.kind === 'sequence'
            ? node.items.map(resolve)
            : node.items.map(pair => [resolve(pair.key), resolve(pair.value)])]
      if (node.anchor) anchors.set(node.anchor, value)
      return value
    }
    return new Map(root.items.map((pair, index) => {
      resolve(pair.key)
      return [block.keys[index]!, resolve(pair.value)]
    }))
  }
  const original = values(before)
  const candidate = values(after)
  return keys.every(key => original.has(key) && candidate.has(key)
    && sameFrontmatterValue(original.get(key), candidate.get(key)))
}

/** The Y.Doc meta key that holds the frontmatter text a document keeps. */
export const FRONTMATTER_SOURCE_META_KEY = 'dohcFrontmatterSource'
/**
 * The prefix of the Y.Doc meta keys that hold the item a frontmatter key held
 * when its text was kept, as `client:clock`. One entry per key, so edits to
 * different keys on different devices merge. Writing a key creates a new
 * item, so a key written since, by any writer, no longer matches. The engine
 * reads them the same way.
 */
export const FRONTMATTER_SOURCE_ITEM_META_PREFIX = 'dohcFrontmatterSourceItem:'

function entryItem(map: Y.Map<unknown>, key: string): string | undefined {
  const item = map._map.get(key)
  return item === undefined || item.deleted ? undefined : `${item.id.client}:${item.id.clock}`
}

/** Record the item each frontmatter key holds now, beside the kept text. */
export function recordFrontmatterSourceItems(frontmatter: Y.Map<unknown>, meta: Y.Map<unknown>): void {
  for (const key of [...meta.keys()]) {
    if (key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX)) meta.delete(key)
  }
  for (const key of frontmatter.keys()) {
    const item = entryItem(frontmatter, key)
    if (item !== undefined) meta.set(FRONTMATTER_SOURCE_ITEM_META_PREFIX + key, item)
  }
}

/** The frontmatter keys still held by the items their kept text was written for. */
export function writtenFrontmatterKeys(frontmatter: Y.Map<unknown>, meta: Y.Map<unknown>): Set<string> {
  const written = new Set<string>()
  for (const [metaKey, item] of meta.entries()) {
    if (!metaKey.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX)) continue
    const key = metaKey.slice(FRONTMATTER_SOURCE_ITEM_META_PREFIX.length)
    if (entryItem(frontmatter, key) === item) written.add(key)
  }
  return written
}

/**
 * Set a frontmatter value. When the key held the item its kept text was
 * written for, the text moves to the new item, so an edited value keeps its
 * place and the comments above it. A key that was absent, or written by
 * someone else since, stays unmatched and settles without its old comments.
 */
export function setFrontmatterValue(doc: Y.Doc, key: string, value: unknown): void {
  patchFrontmatter(doc, new Map([[key, value]]))
}

/** Validate a whole property edit before changing any Y.Map item. */
export function patchFrontmatter(doc: Y.Doc, values: ReadonlyMap<string, unknown>, remove: readonly string[] = []): void {
  const frontmatter = doc.getMap<unknown>('frontmatter')
  const meta = doc.getMap<unknown>('meta')
  const current = nullPrototypeRecord()
  for (const [key, value] of frontmatter) {
    current[key] = value !== null && typeof value === 'object'
      && 'toJSON' in value && typeof value.toJSON === 'function' ? value.toJSON() : value
  }
  for (const key of remove) delete current[key]
  for (const [key, value] of values) current[key] = value
  const candidate = frontmatterBlockFor(current, meta.get(FRONTMATTER_SOURCE_META_KEY), '', '\n', writtenFrontmatterKeys(frontmatter, meta))
  assertRequestedValues(candidate, Object.fromEntries(values))
  doc.transact(() => {
    for (const key of remove) frontmatter.delete(key)
    for (const [key, value] of values) {
      const before = entryItem(frontmatter, key)
      frontmatter.set(key, value)
      const after = entryItem(frontmatter, key)
      const metaKey = FRONTMATTER_SOURCE_ITEM_META_PREFIX + key
      if (before !== undefined && after !== undefined && meta.get(metaKey) === before) meta.set(metaKey, after)
    }
  })
}

function assertRequestedValues(candidate: string, requested: Record<string, unknown>): void {
  if (Object.keys(requested).length === 0) return
  const expected = readFrontmatterBlock(`---\n${frontmatterYaml(requested)}---\n`)
  const actual = readFrontmatterBlock(candidate)
  if (!expected || !actual
    || !Object.keys(requested).every(key => sameFrontmatterValue(requested[key], actual.value[key]))
    || !preservesYamlValues(expected, actual, Object.keys(requested))) {
    throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE)
  }
}

function sameFrontmatterValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index)
        || !sameFrontmatterValue(left[index], right[index])) return false
    }
    return true
  }
  return isFrontmatterMap(left) && isFrontmatterMap(right)
    && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && sameFrontmatterValue(left[key], right[key]))
}

/** The text with each renamed entry written under its new name, in place. */
function withRenamedEntries(
  source: string,
  current: Record<string, unknown>,
  renamed: ReadonlyMap<string, string>,
): string {
  if (renamed.size === 0) return source
  try {
    const block = readFrontmatterBlock(source)
    const entries = block ? rootKeyEntries(block.yaml) : undefined
    if (!block || entries === undefined || entries.length !== block.keys.length) return source
    const indent = mappingIndent(block.yaml, entries)
    let yaml = block.yaml.slice(0, entries[0]?.line ?? block.yaml.length)
    block.keys.forEach((key, index) => {
      const region = block.yaml.slice(entries[index]!.line, entries[index + 1]?.line ?? block.yaml.length)
      const to = renamed.get(key)
      if (to === undefined || !Object.hasOwn(current, to)) {
        yaml += region
        return
      }
      const split = entryTextEnd(region, entries[index]!.keptBlankLines, indent.length)
      const entry = frontmatterYaml({ [to]: current[to] })
      yaml += `${renderEntry(entry, indent, block.open.endsWith('\r\n'))}${region.slice(split)}`
    })
    return `${block.open}${yaml}${block.closing}`
  } catch {
    return source
  }
}

function renderedEntries(values: Record<string, unknown>): Map<string, string> {
  return new Map(Object.keys(values).map(key => [key, frontmatterYaml({ [key]: values[key] })]))
}

type RootKeyEntry = { line: number; keptBlankLines: number }

function mappingIndent(text: string, entries: RootKeyEntry[]): string {
  return entries.length === 0 ? '' : /^ */u.exec(text.slice(entries[0]!.line))![0]
}

function renderEntry(entry: string, indent: string, crlf: boolean): string {
  const indented = entry.replace(/^(?=.)/gmu, indent)
  return crlf ? indented.replaceAll('\n', '\r\n') : indented
}

/**
 * Where each top-level key's line starts, in document order, with the blank
 * lines after the entry that its value keeps: the line breaks a
 * keep-chomped block scalar (`|+`) holds. Undefined unless the root is a
 * block mapping with one written key per line.
 */
function rootKeyEntries(text: string): RootKeyEntry[] | undefined {
  const events = yaml.parseEvents(text, { maxDepth: PARSER_MAX_DEPTH })
  const frames: { mapping: boolean; keyNext: boolean }[] = []
  const entries: RootKeyEntry[] = []
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
    const isKey = parent?.mapping === true && parent.keyNext
    const isRootKey = isKey && frames.length === 2
    if (parent?.mapping) parent.keyNext = !parent.keyNext
    if (event.type === EVENT_MAPPING || event.type === EVENT_SEQUENCE) {
      if (frames.length === 1 && event.style !== COLLECTION_STYLE_BLOCK) return undefined
      frames.push({ mapping: event.type === EVENT_MAPPING, keyNext: true })
      continue
    }
    const last = entries.at(-1)
    if (!isKey && last !== undefined) {
      // A keep-chomped block scalar owns the blank lines after it.
      last.keptBlankLines = event.type === EVENT_SCALAR
        && (event.style === SCALAR_STYLE_LITERAL_BLOCK || event.style === SCALAR_STYLE_FOLDED_BLOCK)
        ? Math.max(0, (/\n*$/u.exec(getScalarValue(text, event))?.[0].length ?? 0) - 1)
        : 0
    }
    if (!isRootKey) continue
    const position = event.type === EVENT_SCALAR
      ? Math.min(...[event.tagStart, event.anchorStart, event.valueStart].filter(at => at >= 0))
      : event.type === EVENT_ALIAS ? event.anchorStart : -1
    // js-yaml gives an empty key no position, so the block does not split.
    if (!Number.isFinite(position) || position < 0) return undefined
    const line = text.lastIndexOf('\n', position - 1) + 1
    if (line <= (entries.at(-1)?.line ?? -1)) return undefined
    entries.push({ line, keptBlankLines: 0 })
  }
  return entries
}

/**
 * Where an entry's own text ends: before its trailing blank lines and
 * comments at or above the mapping's indentation, which belong to the entry
 * below it, except the blank lines a keep-chomped block scalar keeps.
 */
function entryTextEnd(region: string, keptBlankLines: number, indent: number): number {
  let start = region.length
  while (start > 0) {
    const lineStart = region.lastIndexOf('\n', start - 2) + 1
    const line = region.slice(lineStart, start).replace(/\r?\n$/u, '')
    const commentIndent = /^ *(?=#)/u.exec(line)?.[0].length
    if (lineStart === 0 || !(line.trim() === '' || (commentIndent !== undefined && commentIndent <= indent))) break
    start = lineStart
  }
  for (let kept = 0; kept < keptBlankLines; kept += 1) {
    const lineEnd = region.indexOf('\n', start) + 1
    if (lineEnd === 0 || region.slice(start, lineEnd).trim() !== '') break
    start = lineEnd
  }
  return start
}

/**
 * The frontmatter block a projection writes before `body`: the kept text of
 * `source` when it still reads as `frontmatter`, canonical YAML without a source,
 * and nothing when there are no values to write.
 */
export function frontmatterBlockFor(
  frontmatter: Record<string, unknown>,
  source: unknown,
  body: string,
  lineEnding: '\n' | '\r\n',
  written?: ReadonlySet<string>,
): string {
  const kept = typeof source === 'string' ? keptFrontmatter(source, frontmatter, written) : undefined
  if (kept !== undefined) {
    // A closing delimiter at the end of the file needs a line break before
    // the body a person adds under it.
    return kept !== '' && body !== '' && !kept.endsWith('\n') ? `${kept}${lineEnding}${lineEnding}` : kept
  }
  if (typeof source === 'string') throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE)
  if (Object.keys(frontmatter).length === 0) return ''
  const block = `---\n${frontmatterYaml(frontmatter)}---${body.startsWith('\n') ? '\n' : '\n\n'}`
  return lineEnding === '\n' ? block : block.replaceAll('\n', '\r\n')
}

/**
 * Write frontmatter values into a Markdown document, keeping the text of every
 * entry whose value did not change. `renamed` maps an old key to its new
 * name, so a property renamed in a form keeps its place while a person types.
 */
export function writeMarkdownFrontmatter(
  markdown: string,
  frontmatter: Record<string, unknown>,
  renamed: ReadonlyMap<string, string> = new Map(),
): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n'
  const { body } = parseFrontmatter(markdown, lineEnding === '\r\n')
  const written = markdown.slice(0, markdown.length - body.length)
  const source = written === '' ? undefined : withRenamedEntries(written, frontmatter, renamed)
  const candidate = frontmatterBlockFor(frontmatter, source, body, lineEnding)
  const original = readFrontmatterBlock(written)
  const requested = nullPrototypeRecord()
  const unchanged: string[] = []
  for (const key of Object.keys(frontmatter)) {
    if (original && Object.hasOwn(original.value, key)
      && frontmatterYaml({ [key]: original.value[key] }) === frontmatterYaml({ [key]: frontmatter[key] })
      && ![...renamed.values()].includes(key)) unchanged.push(key)
    else requested[key] = frontmatter[key]
  }
  assertRequestedValues(candidate, requested)
  if (original && unchanged.length > 0) {
    const reread = readFrontmatterBlock(candidate)
    if (!reread || !preservesYamlValues(original, reread, unchanged)) throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE)
  }
  return `${candidate}${body}`
}
