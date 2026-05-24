/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { serializeSnapshotToProjectedBody } from './collabProjectionSerializer'

// M1 step 3 sub-commit 3.6.2 — projection serializer end-to-end.
// The thing the projection writer actually calls. Combines
// pmDocToMdast (3.6.1) + serializeMdastToMarkdown (3.1) +
// splitFrontmatter (existing). Frontmatter preservation is the
// critical contract (codex 4th-pass concern #1).

function pmDocJson(): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'hello world' }],
      },
    ],
  })
}

describe('M1 step 3.6.2 — happy path', () => {
  it('serializes a trivial PM doc + preserves existing frontmatter', () => {
    const fm = '---\nid: my.atom\ntitle: My Atom\n---\n'
    const existingBody = fm + 'old content\n'
    const result = serializeSnapshotToProjectedBody(pmDocJson(), existingBody)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // New body must START with the original frontmatter
      expect(result.newBody.startsWith(fm)).toBe(true)
      // and the rest is what the PM doc serialized to
      expect(result.newRest).toContain('hello world')
      expect(result.newBody).toContain('hello world')
      // The OLD content should NOT be in the new body (replaced)
      expect(result.newBody).not.toContain('old content')
    }
  })

  it('atom with NO existing frontmatter ⇒ new body is just the serialized rest', () => {
    const existingBody = 'no frontmatter here\n'
    const result = serializeSnapshotToProjectedBody(pmDocJson(), existingBody)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newBody).not.toMatch(/^---/)
      expect(result.newBody).toContain('hello world')
      expect(result.newRest).toBe(result.newBody)
    }
  })

  it('preserves frontmatter with multiple keys (title, icon, type, custom)', () => {
    // codex 4th-pass concern #1: seedAtomIdIntoBody only protects
    // `id`. title/icon/type/custom would silently disappear without
    // explicit fm preservation.
    const fm = `---
id: my.atom
title: Q4 Plan
icon: target
type: dashboard
owner: alice
custom_field: literal value
---
`
    const existingBody = fm + 'pre-projection content\n'
    const result = serializeSnapshotToProjectedBody(pmDocJson(), existingBody)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Every key survives byte-identical
      expect(result.newBody).toContain('id: my.atom')
      expect(result.newBody).toContain('title: Q4 Plan')
      expect(result.newBody).toContain('icon: target')
      expect(result.newBody).toContain('type: dashboard')
      expect(result.newBody).toContain('owner: alice')
      expect(result.newBody).toContain('custom_field: literal value')
    }
  })

  it('serializes a richer doc (heading + paragraph + list)', () => {
    const richPm = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Intro paragraph.' }],
        },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
              ],
            },
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = serializeSnapshotToProjectedBody(
      richPm,
      '---\nid: x\n---\nold\n',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newBody).toMatch(/^---[\s\S]+?---\n/) // fm intact
      expect(result.newBody).toMatch(/^# Title/m)
      expect(result.newBody).toContain('Intro paragraph.')
      expect(result.newBody).toMatch(/-\s*first/)
      expect(result.newBody).toMatch(/-\s*second/)
    }
  })
})

describe('M1 step 3.6.2 — failure modes (codex 4th-pass concern #2: fail loud)', () => {
  it('malformed JSON ⇒ ok:false (invalid-pm-json)', () => {
    const result = serializeSnapshotToProjectedBody(
      'not valid json {{{',
      'whatever',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-pm-json')
  })

  it('JSON that parses to non-object ⇒ ok:false (invalid-pm-json)', () => {
    const result = serializeSnapshotToProjectedBody('"just a string"', '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-pm-json')
  })

  it('JSON null ⇒ ok:false (invalid-pm-json)', () => {
    const result = serializeSnapshotToProjectedBody('null', '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-pm-json')
  })

  it('unknown PM node type ⇒ ok:false (unknown-pm-node)', () => {
    const badPm = JSON.stringify({
      type: 'doc',
      content: [{ type: 'someBrandNewCrepeFeature', content: [] }],
    })
    const result = serializeSnapshotToProjectedBody(
      badPm,
      '---\nid: x\n---\nbody\n',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unknown-pm-node')
      expect(result.detail).toContain('someBrandNewCrepeFeature')
    }
  })

  it("non-'doc' root ⇒ ok:false (unknown-pm-node)", () => {
    const badPm = JSON.stringify({
      type: 'paragraph',
      content: [{ type: 'text', text: 'orphan' }],
    })
    const result = serializeSnapshotToProjectedBody(badPm, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown-pm-node')
  })
})

describe('M1 step 3.6.2 — frontmatter edge cases', () => {
  it('frontmatter-like content INSIDE the body (not the prefix) is NOT split off', () => {
    // splitFrontmatter only recognizes the LEADING frontmatter
    // block. A `---` later in the doc is a thematic break, not a
    // second frontmatter. The PM doc would represent it as a
    // thematic_break node; the serialized output would reproduce it.
    // Our serializer doesn't touch that case — it only splits the
    // EXISTING body's leading fm and preserves it.
    const existingBody = 'no leading fm\n\n---\n\nthematic break later\n'
    const result = serializeSnapshotToProjectedBody(pmDocJson(), existingBody)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // No leading fm means newBody has no leading fm
      expect(result.newBody).not.toMatch(/^---\n/)
    }
  })

  it('empty existing body ⇒ no fm to preserve; newBody = serialized rest', () => {
    const result = serializeSnapshotToProjectedBody(pmDocJson(), '')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newBody).toBe(result.newRest)
    }
  })

  it('frontmatter without closing fence (degenerate) ⇒ no fm extracted, whole body is rest', () => {
    // splitFrontmatter bails when there's no `\n---` after the opener
    // (ReDoS guard). The "fm" portion stays inside the body as text;
    // serialized newBody won't have the (non-)fm in it because the
    // PM doc doesn't include it.
    const degenerate = '---\nid: never_closed\nsome more text\n'
    const result = serializeSnapshotToProjectedBody(pmDocJson(), degenerate)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Nothing was extracted as fm → newBody is just the rest
      expect(result.newBody).toBe(result.newRest)
    }
  })
})
