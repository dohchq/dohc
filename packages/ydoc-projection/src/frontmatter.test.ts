import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import vectors from '../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/frontmatter-edits.json'
import { leadingFrontmatter, writeMarkdownFrontmatter, loadMarkdownFrontmatter } from './frontmatter.js'
import {
  frontmatterAsWritten,
  frontmatterMapValues,
  patchFrontmatter,
  setFrontmatterValue,
  writtenFrontmatterKeys,
} from './frontmatter-map.js'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'

// The canonical writer keeps `hostile`, `literal`, and `mixed` in shared Y
// types and `exact` as a Yjs Any bigint. The block is canonical, so a
// document keeps no text for it.
const SHARED_BLOCK = [
  '---',
  'exact: 9007199254740993',
  'hostile:', '  __proto__: nested-value', '  constructor: own',
  'literal:', '  - constructor: hostile-constructor', '  - $dohcBigInt: 9007199254740993',
  'mixed:', '  - constructor: hostile-constructor', '  - 9007199254740993',
  'status: draft',
  '---', '', '',
].join('\n')
// The same values with a comment, so a document keeps the text as written.
const KEPT_SHARED_BLOCK = SHARED_BLOCK.replace('---\n', '---\n# Keep this note\n')

/** The document as a replica receives it over the Yjs wire. */
function received(markdown: string): Y.Doc {
  const written = markdownToYDoc(markdown)
  const doc = new Y.Doc()
  try { Y.applyUpdate(doc, Y.encodeStateAsUpdate(written)) } finally { written.destroy() }
  return doc
}

// Every value kind the canonical writer keeps: maps and arrays with a
// `__proto__` or `constructor` key, exact integers, and a literal key spelled
// like the integer's marker, in shared Y types or as Yjs Any.
const MOVED_BLOCK = [
  '---',
  'deep:', '  inner:', '    __proto__: nested-proto', '    exact: 9007199254740993',
  'exact: 9007199254740993',
  'hostile:', '  __proto__: nested-value', '  constructor: own',
  'literal:', '  - constructor: hostile-constructor', '  - $dohcBigInt: 9007199254740993',
  'marker:', '  $dohcBigInt: 9007199254740993', '  constructor: own',
  'mixed:', '  - constructor: hostile-constructor', '  - 9007199254740993',
  'nested:', '  exact: 9007199254740993',
  'settings:', '  pinned: true',
  'status: draft',
  '---', '', '',
].join('\n')
const MOVED_KEYS = ['deep', 'exact', 'hostile', 'literal', 'marker', 'mixed', 'nested', 'settings', 'status']

/** Another replica of the document, through the Yjs wire. */
function replica(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

/** The frontmatter keys an action changes, including changes inside a shared value. */
function changedKeys(doc: Y.Doc, action: () => void): Set<string> {
  const frontmatter = doc.getMap<unknown>('frontmatter')
  const changed = new Set<string>()
  const observe = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
    for (const event of events) {
      if (event.target !== frontmatter) changed.add(String(event.path[0]))
      else if (event instanceof Y.YMapEvent) for (const key of event.keysChanged) changed.add(key)
    }
  }
  frontmatter.observeDeep(observe)
  try { action() } finally { frontmatter.unobserveDeep(observe) }
  return changed
}

const refusal = "dohc can't change one property in this file without rewriting the others. Edit the file's text instead."
describe('shared frontmatter edit candidates', () => {
  it('refuses a sparse array before it can reload with a different value', () => {
    const doc = markdownToYDoc('Body')
    try {
      const before = Y.encodeStateAsUpdate(doc)
      expect(() => setFrontmatterValue(doc, 'value', new Array<unknown>(1))).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    } finally { doc.destroy() }
  })
  it('refuses a batch before writing even its safe fields or deletions', () => {
    const doc = markdownToYDoc('---\na: &v .nan\nb: *v\nc: 0\n---\n\nBody')
    try {
      const before = Y.encodeStateAsUpdate(doc)
      expect(() => patchFrontmatter(doc, new Map([['c', 1], ['a', 1]]))).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
      expect(() => patchFrontmatter(doc, new Map([['c', 1]]), ['a'])).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    } finally { doc.destroy() }
  })

  it('refuses a requested string whose projection matches a YAML number', () => {
    const doc = markdownToYDoc('---\na: &v .nan\nb: *v\n---\n\nBody')
    try {
      const before = Y.encodeStateAsUpdate(doc)
      expect(() => setFrontmatterValue(doc, 'b', '.nan')).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    } finally { doc.destroy() }
  })

  it.each(vectors)('$name', vector => {
    const doc = markdownToYDoc(vector.markdown)
    try {
      const before = Y.encodeStateAsUpdate(doc)
      const edit = () => setFrontmatterValue(doc, vector.key, vector.value)
      const values = { ...loadMarkdownFrontmatter(vector.markdown)!.meta, [vector.key]: vector.value }
      if (vector.refused) {
        expect(edit).toThrow(refusal)
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
        expect(yDocToMarkdown(doc)).toBe(vector.markdown)
        expect(() => writeMarkdownFrontmatter(vector.markdown, values)).toThrow(refusal)
      } else {
        edit()
        expect(yDocToMarkdown(doc)).toBe(vector.expected)
        expect(writeMarkdownFrontmatter(vector.markdown, values)).toBe(vector.expected)
      }
    } finally { doc.destroy() }
  })
})

