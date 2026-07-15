import { describe, expect, it } from 'vitest'
import { parseInlineAtoms } from './inlineAtom'

describe('inline value atoms', () => {
  it('parses numbers in surrounding prose and preserves the source span', () => {
    const text = 'Logged {hours: 6} on Acme.'
    const [atom] = parseInlineAtoms(text)
    expect(atom).toMatchObject({
      kind: 'value',
      key: 'hours',
      value: 6,
      valueType: 'number',
    })
    expect(text.slice(atom.start, atom.end)).toBe(atom.raw)
    expect(atom.raw).toBe('{hours: 6}')
  })

  it('parses supported scalar values', () => {
    expect(parseInlineAtoms('{rate: 150.5}')[0]).toMatchObject({
      value: 150.5,
      valueType: 'number',
    })
    expect(parseInlineAtoms('{delta: -3}')[0]).toMatchObject({
      value: -3,
      valueType: 'number',
    })
    expect(parseInlineAtoms('{billable: true}')[0]).toMatchObject({
      value: true,
      valueType: 'boolean',
    })
    expect(parseInlineAtoms('{due: 2026-05-17}')[0]).toMatchObject({
      value: '2026-05-17',
      valueType: 'date',
    })
    expect(parseInlineAtoms('{client: Acme Corp}')[0]).toMatchObject({
      value: 'Acme Corp',
      valueType: 'string',
    })
    expect(parseInlineAtoms('{note: "client was difficult"}')[0]).toMatchObject({
      value: 'client was difficult',
      valueType: 'string',
    })
  })

  it('finds multiple values and keeps each raw span byte-exact', () => {
    const text = 'Logged {hours: 6} at {rate: 150} for {client: Acme}.'
    const atoms = parseInlineAtoms(text)
    expect(atoms).toHaveLength(3)
    for (const atom of atoms) expect(text.slice(atom.start, atom.end)).toBe(atom.raw)
  })

  it('survives markdown serializer escaping inside a value', () => {
    expect(parseInlineAtoms('{client: Acme\\_Corp}')[0]).toMatchObject({
      key: 'client',
      value: 'Acme_Corp',
      valueType: 'string',
    })
    expect(parseInlineAtoms('{note: 5 \\* 7}')[0]).toMatchObject({ value: '5 * 7' })
  })

  it('allows an escaped closing brace in a string value', () => {
    expect(parseInlineAtoms('{note: "tricky \\} case"}')[0]).toMatchObject({
      value: 'tricky } case',
    })
  })
})

describe('inline atom literal handling', () => {
  it('treats bare brace expressions as ordinary prose', () => {
    expect(parseInlineAtoms('{billable_this_week}')).toEqual([])
    expect(parseInlineAtoms('{sum(logs.*.hours)}')).toEqual([])
  })

  it('ignores escaped braces, nesting, arrays, and invalid captures', () => {
    for (const source of [
      'the set \\{1,2,3\\} is math',
      '{a: {b: 1}}',
      '{tags: [a,b]}',
      '{note: "left \\{ brace"}',
      '{}',
      '{ : 5}',
      '{key:}',
      '{1bad: 2}',
    ]) {
      expect(parseInlineAtoms(source)).toEqual([])
    }
  })

  it('never throws on adversarial input', () => {
    for (const source of ['{', '}', '{{{', '}}}', '{a:{', '{:}', '\\{', '{a: }{']) {
      expect(() => parseInlineAtoms(source)).not.toThrow()
    }
  })

  it('leaves code scoping to the editor caller', () => {
    expect(parseInlineAtoms('`{hours: 6}`')).toHaveLength(1)
  })
})
