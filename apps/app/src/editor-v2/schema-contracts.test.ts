import { describe, expect, it } from 'vitest'
import {
  DOHC_V2_CONSTRUCTS,
  DOHC_V2_SCHEMA_VERSION,
  DOHC_V2_YDOC_FIELDS,
  FIRST_CLASS_V2_CONSTRUCTS,
  assertDohcV2SchemaCompleteness,
} from './schema-contracts'

describe('dohc v2 schema contracts', () => {
  it('pins schema version and canonical Y.Doc fields', () => {
    expect(DOHC_V2_SCHEMA_VERSION).toBe(1)
    expect(DOHC_V2_YDOC_FIELDS).toEqual(['body', 'frontmatter', 'meta'])
  })

  it('covers every required markdown construct before implementation starts', () => {
    expect(() => assertDohcV2SchemaCompleteness()).not.toThrow()
    expect(DOHC_V2_CONSTRUCTS.map((c) => c.name)).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'codeBlock',
      'blockquote',
      'horizontalRule',
      'table',
      'wikilink',
      'inlineAtom',
      'formula',
      'queryBlock',
      'math',
      'htmlAtom',
      'frontmatter',
    ])
  })

  it('keeps AI-native custom constructs first-class and markdown-expressible', () => {
    expect(FIRST_CLASS_V2_CONSTRUCTS).toEqual([
      'wikilink',
      'inlineAtom',
      'formula',
      'queryBlock',
    ])
    for (const name of FIRST_CLASS_V2_CONSTRUCTS) {
      const spec = DOHC_V2_CONSTRUCTS.find((c) => c.name === name)
      expect(spec?.canonical).toBe('tiptap-node')
      expect(spec?.markdown.parse).toBe('custom-extension')
      expect(spec?.markdown.render).toBe('custom-extension')
      expect(spec?.markdown.lossless).toBe(true)
    }
  })

  it('keeps paid Tiptap features out of core schema contracts', () => {
    for (const spec of DOHC_V2_CONSTRUCTS) {
      expect(spec.requiresPaidTiptap).toBe(false)
    }
  })

  it('models frontmatter outside the editable body fragment', () => {
    const frontmatter = DOHC_V2_CONSTRUCTS.find((c) => c.name === 'frontmatter')
    expect(frontmatter?.canonical).toBe('y-map')
    expect(frontmatter?.yjsField).toBe('frontmatter')
    expect(frontmatter?.editableBodyNode).toBe(false)
  })
})