describe('shared frontmatter values a patch writes', () => {
  // A rename removes the old key and writes the value read from it under the
  // new one. The value arrives decoded, with null-prototype maps.
  it.each(MOVED_KEYS)('moves %s to a new key as the canonical writer keeps it', key => {
    const doc = received(`${MOVED_BLOCK}Body`)
    const frontmatter = doc.getMap<unknown>('frontmatter')
    let copy: Y.Doc | undefined
    try {
      expect(doc.getMap('meta').get('dohcFrontmatterSource')).toBeUndefined()
      const value = frontmatterMapValues(frontmatter)[key]
      const shared = frontmatter.get(key) instanceof Y.AbstractType
      const others = MOVED_KEYS.filter(other => other !== key)
      const unchanged = new Map(others.map(other => [other, frontmatter.get(other)] as const))

      expect(changedKeys(doc, () => patchFrontmatter(doc, new Map([[`${key}2`, value]]), [key])))
        .toEqual(new Set([key, `${key}2`]))
      for (const other of others) expect(frontmatter.get(other), other).toBe(unchanged.get(other))

      copy = replica(doc)
      const moved = copy.getMap<unknown>('frontmatter')
      expect(moved.has(key)).toBe(false)
      expect(moved.get(`${key}2`) instanceof Y.AbstractType, 'stored as the canonical writer stores it').toBe(shared)
      expect(frontmatterMapValues(moved)[`${key}2`]).toEqual(value)
      expect(yDocToMarkdown(copy)).toBe(`${MOVED_BLOCK.replace(`\n${key}:`, `\n${key}2:`)}Body`)
    } finally {
      copy?.destroy()
      doc.destroy()
    }
  })

  // Yjs dispatches a plain value through `value.constructor`, and lib0's
  // decoder assigns `__proto__` through its setter.
  it.each<[string, unknown, string]>([
    ['a constructor key', JSON.parse('{"constructor":"own","pinned":true}'), 'value:\n  constructor: own\n  pinned: true\n'],
    ['a nested __proto__ key', JSON.parse('{"inner":{"__proto__":"nested-proto"}}'), 'value:\n  inner:\n    __proto__: nested-proto\n'],
    ['a __proto__ key in a list', JSON.parse('[{"__proto__":"listed"}]'), 'value:\n  - __proto__: listed\n'],
    [
      'a literal marker key beside a constructor key',
      [{ constructor: 'own' }, { $dohcBigInt: 9007199254740993n }],
      'value:\n  - constructor: own\n  - $dohcBigInt: 9007199254740993\n',
    ],
  ])('writes a value with %s that another replica reads back', (_name, value, entry) => {
    const doc = markdownToYDoc('---\nstatus: draft\n---\n\nBody')
    let copy: Y.Doc | undefined
    try {
      setFrontmatterValue(doc, 'value', value)
      copy = replica(doc)
      expect(frontmatterMapValues(copy.getMap('frontmatter')).value).toEqual(value)
      expect(yDocToMarkdown(copy)).toBe(`---\nstatus: draft\n${entry}---\n\nBody`)
    } finally {
      copy?.destroy()
      doc.destroy()
    }
  })

  it('keeps the kept text and the source items of the keys a move leaves alone', () => {
    const doc = received(`${KEPT_SHARED_BLOCK}Body`)
    const frontmatter = doc.getMap<unknown>('frontmatter')
    const meta = doc.getMap<unknown>('meta')
    let copy: Y.Doc | undefined
    try {
      const written = writtenFrontmatterKeys(frontmatter, meta)
      expect(written.has('hostile')).toBe(true)
      const hostile = frontmatterMapValues(frontmatter).hostile

      expect(changedKeys(doc, () => patchFrontmatter(doc, new Map([['hostile2', hostile]]), ['hostile'])))
        .toEqual(new Set(['hostile', 'hostile2']))
      expect(writtenFrontmatterKeys(frontmatter, meta)).toEqual(new Set([...written].filter(key => key !== 'hostile')))

      // Until a settle records new text, the file still holds the old block.
      expect(frontmatterAsWritten(doc, false)).toBe(KEPT_SHARED_BLOCK)
      const entry = 'hostile:\n  __proto__: nested-value\n  constructor: own\n'
      const settled = KEPT_SHARED_BLOCK
        .replace(entry, '')
        .replace('status: draft\n', `status: draft\n${entry.replace('hostile:', 'hostile2:')}`)
      expect(frontmatterAsWritten(doc, true)).toBe(settled)
      copy = replica(doc)
      expect(yDocToMarkdown(copy)).toBe(`${settled}Body`)
    } finally {
      copy?.destroy()
      doc.destroy()
    }
  })

  // Building a shared value can fail after every check passes. The patch
  // builds every value before its first write, including the removal.
  it('writes nothing when a value cannot be built', () => {
    const doc = received(`${KEPT_SHARED_BLOCK}Body`)
    const frontmatter = doc.getMap<unknown>('frontmatter')
    const meta = doc.getMap<unknown>('meta')
    const set = Y.Map.prototype.set
    // Only a detached map, one a value is being built in, refuses the write.
    const building = vi.spyOn(Y.Map.prototype, 'set').mockImplementation(function (this: Y.Map<unknown>, key: string, value: unknown) {
      if (this.doc === null) throw new Error('could not build the value')
      return set.call(this, key, value)
    })
    try {
      const before = Y.encodeStateAsUpdate(doc)
      const source = meta.toJSON()
      const written = writtenFrontmatterKeys(frontmatter, meta)
      const patch = new Map<string, unknown>([['status', 'ready'], ['hostile2', frontmatterMapValues(frontmatter).hostile]])

      expect(() => patchFrontmatter(doc, patch, ['hostile'])).toThrow('could not build the value')
      expect(building).toHaveBeenCalled()
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
      expect(meta.toJSON()).toEqual(source)
      expect(writtenFrontmatterKeys(frontmatter, meta)).toEqual(written)
      expect(frontmatterAsWritten(doc, true)).toBe(KEPT_SHARED_BLOCK)
    } finally {
      building.mockRestore()
      doc.destroy()
    }
  })

  // Yjs keeps whatever a transaction wrote before it threw, so every check
  // must run before the first write, including the removal.
  it.each<[string, string, Map<string, unknown>]>([
    ['rewrites an alias', 'a: &v .nan\nb: *v\n', new Map([['b', '.nan']])],
    ['holds an integer outside int64', '', new Map([['big', { constructor: 'own', value: 2n ** 63n }]])],
  ])('refuses a move beside a value that %s before any write', (_name, extra, values) => {
    const doc = received(`${MOVED_BLOCK.replace('status: draft\n', `status: draft\n${extra}`)}Body`)
    const frontmatter = doc.getMap<unknown>('frontmatter')
    try {
      const hostile = frontmatter.get('hostile')
      const before = Y.encodeStateAsUpdate(doc)
      const patch = new Map<string, unknown>([...values,['hostile2', frontmatterMapValues(frontmatter).hostile]])

      expect(() => patchFrontmatter(doc, patch, ['hostile'])).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
      expect(frontmatter.get('hostile')).toBe(hostile)
    } finally { doc.destroy() }
  })
})

