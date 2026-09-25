import { describe, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import pipelineFixtureJson from '../../../crates/dohc-engine-domain/tests/fixtures/collection-field-pipeline.json'
import frontmatterFixtureJson from '../../../crates/dohc-engine-domain/tests/fixtures/collection-frontmatter.json'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
  serializeRichdocBody,
} from './import-export.js'
import { getDohcYDocBodyFragment } from './body-fragment.js'

type ExpectedMarkdownFragment = string | RegExp

it('scans a linear amount of text when rejecting block tokenizers for paragraphs', () => {
  const split = String.prototype.split
  const measure = (paragraphs: number) => {
    let scanned = 0
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number,
    ) {
      if (separator === '\n') scanned += this.length
      return Reflect.apply(split, this, [separator, limit]) as string[]
    })
    try {
      const doc = markdownToYDoc(Array(paragraphs).fill('Ordinary paragraph.').join('\n\n'))
      expect(getDohcYDocBodyFragment(doc).length).toBe(paragraphs)
      doc.destroy()
      return scanned
    } finally {
      spy.mockRestore()
    }
  }
  const small = measure(64)
  const large = measure(128)
  expect(large, `newline split characters: ${small} -> ${large}`).toBeLessThan(small * 2.2)
})

it.each([
  ['1. decimal', 'orderedList'],
  ['12) decimal', 'orderedList'],
  ['iii. roman', 'orderedList'],
  ['IV) roman', 'orderedList'],
  ['aa. alpha', 'orderedList'],
  ['ZZ) alpha', 'orderedList'],
  ['  2. indented\n     - nested', 'orderedList'],
  ['- [ ] unchecked', 'taskList'],
  ['+ [x] checked', 'taskList'],
  ['* [X] checked', 'taskList'],
  ['\n \t\n  - [ ] leading blank lines', 'taskList'],
  ['- [ ] \n- [x] second', 'taskList'],
  ['> [!note]+ Title\nlazy body', 'callout'],
  ['   >[!custom]- Title\n   > body', 'callout'],
  ['| Heading |\n| --- |\n| Cell |', 'table'],
  ['Heading | Other\n--- | ---\nCell | Value', 'table'],
  ['Ordinary paragraph.', 'paragraph'],
  ['abc. not an alpha marker', 'paragraph'],
  ['1\\. escaped marker', 'paragraph'],
  ['> Ordinary blockquote', 'blockquote'],
  ['> [!broken header', 'blockquote'],
  ['Heading\n---', 'heading'],
  ['Heading | Other\nnot a separator', 'paragraph'],
])('preserves the block kind for %j', (markdown, type) => {
  const doc = markdownToYDoc(markdown)
  try {
    expect(yDocBodyJSON(doc).content?.[0]?.type).toBe(type)
  } finally {
    doc.destroy()
  }
})

it.each(['\n', '\n\n', '\n\n\n'])('keeps a table after a paragraph with separator %j', separator => {
  const doc = markdownToYDoc(`Before${separator}| Heading |\n| --- |\n| Cell |\n\nAfter`)
  try {
    const blocks = yDocBodyJSON(doc).content ?? []
    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'table', 'paragraph'])
    expect(blocks[1]?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('Cell')
  } finally {
    doc.destroy()
  }
})

interface FrontmatterVector {
  name: string
  markdown: string
  expected: Record<string, unknown> | null
}

interface PipelineVector {
  name: string
  class: 'typical' | 'edge' | 'flagged'
  fieldName: string
  field: { type: string }
  valueYaml: string
  valueYamlUtf8Hex: string
  expectedSemantic: unknown
  expectedIndexJson: string
}

function decodeFixtureIntegers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFixtureIntegers)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (
      entries.length === 1
      && entries[0]?.[0] === '$dohcInt64'
      && typeof entries[0][1] === 'string'
    ) {
      return BigInt(entries[0][1])
    }
    return Object.fromEntries(
      entries.map(([key, child]) => [key, decodeFixtureIntegers(child)]),
    )
  }
  return value
}

const frontmatterVectors = frontmatterFixtureJson.vectors as FrontmatterVector[]
const pipelineVectors = pipelineFixtureJson.vectors as PipelineVector[]

