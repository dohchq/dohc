// How frontmatter lives in a Y.Doc: values in the frontmatter map, as Yjs Any
// or as shared types where Any would lose a key or an exact integer, and the
// kept text and its items in the meta map. This module imports only yjs and
// the frontmatter rules, so a surface can read and edit a live document's
// frontmatter without loading the editor.
import * as Y from 'yjs'
import {
  assertFrontmatterEdit,
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
  FRONTMATTER_SOURCE_META_KEY,
  frontmatterBlockFor,
  isFrontmatterMap,
  keptTextRenamed,
  MARKDOWN_CRLF_META_KEY,
  normalizeFrontmatterValue,
  nullPrototypeRecord,
  orderFrontmatter,
  sameFrontmatterValue,
} from './frontmatter.js'

/**
 * The prefix of the Y.Doc meta keys that hold the item a frontmatter key held
 * when its text was kept, as `client:clock`. One entry per key, so edits to
 * different keys on different devices merge. Writing a key creates a new
 * item, so a key written since, by any writer, no longer matches. The engine
 * reads them the same way.
 */
const FRONTMATTER_SOURCE_ITEM_META_PREFIX = 'dohcFrontmatterSourceItem:'

function entryItem(map: Y.Map<unknown>, key: string): string | undefined {
  const item = map._map.get(key)
  return item === undefined || item.deleted ? undefined : `${item.id.client}:${item.id.clock}`
}

/** Record the item each frontmatter key holds now, beside the kept text. */
export function recordFrontmatterSourceItems(frontmatter: Y.Map<unknown>, meta: Y.Map<unknown>): void {
  const items = new Map<string, string>()
  if (meta.has(FRONTMATTER_SOURCE_META_KEY)) {
    for (const key of frontmatter.keys()) {
      const item = entryItem(frontmatter, key)
      if (item !== undefined) items.set(FRONTMATTER_SOURCE_ITEM_META_PREFIX + key, item)
    }
  }
  for (const key of [...meta.keys()]) {
    if (key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX) && !items.has(key)) meta.delete(key)
  }
  for (const [key, item] of items) {
    if (meta.get(key) !== item) meta.set(key, item)
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

/**
 * Validate a whole property edit before changing any Y.Map item. `renamed`
 * maps a key in `remove` to the key in `values` that takes its place. The
 * kept text writes that entry under the new name where it was, with its
 * comments and value text, and the new key keeps that text while the old
 * one did. Values, kept text, and items change in one transaction.
 */
export function patchFrontmatter(
  doc: Y.Doc,
  values: ReadonlyMap<string, unknown>,
  remove: readonly string[] = [],
  renamed: ReadonlyMap<string, string> = new Map(),
): void {
  const frontmatter = doc.getMap<unknown>('frontmatter')
  const meta = doc.getMap<unknown>('meta')
  const current = Object.assign(nullPrototypeRecord(), frontmatterMapValues(frontmatter))
  for (const [from, to] of renamed) {
    if (from === to || !remove.includes(from) || !values.has(to) || !Object.hasOwn(current, from)) {
      throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE)
    }
  }
  const source = meta.get(FRONTMATTER_SOURCE_META_KEY)
  // Canonical frontmatter keeps no text and settles in sorted order. A rename
  // starts from the canonical text, so the renamed key keeps its place.
  let kept = typeof source === 'string' || renamed.size === 0
    ? source
    : frontmatterBlockFor(current, undefined, '', meta.get(MARKDOWN_CRLF_META_KEY) === true ? '\r\n' : '\n')
  const written = writtenFrontmatterKeys(frontmatter, meta)
  // Each entry the kept text renames, and whether its key held that text.
  const moved: [from: string, to: string, held: boolean][] = []
  // Moved keys whose value did not change. Their text reads as the value but
  // need not be the canonical YAML the requested-value check compares.
  const asWritten = new Set<string>()
  for (const [from, to] of renamed) {
    const text = typeof kept === 'string' ? keptTextRenamed(kept, from, to) : undefined
    if (text === undefined) continue
    kept = text
    const held = written.delete(from)
    if (held) written.add(to)
    else written.delete(to)
    moved.push([from, to, held])
    if (sameFrontmatterValue(values.get(to), current[from])) asWritten.add(to)
  }
  if (moved.length === 0) kept = source
  for (const key of remove) delete current[key]
  for (const [key, value] of values) current[key] = value
  // The candidate's own reread already checks that moved values read as before.
  const requested = Object.fromEntries(values)
  for (const key of asWritten) delete requested[key]
  assertFrontmatterEdit(current, kept, written, requested)
  // Yjs keeps what a transaction wrote before it threw, so build every value first.
  const stored = Array.from(values, ([key, value]) => [key, storedFrontmatterValue(value)] as const)
  doc.transact(() => {
    if (kept !== source) meta.set(FRONTMATTER_SOURCE_META_KEY, kept)
    for (const key of remove) frontmatter.delete(key)
    for (const [key, value] of stored) {
      const before = entryItem(frontmatter, key)
      frontmatter.set(key, value)
      const after = entryItem(frontmatter, key)
      const metaKey = FRONTMATTER_SOURCE_ITEM_META_PREFIX + key
      if (before !== undefined && after !== undefined && meta.get(metaKey) === before) meta.set(metaKey, after)
    }
    for (const [from, to, held] of moved) {
      meta.delete(FRONTMATTER_SOURCE_ITEM_META_PREFIX + from)
      const item = entryItem(frontmatter, to)
      if (held && item !== undefined) meta.set(FRONTMATTER_SOURCE_ITEM_META_PREFIX + to, item)
      else meta.delete(FRONTMATTER_SOURCE_ITEM_META_PREFIX + to)
    }
  })
}