describe('live property renames', () => {
  const rename = (doc: Y.Doc, from: string, to: string, value = doc.getMap('frontmatter').get(from)) =>
    patchFrontmatter(doc, new Map([[to, value]]), [from], new Map([[from, to]]))
  const budget = '---\n# Monthly\nbudget: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody'

  it.each([
    {
      name: 'leading and inline comments',
      markdown: budget, from: 'budget', to: 'cost',
      expected: '---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody',
    },
    {
      name: 'a quoted key',
      markdown: '---\n"status": draft # review first\nowner: ice\n---\n\nBody', from: 'status', to: 'state',
      expected: '---\nstate: draft # review first\nowner: ice\n---\n\nBody',
    },
    {
      name: 'a key that needs quotes',
      markdown: '---\nowner: ice # lead\nstatus:  draft\n---\n\nBody', from: 'owner', to: '2026',
      expected: "---\n'2026': ice # lead\nstatus:  draft\n---\n\nBody",
    },
    {
      name: 'a nested value',
      markdown: '---\ntags:   # labels\n  - a   # first\n  - b\nsettings:\n  pinned: true # keep\n---\n\nBody',
      from: 'tags', to: 'labels',
      expected: '---\nlabels:   # labels\n  - a   # first\n  - b\nsettings:\n  pinned: true # keep\n---\n\nBody',
    },
    {
      name: 'CRLF line endings',
      markdown: budget.replaceAll('\n', '\r\n'), from: 'wifi', to: 'network',
      expected: '---\n# Monthly\nbudget: 100 # euros\n# Wi-Fi password\nnetwork: hunter2\n---\n\nBody'.replaceAll('\n', '\r\n'),
    },
    {
      name: 'a value that keeps its text',
      markdown: '---\nbudget: .nan # unknown\nwifi: x\n---\n\nBody', from: 'budget', to: 'cost',
      expected: '---\ncost: .nan # unknown\nwifi: x\n---\n\nBody',
    },
    {
      name: 'a value with its own tag',
      markdown: '---\nbudget: !label x\nwifi: y\n---\n\nBody', from: 'budget', to: 'cost',
      expected: '---\ncost: !label x\nwifi: y\n---\n\nBody',
    },
    {
      name: 'canonical frontmatter',
      markdown: '---\nbudget: 100\nwifi: hunter2\n---\n\nBody', from: 'budget', to: 'yearly',
      expected: '---\nyearly: 100\nwifi: hunter2\n---\n\nBody',
    },
    {
      name: 'canonical frontmatter with CRLF line endings',
      markdown: '---\r\nbudget: 100\r\nwifi: hunter2\r\n---\r\n\r\nBody', from: 'budget', to: 'yearly',
      expected: '---\r\nyearly: 100\r\nwifi: hunter2\r\n---\r\n\r\nBody',
    },
  ])('renames $name in place in one transaction, through a reopen', ({ markdown, from, to, expected }) => {
    const doc = markdownToYDoc(markdown)
    try {
      const value = doc.getMap('frontmatter').get(from)
      const updates: Uint8Array[] = []
      doc.on('update', update => updates.push(update))
      rename(doc, from, to)
      expect(updates).toHaveLength(1)
      expect(doc.getMap('frontmatter').has(from)).toBe(false)
      expect(doc.getMap('frontmatter').get(to)).toEqual(value)
      expect(yDocToMarkdown(doc)).toBe(expected)
      expect(frontmatterAsWritten(doc, true)).toBe(expected.slice(0, -'Body'.length))
      const reopened = markdownToYDoc(expected)
      try {
        expect(yDocToMarkdown(reopened)).toBe(expected)
      } finally { reopened.destroy() }
    } finally { doc.destroy() }
  })

  it.each([
    ['---\nbudget: .nan # unknown\nwifi: x\n---\n\nBody', '---\ncost: .nan # unknown\nwifi: x\n---\n\nBody'],
    ['---\nbudget: !label x\nwifi: y\n---\n\nBody', '---\ncost: !label x\nwifi: y\n---\n\nBody'],
  ])('renames a value that keeps its text in a local file: %j', (markdown, expected) => {
    const { budget: value, ...others } = loadMarkdownFrontmatter(markdown)!.meta
    expect(writeMarkdownFrontmatter(markdown, { cost: value, ...others }, new Map([['budget', 'cost']]))).toBe(expected)
  })

  it('renames with a new value in place, and the comments above stay with later edits', () => {
    const doc = markdownToYDoc(budget)
    try {
      rename(doc, 'budget', 'cost', 200)
      expect(yDocToMarkdown(doc)).toBe('---\n# Monthly\ncost: 200\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody')
      setFrontmatterValue(doc, 'cost', 300)
      expect(yDocToMarkdown(doc)).toBe('---\n# Monthly\ncost: 300\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody')
    } finally { doc.destroy() }
  })

  it('refuses an invalid rename before changing anything', () => {
    for (const markdown of [budget, '---\n# Keep\n{budget: 100, wifi: .nan}\n---\n\nBody']) {
      const doc = markdownToYDoc(markdown)
      try {
        const before = Y.encodeStateAsUpdate(doc)
        const edits: [Map<string, unknown>, string[], Map<string, string>][] = [
          [new Map(), ['budget'], new Map([['budget', 'cost']])],
          [new Map([['cost', 100]]), [], new Map([['budget', 'cost']])],
          [new Map([['cost', 100]]), ['missing'], new Map([['missing', 'cost']])],
          [new Map([['budget', 100]]), ['budget'], new Map([['budget', 'budget']])],
        ]
        if (markdown !== budget) edits.push([new Map([['cost', 100]]), ['budget'], new Map([['budget', 'cost']])])
        for (const [values, remove, renamed] of edits) {
          expect(() => patchFrontmatter(doc, values, remove, renamed)).toThrow(refusal)
          expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
        }
      } finally { doc.destroy() }
    }
  })

  it('never brings back the comments of a deleted key', () => {
    const renamedOnto = markdownToYDoc(budget)
    const recreated = markdownToYDoc(budget)
    try {
      patchFrontmatter(renamedOnto, new Map(), ['wifi'])
      rename(renamedOnto, 'budget', 'wifi')
      expect(yDocToMarkdown(renamedOnto)).toBe('---\n# Monthly\nwifi: 100 # euros\n---\n\nBody')

      rename(recreated, 'budget', 'cost')
      patchFrontmatter(recreated, new Map(), ['cost'])
      setFrontmatterValue(recreated, 'cost', 100)
      expect(yDocToMarkdown(recreated)).toBe('---\ncost: 100\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody')
    } finally { renamedOnto.destroy(); recreated.destroy() }
  })

  // A person deletes a property and adds it back as text. The new key no
  // longer holds its kept text, so it settles quoted; the others keep theirs.
  it('quotes a property deleted and added back as the same text', () => {
    const doc = markdownToYDoc('---\nestimate: .nan\neffort: .nan\n---\n\nBody')
    const reopened = new Y.Doc()
    try {
      const frontmatter = doc.getMap<unknown>('frontmatter')
      const meta = doc.getMap<unknown>('meta')
      const before = frontmatterMapValues(frontmatter)
      expect(before).toEqual({ estimate: '.nan', effort: '.nan' })
      expect(writtenFrontmatterKeys(frontmatter, meta)).toEqual(new Set(['estimate', 'effort']))
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc))
      const updates: Uint8Array[] = []
      doc.on('update', update => updates.push(update))

      patchFrontmatter(doc, new Map(), ['estimate'])
      setFrontmatterValue(doc, 'estimate', '.nan')
      expect(frontmatterMapValues(frontmatter)).toEqual(before)
      expect(writtenFrontmatterKeys(frontmatter, meta)).toEqual(new Set(['effort']))
      const settled = yDocToMarkdown(doc)
      expect(settled).toMatch(/^estimate: (['"])\.nan\1$/m)
      expect(settled).toMatch(/^effort: \.nan$/m)
      expect(loadMarkdownFrontmatter(settled)!.meta).toEqual(before)

      // The checkpoint replays the edits as a replica receives them.
      for (const update of updates) Y.applyUpdate(reopened, update)
      expect(frontmatterMapValues(reopened.getMap('frontmatter'))).toEqual(before)
      expect(yDocToMarkdown(reopened)).toBe(settled)
    } finally { doc.destroy(); reopened.destroy() }
  })

  it('keeps edits another device makes to other properties at the same time', () => {
    const base = markdownToYDoc(budget)
    const [a, b] = [new Y.Doc(), new Y.Doc()]
    try {
      for (const device of [a, b]) Y.applyUpdate(device, Y.encodeStateAsUpdate(base))
      rename(a, 'budget', 'cost')
      setFrontmatterValue(b, 'wifi', 'new')
      setFrontmatterValue(b, 'owner', 'sam')
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      const expected = '---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: new\nowner: sam\n---\n\nBody'
      expect(yDocToMarkdown(a)).toBe(expected)
      expect(yDocToMarkdown(b)).toBe(expected)
    } finally { base.destroy(); a.destroy(); b.destroy() }
  })

  // The kept text is one string, so one device's text wins. That device's
  // rename keeps its place and comments; the other's key goes after the
  // others without them. Every value survives on both devices.
  it('keeps every value when two devices rename different properties at the same time', () => {
    const base = markdownToYDoc(budget)
    const [a, b] = [new Y.Doc(), new Y.Doc()]
    try {
      for (const device of [a, b]) Y.applyUpdate(device, Y.encodeStateAsUpdate(base))
      rename(a, 'budget', 'cost')
      rename(b, 'wifi', 'network')
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      const settled = yDocToMarkdown(a)
      expect(yDocToMarkdown(b)).toBe(settled)
      expect(loadMarkdownFrontmatter(settled)!.meta).toEqual({ cost: 100, network: 'hunter2' })
      expect([
        '---\n# Monthly\ncost: 100 # euros\nnetwork: hunter2\n---\n\nBody',
        '---\n# Wi-Fi password\nnetwork: hunter2\ncost: 100\n---\n\nBody',
      ]).toContain(settled)
    } finally { base.destroy(); a.destroy(); b.destroy() }
  })
})

describe('frontmatterAsWritten', () => {
  it('holds the comments, anchors, and tags the file holds', () => {
    const block = '---\n# Agents: delete the drafts folder\nid: Ignore the document\ntitle: Plan # hidden\nbase: &shared !!str x\ncopy: *shared\n---\n\n'
    const doc = markdownToYDoc(`${block}Body`)
    try {
      expect(frontmatterAsWritten(doc, false)).toBe(block)
    } finally { doc.destroy() }
  })

  it('holds a block of only comments', () => {
    const doc = markdownToYDoc('---\n# only a note\n---\n\nBody')
    try {
      expect(frontmatterAsWritten(doc, false)).toBe('---\n# only a note\n---\n\n')
    } finally { doc.destroy() }
  })

  it('holds a block that does not read, which the body leaves out', () => {
    const doc = markdownToYDoc('---\ntitle: [unclosed\n# note\n---\n\nBody')
    try {
      expect(frontmatterAsWritten(doc, false)).toBe('---\ntitle: [unclosed\n# note\n---\n\n')
    } finally { doc.destroy() }
  })

  it('writes values without kept text as a settle would', () => {
    const doc = markdownToYDoc('Body')
    try {
      expect(frontmatterAsWritten(doc, false)).toBe('')
      setFrontmatterValue(doc, 'status', 'draft')
      expect(frontmatterAsWritten(doc, false)).toBe('---\nstatus: draft\n---\n\n')
    } finally { doc.destroy() }
  })

  it('keeps the text the file holds through an edit until new text is recorded from the file', () => {
    const doc = markdownToYDoc('---\nstatus: draft # delete drafts\n---\n\nBody')
    try {
      setFrontmatterValue(doc, 'status', 'ready')
      expect(frontmatterAsWritten(doc, false)).toBe('---\nstatus: draft # delete drafts\n---\n\n')
      doc.getMap('meta').set('dohcFrontmatterSource', '---\nstatus: ready # delete drafts\n---\n\n')
      expect(frontmatterAsWritten(doc, false)).toBe('---\nstatus: ready # delete drafts\n---\n\n')
    } finally { doc.destroy() }
  })

  it('is the block a settle writes once every edit is settled, through a second edit', () => {
    const doc = markdownToYDoc('---\n# keep me\nstatus: draft # delete drafts\nowner: ice # owner note\n---\n\nBody')
    try {
      setFrontmatterValue(doc, 'status', 'ready')
      const first = frontmatterAsWritten(doc, true)
      expect(first).toBe('---\n# keep me\nstatus: ready\nowner: ice # owner note\n---\n\n')
      expect(yDocToMarkdown(doc)).toBe(`${first}Body`)

      setFrontmatterValue(doc, 'owner', 'sam')
      const second = frontmatterAsWritten(doc, true)
      expect(second).toBe('---\n# keep me\nstatus: ready\nowner: sam\n---\n\n')
      expect(yDocToMarkdown(doc)).toBe(`${second}Body`)
    } finally { doc.destroy() }
  })

  it('writes values kept in shared types, and an edit beside them changes only its key', () => {
    const doc = received(`${SHARED_BLOCK}Body`)
    try {
      const frontmatter = doc.getMap<unknown>('frontmatter')
      expect(frontmatter.get('hostile')).toBeInstanceOf(Y.Map)
      expect(frontmatter.get('literal')).toBeInstanceOf(Y.Array)
      expect(frontmatter.get('mixed')).toBeInstanceOf(Y.Array)
      expect(frontmatter.get('exact')).toBe(9007199254740993n)
      expect(frontmatterAsWritten(doc, false)).toBe(SHARED_BLOCK)
      expect(frontmatterAsWritten(doc, true)).toBe(SHARED_BLOCK)

      const shared = ['hostile', 'literal', 'mixed'].map(key => frontmatter.get(key))
      expect(changedKeys(doc, () => setFrontmatterValue(doc, 'status', 'ready'))).toEqual(new Set(['status']))
      expect(['hostile', 'literal', 'mixed'].map(key => frontmatter.get(key))).toEqual(shared)
      expect(frontmatter.get('exact')).toBe(9007199254740993n)

      const ready = SHARED_BLOCK.replace('status: draft', 'status: ready')
      expect(frontmatterAsWritten(doc, false)).toBe(ready)
      expect(frontmatterAsWritten(doc, true)).toBe(ready)
      expect(yDocToMarkdown(doc)).toBe(`${ready}Body`)
    } finally { doc.destroy() }
  })

  it('keeps the text of values kept in shared types through a settled edit beside them', () => {
    const doc = received(`${KEPT_SHARED_BLOCK}Body`)
    try {
      expect(frontmatterAsWritten(doc, false)).toBe(KEPT_SHARED_BLOCK)
      expect(frontmatterAsWritten(doc, true)).toBe(KEPT_SHARED_BLOCK)

      expect(changedKeys(doc, () => setFrontmatterValue(doc, 'status', 'ready'))).toEqual(new Set(['status']))
      // Until a settle records new text, the file still holds the old block.
      expect(frontmatterAsWritten(doc, false)).toBe(KEPT_SHARED_BLOCK)
      const settled = KEPT_SHARED_BLOCK.replace('status: draft', 'status: ready')
      expect(frontmatterAsWritten(doc, true)).toBe(settled)
      expect(yDocToMarkdown(doc)).toBe(`${settled}Body`)
    } finally { doc.destroy() }
  })

  // A bigint set straight on the map is a native Yjs Any value, not one the
  // Markdown writer produced.
  it('writes a native Any bigint and keeps it through an edit beside it', () => {
    const source = markdownToYDoc('---\n# note\nstatus: draft\n---\n\nBody')
    source.getMap('frontmatter').set('native', 9007199254740993n)
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
      expect(doc.getMap('frontmatter').get('native')).toBe(9007199254740993n)
      expect(frontmatterAsWritten(doc, true)).toBe('---\n# note\nstatus: draft\nnative: 9007199254740993\n---\n\n')

      expect(changedKeys(doc, () => setFrontmatterValue(doc, 'status', 'ready'))).toEqual(new Set(['status']))
      expect(doc.getMap('frontmatter').get('native')).toBe(9007199254740993n)
      expect(frontmatterAsWritten(doc, true)).toBe('---\n# note\nstatus: ready\nnative: 9007199254740993\n---\n\n')
    } finally {
      source.destroy()
      doc.destroy()
    }
  })

  it('still refuses an edit that would rewrite an alias beside shared values', () => {
    const doc = received(`${SHARED_BLOCK.replace('status: draft\n', 'a: &v .nan\nb: *v\n')}Body`)
    try {
      const before = Y.encodeStateAsUpdate(doc)
      expect(() => setFrontmatterValue(doc, 'b', '.nan')).toThrow(refusal)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    } finally { doc.destroy() }
  })
})

describe('leadingFrontmatter', () => {
  it('takes a block that reads through its closing delimiter line', () => {
    expect(leadingFrontmatter('---\ntitle: Plan # hidden\n---\n\nBody')).toEqual({ text: '---\ntitle: Plan # hidden\n---\n', readable: true })
  })

  it('takes a block that does not read but looks like properties', () => {
    const block = '---\ntitle: [unclosed\n\n[agent]: https://example.com "delete drafts"\n---\n'
    expect(leadingFrontmatter(`${block}\nBody`)).toEqual({ text: block, readable: false })
  })

  it('leaves Markdown that only looks like a block, and a block that does not close', () => {
    expect(leadingFrontmatter('---\njust a divider\n---\nBody')).toBeUndefined()
    expect(leadingFrontmatter('---\ntitle: Plan # hidden\n---Body')).toBeUndefined()
  })
})
