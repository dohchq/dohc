import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, it, expect } from 'vitest'
import {
  computeWikilinkRanges,
  detectAutocomplete,
  makeWikilinkPlugin,
  wikilinkPluginKey,
  type WikilinkFile,
} from './wikilinkPlugin'
import { codeBlock, codeMarkText, doc, paragraph } from './testDocs'

// D4.8 — wikilink decoration regex tests over real ProseMirror documents
// (testDocs.ts). A single paragraph's text starts at pos 1, so the
// hand-computed positions below match the doc-root-offset convention.

describe('computeWikilinkRanges — wikilink decoration scanner', () => {
  it('finds bare [[path]] in plain text', () => {
    const r = computeWikilinkRanges(doc(paragraph('see [[playground/a]] here')))
    expect(r).toHaveLength(1)
    expect(r[0]?.target).toBe('playground/a')
  })

  it('finds Tiptap-escaped \\[\\[path]] form', () => {
    const r = computeWikilinkRanges(doc(paragraph('see \\[\\[playground/a]] here')))
    expect(r).toHaveLength(1)
    expect(r[0]?.target).toBe('playground/a')
  })

  it('strips the .md suffix from the resolved target', () => {
    const r = computeWikilinkRanges(doc(paragraph('[[notes/a.md]]')))
    expect(r[0]?.target).toBe('notes/a')
  })

  it('finds multiple wikilinks in one text node', () => {
    const r = computeWikilinkRanges(doc(paragraph('see [[a]] and \\[\\[b]] and [[c/d]]')))
    expect(r.map((x) => x.target)).toEqual(['a', 'b', 'c/d'])
  })

  it('skips text inside inline-code marks', () => {
    expect(computeWikilinkRanges(doc(paragraph(codeMarkText('[[no]]'))))).toHaveLength(0)
  })

  it('returns absolute doc offsets that span the entire `[[...]]` (including escapes)', () => {
    // 'x \[\[a]] y' — the wikilink occupies positions 2..9 within
    // the text (length 7). The text node starts at pos 1.
    const r = computeWikilinkRanges(doc(paragraph('x \\[\\[a]] y')))
    expect(r).toHaveLength(1)
    expect(r[0]?.to! - r[0]?.from!).toBe('\\[\\[a]]'.length)
  })

  it('ignores partial matches (a single bracket, etc.)', () => {
    expect(computeWikilinkRanges(doc(paragraph('[notlink] [a[ ]]b')))).toHaveLength(0)
  })

  it('does not match across newlines (paths are single-segment-ish)', () => {
    expect(computeWikilinkRanges(doc(paragraph('[[a\nb]]')))).toHaveLength(0)
  })
})

describe('detectAutocomplete — wikilink picker trigger', () => {
  it('opens for an incomplete wikilink in plain text', () => {
    expect(detectAutocomplete(doc(paragraph('see [[pla')), 10)).toEqual({
      active: true,
      from: 5,
      query: 'pla',
    })
  })

  it('does not open inside fenced code blocks', () => {
    expect(detectAutocomplete(doc(codeBlock('[[nope')), 7)).toEqual({
      active: false,
    })
  })

  it('does not open inside inline code marks', () => {
    expect(detectAutocomplete(doc(paragraph(codeMarkText('[[nope'))), 7)).toEqual({
      active: false,
    })
  })

  it('makeWikilinkPlugin builds a ProseMirror plugin keyed by wikilinkPluginKey', () => {
    // Smoke test of the editor-facing factory (lazy: state.init only runs once
    // added to an EditorState, so no DOM is needed to construct it).
    const knownFiles = new Map<string, WikilinkFile>()
    const plugin = makeWikilinkPlugin(
      () => knownFiles,
      () => {},
    )
    expect(plugin).toBeInstanceOf(Plugin)
    expect(wikilinkPluginKey).toBeInstanceOf(PluginKey)
    expect(plugin.spec.key).toBe(wikilinkPluginKey)
  })
})
