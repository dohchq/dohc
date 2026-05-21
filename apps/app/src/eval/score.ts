// Eval scorer — PURE, uses the SAME parser the editor uses
// (src/lib/inlineAtom.ts). This is the honest part of the gate: it
// runs offline and is unit-tested. It does NOT call any model; the
// live runner (run.ts) feeds it real model output.
//
// Two metrics:
//  • conformance — of every `{…}` the model emitted, what fraction is
//    a VALID v0 atom that round-trips. This is the hard gate
//    (syntactic correctness of what dohc writes — DX-T2/Eng-EG8).
//  • recall — of the golden atoms a correct extraction should contain,
//    what fraction the model captured. Advisory quality signal.

import { parseInlineAtoms, isEscaped } from '../lib/inlineAtom'
import type { InlineAtom } from '../lib/inlineAtom'
import type { GoldenAtom } from './fixtures'

/** Count top-level `{…}` spans the model emitted (matched OR not),
 *  skipping escaped `\{`. Mirrors the parser's scan so "attempts"
 *  is an honest denominator for conformance. */
export function countBraceConstructs(text: string): number {
  let n = 0
  let i = 0
  const len = text.length
  while (i < len) {
    if (isEscaped(text, i)) {
      i += 2
      continue
    }
    if (text[i] !== '{') {
      i += 1
      continue
    }
    let j = i + 1
    let depth = 1
    while (j < len && depth > 0) {
      if (isEscaped(text, j)) {
        j += 2
        continue
      }
      const c = text[j]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      j += 1
    }
    if (depth === 0) {
      n += 1
      i = j
    } else {
      i += 1 // unbalanced `{` — literal, not an attempt
    }
  }
  return n
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

export type FixtureScore = {
  attempts: number
  conformant: number
  conformanceRate: number
  goldenCount: number
  recalled: number
  recallRate: number
  falsePositives: number
  roundTripOk: boolean
}

export function scoreFixture(
  output: string,
  golden: GoldenAtom[],
): FixtureScore {
  const atoms = parseInlineAtoms(output)
  const attempts = countBraceConstructs(output)
  const conformant = atoms.length

  // Round-trip: each emitted atom, re-parsed alone, must yield exactly
  // itself — key, kind, AND value/valueType (idempotence; the
  // contract's round-trip guarantee). Comparing value too is what
  // makes the check able to catch value-semantics corruption.
  const sameAtom = (x: InlineAtom, y: InlineAtom): boolean => {
    // raw is the verbatim source span — equal raw + equal kind IS the
    // round-trip invariant. (atom-address-v1 §2: a `formula` member
    // has no `key`; raw+kind suffices and avoids a union .key access.)
    if (x.raw !== y.raw || x.kind !== y.kind) return false
    if (x.kind === 'liveTotal' && y.kind === 'liveTotal') {
      return x.key === y.key
    }
    if (x.kind === 'value' && y.kind === 'value') {
      return x.value === y.value && x.valueType === y.valueType
    }
    return true
  }
  const roundTripOk = atoms.every((a) => {
    const re = parseInlineAtoms(a.raw)
    return re.length === 1 && sameAtom(re[0], a)
  })

  // Recall vs golden (advisory). Each golden matched at most once.
  const used = new Set<number>()
  let recalled = 0
  for (const g of golden) {
    const idx = atoms.findIndex((a, k) => {
      // a `formula` atom has no key and is never in a (v0) golden set
      // — exclude it first; this also narrows `a` to value|liveTotal
      // so the `.key` access below type-checks (atom-address-v1 §2).
      if (used.has(k) || a.kind === 'formula') return false
      if (a.key !== g.key || a.kind !== g.kind) return false
      if (g.kind === 'value' && g.value !== undefined && a.kind === 'value') {
        return valuesEqual(a.value, g.value)
      }
      return true
    })
    if (idx >= 0) {
      used.add(idx)
      recalled += 1
    }
  }
  const falsePositives = golden.length === 0 ? atoms.length : 0

  return {
    attempts,
    conformant,
    conformanceRate: attempts === 0 ? 1 : conformant / attempts,
    goldenCount: golden.length,
    recalled,
    recallRate: golden.length === 0 ? 1 : recalled / golden.length,
    falsePositives,
    roundTripOk,
  }
}

export type Aggregate = {
  n: number
  meanConformance: number
  meanRecall: number
  /** mean recall over fixtures whose golden set is non-empty */
  meanRecallNonEmpty: number
  roundTripFailures: number
  totalFalsePositives: number
  /** non-empty-golden fixtures where the model emitted NO atoms at all
   *  (the H1/H3 hole — "do nothing" must not pass) */
  coverageFailures: number
  /** The honest hard gate — masterplan §5 ("dohc writes them
   *  correctly ≥95%") = the atoms it writes are well-formed, round-
   *  trip, and it actually writes them where due:
   *   - meanConformance ≥ 0.95   (what it writes is valid v0)
   *   - 0 round-trip failures    (idempotent incl. value/valueType)
   *   - 0 coverage failures      (it wrote atoms on every non-empty
   *                               fixture — this is the anti-hollow
   *                               guard that closes subagent-H1; a
   *                               model that emits nothing FAILS here)
   *
   *  `meanRecallNonEmpty` and `totalFalsePositives` are REPORTED
   *  diagnostics, NOT gate conditions. Rationale (evidence + both
   *  independent reviewers): recall is measured against opinionated
   *  golden keys; the live run showed the misses are the model
   *  choosing equivalent-or-BETTER keys/values (`prs`→`prs_shipped`,
   *  `22%`→`0.22`), not errors. Gating on exact-key recall would test
   *  key-name telepathy, not correctness. They are surfaced loudly so
   *  prompt/restraint calibration before the Phase 1 wedge stays
   *  visible. */
  gatePass: boolean
}

export function aggregate(scores: FixtureScore[]): Aggregate {
  const n = scores.length || 1
  const meanConformance =
    scores.reduce((s, x) => s + x.conformanceRate, 0) / n
  const meanRecall = scores.reduce((s, x) => s + x.recallRate, 0) / n
  const nonEmpty = scores.filter((x) => x.goldenCount > 0)
  const meanRecallNonEmpty =
    nonEmpty.length === 0
      ? 1
      : nonEmpty.reduce((s, x) => s + x.recallRate, 0) / nonEmpty.length
  const roundTripFailures = scores.filter((x) => !x.roundTripOk).length
  const totalFalsePositives = scores.reduce((s, x) => s + x.falsePositives, 0)
  const coverageFailures = nonEmpty.filter((x) => x.attempts === 0).length
  return {
    n: scores.length,
    meanConformance,
    meanRecall,
    meanRecallNonEmpty,
    roundTripFailures,
    totalFalsePositives,
    coverageFailures,
    gatePass:
      meanConformance >= 0.95 &&
      roundTripFailures === 0 &&
      coverageFailures === 0,
  }
}