/**
 * A live document's frontmatter block. Once a settle has written every edit
 * (`settled`), that is the block the settle wrote. Otherwise it is the kept
 * text, which holds a rename before the file does, or the canonical block of
 * the values when no text was kept.
 */
export function frontmatterAsWritten(doc: Y.Doc, settled: boolean): string {
  const frontmatter = doc.getMap<unknown>('frontmatter')
  const meta = doc.getMap<unknown>('meta')
  const source = meta.get(FRONTMATTER_SOURCE_META_KEY)
  if (typeof source === 'string' && !settled) return source
  try {
    return frontmatterBlockFor(orderFrontmatter(frontmatterMapValues(frontmatter)), source, '', '\n', writtenFrontmatterKeys(frontmatter, meta))
  } catch {
    // A refused settle leaves the file as it was.
    return typeof source === 'string' ? source : ''
  }
}

/** Write plain values into a document's frontmatter map. The meta map uses the same encoding. */
export function writeFrontmatterMap(map: Y.Map<unknown>, values: Record<string, unknown>): void {
  writeMap(map, values, false)
}

/** A document's frontmatter map as plain values, with keys sorted. */
export function frontmatterMapValues(map: Y.Map<unknown>): Record<string, unknown> {
  return mapToObject(map, false)
}

function writeMap(
  map: Y.Map<unknown>,
  values: Record<string, unknown>,
  escapeSharedBigIntKeys: boolean,
): void {
  for (const [key, value] of Object.entries(values)) {
    map.set(escapeSharedBigIntKeys ? escapeSharedBigIntKey(key) : key, storedFrontmatterValue(value))
  }
}

// A plain value as a frontmatter map stores it, in a detached shared type
// when it needs one.
function storedFrontmatterValue(value: unknown): unknown {
  return frontmatterValueNeedsSharedType(value) ? frontmatterValueToY(value) : frontmatterValueToAny(value)
}

function frontmatterValueNeedsSharedType(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(frontmatterValueNeedsSharedType)
  if (!isFrontmatterMap(value)) return false
  // Yjs dispatches plain values through `value.constructor`; lib0's plain-map
  // decoder assigns `__proto__` through its setter. Shared types preserve both keys.
  return Object.hasOwn(value, 'constructor')
    || Object.hasOwn(value, '__proto__')
    || Object.values(value).some(frontmatterValueNeedsSharedType)
}

function frontmatterValueToAny(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(frontmatterValueToAny)
  if (!isFrontmatterMap(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, frontmatterValueToAny(child)]),
  )
}

const FRONTMATTER_SHARED_BIGINT_KEY = '$dohcBigInt'
// The sentinel spelling and every extra-`$` escape depth of it. Literal keys
// spelled this way gain one `$` when a shared map is built and lose one when
// it is read, so only a real sentinel ever carries the unescaped key.
const SHARED_BIGINT_KEY_SPELLING = /^\$+dohcBigInt$/

function escapeSharedBigIntKey(key: string): string {
  return SHARED_BIGINT_KEY_SPELLING.test(key) ? `$${key}` : key
}

function unescapeSharedBigIntKey(key: string): string {
  return key.startsWith('$$') && SHARED_BIGINT_KEY_SPELLING.test(key)
    ? key.slice(1)
    : key
}

function frontmatterValueToY(value: unknown): unknown {
  if (typeof value === 'bigint') {
    // Y.Map stores bigint through ContentAny, while Y.Array rejects bigint as
    // a direct item in Yjs 13. Keep the exact value in Any instead of changing
    // its scalar kind to a collaborative text node.
    const integer = new Y.Map<unknown>()
    integer.set(FRONTMATTER_SHARED_BIGINT_KEY, value)
    return integer
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>()
    array.insert(0, value.map(frontmatterValueToY))
    return array
  }
  if (isFrontmatterMap(value)) {
    const map = new Y.Map<unknown>()
    writeMap(map, value, true)
    return map
  }
  return value
}

function yFrontmatterValueToPlain(value: unknown): unknown {
  if (
    value instanceof Y.Map
    && value.size === 1
    && typeof value.get(FRONTMATTER_SHARED_BIGINT_KEY) === 'bigint'
  ) {
    return value.get(FRONTMATTER_SHARED_BIGINT_KEY)
  }
  if (value instanceof Y.Map) return mapToObject(value, true)
  if (value instanceof Y.Array) {
    return value.toArray().map(yFrontmatterValueToPlain)
  }
  // No writer puts Y.Text in frontmatter (bigints ride the shared singleton
  // map); a foreign one degrades to its visible string instead of throwing.
  if (value instanceof Y.Text) return value.toString()
  return normalizeFrontmatterValue(value)
}

function mapToObject(
  map: Y.Map<unknown>,
  unescapeSharedBigIntKeys: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Array.from(map.entries(), ([key, child]) => [
      unescapeSharedBigIntKeys ? unescapeSharedBigIntKey(key) : key,
      yFrontmatterValueToPlain(child),
    ] as const).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  )
}
