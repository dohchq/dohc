/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { pmDocToMdast, UnknownPmNodeError, type PmNode } from './pmToMdast'
import { serializeMdastToMarkdown } from './markdownRoundtrip'

// M1 step 3 sub-commit 3.6.1 — PM JSON → mdast walker. The whole
// point is that remark-stringify owns escaping/emission/formatting;
// we own the structural mapping. Tests verify:
//   - Each Crepe node type maps to the right mdast equivalent
//   - PM → mdast → markdown roundtrips for common shapes
//   - Unknown nodes throw UnknownPmNodeError (codex 4th-pass
//     concern #2: fail loud, don't emit lossy markdown)

function pm(type: string, attrs: Record<string, unknown> | null, content?: PmNode[]): PmNode {
  const n: PmNode = { type }
  if (attrs) n.attrs = attrs
  if (content) n.content = content
  return n
}
function text(value: string, marks?: PmNode['marks']): PmNode {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
}
const doc = (...children: PmNode[]) => pm('doc', null, children)

describe('M1 step 3.6.1 — pmDocToMdast structural mapping', () => {
  it('top-level non-doc throws UnknownPmNodeError', () => {
    expect(() => pmDocToMdast(pm('paragraph', null, [text('x')]))).toThrow(
      UnknownPmNodeError,
    )
  })

  it('paragraph + text → mdast paragraph + text', () => {
    const md = serializeMdastToMarkdown(pmDocToMdast(doc(pm('paragraph', null, [text('Hello.')]))))
    expect(md.trim()).toBe('Hello.')
  })

  it('heading levels 1-6 preserved', () => {
    for (let level = 1; level <= 6; level++) {
      const md = serializeMdastToMarkdown(
        pmDocToMdast(doc(pm('heading', { level }, [text(`H${level}`)]))),
      )
      expect(md.startsWith('#'.repeat(level) + ' ')).toBe(true)
    }
  })

  it('code_block with language attrs', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('code_block', { language: 'js' }, [text('const x = 1')])),
      ),
    )
    expect(md).toMatch(/^```js\n/)
    expect(md).toContain('const x = 1')
  })

  it('code_block without language (lang:null)', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(doc(pm('code_block', null, [text('plain')]))),
    )
    expect(md).toMatch(/^```\n/)
    expect(md).toContain('plain')
  })

  it('blockquote with nested paragraph', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(doc(pm('blockquote', null, [pm('paragraph', null, [text('quoted')])])))
    )
    expect(md.trim()).toBe('> quoted')
  })

  it('bullet list with multiple items', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(
          pm('bullet_list', null, [
            pm('list_item', null, [pm('paragraph', null, [text('one')])]),
            pm('list_item', null, [pm('paragraph', null, [text('two')])]),
          ]),
        ),
      ),
    )
    expect(md).toMatch(/-\s*one[\s\S]*-\s*two/)
  })

  it('ordered list with start attr', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(
          pm('ordered_list', { order: 1 }, [
            pm('list_item', null, [pm('paragraph', null, [text('first')])]),
            pm('list_item', null, [pm('paragraph', null, [text('second')])]),
          ]),
        ),
      ),
    )
    expect(md).toMatch(/1\.\s*first[\s\S]*2\.\s*second/)
  })

  it('horizontal_rule + thematic_break both → mdast thematicBreak', () => {
    const md1 = serializeMdastToMarkdown(pmDocToMdast(doc(pm('horizontal_rule', null))))
    const md2 = serializeMdastToMarkdown(pmDocToMdast(doc(pm('thematic_break', null))))
    // remark-stringify uses '---' (per our config in 3.1)
    expect(md1.trim()).toContain('---')
    expect(md2.trim()).toContain('---')
  })

  it('image block-level (url + alt + title)', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('image', { src: 'https://example.com/img.png', alt: 'pic' })),
      ),
    )
    expect(md).toContain('![pic](https://example.com/img.png)')
  })

  it('hard_break inside paragraph', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('line1'), pm('hard_break', null), text('line2')])),
      ),
    )
    // remark-stringify emits hard break as backslash+newline or two trailing spaces
    expect(md).toMatch(/line1[\\\s]+line2|line1\n  \nline2/)
  })

  it('emphasis (em) mark', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('it is '), text('italic', [{ type: 'em' }])])),
      ),
    )
    expect(md).toContain('_italic_')
  })

  it('strong (bold) mark', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('be '), text('bold', [{ type: 'strong' }])])),
      ),
    )
    expect(md).toContain('*bold*')
  })

  it('inline code mark', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('try '), text('x = 1', [{ type: 'code' }])])),
      ),
    )
    expect(md).toContain('`x = 1`')
  })

  it('link mark with href + optional title', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(
          pm('paragraph', null, [
            text('click ', undefined),
            text('here', [{ type: 'link', attrs: { href: 'https://x.com', title: 'X' } }]),
          ]),
        ),
      ),
    )
    expect(md).toMatch(/\[here]\(https:\/\/x\.com.*\)/)
  })

  it('strikethrough mark', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('strike', [{ type: 'strikethrough' }])])),
      ),
    )
    expect(md).toMatch(/~~strike~~|~strike~/)
  })
})

