// M1 step 3 sub-commit 1 — Convex-runtime DECIDER for the markdown
// serializer (architecture doc §Step 1a).
//
// This internalQuery exists ONLY to be invoked from a real Convex
// dev deploy as a one-shot smoke test:
//
//   npx convex run --once internal:markdownRoundtripDecider._runRemarkRoundtrip
//
// Pass = remark works in Convex V8 → adopt library serialization
// for the collab projection writer.
// Fail = bundling/runtime issue → fall back to a hand-rolled
// serializer scoped to Crepe's node set.
//
// The Vitest test (`markdownRoundtrip.test.ts`) exercises the same
// helpers in Node. convex-test runs in Node too, so it catches
// import-path + roundtrip-correctness regressions, but does NOT
// guarantee Convex V8 bundling works — only a real deploy does.

import { internalQuery } from './_generated/server'
import { roundtripMarkdown } from './markdownRoundtrip'

// The fixture set Codex demanded in v3 review pass (expanded from
// v2's single-fixture). Covers dohc's specific content shapes plus
// the standard remark surface area. Each entry pairs an input with
// an expected output (or a property to assert on the round-tripped
// result). The expected outputs are what the FROZEN remark-parse +
// remark-stringify pipeline yields with our configured options.
type Fixture = { name: string; input: string; assert: 'byte-stable' | 'idempotent' }

const FIXTURES: Fixture[] = [
  // Standard surface (covers what most docs contain)
  { name: 'plain-paragraph', input: 'Hello world.\n', assert: 'idempotent' },
  { name: 'headings', input: '# H1\n\n## H2\n\n### H3\n', assert: 'idempotent' },
  { name: 'emphasis', input: 'A _italic_ and *bold* and **bold-star** word.\n', assert: 'idempotent' },
  { name: 'code-fence', input: '```js\nconst x = 1\n```\n', assert: 'idempotent' },
  { name: 'blockquote', input: '> quoted line\n> second line\n', assert: 'idempotent' },
  { name: 'bullet-list', input: '- one\n- two\n- three\n', assert: 'idempotent' },
  { name: 'nested-list', input: '- one\n  - nested\n  - also nested\n- two\n', assert: 'idempotent' },
  { name: 'ordered-list', input: '1. one\n2. two\n3. three\n', assert: 'idempotent' },
  { name: 'horizontal-rule', input: 'before\n\n---\n\nafter\n', assert: 'idempotent' },
  { name: 'link', input: '[label](https://example.com)\n', assert: 'idempotent' },
  { name: 'image', input: '![alt](https://example.com/img.png)\n', assert: 'idempotent' },
  // dohc-specific content shapes (the parts most at risk of being lost
  // on roundtrip — these stay as literal text in the markdown layer
  // because they're decorations the editor applies, not mdast nodes)
  { name: 'inline-atom', input: 'A {salary: 100000} note.\n', assert: 'idempotent' },
  { name: 'formula', input: 'Total: {= sum(salary) }.\n', assert: 'idempotent' },
  { name: 'live-total', input: 'Count: {projects}.\n', assert: 'idempotent' },
  { name: 'wikilink', input: 'See [[clients/acme]] for details.\n', assert: 'idempotent' },
  { name: 'query-block', input: '```query\ndocs.glob("**/*.md")\n```\n', assert: 'idempotent' },
  { name: 'ascii-sketch', input: '```ascii\n  +---+\n  | x |\n  +---+\n```\n', assert: 'idempotent' },
  { name: 'frontmatter-like', input: '---\nid: x\n---\n\nbody\n', assert: 'idempotent' },
  { name: 'html-fence', input: '```html\n<p>hi</p>\n```\n', assert: 'idempotent' },
  // Escapes + edge cases
  { name: 'escaped-brackets', input: 'A \\[literal\\] bracket pair.\n', assert: 'idempotent' },
  { name: 'inline-code', input: 'A `code span` inline.\n', assert: 'idempotent' },
]

export const _runRemarkRoundtrip = internalQuery({
  // Returns a list of {name, status, sample?} so the dev-deploy
  // invoker can see at a glance which fixtures passed.
  // Idempotent: a fixture is "stable" if roundtrip(input) === input;
  // "idempotent" (weaker) if roundtrip(roundtrip(input)) ===
  // roundtrip(input). The weaker test catches whether remark
  // canonicalizes to a stable form on the SECOND pass even if the
  // first pass altered whitespace.
  args: {},
  handler: async () => {
    const results: Array<{
      name: string
      status: 'pass' | 'fail'
      detail: string
    }> = []
    let firstError: string | null = null
    for (const fx of FIXTURES) {
      try {
        const first = roundtripMarkdown(fx.input)
        if (fx.assert === 'byte-stable') {
          if (first === fx.input) {
            results.push({ name: fx.name, status: 'pass', detail: 'byte-stable' })
          } else {
            results.push({
              name: fx.name,
              status: 'fail',
              detail: `byte-stable check failed: input ${JSON.stringify(fx.input)} → ${JSON.stringify(first)}`,
            })
          }
        } else {
          const second = roundtripMarkdown(first)
          if (second === first) {
            results.push({ name: fx.name, status: 'pass', detail: 'idempotent on 2nd pass' })
          } else {
            results.push({
              name: fx.name,
              status: 'fail',
              detail: `idempotency failed: 1st ${JSON.stringify(first)} → 2nd ${JSON.stringify(second)}`,
            })
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        results.push({ name: fx.name, status: 'fail', detail: `threw: ${msg}` })
        if (!firstError) firstError = msg
      }
    }
    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.filter((r) => r.status === 'fail').length
    return {
      summary: `${passed}/${results.length} passed${failed > 0 ? ` (${failed} failed)` : ''}`,
      firstError,
      results,
    }
  },
})
