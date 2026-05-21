import { describe, it, expect } from 'vitest'
import { countBraceConstructs, scoreFixture, aggregate } from './score'
import { FIXTURES } from './fixtures'
import type { GoldenAtom } from './fixtures'

// These tests verify the HARNESS itself offline — no model involved.
// They prove the gate would correctly pass clean output and correctly
// catch malformed output.

describe('countBraceConstructs', () => {
  it('counts matched + unmatched top-level spans, skips escaped', () => {
    expect(countBraceConstructs('{a: 1} and {b: 2}')).toBe(2)
    expect(countBraceConstructs('{a: {b: 1}}')).toBe(1) // one span (nested)
    expect(countBraceConstructs('the set \\{1,2\\} math')).toBe(0)
    expect(countBraceConstructs('no braces here')).toBe(0)
  })
})

describe('scoreFixture — clean output passes', () => {
  it('golden-perfect output → conformance 1, recall 1, round-trip ok', () => {
    const golden: GoldenAtom[] = [
      { key: 'hours', kind: 'value', value: 6 },
      { key: 'client', kind: 'value', value: 'Acme' },
    ]
    const out = 'Logged {hours: 6} for {client: Acme} today.'
    const s = scoreFixture(out, golden)
    expect(s.conformanceRate).toBe(1)
    expect(s.recallRate).toBe(1)
    expect(s.roundTripOk).toBe(true)
    expect(s.falsePositives).toBe(0)
  })

  it('empty golden + restrained output → recall 1, no false positives', () => {
    const s = scoreFixture('Follow up with Maya next week.', [])
    expect(s.recallRate).toBe(1)
    expect(s.falsePositives).toBe(0)
  })
})

describe('scoreFixture — malformed output is caught', () => {
  it('nested braces are an attempt but NOT conformant', () => {
    const s = scoreFixture('value is {a: {b: 1}}', [
      { key: 'a', kind: 'value' },
    ])
    expect(s.attempts).toBe(1)
    expect(s.conformant).toBe(0)
    expect(s.conformanceRate).toBe(0) // gate would fail — good
  })

  it('invalid key is caught', () => {
    const s = scoreFixture('{1bad: 2}', [{ key: 'x', kind: 'value' }])
    expect(s.attempts).toBe(1)
    expect(s.conformanceRate).toBe(0)
  })

  it('mixed valid + invalid → partial conformance detected', () => {
    const s = scoreFixture('{ok: 1} but {a: {b: 2}}', [
      { key: 'ok', kind: 'value', value: 1 },
    ])
    expect(s.attempts).toBe(2)
    expect(s.conformant).toBe(1)
    expect(s.conformanceRate).toBe(0.5)
  })

  it('spurious atom on empty-golden fixture is a false positive', () => {
    const s = scoreFixture('nothing here {oops: 1}', [])
    expect(s.falsePositives).toBe(1)
  })
})

// NOTE: these verify the scorer's ARITHMETIC offline — they do NOT
// mean a real model passed. The real ≥95% gate is live.test.ts and
// only runs with ANTHROPIC_API_KEY.
describe('aggregate — scorer arithmetic (NOT a live model result)', () => {
  it('REGRESSION (H1/H3): model that emits NO atoms must FAIL the gate', () => {
    // Each fixture returned verbatim (no braces) → conformance is
    // vacuously 1, but coverage fails and recall is 0 → gate FAIL.
    const scores = FIXTURES.map((f) => scoreFixture(f.artifact, f.golden))
    const agg = aggregate(scores)
    expect(agg.meanConformance).toBe(1) // precision is vacuously perfect…
    expect(agg.coverageFailures).toBeGreaterThan(0) // …but it wrote nothing
    expect(agg.gatePass).toBe(false) // the hole is closed
  })

  it('all-clean corpus passes ≥0.95', () => {
    const scores = FIXTURES.map((f) => {
      // Build a synthetic "perfect" output from the golden set so the
      // harness gate logic is exercised end-to-end without a model.
      const atoms = f.golden
        .map((g) =>
          g.kind === 'liveTotal'
            ? `{${g.key}}`
            : `{${g.key}: ${typeof g.value === 'string' ? g.value : g.value}}`,
        )
        .join(' ')
      return scoreFixture(`${f.artifact}\n\n${atoms}`.trim(), f.golden)
    })
    const agg = aggregate(scores)
    expect(agg.n).toBe(FIXTURES.length)
    expect(agg.meanConformance).toBeGreaterThanOrEqual(0.95)
    expect(agg.roundTripFailures).toBe(0)
    expect(agg.gatePass).toBe(true)
  })

  it('one malformed fixture drags the gate to fail', () => {
    const good = scoreFixture('{a: 1}', [{ key: 'a', kind: 'value', value: 1 }])
    const bad = scoreFixture('{x: {y: 1}}', [{ key: 'x', kind: 'value' }])
    const agg = aggregate([good, good, bad])
    expect(agg.gatePass).toBe(false)
  })

  it('corpus has ≥30 fixtures across 3 archetypes (plan §5)', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(30)
    const kinds = new Set(FIXTURES.map((f) => f.archetype))
    expect(kinds).toEqual(new Set(['notes', 'transcript', 'spreadsheet']))
  })
})
