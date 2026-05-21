import { describe, it, expect } from 'vitest'
import { resolveLiveTotal, type ValueAtom } from './liveTotal'

// Unit 4a — the pure rollup core. UC-3: a projection, never written
// back. Fail-soft by contract: a non-resolving total is null (renders
// `___`), never an error.

const atoms: ValueAtom[] = [
  { key: 'billable', value: 6 },
  { key: 'billable', value: 4 },
  { key: 'billable', value: 'oops' }, // string — must NOT be coerced
  { key: 'rate', value: 150 },
  { key: 'done', value: true },
]

describe('resolveLiveTotal — sum', () => {
  it('sums only NUMBER-typed values for the key', () => {
    expect(resolveLiveTotal({ op: 'sum', key: 'billable' }, atoms)).toBe(10)
  })
  it('never coerces a string value into numeric truth', () => {
    // the only `rate` is numeric → 150; a string-only key → null
    expect(resolveLiveTotal({ op: 'sum', key: 'rate' }, atoms)).toBe(150)
    expect(
      resolveLiveTotal({ op: 'sum', key: 'k' }, [{ key: 'k', value: '9' }]),
    ).toBeNull()
  })
  it('no matching numeric atom ⇒ null (absent, not a misleading 0)', () => {
    expect(resolveLiveTotal({ op: 'sum', key: 'missing' }, atoms)).toBeNull()
    expect(resolveLiveTotal({ op: 'sum', key: 'done' }, atoms)).toBeNull()
  })
  it('a real zero sum is 0, not null', () => {
    expect(
      resolveLiveTotal({ op: 'sum', key: 'x' }, [
        { key: 'x', value: 5 },
        { key: 'x', value: -5 },
      ]),
    ).toBe(0)
  })
  it('skips non-finite numbers', () => {
    expect(
      resolveLiveTotal({ op: 'sum', key: 'x' }, [
        { key: 'x', value: Infinity },
        { key: 'x', value: 3 },
      ]),
    ).toBe(3)
  })
})

describe('resolveLiveTotal — count', () => {
  it('counts atoms with the key (0 is a real answer, not null)', () => {
    expect(resolveLiveTotal({ op: 'count', key: 'billable' }, atoms)).toBe(3)
    expect(resolveLiveTotal({ op: 'count', key: 'nope' }, atoms)).toBe(0)
  })
})

describe('resolveLiveTotal — fail-soft (never throws, never errors)', () => {
  it('null / undefined / malformed spec ⇒ null', () => {
    expect(resolveLiveTotal(null, atoms)).toBeNull()
    expect(resolveLiveTotal(undefined, atoms)).toBeNull()
    expect(resolveLiveTotal({ op: 'avg' as never, key: 'billable' }, atoms)).toBeNull()
    expect(resolveLiveTotal({ op: 'sum', key: '' }, atoms)).toBeNull()
  })
  it('forbidden spec key ⇒ null (no prototype vector)', () => {
    expect(
      resolveLiveTotal({ op: 'sum', key: '__proto__' }, atoms),
    ).toBeNull()
  })
  it('empty atom set ⇒ null (sum) / 0 (count)', () => {
    expect(resolveLiveTotal({ op: 'sum', key: 'a' }, [])).toBeNull()
    expect(resolveLiveTotal({ op: 'count', key: 'a' }, [])).toBe(0)
  })
  it('tolerates junk entries in the atom array', () => {
    const dirty = [
      null as unknown as ValueAtom,
      { key: 'a', value: 2 },
      undefined as unknown as ValueAtom,
    ]
    expect(resolveLiveTotal({ op: 'sum', key: 'a' }, dirty)).toBe(2)
  })
})
