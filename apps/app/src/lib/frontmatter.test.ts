import { describe, it, expect } from 'vitest'
import {
  parseFrontmatter,
  frontmatterEntries,
  applyFrontmatter,
  setFrontmatterTitle,
} from './frontmatter'

// D4.22 — page title stored as a frontmatter `title:` property.
describe('setFrontmatterTitle', () => {
  it('adds title after id, before user props', () => {
    const out = setFrontmatterTitle('---\nid: x\nstatus: active\n---\nbody', 'My Page')
    expect(out).toBe('---\nid: x\ntitle: My Page\nstatus: active\n---\nbody')
  })

  it('updates an existing title', () => {
    const out = setFrontmatterTitle('---\nid: x\ntitle: Old\n---\nb', 'New')
    expect(parseFrontmatter(out).meta.title).toBe('New')
  })

  it('blank title drops the key', () => {
    const out = setFrontmatterTitle('---\nid: x\ntitle: Gone\n---\nb', '   ')
    expect(parseFrontmatter(out).meta.title).toBeUndefined()
    expect(parseFrontmatter(out).meta.id).toBe('x') // id kept
  })

  it('adds frontmatter to a bare body', () => {
    expect(setFrontmatterTitle('# content', 'Hi')).toBe(
      '---\ntitle: Hi\n---\n# content',
    )
  })

  it('preserves the content body verbatim', () => {
    const out = setFrontmatterTitle('---\nid: x\n---\nline1\nline2', 'T')
    expect(out).toContain('\nline1\nline2')
  })

  it('seeds a new page via applyFrontmatter (creation path)', () => {
    expect(applyFrontmatter('', { title: 'Project Plan' })).toBe(
      '---\ntitle: Project Plan\n---\n',
    )
  })
})

// D4.19 — page-properties helpers (frontmatter read/write).
describe('frontmatterEntries', () => {
  it('reads ordered key/value entries', () => {
    const body = '---\nid: my-page\nstatus: active\npriority: high\n---\n# Hi'
    expect(frontmatterEntries(body)).toEqual([
      { key: 'id', value: 'my-page' },
      { key: 'status', value: 'active' },
      { key: 'priority', value: 'high' },
    ])
  })

  it('returns [] for a body with no frontmatter', () => {
    expect(frontmatterEntries('# just a heading')).toEqual([])
  })

  it('stringifies non-string values', () => {
    const body = '---\nid: x\ncount: 42\ndone: true\n---\nbody'
    expect(frontmatterEntries(body)).toEqual([
      { key: 'id', value: 'x' },
      { key: 'count', value: '42' },
      { key: 'done', value: 'true' },
    ])
  })
})

describe('applyFrontmatter', () => {
  it('rewrites the frontmatter, preserves the body verbatim', () => {
    const body = '---\nid: x\n---\n# Title\n\nsome content'
    const out = applyFrontmatter(body, { id: 'x', status: 'active' })
    expect(out).toContain('id: x')
    expect(out).toContain('status: active')
    expect(out).toContain('# Title\n\nsome content')
    // round-trips back through the reader
    expect(frontmatterEntries(out)).toEqual([
      { key: 'id', value: 'x' },
      { key: 'status', value: 'active' },
    ])
  })

  it('adds frontmatter to a body that had none', () => {
    const out = applyFrontmatter('# Bare', { client: 'Acme' })
    expect(out).toBe('---\nclient: Acme\n---\n# Bare')
  })

  it('empty props ⇒ drops the frontmatter block entirely', () => {
    expect(applyFrontmatter('---\nid: x\n---\nbody', {})).toBe('body')
  })

  it('preserves the id when other props change (id never lost)', () => {
    const body = '---\nid: keep-me\nstatus: old\n---\nbody'
    const out = applyFrontmatter(body, { id: 'keep-me', status: 'new' })
    expect(parseFrontmatter(out).meta.id).toBe('keep-me')
    expect(parseFrontmatter(out).meta.status).toBe('new')
  })

  it('quotes values with special chars (yaml-safe)', () => {
    const out = applyFrontmatter('---\nid: x\n---\nb', {
      id: 'x',
      note: 'a: colon here',
    })
    // round-trips correctly despite the colon
    expect(parseFrontmatter(out).meta.note).toBe('a: colon here')
  })
})
