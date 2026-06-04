import { describe, expect, it } from 'vitest'
import {
  pageIdFromRef,
  pagePath,
  pageRef,
  slugFromTitle,
} from '../lib/page-urls'

describe('pretty page URLs', () => {
  it('builds a cosmetic slug plus a global atom id', () => {
    expect(
      pageRef({
        _id: 'atom_01ABC',
        title: 'Features',
        path: 'product/features.md',
      }),
    ).toBe('features-atom_01ABC')
    expect(
      pagePath({
        workspaceSlug: 'ice',
        _id: 'atom_01ABC',
        title: 'Features',
        path: 'product/features.md',
      }),
    ).toBe('/ice/features-atom_01ABC')
  })

  it('falls back to the path leaf when the title is blank', () => {
    expect(
      pageRef({
        _id: 'atom_01ABC',
        title: '',
        path: 'Product Roadmap.md',
      }),
    ).toBe('product-roadmap-atom_01ABC')
  })

  it('parses the global atom id from the last dash', () => {
    expect(pageIdFromRef('product-features-atom_01ABC')).toBe('atom_01ABC')
    expect(pageIdFromRef('atom_01ABC')).toBeNull()
    expect(pageIdFromRef('files')).toBeNull()
    expect(pageIdFromRef('signed-out')).toBeNull()
  })

  it('normalizes title text without depending on the slug for identity', () => {
    expect(slugFromTitle('  Product / Features!  ')).toBe('product-features')
    expect(slugFromTitle('')).toBe('page')
  })
})
