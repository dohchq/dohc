/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import {
  parseMarkdownToMdast,
  serializeMdastToMarkdown,
  roundtripMarkdown,
} from './markdownRoundtrip'

// M1 step 3 sub-commit 1 (multiplayer-and-h-followups §8 + v3
// review feedback) — verifies the markdown ↔ mdast helpers run
// correctly in Node. Convex-runtime feasibility is a SEPARATE
// verification path (push convex/markdownRoundtripDecider.ts to a
// dev deploy + invoke _runRemarkRoundtrip) — this Vitest suite
// catches API regressions + roundtrip correctness, which the
// dev-deploy path also covers but is slower to iterate on.
//
// The fixture set matches the Convex DECIDER's fixtures so the two
// stay in sync. Codex's v3 critique demanded expansion beyond the
// single-roundtrip fixture v2 had; here are the dohc-specific
// shapes Codex flagged as edge-case risks (tables, escapes,
// wikilinks, inline atoms, formulas, query blocks, ASCII sketches,
// frontmatter, code fences, html atoms).

describe('markdownRoundtrip — helpers exist + work in Node', () => {
  it('parses + serializes a trivial document', () => {
    const md = '# Hello\n\nworld.\n'
    const tree = parseMarkdownToMdast(md)
    expect(tree.type).toBe('root')
    expect(tree.children.length).toBeGreaterThan(0)
    const out = serializeMdastToMarkdown(tree)
    expect(out).toContain('# Hello')
    expect(out).toContain('world.')
  })

  it('roundtripMarkdown is idempotent on 2nd pass', () => {
    const md = 'Plain text.\n'
    const once = roundtripMarkdown(md)
    const twice = roundtripMarkdown(once)
    expect(twice).toBe(once)
  })
})

describe('markdownRoundtrip — dohc-specific shapes are preserved', () => {
  // Each test asserts that the SHAPE survives a roundtrip — not
  // necessarily byte-identical (remark normalizes whitespace +
  // chooses canonical forms for things like list bullets). The
  // important invariant: the SEMANTIC content is preserved enough
  // that search/formulas/render still work after a projection.
  it('inline atoms preserved verbatim in text content', () => {
    const md = 'A {salary: 100000} note.\n'
    const out = roundtripMarkdown(md)
    expect(out).toContain('{salary: 100000}')
  })

  it('formulas preserved verbatim', () => {
    const md = 'Total: {= sum(salary) }.\n'
    const out = roundtripMarkdown(md)
    expect(out).toContain('{= sum(salary) }')
  })

  it('live totals preserved verbatim', () => {
    const md = 'Count: {projects}.\n'
    const out = roundtripMarkdown(md)
    expect(out).toContain('{projects}')
  })

  it('wikilinks survive but get backslash-escaped (KNOWN GAP for production)', () => {
    // remark-stringify escapes `[[` as `\[\[` because `[` is the
    // markdown link syntax. Round-trip is LOSSY for wikilinks today:
    //   in:  See [[clients/acme]] for details.
    //   out: See \[\[clients/acme]] for details.
    //
    // PRODUCTION GAP: the collab projection's PM → markdown writer
    // needs to either (a) emit a different markdown form for
    // wikilinks that remark won't escape, OR (b) use a serializer
    // that knows about dohc's wikilink syntax (e.g. a remark plugin
    // like `remark-wiki-link`, or our own custom serializer).
    //
    // Pinning this test against the lossy current behavior so a
    // future fix (adding the wikilink handler) shows up as a passing
    // test that's now strict (just update expectation to verbatim).
    const md = 'See [[clients/acme]] for details.\n'
    const out = roundtripMarkdown(md)
    // Either form is acceptable until the wikilink handler lands.
    // The slug content must survive in some form.
    expect(out).toContain('clients/acme')
    // Document the lossy form — the production serializer must close this.
    expect(out).toMatch(/\\\[\\\[clients\/acme]]|\[\[clients\/acme]]/)
  })

  it('query blocks survive (code fence with `query` lang)', () => {
    const md = '```query\ndocs.glob("**/*.md")\n```\n'
    const out = roundtripMarkdown(md)
    // Language tag + content both preserved
    expect(out).toMatch(/```query/)
    expect(out).toContain('docs.glob("**/*.md")')
  })

  it('ASCII sketches survive (code fence with `ascii` lang)', () => {
    const md = '```ascii\n  +---+\n  | x |\n  +---+\n```\n'
    const out = roundtripMarkdown(md)
    expect(out).toMatch(/```ascii/)
    expect(out).toContain('+---+')
    expect(out).toContain('| x |')
  })

  it('html atom code fence preserved', () => {
    const md = '```html\n<p>hi</p>\n```\n'
    const out = roundtripMarkdown(md)
    expect(out).toMatch(/```html/)
    expect(out).toContain('<p>hi</p>')
  })

  it('YAML-like frontmatter content survives (as a thematic break + content)', () => {
    // Note: remark-parse without remark-frontmatter treats `---` as
    // a thematic break, so true YAML frontmatter parsing requires
    // an additional plugin. For dohc's current usage (atoms.body
    // includes frontmatter as `id: x`), test what happens by
    // default. If this regresses in the collab projection, the
    // fix is to add remark-frontmatter to the unified pipeline.
    const md = '---\nid: x\n---\n\nbody\n'
    const out = roundtripMarkdown(md)
    // The id: line should still be in the output somewhere
    // (either as text content under a thematic break, or as
    // proper YAML frontmatter if we add the plugin later).
    expect(out).toContain('id: x')
    expect(out).toContain('body')
  })
})

describe('markdownRoundtrip — code structure for collab projection', () => {
  it('parser returns mdast Root nodes (callable from server code)', () => {
    const tree = parseMarkdownToMdast('test\n')
    expect(tree.type).toBe('root')
    // The collab projection writer needs to traverse the tree.
    // Verify a paragraph node is present (standard mdast shape).
    expect(tree.children[0]?.type).toBe('paragraph')
  })

  it('parser does not throw on empty input', () => {
    expect(() => parseMarkdownToMdast('')).not.toThrow()
    expect(() => roundtripMarkdown('')).not.toThrow()
  })

  it('parser does not throw on whitespace-only input', () => {
    expect(() => roundtripMarkdown('\n\n   \n')).not.toThrow()
  })

  it('parser does not throw on huge input (collab projection might serialize a large doc)', () => {
    const huge = '# heading\n\n' + 'A paragraph.\n\n'.repeat(1000)
    expect(() => roundtripMarkdown(huge)).not.toThrow()
  })
})
