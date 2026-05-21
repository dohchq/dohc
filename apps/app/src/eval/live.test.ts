import { describe, it, expect } from 'vitest'
import { FIXTURES } from './fixtures'
import { scoreFixture, aggregate, type FixtureScore } from './score'
import { INLINE_ATOM_AUTHORING_PROMPT, INLINE_ATOM_MODEL } from './prompt'

// The REAL Phase 1b gate. Honest by construction:
//  • no ANTHROPIC_API_KEY  → the gate test is SKIPPED and a BLOCK
//    notice is printed. No number is ever fabricated.
//  • key present           → every fixture is sent to the real model,
//    scored by the SAME parser the offline suite verifies, and the
//    test FAILS unless mean conformance ≥ 95% with 0 round-trip fails.
// Run: ANTHROPIC_API_KEY=… pnpm eval

const KEY = process.env.ANTHROPIC_API_KEY

async function callModel(artifact: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: INLINE_ATOM_MODEL,
      max_tokens: 1024,
      system: INLINE_ATOM_AUTHORING_PROMPT,
      messages: [{ role: 'user', content: artifact }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ text?: string }> }
  return json.content.map((c) => c.text ?? '').join('')
}

describe('Phase 1b — live ≥95% conformance gate', () => {
  it.skipIf(KEY)('BLOCKED without ANTHROPIC_API_KEY (never fakes a pass)', () => {
    console.warn(
      '\n[Phase 1b gate SKIPPED] Set ANTHROPIC_API_KEY to run the real ' +
        '≥95% eval (`ANTHROPIC_API_KEY=… pnpm eval`). The scorer is ' +
        'offline-verified by score.test.ts; only the model call is gated.\n',
    )
    expect(KEY).toBeFalsy()
  })

  it.runIf(KEY)(
    'beam writes conformant inline atoms ≥95% across the corpus',
    async () => {
      const scores: FixtureScore[] = []
      for (const f of FIXTURES) {
        const out = await callModel(f.artifact)
        const s = scoreFixture(out, f.golden)
        scores.push(s)
        // Diagnostic: surface exactly what beam wrote when it missed
        // recall or tripped a false positive — evidence, not guessing.
        if (s.falsePositives > 0 || (s.goldenCount > 0 && s.recallRate < 1)) {
          console.log(
            `DIAG ${f.id}[${f.archetype}] recall=${s.recallRate.toFixed(2)} fp=${s.falsePositives}\n` +
              `  artifact: ${JSON.stringify(f.artifact).slice(0, 90)}\n` +
              `  golden:   ${JSON.stringify(f.golden)}\n` +
              `  output:   ${JSON.stringify(out).slice(0, 200)}`,
          )
        }
      }
      const agg = aggregate(scores)
      console.log(
        `\nPhase 1b eval — n=${agg.n} ` +
          `conformance=${(agg.meanConformance * 100).toFixed(1)}% ` +
          `recall(nonEmpty)=${(agg.meanRecallNonEmpty * 100).toFixed(1)}% ` +
          `rtFail=${agg.roundTripFailures} ` +
          `coverageFail=${agg.coverageFailures} ` +
          `falsePos=${agg.totalFalsePositives} ` +
          `gate=${agg.gatePass ? 'PASS' : 'FAIL'}\n`,
      )
      // Hard gate (masterplan §5): conformance + round-trip +
      // coverage. recall/falsePos are reported diagnostics (see
      // score.ts rationale), not pass/fail.
      expect(agg.roundTripFailures).toBe(0)
      expect(agg.coverageFailures).toBe(0) // anti-hollow guard (H1)
      expect(agg.meanConformance).toBeGreaterThanOrEqual(0.95)
      expect(agg.gatePass).toBe(true)
    },
    600_000,
  )
})