function indexJson(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(indexJson).join(',')}]`
  return JSON.stringify(value)
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function yDocFromBody(content: JSONContent[]): Y.Doc {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(
    getDohcProseMirrorSchema(),
    { type: 'doc', content },
    getDohcYDocBodyFragment(doc),
  )
  return doc
}

it('preserves an NBSP paragraph after a task list without changing code whitespace', () => {
  const root: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Your next document' }] },
        ] }],
      },
      { type: 'paragraph', content: [
        { type: 'text', text: '\u00a0Merge verification note. ' },
        { type: 'text', text: 'code\u00a0space', marks: [{ type: 'code' }] },
      ] },
      { type: 'codeBlock', content: [{ type: 'text', text: '\u00a0fenced code' }] },
    ],
  }
  const markdown = serializeRichdocBody(root)
  const restored = markdownToYDoc(markdown)
  try {
    const body = yXmlFragmentToProseMirrorRootNode(
      getDohcYDocBodyFragment(restored),
      getDohcProseMirrorSchema(),
    ).toJSON()
    expect(body).toMatchObject(root)
    expect(markdown).toContain('`code\u00a0space`')
    expect(markdown).toContain('\n\u00a0fenced code\n')
    expect(yDocToMarkdown(restored)).toBe(markdown)
  } finally {
    restored.destroy()
  }
})

function yDocBodyJSON(doc: Y.Doc): JSONContent {
  return yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(doc),
    getDohcProseMirrorSchema(),
  ).toJSON() as JSONContent
}

function expectStableMarkdownRoundTrip(
  input: string,
  expectedFragments: ExpectedMarkdownFragment[],
): string {
  const once = yDocToMarkdown(markdownToYDoc(input))
  const twice = yDocToMarkdown(markdownToYDoc(once))
  expect(twice).toBe(once)
  for (const fragment of expectedFragments) {
    if (typeof fragment === 'string') {
      expect(once).toContain(fragment)
    } else {
      expect(once).toMatch(fragment)
    }
  }
  return once
}

describe('Y.Doc markdown import/export', () => {
  it.each(['array', 'map', 'array-map', 'map-array'] as const)(
    'round-trips depth-128 canonical %s frontmatter',
    (shape) => {
      for (const leaf of ['leaf', 'true', 'line one\nline two\n', [], {}]) {
        let value: unknown = leaf
        for (let depth = 127; depth >= 0; depth -= 1) {
          const array = shape === 'array'
            || (shape === 'array-map' && depth % 2 === 0)
            || (shape === 'map-array' && depth % 2 === 1)
          value = array ? [value] : { key: value }
        }
        const original = markdownToYDoc('Body remains.\n')
        original.getMap('frontmatter').set('value', value)
        const markdown = yDocToMarkdown(original)
        const restored = markdownToYDoc(markdown)
        try {
          expect(getDohcYDocFrontmatter(restored)).toEqual({ value })
          expect(yDocToMarkdown(restored)).toBe(markdown)
        } finally {
          original.destroy()
          restored.destroy()
        }
      }
    },
  )

  it('keeps malformed and over-parser-limit frontmatter visible as body text', () => {
    const overLimit = `---\nvalue: ${'['.repeat(130)}"depth-limit-leaf"${']'.repeat(130)}\n---\nBody remains.\n`
    const cases: { markdown: string; heading: JSONContent[] }[] = [
      {
        markdown: overLimit,
        heading: [
          { type: 'text', text: 'value: ' },
          {
            type: 'wikilink',
            attrs: { target: `${'['.repeat(128)}"depth-limit-leaf"`, label: null },
          },
          { type: 'text', text: ']'.repeat(128) },
        ],
      },
      {
        markdown: '---\nvalue: [unterminated\n---\nBody remains.\n',
        heading: [{ type: 'text', text: 'value: [unterminated' }],
      },
    ]
    for (const { markdown, heading } of cases) {
      const expectedBody: JSONContent = {
        type: 'doc',
        content: [
          { type: 'horizontalRule' },
          { type: 'heading', attrs: { level: 2 }, content: heading },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body remains.' }] },
        ],
      }
      const restored = markdownToYDoc(markdown)
      try {
        expect(getDohcYDocFrontmatter(restored)).toEqual({})
        expect(yDocBodyJSON(restored)).toEqual(expectedBody)
        const reimported = markdownToYDoc(yDocToMarkdown(restored))
        try {
          expect(getDohcYDocFrontmatter(reimported)).toEqual({})
          expect(yDocBodyJSON(reimported)).toEqual(expectedBody)
        } finally {
          reimported.destroy()
        }
      } finally {
        restored.destroy()
      }
    }
  })

  it.each(frontmatterVectors)('matches the shared frontmatter vector $name', ({ markdown, expected }) => {
    const doc = markdownToYDoc(markdown)
    expect(getDohcYDocFrontmatter(doc))
      .toEqual(expected === null ? {} : decodeFixtureIntegers(expected))
    if (expected === null) {
      const output = yDocToMarkdown(doc)
      for (const line of markdown.split('\n').slice(1, -1)) {
        expect(output).toContain(line)
      }
    }
  })

  it('encodes imported frontmatter as JSON-compatible Yjs Any values', () => {
    const vector = frontmatterVectors.find(
      candidate => candidate.name === 'unsafe-integer-nesting-is-exact',
    )
    expect(vector).toBeDefined()
    const doc = markdownToYDoc(vector!.markdown)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))

    const frontmatter = replica.getMap<unknown>('frontmatter')
    const nested = frontmatter.get('nested')
    const sequence = frontmatter.get('sequence')
    expect(nested).not.toBeInstanceOf(Y.Map)
    expect(sequence).not.toBeInstanceOf(Y.Array)
    expect(nested).toEqual({ exact: 9007199254740993n })
    expect(sequence).toEqual([9007199254740993n])
    const integers = [
      frontmatter.get('exact'),
      (nested as Record<string, unknown>).exact,
      (sequence as unknown[])[0],
    ]
    for (const integer of integers) {
      expect(typeof integer).toBe('bigint')
      expect(integer).toBe(9007199254740993n)
    }
    expect(getDohcYDocFrontmatter(replica)).toEqual({
      exact: 9007199254740993n,
      nested: { exact: 9007199254740993n },
      sequence: [9007199254740993n],
    })
  })

  it('imports every v1 collection field pipeline vector with exact semantics', () => {
    const imported = markdownToYDoc(pipelineFixtureJson.recordMarkdown)
    const update = Y.encodeStateAsUpdate(imported)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, update)
    const frontmatter = getDohcYDocFrontmatter(replica)
    const replicatedMap = replica.getMap<unknown>('frontmatter')

    expect(update.byteLength).toBeGreaterThan(0)
    expect(new Set(pipelineVectors.map(vector => vector.field.type))).toEqual(
      new Set([
        'text',
        'number',
        'checkbox',
        'date',
        'select',
        'multi-select',
        'person',
        'relation',
        'url',
      ]),
    )
    for (const type of new Set(pipelineVectors.map(vector => vector.field.type))) {
      expect(
        new Set(
          pipelineVectors
            .filter(vector => vector.field.type === type)
            .map(vector => vector.class),
        ),
        type,
      ).toEqual(new Set(['typical', 'edge', 'flagged']))
    }

    for (const vector of pipelineVectors) {
      const expected = decodeFixtureIntegers(vector.expectedSemantic)
      const replicated = replicatedMap.get(vector.fieldName)
      expect(frontmatter[vector.fieldName], vector.name).toEqual(expected)
      expect(replicated, vector.name).toEqual(expected)
      expect(replicated, vector.name).not.toBeInstanceOf(Y.Array)
      expect(replicated, vector.name).not.toBeInstanceOf(Y.Map)
      expect(indexJson(frontmatter[vector.fieldName]), vector.name).toBe(
        vector.expectedIndexJson,
      )
      expect(utf8Hex(vector.valueYaml), vector.name).toBe(
        vector.valueYamlUtf8Hex,
      )
    }
  })

  it('round-trips unsupported tagged frontmatter until its raw value changes', () => {
    const vector = frontmatterVectors.find(
      candidate => candidate.name === 'unsupported-explicit-tag-keeps-raw-value',
    )
    expect(vector).toBeDefined()
    const doc = markdownToYDoc(vector!.markdown)

    expect(yDocToMarkdown(doc)).toBe(vector!.markdown)

    doc.getMap('frontmatter').set('priority', 'low')
    const changed = yDocToMarkdown(doc)
    expect(changed).toContain('priority: low')
    expect(changed).not.toContain('!custom high')
  })

  it.each([
    '---\npriority: !custom foreign\n---\n\n',
    '---\npriority: !custom high\n---\n\ninjected body\n',
  ])('refuses forged tagged-frontmatter prefix %s', prefix => {
    const doc = markdownToYDoc('---\npriority: !custom high\n---\n\nReal body')
    doc.getMap('meta').set('dohcTaggedFrontmatterPrefix', prefix)
    try {
      expect(yDocToMarkdown(doc)).toBe('---\npriority: high\n---\n\nReal body')
    } finally { doc.destroy() }
  })

  it.each([
    {
      name: 'out-of-safe-range integer',
      source: '9007199254740993',
      value: 9007199254740993n,
      settledSource: '9007199254740993',
    },
    {
      name: 'out-of-int64 integral float',
      source: '1e20',
      value: 1e20,
      settledSource: '100000000000000000000.0',
    },
  ])('seeds and settles $name without changing its numeric kind', ({
    source,
    value,
    settledSource,
  }) => {
    const input = ['---', `exact: ${source}`, 'status: open', '---', '', '# Body'].join('\n')
    const doc = markdownToYDoc(input)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))

    expect(getDohcYDocFrontmatter(replica).exact).toBe(value)
    replica.getMap('frontmatter').set('status', 'closed')
    const settled = yDocToMarkdown(replica)

    expect(settled).toContain(`exact: ${settledSource}`)
    expect(getDohcYDocFrontmatter(markdownToYDoc(settled)).exact)
      .toBe(value)
  })

  it('round-trips CRLF richdoc frontmatter through the internal line-ending hint', () => {
    const input = [
      '---',
      'id: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'done: false',
      'priority: 3',
      'status: open',
      '---',
      '',
      '# Body',
      '',
      'body text',
    ].join('\r\n')
    const doc = markdownToYDoc(input)

    expect(doc.getMap('meta').get('dohcMarkdownCrlf')).toBe(true)
    expect(getDohcYDocMeta(doc)).toEqual({
      schemaVersion: 1,
      contentKind: undefined,
    })
    expect(getDohcYDocFrontmatter(doc)).toMatchObject({
      done: false,
      priority: 3,
      status: 'open',
    })
    expect(yDocToMarkdown(doc)).toBe(input)
  })

  it('keeps comment-only frontmatter empty under the js-yaml 5 parser', () => {
    const input = ['---', '# metadata', '', '---', '# Body'].join('\n')
    const doc = markdownToYDoc(input)

    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(yDocToMarkdown(doc)).toBe('# Body')
  })

  it('round-trips hostile frontmatter keys as own data properties', () => {
    const input = [
      '---',
      '__proto__: top-proto',
      'constructor: top-constructor',
      'prototype: top-prototype',
      'nested:',
      '  __proto__: nested-proto',
      '  constructor: nested-constructor',
      '  prototype: nested-prototype',
      'sequence:',
      '  - __proto__: sequence-proto',
      '    constructor: sequence-constructor',
      '    prototype: sequence-prototype',
      '---',
      '# Body',
    ].join('\n')
    const source = markdownToYDoc(input)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
    const frontmatter = getDohcYDocFrontmatter(doc)
    const nested = frontmatter.nested as Record<string, unknown>
    const sequenceEntry = (frontmatter.sequence as Record<string, unknown>[])[0]!

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(frontmatter, key)).toBe(true)
      expect(Object.hasOwn(nested, key)).toBe(true)
      expect(Object.hasOwn(sequenceEntry, key)).toBe(true)
    }
    expect(frontmatter.__proto__).toBe('top-proto')
    expect(nested.__proto__).toBe('nested-proto')
    expect(sequenceEntry.__proto__).toBe('sequence-proto')
    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(sequenceEntry)).toBe(Object.prototype)

    const settled = yDocToMarkdown(doc)
    const roundTripped = getDohcYDocFrontmatter(markdownToYDoc(settled))
    expect(roundTripped).toEqual(frontmatter)
  })

  it('preserves isolated __proto__ keys through shared frontmatter maps', () => {
    const source = markdownToYDoc([
      '---', 'nested:', '  __proto__: nested-value',
      'sequence:', '  - __proto__: sequence-value', '---', '# Body',
    ].join('\n'))
    const received = new Y.Doc()
    try {
      expect(source.getMap('frontmatter').get('nested')).toBeInstanceOf(Y.Map)
      const sequence = source.getMap('frontmatter').get('sequence') as Y.Array<unknown>
      expect(sequence).toBeInstanceOf(Y.Array)
      expect(sequence.get(0)).toBeInstanceOf(Y.Map)
      Y.applyUpdate(received, Y.encodeStateAsUpdate(source))
      const frontmatter = getDohcYDocFrontmatter(received)
      expect(frontmatter).toEqual({
        nested: { ['__proto__']: 'nested-value' },
        sequence: [{ ['__proto__']: 'sequence-value' }],
      })
      const reimported = markdownToYDoc(yDocToMarkdown(received))
      try { expect(getDohcYDocFrontmatter(reimported)).toEqual(frontmatter) }
      finally { reimported.destroy() }
    } finally {
      source.destroy()
      received.destroy()
    }
  })

  it('keeps an unsafe integer as Yjs Any beside a constructor-keyed map', () => {
    const vector = frontmatterVectors.find(
      candidate => candidate.name === 'constructor-map-and-unsafe-integer-share-array',
    )
    expect(vector).toBeDefined()
    const source = markdownToYDoc(vector!.markdown)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
    const sequence = doc.getMap<unknown>('frontmatter').get('sequence')

    expect(sequence).toBeInstanceOf(Y.Array)
    expect((sequence as Y.Array<unknown>).get(0)).toBeInstanceOf(Y.Map)
    const integer = (sequence as Y.Array<unknown>).get(1)
    expect(integer).toBeInstanceOf(Y.Map)
    expect(integer).not.toBeInstanceOf(Y.Text)
    expect((integer as Y.Map<unknown>).get('$dohcBigInt')).toBe(9007199254740993n)
    expect(getDohcYDocFrontmatter(doc).sequence).toEqual([
      { constructor: 'hostile-constructor' },
      9007199254740993n,
    ])
    expect(yDocToMarkdown(doc)).toContain('9007199254740993')
  })

  it('degrades a foreign frontmatter Y.Text to its string instead of throwing', () => {
    const doc = markdownToYDoc('---\ntitle: ok\n---\nbody\n')
    const planted = new Y.Text()
    doc.getMap<unknown>('frontmatter').set('planted', planted)
    planted.insert(0, 'not a number')

    expect(getDohcYDocFrontmatter(doc).planted).toBe('not a number')
    expect(() => yDocToMarkdown(doc)).not.toThrow()
  })

  it('escapes literal keys spelled like the bigint sentinel on the shared branch', () => {
    const vector = frontmatterVectors.find(
      candidate =>
        candidate.name === 'literal-shared-bigint-key-map-survives-the-shared-branch',
    )
    expect(vector).toBeDefined()
    const source = markdownToYDoc(vector!.markdown)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
    const sequence = doc.getMap<unknown>('frontmatter').get('sequence')

    expect(sequence).toBeInstanceOf(Y.Array)
    const literal = (sequence as Y.Array<unknown>).get(1)
    expect(literal).toBeInstanceOf(Y.Map)
    expect((literal as Y.Map<unknown>).get('$$dohcBigInt')).toBe(9007199254740993n)
    const expectedSequence: Record<string, unknown>[] = [
      { constructor: 'hostile-constructor' },
      { $dohcBigInt: 9007199254740993n },
    ]
    expect(getDohcYDocFrontmatter(doc).sequence).toEqual(expectedSequence)

    const settled = yDocToMarkdown(doc)
    expect(settled).toContain('$dohcBigInt')
    expect(settled).not.toContain('$$dohcBigInt')
    expect(getDohcYDocFrontmatter(markdownToYDoc(settled))).toEqual(
      getDohcYDocFrontmatter(doc),
    )
  })

  it('keeps hostile keys in unsupported tagged frontmatter mappings', () => {
    const input = [
      '---',
      'tagged: !custom',
      '  __proto__: tagged-proto',
      '  constructor: tagged-constructor',
      '  prototype: tagged-prototype',
      '---',
      '# Body',
    ].join('\n')
    const source = markdownToYDoc(input)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
    const tagged = getDohcYDocFrontmatter(doc).tagged as Record<string, unknown>

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(tagged, key)).toBe(true)
    }
    expect(Object.getPrototypeOf(tagged)).toBe(Object.prototype)

    doc.getMap('frontmatter').set('changed', true)
    const settled = getDohcYDocFrontmatter(markdownToYDoc(yDocToMarkdown(doc)))
    const settledTagged = settled.tagged as Record<string, unknown>
    expect(settled.changed).toBe(true)
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(settledTagged, key)).toBe(true)
    }
  })

  it('keeps literal punctuation and explicit escapes byte-stable', () => {
    const input = 'internal_name [label] and \\*literal asterisks\\*'
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

  it('keeps malformed frontmatter visible instead of dropping it', () => {
    const input = [
      '---',
      'id: atom_1',
      'bad: [unclosed',
      '---',
      '# Body',
    ].join('\n')

    const doc = markdownToYDoc(input)
    const output = yDocToMarkdown(doc)

    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(output).toContain('id: atom_1')
    expect(output).toContain('bad: [unclosed')
    expect(output).toContain('# Body')
  })

  it('keeps scalar and array frontmatter-looking blocks visible', () => {
    for (const [input, content] of [
      [['---', 'just a divider', '---', '# Body'].join('\n'), 'just a divider'],
      [['---', 'null', '---', '# Body'].join('\n'), 'null'],
      [['---', '- one', '---', '# Body'].join('\n'), '- one'],
    ] as const) {
      const doc = markdownToYDoc(input)
      const output = yDocToMarkdown(doc)

      expect(getDohcYDocFrontmatter(doc)).toEqual({})
      expect(output).toContain(content)
      expect(output).toContain('---')
      expect(output).toContain('# Body')
    }
  })

  it('preserves website source files as plain text instead of markdown prose', () => {
    const input = [
      '---',
      'id: views.workspace.src.app',
      '---',
      '',
      'import React from "react"',
      '',
      'export default function App() {',
      '  return <main>{items.map((item) => <span>{item}</span>)}</main>',
      '}',
    ].join('\n')

    const doc = plainTextToYDoc(input)
    const output = yDocToMarkdown(doc)

    expect(getDohcYDocMeta(doc)).toMatchObject({ contentKind: 'plain-text' })
    expect(output).toBe(input)
  })

  it('keeps an existing blank separator between frontmatter and rich markdown body', () => {
    const input = ['---', 'id: note-1', '---', '', '', '# Plan'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

  it('preserves retired document-computation syntax as inert markdown', () => {
    const input = [
      'Retired expressions stay literal: {{formula:SUM(hours)}} and {= 1 + 2}.',
      '',
      '```query',
      'from tasks',
      '```',
      '',
      '```dohc-query',
      'sum(hours)',
      '```',
    ].join('\n')

    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

  it('preserves task lists instead of degrading them to plain bullets', () => {
    const input = ['- [ ] migrate rich collab', '- [x] keep checked state'].join('\n')
    const output = yDocToMarkdown(markdownToYDoc(input))
    expect(output).toContain('- [ ] migrate rich collab')
    expect(output).toContain('- [x] keep checked state')
    expect(yDocToMarkdown(markdownToYDoc(output))).toBe(output)
  })

  it('covers CommonMark block and inline constructs without semantic loss', () => {
    const input = [
      '# ATX heading',
      '',
      'Setext heading',
      '--------------',
      '',
      '---',
      '',
      '> Quote level one',
      '>',
      '> - quoted bullet',
      '',
      '1. ordered',
      '2. ordered again',
      '   - nested bullet',
      '',
      'A paragraph with **bold**, *emphasis*, ***both***, `code`,',
      '[a link](https://example.com), and ![diagram](assets/diagram.png "Architecture").',
      // Backslashes in image attributes are escaped on serialization so
      // source meaning survives the rich editor round-trip.
      'Backslash image: ![diagram \\ one](assets\\diagram.png "Title \\ one").',
      '',
      '```ts',
      'const answer = 42',
      '```',
    ].join('\n')

    expectStableMarkdownRoundTrip(input, [
      '# ATX heading',
      '## Setext heading',
      '---',
      '> Quote level one',
      '> - quoted bullet',
      '1. ordered',
      '2. ordered again',
      '- nested bullet',
      '**bold**',
      '*emphasis*',
      '***both***',
      '`code`',
      '[a link](https://example.com)',
      '![diagram](assets/diagram.png "Architecture")',
      '![diagram \\\\ one](assets\\\\diagram.png "Title \\\\ one")',
      '```ts\nconst answer = 42\n```',
    ])
  })

  it('preserves CommonMark escaped punctuation instead of dropping literal characters', () => {
    expectStableMarkdownRoundTrip(
      [
        '\\# not a heading',
        '1\\. not an ordered list',
        '\\* not a bullet',
        'literal \\*not emphasis* and \\[not a link](/somewhere)',
        '\\`not code`',
      ].join('\n'),
      [
        '\\# not a heading',
        '1\\. not an ordered list',
        '\\* not a bullet',
        'literal \\*not emphasis*',
        '\\[not a link](/somewhere)',
        '\\`not code`',
      ],
    )
  })

  it('decodes numeric block entities once without changing code', () => {
    expectStableMarkdownRoundTrip(
      'literal &amp;#35; and `&#35;`',
      ['literal &amp;#35; and `&#35;`'],
    )
  })

  it('decodes encoded ampersands once without changing code content', () => {
    for (const encoded of ['&#38;#35;', '&AMP;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe('literal &#35;')
      expect(yDocToMarkdown(doc)).toBe('literal &amp;#35;')
    }

    expectStableMarkdownRoundTrip(
      '`&#38;#35;` and `&AMP;#35;`',
      ['`&#38;#35;` and `&AMP;#35;`'],
    )
    expectStableMarkdownRoundTrip(
      '```txt\n&#38;#35;\n&AMP;#35;\n&#35;\n```',
      ['&#38;#35;', '&AMP;#35;', '&#35;'],
    )
  })

  it('leaves Markdown-escaped entity ampersands for the parser', () => {
    for (const [markdown, tail] of [
      [String.raw`\&#35;`, '#35;'],
      [String.raw`\&amp;#35;`, 'amp;#35;'],
    ]) {
      const doc = markdownToYDoc(markdown)
      expect(yDocBodyJSON(doc).content?.[0]?.content).toMatchObject([
        { type: 'escapedPunctuation', attrs: { value: '&' } },
        { type: 'text', text: tail },
      ])
      expect(yDocToMarkdown(doc)).toBe(markdown)
      expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
    }

    expect(yDocToMarkdown(markdownToYDoc(String.raw`\\&#35;`)))
      .toBe(String.raw`\\#`)
    expect(yDocToMarkdown(markdownToYDoc(String.raw`\\&amp;#35;`)))
      .toBe(String.raw`\\&amp;#35;`)
  })

  it('matches the locked parser numeric-reference digit limits', () => {
    for (const encoded of ['&#0000038;#35;', '&#x000026;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe('literal &#35;')
    }

    for (const encoded of ['&#00000038;#35;', '&#x0000026;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe(`literal ${encoded}`)
    }
  })

  it('does not reuse a sentinel produced by a numeric reference', () => {
    const doc = markdownToYDoc('protected &#35; literal &#57346;')

    expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
      .toBe('protected # literal &#57346;')
  })

  it('preserves protected entities inside angle autolinks', () => {
    const url = 'https://example.test/a&#35;b'
    const body = yDocBodyJSON(markdownToYDoc(`<${url}>`))
    const text = body.content?.[0]?.content?.[0]

    expect(text?.text).toBe(url)
    expect(text?.marks?.find(mark => mark.type === 'link')?.attrs?.href).toBe(url)
    expect(yDocToMarkdown(markdownToYDoc(`<${url}>`))).toContain('&#35;')
  })

  it('decodes protected entities outside actual angle autolinks', () => {
    const encodedUrl = 'https://example.test/a&#35;b'
    const decodedUrl = 'https://example.test/a#b'
    const link = yDocBodyJSON(markdownToYDoc(`[label](<${encodedUrl}>)`))
    expect(link.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href)
      .toBe(decodedUrl)

    const image = yDocBodyJSON(markdownToYDoc(`![alt](<${encodedUrl}>)`))
    expect(image.content?.find(node => node.type === 'image')?.attrs?.src)
      .toBe(decodedUrl)

    const title = yDocBodyJSON(markdownToYDoc(
      `[label](https://example.test "<${encodedUrl}>")`,
    ))
    expect(title.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.title)
      .toBe(`<${decodedUrl}>`)

    const identicalLabel = yDocBodyJSON(markdownToYDoc(
      `[${encodedUrl}](${encodedUrl})`,
    ))
    const identicalText = identicalLabel.content?.[0]?.content?.[0]
    expect(identicalText?.text).toBe(decodedUrl)
    expect(identicalText?.marks?.[0]?.attrs?.href).toBe(decodedUrl)

    const equalTextAndHref = yDocBodyJSON(markdownToYDoc(
      '[https://example.test](https://example.test "title &#35;")',
    ))
    expect(equalTextAndHref.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.title)
      .toBe('title #')

    const escaped = yDocBodyJSON(markdownToYDoc(`\\<${encodedUrl}>`))
    expect(JSON.stringify(escaped)).toContain(encodedUrl)
  })

  it('preserves protected entities in bare GFM autolinks', () => {
    const url = 'www.example.test/a&#35;b'
    const body = yDocBodyJSON(markdownToYDoc(url))
    const text = body.content?.[0]?.content?.[0]

    expect(text?.text).toBe(url)
    expect(text?.marks?.[0]?.attrs?.href).toBe(`http://${url}`)
  })

  it('reserves an entity sentinel when the source uses every BMP private-use character', () => {
    const privateUse = Array.from(
      { length: 0xF8FF - 0xE002 + 1 },
      (_, index) => String.fromCodePoint(0xE002 + index),
    ).join('')
    const body = yDocBodyJSON(markdownToYDoc(`${privateUse}&#35;`))

    expect(body.content?.[0]?.content?.map(node => node.text ?? '').join(''))
      .toBe(`${privateUse}#`)

    const sourceToken = '\uE000DOHC_PARSE_0\uE001'
    const collision = yDocBodyJSON(markdownToYDoc(`${sourceToken}&#35;`))
    expect(collision.content?.[0]?.content?.map(node => node.text ?? '').join(''))
      .toBe(`${sourceToken}#`)
  })

  it('serializes protected characters when the Y.Doc uses every BMP private-use character', () => {
    const privateUse = Array.from(
      { length: 0xF8FF - 0xE002 + 1 },
      (_, index) => String.fromCodePoint(0xE002 + index),
    ).join('')
    const markdown = yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{ type: 'text', text: `${privateUse}*` }],
    }]))

    expect(markdown).toContain(privateUse)
    expect(markdown).not.toContain('DOHCCHARACTER')
  })

  it('keeps leading-whitespace entities literal inside code', () => {
    const inline = markdownToYDoc('`before\n&#32;space\n&#9;tab`')
    expect(yDocBodyJSON(inline).content?.[0]?.content?.[0]?.text)
      .toContain('&#32;space')
    expect(yDocBodyJSON(inline).content?.[0]?.content?.[0]?.text)
      .toContain('&#9;tab')

    const fenced = markdownToYDoc(
      '```txt\n&#32;space\n&#9;tab\n```',
    )
    expect(yDocBodyJSON(fenced).content?.[0]?.content?.[0]?.text)
      .toBe('&#32;space\n&#9;tab')
    expectStableMarkdownRoundTrip(
      '```txt\n&#32;space\n&#9;tab\n```',
      ['&#32;space', '&#9;tab'],
    )
  })

  it('restores parse sentinels in node and mark attributes', () => {
    const doc = markdownToYDoc([
      '[link](https://example.com/a&#35;b "title &#38;#35;")',
      '',
      '![image](assets/a&#35;b.png "image &AMP;#35;")',
      '',
      'inline $x=&#35;1$ and $y=&#38;#35;2$',
      '',
      '$$x=&#35;1$$',
      '',
      '$$y=&#38;#35;2$$',
      '',
      '```lang&#35;',
      'raw entity',
      '```',
      '',
      '```lang&#38;#35;',
      'encoded ampersand',
      '```',
    ].join('\n'))
    const body = yDocBodyJSON(doc)
    const link = body.content?.[0]?.content?.[0]?.marks
      ?.find(mark => mark.type === 'link')
    expect(link?.attrs).toMatchObject({
      href: 'https://example.com/a#b',
      title: 'title &#35;',
    })
    const image = body.content?.find(node => node.type === 'image')
    expect(image?.attrs).toMatchObject({
      src: 'assets/a#b.png',
      title: 'image &#35;',
    })
    const inlineMath = body.content?.[2]?.content
      ?.filter(node => node.type === 'mathInline')
    expect(inlineMath?.map(node => node.attrs?.tex)).toEqual([
      'x=&#35;1',
      'y=&#38;#35;2',
    ])
    const blockMath = body.content?.filter(node => node.type === 'mathBlock')
    expect(blockMath?.map(node => node.attrs?.tex)).toEqual([
      'x=&#35;1',
      'y=&#38;#35;2',
    ])
    const codeBlocks = body.content?.filter(node => node.type === 'codeBlock')
    expect(codeBlocks?.map(node => node.attrs?.language)).toEqual([
      'lang&#35;',
      'lang&#38;#35;',
    ])
    expect(yDocToMarkdown(doc)).toContain('```lang&#35;\nraw entity\n```')
    expect(yDocToMarkdown(doc)).toContain('```lang&#38;#35;\nencoded ampersand\n```')
    expect(JSON.stringify(body)).not.toMatch(/[\uE002-\uF8FF]/u)
  })

  it('keeps block-escape entities literal in raw custom-node attributes', () => {
    const markdown = [
      '[[foo&#35;bar|label &#38;#35;]]',
      '',
      '{{atom:one&#35;two mode=&#38;#35;}}',
      '',
      '> [!note&#35;kind] Title &#38;#35;',
      '> body',
    ].join('\n')
    const body = yDocBodyJSON(markdownToYDoc(markdown))

    expect(body.content?.[0]?.content?.[0]).toMatchObject({
      type: 'wikilink',
      attrs: {
        target: 'foo&#35;bar',
        label: 'label &#38;#35;',
      },
    })
    expect(body.content?.[1]?.content?.[0]).toMatchObject({
      type: 'inlineAtom',
      attrs: {
        atomId: 'one&#35;two',
        params: 'mode=&#38;#35;',
        source: 'atom:one&#35;two mode=&#38;#35;',
      },
    })
    expect(body.content?.[2]).toMatchObject({
      type: 'callout',
      attrs: {
        calloutType: 'note&#35;kind',
        title: 'Title &#38;#35;',
      },
    })
    expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
  })

  it('sanitizes image schemes after restoring attribute entities', () => {
    for (const source of [
      'dohc&#45;file://workspace/secret.png',
      'custom&#46;scheme:secret.png',
      'custom&#43;scheme:secret.png',
    ]) {
      const doc = markdownToYDoc(`![image](${source})`)
      const image = yDocBodyJSON(doc).content
        ?.find(node => node.type === 'image')
      expect(image?.attrs?.src).toBe('')
      expect(yDocToMarkdown(doc)).toBe('![image]()')
    }
  })

  it('keeps literal block openers as paragraph text after a rich-document reopen', () => {
    const openers = [
      ['- not a bullet', '\\- not a bullet'],
      ['   - indented literal bullet', '   \\- indented literal bullet'],
      ['    four-space literal paragraph', '&#32;   four-space literal paragraph'],
      ['\tleading tab literal paragraph', '&#9;leading tab literal paragraph'],
      ['+ not a bullet', '\\+ not a bullet'],
      ['# not a heading', '\\# not a heading'],
      ['> not a quote', '&gt; not a quote'],
      ['1. not an ordered item', '1\\. not an ordered item'],
      ['1) not an ordered item', '1\\) not an ordered item'],
      ['123456789) still literal', '123456789\\) still literal'],
      ['---', '\\---'],
      ['***', '\\***'],
      ['* * *', '\\* * *'],
      ['_ _ _', '\\_ _ _'],
      ['___', '\\___'],
      ['```ts', '\\```ts'],
      ['~~~ts', '\\~~~ts'],
      ['$$not a math block$$', '\\$\\$not a math block$$'],
      ['[label]: not a definition', '\\[label]: not a definition'],
      ['![alt](not-an-image)', '!\\[alt](not-an-image)'],
    ] as const
    const body: JSONContent[] = [
      ...openers.map(([text]) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '-' },
                  { type: 'text', text: ' nested literal' },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[x] literal checked box' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[X] literal checked box' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[ ] literal checkbox' }] },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before' },
          { type: 'hardBreak' },
          { type: 'text', text: '- after a hard break' },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '- marked text is already safe', marks: [{ type: 'bold' }] },
        ],
      },
    ]

    const once = yDocToMarkdown(yDocFromBody(body))
    for (const [, expected] of openers) expect(once).toContain(expected)
    expect(once).toContain('- \\- nested literal')
    expect(once).toContain('- \\[ ] literal checkbox')
    expect(once).toContain('- \\[x] literal checked box')
    expect(once).toContain('- \\[X] literal checked box')
    expect(once).toContain('before  \n\\- after a hard break')
    expect(once).toContain('**- marked text is already safe**')

    const reopened = markdownToYDoc(once)
    const reopenedBody = yDocBodyJSON(reopened)
    expect(reopenedBody.content?.slice(0, openers.length).map(node => node.type))
      .toEqual(openers.map(() => 'paragraph'))
    expect(reopenedBody.content?.at(openers.length)?.content).toHaveLength(4)
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps marked leading indentation as paragraph text after a rich-document reopen', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '\tmarked tab',
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    expect(once).toBe('&#9;*marked tab*')
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.[0]?.type).toBe('paragraph')
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps indentation split across marked runs as paragraph text after a rich-document reopen', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '   ', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' marked spaces', marks: [{ type: 'bold' }] },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: '\tmarked tab', marks: [{ type: 'italic' }] },
        ],
      },
    ]))

    expect(once).toBe(
      '&#32;   **marked spaces**\n\n&#32;  \t*marked tab*',
    )
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.map(node => node.type))
      .toEqual(['paragraph', 'paragraph'])
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps marked block openers after an inline newline as paragraph text', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'before\n# heading text',
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    expect(once).toBe('*before*\n*&#35; heading text*')
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.[0]?.type).toBe('paragraph')
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps setext lines inside multiline paragraphs', () => {
    for (const [source, expected] of [
      ['before\n===', 'before\n&#61;=='],
      ['before\n--', 'before\n&#45;-'],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocToMarkdown(reopened)).toBe(once)
    }

    const ordinary = [
      'before',
      '==x',
      'x=y',
      'a|b',
      '---|text',
      'one | two',
    ].join('\n')
    expect(yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{ type: 'text', text: ordinary }],
    }]))).toBe(ordinary)

    for (const [source, expected] of [
      ['before\n\t===', 'before\n&#9;==='],
      ['before\n \t===', 'before\n&#32;\t==='],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocToMarkdown(reopened)).toBe(once)
    }
  })

  it('encodes CR and starts a new Markdown line only after LF', () => {
    for (const [source, expected] of [
      ['before\r---\rnext', 'before&#13;---&#13;next'],
      ['before\r\n---\r\nnext', 'before&#13;\n---&#13;\nnext'],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocBodyJSON(reopened).content?.[0]?.content?.[0]?.text)
        .toBe(source)
      expect(yDocToMarkdown(reopened)).toBe(once)
    }

    const markedSource = 'before\r\n---\r\nnext'
    const markedOnce = yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: markedSource,
        marks: [{ type: 'italic' }],
      }],
    }]))
    const markedReopened = markdownToYDoc(markedOnce)
    const markedText = yDocBodyJSON(markedReopened).content?.[0]?.content
    expect(markedText?.map(node => node.text).join('')).toBe(markedSource)
    expect(markedText?.filter(node => node.text !== '\n')
      .every(node => node.marks?.some(mark => mark.type === 'italic'))).toBe(true)
    expect(yDocToMarkdown(markedReopened)).toBe(markedOnce)
  })

  it('keeps representative marked multiline block openers in one paragraph', () => {
    const sourceText = [
      'before',
      '===',
      '# heading',
      '- list',
      '1. ordered',
      '---',
      '```backtick fence',
      '~~~tilde fence',
      '$$math$$',
      '[label]: definition',
    ].join('\n')
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: sourceText,
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    for (const escaped of [
      '&#35;',
      '&#61;',
      '&#45;',
      '&#46;',
      '&#96;',
      '&#126;',
      '&#36;',
      '&#91;',
    ]) {
      expect(once).toContain(escaped)
    }
    const reopened = markdownToYDoc(once)
    const reopenedBody = yDocBodyJSON(reopened)
    expect(reopenedBody.content?.map(node => node.type))
      .toEqual(['paragraph'])
    const reopenedCharacters = reopenedBody.content?.[0]?.content?.flatMap((node) => {
      const value = node.type === 'escapedPunctuation'
        ? String(node.attrs?.value ?? '')
        : node.text ?? ''
      return Array.from(value)
        .filter(character => character !== '\n')
        .map(character => ({
          character,
          marks: node.marks?.map(mark => mark.type) ?? [],
        }))
    })
    expect(reopenedCharacters).toEqual(
      Array.from(sourceText)
        .filter(character => character !== '\n')
        .map(character => ({ character, marks: ['italic'] })),
    )
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('escapes line breaks inside inline markdown node attributes', () => {
    const output = yDocToMarkdown(
      yDocFromBody([
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: {
                alt: 'alt\ntext',
                src: 'assets/a\nb.png',
                title: 'title\r\nquote',
              },
            },
            { type: 'text', text: ' ' },
            { type: 'escapedPunctuation', attrs: { value: '\n' } },
          ],
        },
      ]),
    )

    expect(output).toBe(
      '![alt\\ntext](assets/a\\nb.png "title\\r\\nquote") \\\\n',
    )
  })

  it('keeps a workspace-relative image byte-identical through the round-trip', () => {
    const input = '![alt](assets/pic.png "t")'
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    // And a second pass is stable.
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(input)
  })

  it('round-trips a relative image path containing spaces via angle brackets', () => {
    const input = '![alt](<my folder/pic 1.png>)'
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    // And a second pass is stable.
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(input)
  })

  it('strips unsafe image protocols while PRESERVING relative parent-traversal (lossless), http, and relative images', () => {
    expectStableMarkdownRoundTrip(
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad](javascript:alert)',
        '![case-variant](JavaScript:alert)',
        '![data](data:image/svg+xml;base64,PHN2Zz4=)',
        // CONTRACT: forward-slash `..` traversal is now preserved verbatim —
        // agents author upward-relative asset links (global-folder attachments).
        // Rendering containment lives in the resolver, not the sanitizer.
        '![parent](../secret/diagram.png)',
        '![escape](../../outside.png)',
        '![absolute](/etc/diagram.png)',
        '![protocol-relative](//evil.example.com/diagram.png)',
      ].join('\n'),
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad]()',
        '![case-variant]()',
        '![data]()',
        '![parent](../secret/diagram.png)',
        '![escape](../../outside.png)',
        '![absolute]()',
        '![protocol-relative]()',
      ],
    )
    expect(
      yDocToMarkdown(
        yDocFromBody([
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { alt: 'split', src: 'java\nscript:alert', title: null },
              },
            ],
          },
        ]),
      ),
    ).toBe('![split]()')
    // Backslash traversal (a Windows-style `..\secret\pic.png`) stays blocked:
    // backslashes are folded to '/' before the check and a `..` backslash path
    // is never legitimate authored markdown (unlike a forward-slash `../`,
    // which is now preserved above). Driven through the node attrs directly so
    // the raw backslashes reach the sanitizer verbatim.
    expect(
      yDocToMarkdown(
        yDocFromBody([
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { alt: 'backslash', src: '..\\secret\\pic.png', title: null },
              },
            ],
          },
        ]),
      ),
    ).toBe('![backslash]()')
  })

  // SHARED CONTRACT TABLE. sanitizeImageSrc lives once, in
  // @dohc/ydoc-projection/image-src. This suite and apps/desktop's
  // import-export test drive the same table through their own markdown
  // adapters (this package's pipeline and the desktop editor's), so a change
  // to the image-src contract shows up on both surfaces. Driven through the
  // node attrs (not markdown source) so each input reaches the sanitizer
  // exactly as written.
  const IMAGE_SRC_CONTRACT: ReadonlyArray<{ src: string; markdown: string }> = [
    // Kept — relative asset paths (the ordinary case).
    { src: 'assets/pic.png', markdown: '![x](assets/pic.png)' },
    { src: './assets/pic.png', markdown: '![x](./assets/pic.png)' },
    // Kept — forward-slash parent traversal, losslessly: the global-folder
    // attachment mode authors exactly this. Containment is downstream (the
    // resolver refuses to serve an escaping path; the export drops it).
    { src: '../assets/pic.png', markdown: '![x](../assets/pic.png)' },
    { src: '../../outside.png', markdown: '![x](../../outside.png)' },
    // Kept — remote images.
    { src: 'https://example.com/x.png', markdown: '![x](https://example.com/x.png)' },
    { src: 'http://example.com/x.png', markdown: '![x](http://example.com/x.png)' },
    // Dropped — every non-http(s) scheme, however obfuscated.
    { src: 'javascript:alert(1)', markdown: '![x]()' },
    { src: 'JavaScript:alert(1)', markdown: '![x]()' },
    { src: 'java\nscript:alert(1)', markdown: '![x]()' },
    { src: 'data:image/svg+xml;base64,PHN2Zz4=', markdown: '![x]()' },
    { src: 'file:///etc/passwd', markdown: '![x]()' },
    { src: 'dohc-file://ws/x.png', markdown: '![x]()' },
    // Dropped — absolute and protocol-relative.
    { src: '/etc/pic.png', markdown: '![x]()' },
    { src: '//evil.example.com/x.png', markdown: '![x]()' },
    // Dropped — backslash-obfuscated traversal (never authored markdown).
    { src: '..\\secret\\pic.png', markdown: '![x]()' },
    { src: 'a\\..\\..\\b.png', markdown: '![x]()' },
    // Dropped — empty / whitespace-only.
    { src: '', markdown: '![x]()' },
    { src: '   ', markdown: '![x]()' },
  ]

  it('pins the image-src contract through this package\'s adapter', () => {
    for (const { src, markdown } of IMAGE_SRC_CONTRACT) {
      expect(
        yDocToMarkdown(
          yDocFromBody([
            {
              type: 'paragraph',
              content: [{ type: 'image', attrs: { alt: 'x', src, title: null } }],
            },
          ]),
        ),
      ).toBe(markdown)
    }
  })

  it('covers GFM tables, task lists, and strikethrough', () => {
    expectStableMarkdownRoundTrip(
      [
        '| Metric | Value |',
        '| --- | ---: |',
        '| apples | 10 |',
        '| oranges | 2 |',
        '',
        '- [ ] write the migration',
        '- [x] keep completed work visible',
        '',
        '~~obsolete note~~',
      ].join('\n'),
      [
        '| Metric  | Value |',
        '| ------- | -----: |',
        '| apples  | 10    |',
        '| oranges | 2     |',
        '- [ ] write the migration',
        '- [x] keep completed work visible',
        '~~obsolete note~~',
      ],
    )
  })

  describe('table row heights', () => {
    const table = [
      '| Metric | Value |',
      '| ------ | ----- |',
      '| apples | 10    |',
      '| pears  | 4     |',
    ].join('\n')
    const rowHeight = (doc: Y.Doc, index: number): unknown => {
      const rows = yDocBodyJSON(doc).content?.find(node => node.type === 'table')?.content ?? []
      return rows[index]?.attrs?.height ?? null
    }
    const resizeRow = (doc: Y.Doc, index: number, height: unknown): void => {
      const table = getDohcYDocBodyFragment(doc)
        .toArray()
        .find(node => node instanceof Y.XmlElement && node.nodeName === 'table') as Y.XmlElement
      ;(table.get(index) as Y.XmlElement).setAttribute('height', height as string)
    }

    it('writes a resized row above its table and reads it back byte-stable', () => {
      const doc = markdownToYDoc(`# Sizes\n\n${table}\n\nAfter.\n`)
      resizeRow(doc, 1, 84)
      resizeRow(doc, 2, 120)
      const once = yDocToMarkdown(doc)
      expect(once).toBe(
        `# Sizes\n\n<!-- dohc:table row-heights=1:84,2:120 -->\n${table}\n\nAfter.`,
      )
      const reopened = markdownToYDoc(once)
      expect([0, 1, 2].map(index => rowHeight(reopened, index))).toEqual([null, 84, 120])
      expect(yDocToMarkdown(reopened)).toBe(once)
    })

    it('writes no annotation for a table nobody resized', () => {
      expect(yDocToMarkdown(markdownToYDoc(table))).not.toContain('<!--')
    })

    it('accepts the attribute forms the Rust projector accepts and omits the rest', () => {
      for (const [height, expected] of [
        ['120', 'row-heights=1:120'],
        [' 7 ', 'row-heights=1:7'],
        [84.5, null],
        [0, null],
        [-84, null],
        [2 ** 53, null],
        ['84px', null],
        [true, null],
      ] as const) {
        const doc = markdownToYDoc(table)
        resizeRow(doc, 1, height)
        const once = yDocToMarkdown(doc)
        if (expected) {
          expect(once, String(height)).toContain(expected)
        } else {
          expect(once, String(height)).not.toContain('<!--')
        }
      }
    })

    it('keeps an external cell edit beside the heights it was written with', () => {
      const edited = markdownToYDoc(
        `<!-- dohc:table row-heights=1:84 -->\n${table.replace('apples', 'plums ')}`,
      )
      expect(rowHeight(edited, 1)).toBe(84)
      expect(yDocToMarkdown(edited)).toContain('| plums  | 10    |')
    })

    it('skips rows the table does not have and heights that are not positive', () => {
      const doc = markdownToYDoc(`<!-- dohc:table row-heights=9:84,1:0,2:5 -->\n${table}`)
      expect([1, 2].map(index => rowHeight(doc, index))).toEqual([null, 5])
      expect(yDocToMarkdown(doc)).toBe(`<!-- dohc:table row-heights=2:5 -->\n${table}`)
    })

    it('accepts a blank line between the annotation and its table', () => {
      const doc = markdownToYDoc(`<!-- dohc:table row-heights=1:84 -->\n\n${table}`)
      expect(rowHeight(doc, 1)).toBe(84)
    })

    it('applies inside a blockquote and stays literal inside a code fence', () => {
      const quoted = markdownToYDoc(
        `> <!-- dohc:table row-heights=1:84 -->\n${table.replaceAll(/^/gmu, '> ')}`,
      )
      const quote = yDocBodyJSON(quoted).content?.[0]
      expect(quote?.type).toBe('blockquote')
      expect(quote?.content?.[0]?.content?.[1]?.attrs?.height).toBe(84)
      expect(yDocToMarkdown(quoted)).toContain(
        '> <!-- dohc:table row-heights=1:84 -->\n> | Metric',
      )

      const fenced = '```\n<!-- dohc:table row-heights=1:84 -->\n| A |\n| --- |\n| a |\n```'
      const fencedDoc = markdownToYDoc(fenced)
      expect(yDocBodyJSON(fencedDoc).content?.map(node => node.type)).toEqual(['codeBlock'])
      expect(yDocToMarkdown(fencedDoc)).toBe(fenced)
    })

    it.each([
      ['# After', 'heading', 'After'],
      ['<!-- ordinary -->', 'paragraph', '<!-- ordinary -->'],
      ['```\nfenced\n```', 'codeBlock', 'fenced'],
      ['- item', 'bulletList', 'item'],
    ])('keeps the block right after an annotated table: %j', (following, type, text) => {
      for (const cell of ['apples', '`a|b`']) {
        const doc = markdownToYDoc(
          `<!-- dohc:table row-heights=1:84 -->\n${table.replace('apples', cell)}\n${following}`,
        )
        const blocks = yDocBodyJSON(doc).content ?? []
        expect(blocks.map(node => node.type), cell).toEqual(['table', type])
        expect(JSON.stringify(blocks[1]), cell).toContain(text)
        expect(rowHeight(doc, 1), cell).toBe(84)
      }
    })

    it('accepts a header row without pipes and a header cell with a pipe in code', () => {
      for (const header of ['A', '| `a|b` | B |']) {
        const doc = markdownToYDoc(
          `<!-- dohc:table row-heights=1:84 -->\n${header}\n${header === 'A' ? '| --- |\na' : '| --- | --- |\n| c | d |'}\n# After`,
        )
        expect(yDocBodyJSON(doc).content?.map(node => node.type), header).toEqual(['table', 'heading'])
        expect(rowHeight(doc, 1), header).toBe(84)
      }
    })

    // Regular-expression runs stand in for parser work: every block rule in
    // marked is one, so re-lexing the rest of the document shows up here.
    const regExpRuns = (parse: () => void): number => {
      const exec = RegExp.prototype.exec
      let runs = 0
      const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (
        this: RegExp,
        value: string,
      ) {
        runs += 1
        return Reflect.apply(exec, this, [value]) as RegExpExecArray | null
      })
      try {
        parse()
        return runs
      } finally {
        spy.mockRestore()
      }
    }

    it('rejects orphan annotations without lexing the rest of the document', () => {
      const measure = (annotations: number): number => regExpRuns(() => {
        const doc = markdownToYDoc(
          `${Array(annotations).fill('<!-- dohc:table row-heights=1:84 -->').join('\n')}\nNot a table.`,
        )
        expect(getDohcYDocBodyFragment(doc).length).toBe(annotations + 1)
        doc.destroy()
      })
      const small = measure(32)
      const large = measure(64)
      expect(large, `regular-expression runs: ${small} -> ${large}`).toBeLessThan(small * 2.5)
    })

    it('parses a run of annotated tables without lexing the rest of the document', () => {
      const measure = (tables: number): number => regExpRuns(() => {
        const doc = markdownToYDoc(
          Array(tables).fill(`<!-- dohc:table row-heights=1:84 -->\n${table}`).join('\n'),
        )
        const blocks = yDocBodyJSON(doc).content ?? []
        expect(blocks.map(node => node.type)).toEqual(Array(tables).fill('table'))
        expect(blocks.every(block => block.content?.[1]?.attrs?.height === 84)).toBe(true)
        doc.destroy()
      })
      const small = measure(32)
      const large = measure(64)
      expect(large, `regular-expression runs: ${small} -> ${large}`).toBeLessThan(small * 2.5)
    })

    it('keeps a list item whose first block is an annotated table', () => {
      const input = [
        '- <!-- dohc:table row-heights=1:84 -->',
        '  | A | B |',
        '  | --- | --- |',
        '  | a | b |',
        '- second item',
      ].join('\n')
      const doc = markdownToYDoc(input)
      const list = yDocBodyJSON(doc).content?.[0]
      expect(list?.type).toBe('bulletList')
      expect(list?.content?.map(item => item.content?.map(block => block.type))).toEqual([
        ['paragraph', 'table'],
        ['paragraph'],
      ])
      expect(list?.content?.[0]?.content?.[1]?.content?.[1]?.attrs?.height).toBe(84)
    })

    it('leaves an annotation that no table follows as an ordinary comment', () => {
      const doc = markdownToYDoc('<!-- dohc:table row-heights=1:84 -->\nNot a table.')
      expect(yDocBodyJSON(doc).content?.map(node => node.type)).toEqual([
        'paragraph',
        'paragraph',
      ])
    })
  })

  it('keeps one blank separator between a table and a following nested list', () => {
    const input = [
      '---',
      'status: open',
      '---',
      '',
      '| Metric | Value |',
      '| ------ | ----- |',
      '| apples | 10    |',
      '',
      '- parent',
      '  - nested with **bold** and [details](https://example.com)',
    ].join('\n')

    const doc = markdownToYDoc(input)
    expect(yDocBodyJSON(doc).content?.map(node => node.type)).toEqual([
      'table',
      'bulletList',
    ])
    expect(yDocToMarkdown(doc)).toBe(input)
  })

  it('ends a table at a row with more cells than its header so no cell text disappears', () => {
    for (const input of [
      '| a | b |\n|---|---|\n| c | d | hidden |\n',
      'a | b\n--- | ---\nc | d\ne | f | hidden\n',
      '> | a | b |\n> |---|---|\n> | c | d | hidden |\n',
      '- [ ] task\n  | a | b |\n  |---|---|\n  | c | d | hidden |\n',
      '| a | b |\n|---|---|\n| `c|x` | d | hidden |\n',
      // A code-span pipe in the header sends the importer to the raw text,
      // where the code span in the row splits too.
      '| `a|b` | c |\n|---|---|---|\n| x | `y|z` | hidden |\n',
    ]) {
      expect(yDocToMarkdown(markdownToYDoc(input)), JSON.stringify(input)).toContain('hidden')
    }
  })

  it('keeps a link reference definition as text, and a link that uses it still resolves', () => {
    expect(yDocToMarkdown(markdownToYDoc('Hello\n\n[x]: https://h.example "kept"\n')))
      .toBe('Hello\n\n\\[x]: https://h.example "kept"')
    // marked drops a second definition of a label without a token.
    expect(yDocToMarkdown(markdownToYDoc('[x]: https://a.example\n[x]: https://b.example "kept"\n')))
      .toBe('\\[x]: https://a.example\n\n\\[x]: https://b.example "kept"')
    // A link with no text keeps its destination and title as text.
    expect(yDocBodyJSON(markdownToYDoc('Hello[](https://h.example "kept")\n')).content?.[0])
      .toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Hello[](https://h.example "kept")' }] })
    expect(yDocBodyJSON(markdownToYDoc('[docs](https://example.com)\n')).content?.[0]?.content?.[0])
      .toMatchObject({ text: 'docs', marks: [{ type: 'link' }] })
  })

  it('keeps repeated definitions of one label in linear work', () => {
    const repeats = 10_000
    const hasOwn = vi.spyOn(Object, 'hasOwn')
    try {
      const doc = markdownToYDoc('[x]: /a\n'.repeat(repeats))
      expect(yDocBodyJSON(doc).content?.length).toBe(repeats)
      // One check for each definition, with room for the rest of the import.
      expect(hasOwn.mock.calls.length).toBeLessThan(10 * repeats)
    } finally { hasOwn.mockRestore() }
    const body = yDocBodyJSON(markdownToYDoc('See [docs][x].\n\n[x]: https://example.com\n'))
    expect(body.content?.[0]?.content?.[1]).toMatchObject({
      text: 'docs',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
    })
    expect(body.content?.[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '[x]: https://example.com' }],
    })
  })

  it('still reads an empty extra cell and a pipe inside inline code as one table', () => {
    for (const [input, rows] of [
      ['| a | b |\n|---|---|\n| c | d |  |\n', [['a', 'b'], ['c', 'd']]],
      ['| a | b |\n|---|---|\n| `c|x` | d |\n', [['a', 'b'], ['c|x', 'd']]],
    ] as const) {
      const table = yDocBodyJSON(markdownToYDoc(input)).content?.[0]
      expect(table?.type, input).toBe('table')
      expect(table?.content?.map(row => row.content?.map(cell =>
        cell.content?.[0]?.content?.[0]?.text ?? ''))).toEqual(rows)
    }
  })

  it('escapes literal table-cell pipes before computing column widths', () => {
    const doc = yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
              },
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'left | right' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stable' }] }],
              },
            ],
          },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '',
      '| Value         | Other  |',
      '| ------------- | ------ |',
      '| left \\| right | stable |',
    ].join('\n'))
  })

  it('promotes a headerless table first row instead of inserting a blank row', () => {
    const doc = yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'row' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'row' }] }],
              },
            ],
          },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '',
      '| first  | row |',
      '| ------ | --- |',
      '| second | row |',
    ].join('\n'))
  })

  it('projects multi-block table cells with a GFM inline break and no controls', () => {
    const output = yDocToMarkdown(yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'H' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            }],
          },
        ],
      },
    ]))

    expect(output).toBe([
      '',
      '| H               |',
      '| --------------- |',
      '| first<br>second |',
    ].join('\n'))
    expect(output).not.toContain('\u001F')
    expect(output).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u)
  })

  it('projects a multiline fenced code block in a table cell as legal inline content', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Code' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{
                type: 'codeBlock',
                attrs: { language: 'mermaid' },
                content: [{
                  type: 'text',
                  text: 'const fence = ```;\nleft | right <&>',
                }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{
                type: 'codeBlock',
                attrs: { language: '' },
              }],
            }],
          },
        ],
      },
    ]))

    expect(once).toContain(
      '````const fence = ```;````<br>`left \\| right <&>`',
    )
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(yDocBodyJSON(markdownToYDoc(once)).content?.[0].content).toHaveLength(3)
    expect(once).not.toContain('DOHC_CODE_BLOCK')
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it.each([
    {
      type: 'image',
      node: {
        type: 'image',
        attrs: {
          alt: 'plot | draft',
          src: 'assets/plot|`draft`.png',
          title: 'chart | `draft`',
        },
      },
      expected: '![plot \\| draft](assets/plot\\|`draft`.png "chart \\| `draft`")',
    },
    {
      type: 'escapedPunctuation',
      node: { type: 'escapedPunctuation', attrs: { value: '|' } },
      expected: '\\|',
    },
    {
      type: 'wikilink',
      node: {
        type: 'wikilink',
        attrs: { target: 'notes/`plan`', label: 'left | right' },
      },
      expected: '[[notes/`plan`\\|left \\| right]]',
    },
    {
      type: 'inlineAtom',
      node: {
        type: 'inlineAtom',
        attrs: {
          atomId: 'one',
          params: 'mode=left|`draft`',
          source: 'atom:one mode=left|`draft`',
        },
      },
      expected: '{{atom:one mode=left\\|`draft`}}',
    },
    {
      type: 'mathInline',
      node: { type: 'mathInline', attrs: { tex: 'a|`b`' } },
      expected: '$a\\|`b`$',
    },
  ])('escapes table pipes emitted by the $type renderer', ({ node, expected }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [node] }],
            }],
          },
        ],
      }],
    }).trimEnd()

    expect(once).toContain(expected)
    const roundTripDoc = markdownToYDoc(once)
    expect(yDocToMarkdown(roundTripDoc)).toBe(once)
    if (node.type !== 'escapedPunctuation') {
      const roundTripNode = yDocBodyJSON(roundTripDoc)
        .content?.[0].content?.[1].content?.[0].content?.[0].content?.[0]
      expect(roundTripNode).toMatchObject(node)
    }
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it('keeps the complete table-cell block and inline-node inventories explicit', () => {
    const schema = getDohcProseMirrorSchema()
    const tableCellContent = schema.nodes.tableCell.contentMatch
    const directCellBlocks = Object.values(schema.nodes)
      .filter(nodeType => tableCellContent.matchType(nodeType) !== null)
      .map(nodeType => nodeType.name)
      .sort()
    const inlineNodes = Object.values(schema.nodes)
      .filter(nodeType => nodeType.isInline)
      .map(nodeType => nodeType.name)
      .sort()

    expect(directCellBlocks).toEqual([
      'blockquote',
      'bulletList',
      'callout',
      'codeBlock',
      'heading',
      'horizontalRule',
      'mathBlock',
      'orderedList',
      'paragraph',
      'table',
      'taskList',
    ])
    expect(inlineNodes).toEqual([
      'escapedPunctuation',
      'hardBreak',
      'image',
      'inlineAtom',
      'mathInline',
      'text',
      'wikilink',
    ])
  })

  it.each([
    {
      type: 'blockquote',
      block: {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'quote | `tick`' }],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          },
        ],
      },
    },
    {
      type: 'bulletList',
      block: {
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'bullet | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
    {
      type: 'callout',
      block: {
        type: 'callout',
        attrs: { calloutType: 'note', fold: '', title: 'Title | `tick`' },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'body | `tick`' }],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          },
        ],
      },
    },
    {
      type: 'codeBlock',
      block: {
        type: 'codeBlock',
        attrs: { language: 'txt' },
        content: [{ type: 'text', text: 'code | ```' }],
      },
    },
    {
      type: 'heading',
      block: {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'heading | `tick`' }],
      },
    },
    {
      type: 'horizontalRule',
      block: { type: 'horizontalRule' },
    },
    {
      type: 'mathBlock',
      block: { type: 'mathBlock', attrs: { tex: 'a|`b`' } },
    },
    {
      type: 'orderedList',
      block: {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'ordered | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
    {
      type: 'paragraph',
      block: {
        type: 'paragraph',
        content: [{ type: 'text', text: 'paragraph | `tick`' }],
      },
    },
    {
      type: 'table',
      block: {
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableHeader',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'nested | `tick`' }],
            }, {
              type: 'codeBlock',
              content: [{ type: 'text', text: 'deeper | ```' }],
            }],
          }],
        }],
      },
    },
    {
      type: 'taskList',
      block: {
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: false },
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'task | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
  ])('serializes the $type block shape inside a table cell without a sentinel', ({ block }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [block],
            }],
          },
        ],
      }],
    }).trimEnd()

    const normalized = yDocToMarkdown(markdownToYDoc(once))
    expect(yDocToMarkdown(markdownToYDoc(normalized))).toBe(normalized)
    expect(yDocBodyJSON(markdownToYDoc(once)).content?.[0].content?.[1].content)
      .toHaveLength(1)
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it.each([
    {
      type: 'text',
      content: [{ type: 'text', text: 'left | `right`' }],
    },
    {
      type: 'hardBreak',
      content: [
        { type: 'text', text: 'left' },
        { type: 'hardBreak' },
        { type: 'text', text: 'right | `tick`' },
      ],
    },
    {
      type: 'text with link mark',
      content: [{
        type: 'text',
        text: 'label',
        marks: [{
          type: 'link',
          attrs: { href: 'https://example.com/left|`right`' },
        }],
      }],
    },
  ])('serializes the $type inline shape inside a table cell without a sentinel', ({ content }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{ type: 'paragraph', content }],
            }],
          },
        ],
      }],
    }).trimEnd()

    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it('round-trips per-column GFM alignment (left/center/right) losslessly', () => {
    // Phase 1 assumed per-column alignment was inexpressible; it is not. The
    // `align` cell attr (set by tableControls' column grip menu) serializes to
    // the delimiter row and parses back, so a mixed-alignment table — left
    // (`:---`), center (`:---:`), right (`---:`), and default (`---`) — is
    // byte-stable across the round-trip.
    const once = expectStableMarkdownRoundTrip(
      [
        '| L | C | R | D |',
        '| :--- | :---: | ---: | --- |',
        '| a | b | c | d |',
      ].join('\n'),
      ['| :--- | :---: | ---: | --- |'],
    )
    expect(once).toContain('| L')
    expect(once).toContain('| a')
  })

  it('keeps Obsidian-style power-user syntax stable as text or custom nodes', () => {
    expectStableMarkdownRoundTrip(
      [
        '---',
        'tags:',
        '  - alpha/beta',
        'aliases:',
        '  - Today',
        '---',
        '',
        '# Daily note',
        '',
        'See [[Projects/dohc#Graph view|graph plan]] and [[Notes/Ideas#^block-ref]].',
        'Embed stays visible: ![[assets/chart.png]].',
        '',
        '> [!note]+ Launch callout',
        '> Body with #work/deep and ==highlighted text==.',
        '',
        '%% private drafting note %%',
        '',
        'Footnote ref[^1].',
        '',
        '[^1]: Footnote body.',
      ].join('\n'),
      [
        'aliases:\n  - Today',
        'tags:\n  - alpha/beta',
        '[[Projects/dohc#Graph view|graph plan]]',
        '[[Notes/Ideas#^block-ref]]',
        '![[assets/chart.png]]',
        '> [!note]+ Launch callout',
        '#work/deep',
        '==highlighted text==',
        '%% private drafting note %%',
        'Footnote ref[^1].',
        '[^1]: Footnote body.',
      ],
    )
  })

  it('round-trips ordinary fenced code blocks without dropping them', () => {
    expectStableMarkdownRoundTrip(
      ['```js', 'const x = 1;', '```', '', '```', 'no language here', '```', ''].join('\n'),
      ['```js\nconst x = 1;\n```', 'no language here'],
    )
  })

  it.each(['lang`tick', '`leading', '```leading', '~lang`tick'])('round-trips code blocks whose language is %s', language => {
    for (const content of ['', 'code', 'before\n~~~\n```\nafter']) {
      for (const quoted of [false, true]) {
        const block = {
          type: 'codeBlock',
          attrs: { language },
          ...(content ? { content: [{ type: 'text', text: content }] } : {}),
        }
        const doc = yDocFromBody([
          quoted ? { type: 'blockquote', content: [block] } : block,
          { type: 'paragraph', content: [{ type: 'text', text: 'After code' }] },
        ])
        const markdown = yDocToMarkdown(doc)
        const fence = content.includes('~~~') ? '~~~~' : '~~~'
        expect(markdown).toContain(`${fence}${language.startsWith('~') ? ' ' : ''}${language}`)
        expect(markdown).not.toContain('DOHC_CODE_BLOCK')
        const restored = markdownToYDoc(markdown)
        expect(yDocBodyJSON(restored)).toEqual(yDocBodyJSON(doc))
        expect(yDocToMarkdown(restored)).toBe(markdown)
      }
    }
  })

  it.each(['js', 'lang`tick'])('keeps an empty %s code block indented inside a list', language => {
    const fence = language.includes('`') ? '~~~' : '```'
    const markdown = `- intro\n  ${fence}${language}\n  \n  ${fence}\n\nAfter`
    expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
  })

  it('uses collision-free block and inline code delimiters', () => {
    const doc = yDocFromBody([
      {
        type: 'codeBlock',
        attrs: { language: 'js' },
        content: [{ type: 'text', text: 'before\n```\nafter' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a`b', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: '`edge`', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: ' spaced ', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: '   ', marks: [{ type: 'code' }] },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '````js',
      'before',
      '```',
      'after',
      '````',
      '',
      '``a`b`` / `` `edge` `` / `  spaced  ` / `   `',
    ].join('\n'))
  })

  it('reserves many code-block tokens without rescanning the source per block', () => {
    const includes = vi.spyOn(String.prototype, 'includes')
    try {
      const markdown = serializeRichdocBody({
        type: 'doc',
        content: Array.from({ length: 200 }, (_, index) => ({
          type: 'codeBlock',
          attrs: { language: 'txt' },
          content: [{ type: 'text', text: `block ${index}` }],
        })),
      })
      const tokenSourceScans = includes.mock.calls.filter(
        ([search]) =>
          typeof search === 'string'
          && /^\uE000DOHC_CODE_BLOCK_\d+\uE001$/u.test(search),
      )

      expect(tokenSourceScans).toHaveLength(0)
      expect(markdown).toContain('block 0')
      expect(markdown).toContain('block 199')
      expect(markdown).not.toContain('DOHC_CODE_BLOCK')
    } finally {
      includes.mockRestore()
    }
  })

  it('keeps HTML-special characters raw inside inline code', () => {
    const markdown = 'Compare `<tag> && value > 1` without entity expansion.'
    expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
  })

  it.each([
    {
      context: 'the first block of a bullet item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const bullet = true' }],
          }],
        }],
      }],
      markdown: ['- ```js', '  const bullet = true', '  ```'].join('\n'),
    },
    {
      context: 'the first block of an ordered item',
      content: [{
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{
          type: 'listItem',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const ordered = true' }],
          }],
        }],
      }],
      markdown: ['1. ```js', '   const ordered = true', '   ```'].join('\n'),
    },
    {
      context: 'the first block of a nested list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'parent' }],
            },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{
                  type: 'codeBlock',
                  attrs: { language: 'js' },
                  content: [{ type: 'text', text: 'const nested = true' }],
                }],
              }],
            },
          ],
        }],
      }],
      markdown: [
        '- parent',
        '  - ```js',
        '    const nested = true',
        '    ```',
      ].join('\n'),
    },
    {
      context: 'a blockquote',
      content: [{
        type: 'blockquote',
        content: [{
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const quoted = true' }],
        }],
      }],
      markdown: ['> ```js', '> const quoted = true', '> ```'].join('\n'),
    },
    {
      context: 'a callout',
      content: [{
        type: 'callout',
        attrs: { calloutType: 'note', fold: '', title: 'Code' },
        content: [{
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const callout = true' }],
        }],
      }],
      markdown: [
        '> [!note] Code',
        '> ```js',
        '> const callout = true',
        '> ```',
      ].join('\n'),
    },
    {
      context: 'the first block of a task item',
      content: [{
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: false },
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const task = true' }],
          }],
        }],
      }],
      markdown: ['- [ ] ```js', '  const task = true', '  ```'].join('\n'),
    },
    {
      context: 'a later block of a list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'introduction' }],
            },
            {
              type: 'codeBlock',
              attrs: { language: 'js' },
              content: [{ type: 'text', text: 'const later = true' }],
            },
          ],
        }],
      }],
      markdown: [
        '- introduction',
        '  ```js',
        '  const later = true',
        '  ```',
      ].join('\n'),
    },
    {
      context: 'a blockquote nested in a list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'quote' }],
            },
            {
              type: 'blockquote',
              content: [{
                type: 'codeBlock',
                attrs: { language: 'js' },
                content: [{ type: 'text', text: 'const nestedQuote = true' }],
              }],
            },
          ],
        }],
      }],
      markdown: [
        '- quote',
        '  > ```js',
        '  > const nestedQuote = true',
        '  > ```',
      ].join('\n'),
    },
  ])('round-trips fenced code inside $context without leaking sentinels', ({ content, markdown }) => {
    const once = serializeRichdocBody({ type: 'doc', content }).trimEnd()
    expect(once).toBe(markdown)
    expect(once).not.toContain('DOHC_CODE_BLOCK')
  })

  it.each([
    {
      value: 'left | right',
      markdown: [
        '| Value | Other |',
        '| ----- | ----- |',
        '| `left \\| right` | stable |',
      ].join('\n'),
    },
    {
      value: 'a`b | c',
      markdown: [
        '| Value | Other |',
        '| ----- | ----- |',
        '| ``a`b \\| c`` | stable |',
      ].join('\n'),
    },
  ])('round-trips inline code containing table pipes: $value', ({ markdown }) => {
    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(once).toContain(markdown.split('\n')[2])

    const table = yDocBodyJSON(markdownToYDoc(once)).content?.[0]
    expect(table?.content?.[1].content).toHaveLength(2)
    expect(table?.content?.[1].content?.[0]).toMatchObject({
      content: [{
        content: [{
          type: 'text',
          text: markdown.includes('a`b') ? 'a`b | c' : 'left | right',
          marks: [{ type: 'code' }],
        }],
      }],
    })
  })

  it('projects many inline-code spans without leaking or corrupting reserved tokens', () => {
    const markdown = Array.from(
      { length: 500 },
      (_, index) => `span-${index}: \`value-${index}\``,
    ).join('\n\n')

    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(once).toBe(markdown)
    expect(once).not.toContain('DOHC_INLINE_CODE')
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  it.each([
    {
      context: 'a bullet item',
      markdown: '- bullet ``a`b | c``',
    },
    {
      context: 'an ordered item',
      markdown: '1. ordered ``a`b | c``',
    },
    {
      context: 'a nested list item',
      markdown: ['- parent', '  - nested ``a`b | c``'].join('\n'),
    },
    {
      context: 'a blockquote',
      markdown: '> quote ``a`b | c``',
    },
    {
      context: 'a callout',
      markdown: ['> [!note] Inline', '> body ``a`b | c``'].join('\n'),
    },
    {
      context: 'a task item',
      markdown: '- [ ] task ``a`b | c``',
    },
    {
      context: 'a heading',
      markdown: '# heading ``a`b | c``',
    },
  ])('round-trips inline code inside $context without placeholder-sensitive output', ({ markdown }) => {
    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(once).toBe(markdown)
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  it('preserves user private-use codepoints when reserving serialization sentinels', () => {
    const tableSentinel0 = String.fromCodePoint(0xF0000)
    const tableSentinel1 = String.fromCodePoint(0xF0001)
    const blockToken0 = '\uE000DOHC_CODE_BLOCK_0\uE001'
    const blockToken1 = '\uE000DOHC_CODE_BLOCK_1\uE001'
    const inlineToken3 = '\uE000DOHC_INLINE_CODE_3\uE001'
    const inlineToken4 = '\uE000DOHC_INLINE_CODE_4\uE001'
    const inlineEntitySentinels = '\uE002\uE003\uE004'
    const doc = yDocFromBody([
      {
        type: 'codeBlock',
        attrs: { language: 'txt' },
        content: [{ type: 'text', text: `${blockToken0} ${blockToken1}` }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{
                  type: 'paragraph',
                  content: [{
                    type: 'text',
                    text: `${tableSentinel0} | ${tableSentinel1}`,
                  }],
                }],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{
          type: 'text',
          text: `${inlineToken3} ${inlineToken4} ${inlineEntitySentinels} <&>`,
          marks: [{ type: 'code' }],
        }],
      },
    ])

    const markdown = yDocToMarkdown(doc)
    expect(markdown).toContain(`${blockToken0} ${blockToken1}`)
    expect(markdown).toContain(`${tableSentinel0} \\| ${tableSentinel1}`)
    expect(markdown).toContain(
      `\`${inlineToken3} ${inlineToken4} ${inlineEntitySentinels} <&>\``,
    )
    expect(markdown).not.toContain(String.fromCodePoint(0xF0002))
  })

  it('round-trips Obsidian callouts across every core type, fold flag, and title state', () => {
    const once = expectStableMarkdownRoundTrip(
      [
        '> [!note] Titled note',
        '> note body',
        '',
        '> [!tip]',
        '> untitled tip body',
        '',
        '> [!info]+ Explicitly open',
        '> info body',
        '',
        '> [!warning]- Folded warning',
        '> hidden until expanded',
        '',
        '> [!danger] Danger zone',
        '> danger body',
        '',
        '> [!quote] A quote callout',
        '> quoted body',
      ].join('\n'),
      [
        '> [!note] Titled note',
        '> [!tip]',
        '> [!info]+ Explicitly open',
        '> [!warning]- Folded warning',
        '> [!danger] Danger zone',
        '> [!quote] A quote callout',
        '> hidden until expanded',
      ],
    )
    expect(once).toContain('> untitled tip body')
  })

  it('preserves unknown callout types verbatim instead of dropping them', () => {
    expectStableMarkdownRoundTrip(
      ['> [!custom-thing]- Secret label', '> body text'].join('\n'),
      ['> [!custom-thing]- Secret label', '> body text'],
    )
  })

  it('preserves callout titles that contain brackets', () => {
    expectStableMarkdownRoundTrip(
      ['> [!note] Title with ] bracket', '> body'].join('\n'),
      ['> [!note] Title with ] bracket'],
    )
  })

  it('round-trips callouts that contain lists and code blocks', () => {
    expectStableMarkdownRoundTrip(
      [
        '> [!info] With blocks',
        '> - first',
        '> - second',
        '>',
        '> ```ts',
        '> const x = 1',
        '> ```',
      ].join('\n'),
      [
        '> [!info] With blocks',
        '> - first',
        '> - second',
        '> ```ts',
        '> const x = 1',
        '> ```',
      ],
    )
  })

  it('leaves a plain blockquote (no callout header) as an ordinary blockquote', () => {
    const once = expectStableMarkdownRoundTrip(
      ['> just a quote', '> second line'].join('\n'),
      ['> just a quote', '> second line'],
    )
    expect(once).not.toContain('[!')
  })

  it('round-trips ==highlight== including adjacent and nested marks', () => {
    const once = expectStableMarkdownRoundTrip(
      'Plain ==highlighted== then ==one== ==two== adjacent, plus **==bold highlight==** and ==**inner bold**==.',
      ['==highlighted==', '==one==', '==two=='],
    )
    expect(once).toContain('bold highlight')
    expect(once).toContain('inner bold')
  })

  it('does not fire highlight on stray or spaced equals', () => {
    expectStableMarkdownRoundTrip(
      'Prose a == b stays literal and a lone = sign too.',
      ['a == b stays literal'],
    )
  })

  it('round-trips a callout nested inside a list item without dropping it', () => {
    const input = ['- item', '  > [!note] In list', '  > body'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('keeps a list item and a following callout distinct (nested callout survives)', () => {
    const input = [
      '- item',
      '  > [!note] In list',
      '  > body',
      '',
      '- second',
    ].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    // The blank line between tight list items normalizes away, but the nested
    // callout and both list items survive, and the result is idempotent.
    expect(once).toContain('> [!note] In list')
    expect(once).toContain('> body')
    expect(once).toContain('- item')
    expect(once).toContain('- second')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('emits a title-only callout without a stray trailing > line', () => {
    expect(yDocToMarkdown(markdownToYDoc('> [!note] Just a title'))).toBe(
      '> [!note] Just a title',
    )
    expect(yDocToMarkdown(markdownToYDoc('> [!tip]'))).toBe('> [!tip]')
    expect(yDocToMarkdown(markdownToYDoc('> [!warning]- Folded title'))).toBe(
      '> [!warning]- Folded title',
    )
  })

  it('absorbs a lazy-continuation line into the callout instead of reflowing it out', () => {
    const input = ['> [!note] Title', '> first line', 'lazy continuation'].join(
      '\n',
    )
    const once = yDocToMarkdown(markdownToYDoc(input))
    // First pass normalizes the lazy line to a `>`-prefixed body line inside the
    // callout (rather than reflowing it into a separate paragraph)...
    expect(once).toBe(
      ['> [!note] Title', '> first line', '> lazy continuation'].join('\n'),
    )
    // ...and the normalized form is byte-stable thereafter.
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('losslessly round-trips a highlight applied over text containing ==', () => {
    const highlighted = (text: string): Y.Doc =>
      yDocFromBody([
        {
          type: 'paragraph',
          content: [{ type: 'text', text, marks: [{ type: 'highlight' }] }],
        },
      ])
    // The concrete escaped form is unambiguous and reversible.
    expect(yDocToMarkdown(highlighted('a==b'))).toBe('==a\\=\\=b==')
    // A lone `=` adjacent to the closing delimiter must also be escaped, or the
    // mark would close one char early (`==a=` → `==a===`).
    expect(yDocToMarkdown(highlighted('a='))).toBe('==a\\===')
    for (const text of [
      'a==b',
      'a ==b== c',
      'a==b==c',
      '==edge==',
      'trailing==',
      'x = y',
      'a=',
      '=lead',
      'a=b=',
      'plain',
    ]) {
      const once = yDocToMarkdown(highlighted(text))
      const twice = yDocToMarkdown(markdownToYDoc(once))
      expect(twice, `text=${JSON.stringify(text)}`).toBe(once)
      // The highlight is preserved as a single `==...==` span, never split.
      expect(once.startsWith('=='), `text=${JSON.stringify(text)}`).toBe(true)
      expect(once.endsWith('=='), `text=${JSON.stringify(text)}`).toBe(true)
    }
  })

  it('keeps adversarial raw == sequences literal and byte-stable', () => {
    for (const input of ['==a ==b== c==', 'a ==b==c== d', '==x==y==z==']) {
      const once = yDocToMarkdown(markdownToYDoc(input))
      expect(once, `input=${JSON.stringify(input)}`).toBe(input)
      const twice = yDocToMarkdown(markdownToYDoc(once))
      expect(twice, `input=${JSON.stringify(input)}`).toBe(once)
    }
  })

  it('round-trips inline $...$ TeX math byte-for-byte', () => {
    const input = 'Euler: $e^{i\\pi} + 1 = 0$ is neat.'
    const once = expectStableMarkdownRoundTrip(input, ['$e^{i\\pi} + 1 = 0$'])
    expect(once).toBe(input)
  })

  it('round-trips a single-line $$...$$ block byte-for-byte', () => {
    const input = '$$E = mc^2$$'
    const once = expectStableMarkdownRoundTrip(input, ['$$E = mc^2$$'])
    expect(once).toBe(input)
  })

  it('round-trips a multi-line $$...$$ block byte-for-byte', () => {
    const input = [
      '$$',
      '\\sum_{i=0}^n i = \\frac{n(n+1)}{2}',
      'E = mc^2',
      '$$',
    ].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('escapes wikilink delimiters in a mention label so it round-trips', () => {
    const doc = yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'wikilink',
            attrs: { target: 'notes/plan', label: 'Plan ]] Draft | v2' },
          },
        ],
      },
    ])
    // `]` and `|` in the label are backslash-escaped so the closing `]]` and the
    // target/label separator aren't matched early.
    const once = yDocToMarkdown(doc)
    expect(once).toBe('[[notes/plan|Plan \\]\\] Draft \\| v2]]')
    // Re-parsing unescapes the label and re-serializing reproduces it verbatim
    // (a truncated re-parse would drop the tail and diverge here).
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('round-trips an empty $$$$ block', () => {
    const input = '$$$$'
    const once = expectStableMarkdownRoundTrip(input, ['$$$$'])
    expect(once).toBe(input)
  })

  it('keeps escaped \\$ literal instead of opening math', () => {
    const input = 'Price is \\$5 and \\$6 today.'
    const once = expectStableMarkdownRoundTrip(input, ['\\$5', '\\$6'])
    expect(once).toBe(input)
  })

  it('does not fire inline math on prose dollar amounts like $5 and $6', () => {
    const input = 'I have $5 and $6 in my wallet.'
    const once = expectStableMarkdownRoundTrip(input, ['$5 and $6'])
    expect(once).toBe(input)
  })

  it('round-trips inline math adjacent to marks', () => {
    // A mark that wraps a childless inline atom is dropped by the base markdown
    // manager (applyMarkToContent only attaches marks to text nodes) — this is
    // shared by every inline atom (image, inlineAtom, wikilink), not a
    // math quirk. Marks adjacent to math round-trip cleanly, which is the case
    // that matters in practice.
    const input = 'Adjacent **bold** and $x^2$ and *emphasis* stay put.'
    const once = expectStableMarkdownRoundTrip(input, [
      '**bold**',
      '$x^2$',
      '*emphasis*',
    ])
    expect(once).toBe(input)
  })

  it('leaves a mid-paragraph $$x$$ with trailing text literal', () => {
    const input = 'inline $$x$$ trailing stays literal'
    const once = expectStableMarkdownRoundTrip(input, ['$$x$$ trailing'])
    expect(once).toBe(input)
  })

  it('detects a mid-line wikilink whose label contains an escaped delimiter', () => {
    const doc = yDocFromBody([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'wikilink', attrs: { target: 'notes/plan', label: 'Plan ]] Draft' } },
          { type: 'text', text: ' here' },
        ],
      },
    ])
    const once = yDocToMarkdown(doc)
    expect(once).toBe('See [[notes/plan|Plan \\]\\] Draft]] here')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('does not absorb text after a fenced code block inside a callout', () => {
    const input = ['> [!note]', '> ```', '> code', '> ```', 'outside'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    // `outside` is a plain top-level paragraph, not a lazy `>`-prefixed body line.
    expect(once).toMatch(/^outside$/m)
    expect(once).not.toContain('> outside')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('does not absorb text after a heading inside a callout', () => {
    const input = ['> [!note]', '> # Section', 'outside'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toMatch(/^outside$/m)
    expect(once).not.toContain('> outside')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })
})

// A bare TaskItem takes `paragraph+`, so an indented list under a checkbox is
// schema-invalid and the Y.Doc -> ProseMirror conversion returned an empty
// document: the whole task list disappeared on open.
describe('a list nested inside a task item', () => {
  const CASES = [
    ['bullet', '- [ ] parent\n  - child one\n  - child two'],
    ['ordered', '- [x] parent\n  1. first\n  2. second'],
    ['task', '- [ ] parent\n  - [x] done child\n  - [ ] open child'],
  ] as const

  for (const [kind, markdown] of CASES) {
    it(`survives the Y.Doc round-trip as a ${kind} list`, () => {
      expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
    })
  }
})

// CommonMark lets a fenced code block's opener carry up to three leading
// spaces. Four or more make an indented code block instead, which is a
// different construct. markdownToYDoc used to drop a top-level fence indented
// 1-3 spaces together with its whole body, so opening such a document and
// letting it settle wrote the deletion back to disk. This mirrors the
// desktop editor's suite — both packages parse markdown with the same rules.
describe('indented code fences', () => {
  function bodyBlocks(markdown: string): JSONContent[] {
    return yDocBodyJSON(markdownToYDoc(markdown)).content ?? []
  }

  function codeText(node: JSONContent | undefined): string {
    return (node?.content ?? []).map((child) => child.text ?? '').join('')
  }

  for (const indent of [1, 2, 3]) {
    for (const fence of ['```', '~~~']) {
      for (const info of ['', 'ts']) {
        const opener = `${' '.repeat(indent)}${fence}${info}`
        const label = `a ${indent}-space ${fence} fence ${info ? `with the info string "${info}"` : 'with no info string'}`

        it(`keeps ${label}`, () => {
          const input = [
            'Para',
            '',
            opener,
            'const a = 1',
            `${' '.repeat(indent)}${fence}`,
            '',
            'After',
          ].join('\n')

          const blocks = bodyBlocks(input)
          expect(blocks.map((block) => block.type)).toEqual([
            'paragraph',
            'codeBlock',
            'paragraph',
          ])
          expect(codeText(blocks[1])).toBe('const a = 1')
          expect(blocks[1]?.attrs?.language ?? null).toBe(info || null)
        })
      }
    }
  }

  it('keeps every body line, stripping only the opener indent', () => {
    const input = [
      '  ```md',
      '  first',
      '',
      '# not a heading',
      '   deeper',
      '  ```',
    ].join('\n')
    const blocks = bodyBlocks(input)
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock'])
    expect(codeText(blocks[0])).toBe('first\n\n# not a heading\n deeper')
    expect(blocks[0]?.attrs?.language).toBe('md')
  })

  it('normalizes an indented fence to column 0 on export', () => {
    const once = yDocToMarkdown(markdownToYDoc(' ```js\ncode\n ```'))
    expect(once).toBe('```js\ncode\n```')
  })

  // An empty fence has no body. The codeBlock must be built with no content at
  // all: a text node holding '' is schema-invalid, so markdownToYDoc would
  // throw `RangeError: Empty text nodes are not allowed` and the document would
  // fail to open.
  it('imports an empty indented fence as a codeBlock with no text node', () => {
    const input = ' ```js\n ```'
    const blocks = bodyBlocks(input)
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock'])
    expect(blocks[0]?.attrs?.language).toBe('js')
    expect(codeText(blocks[0])).toBe('')

    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe('```js\n\n```')
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  // Boundary: four spaces is an indented code block, not a fence.
  it('treats a 4-space-indented backtick run as code content, not a fence', () => {
    const blocks = bodyBlocks('    ```\nParagraph')
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock', 'paragraph'])
    expect(codeText(blocks[0])).toBe('```')
    expect(blocks[0]?.attrs?.language ?? null).toBeNull()
  })

  // Boundary: fences that already worked must keep working.
  it('keeps a fence indented inside a list item nested in that item', () => {
    const blocks = bodyBlocks(['- item', '', '  ```', '  code', '  ```', '', 'After'].join('\n'))
    expect(blocks.map((block) => block.type)).toEqual(['bulletList', 'paragraph'])
    const itemBlocks = blocks[0]?.content?.[0]?.content ?? []
    expect(itemBlocks.map((block) => block.type)).toEqual(['paragraph', 'codeBlock'])
    expect(codeText(itemBlocks[1])).toBe('code')
  })

  // `round-trips fenced code inside $context` covers the quoted container in
  // the export direction only — it starts from a doc, not from markdown.
  it('keeps a fence inside a plain blockquote quoted', () => {
    const input = ['> ```', '> code', '> ```'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })
})