describe('M1 step 3.6.1 — dohc-specific text shapes ride through as plain text', () => {
  it('inline atom {key: value} preserved as text', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('salary {salary: 100000} note')])),
      ),
    )
    expect(md).toContain('{salary: 100000}')
  })

  it('formula {= sum() } preserved as text', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('paragraph', null, [text('total: {= sum(salary) }')])),
      ),
    )
    expect(md).toContain('{= sum(salary) }')
  })

  it('query code fence (language: query)', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('code_block', { language: 'query' }, [text('docs.glob("**/*.md")')])),
      ),
    )
    expect(md).toMatch(/^```query\n/)
    expect(md).toContain('docs.glob("**/*.md")')
  })

  it('ascii code fence', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('code_block', { language: 'ascii' }, [text('+--+\n|  |\n+--+')])),
      ),
    )
    expect(md).toMatch(/^```ascii\n/)
  })

  it('html code fence', () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc(pm('code_block', { language: 'html' }, [text('<p>hi</p>')])),
      ),
    )
    expect(md).toMatch(/^```html\n/)
    expect(md).toContain('<p>hi</p>')
  })
})

describe('M1 step 3.6.1 — fail loud on unknown nodes (codex concern #2)', () => {
  it('unknown block node throws UnknownPmNodeError', () => {
    expect(() =>
      pmDocToMdast(doc(pm('unknownBlockType', null, [text('x')]))),
    ).toThrow(UnknownPmNodeError)
  })

  it('unknown inline node throws UnknownPmNodeError (no content recursion fallback)', () => {
    expect(() =>
      pmDocToMdast(doc(pm('paragraph', null, [pm('mystery_node', null)]))),
    ).toThrow(UnknownPmNodeError)
  })

  it('unknown mark throws UnknownPmNodeError', () => {
    expect(() =>
      pmDocToMdast(
        doc(pm('paragraph', null, [text('x', [{ type: 'mystery_mark' }])])),
      ),
    ).toThrow(UnknownPmNodeError)
  })

  it('UnknownPmNodeError carries the offending node type', () => {
    try {
      pmDocToMdast(doc(pm('weird_node', null)))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownPmNodeError)
      expect((e as UnknownPmNodeError).nodeType).toBe('weird_node')
    }
  })
})

describe('M1 step 3.6.1 — full doc roundtrip (composition test)', () => {
  it('multi-block doc serializes coherently', () => {
    const pmDoc = doc(
      pm('heading', { level: 1 }, [text('Title')]),
      pm('paragraph', null, [
        text('Intro with '),
        text('bold', [{ type: 'strong' }]),
        text(' and '),
        text('italic', [{ type: 'em' }]),
        text('.'),
      ]),
      pm('bullet_list', null, [
        pm('list_item', null, [pm('paragraph', null, [text('first')])]),
        pm('list_item', null, [pm('paragraph', null, [text('second')])]),
      ]),
      pm('code_block', { language: 'js' }, [text('const x = 1')]),
      pm('thematic_break', null),
      pm('paragraph', null, [text('After the rule.')]),
    )
    const md = serializeMdastToMarkdown(pmDocToMdast(pmDoc))
    expect(md).toMatch(/^# Title/m)
    expect(md).toMatch(/\*bold\*/)
    expect(md).toMatch(/_italic_/)
    expect(md).toMatch(/-\s*first/)
    expect(md).toMatch(/-\s*second/)
    expect(md).toMatch(/```js/)
    expect(md).toMatch(/---/)
    expect(md).toMatch(/After the rule\./)
  })
})
