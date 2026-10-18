// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { StarterKit } from '@tiptap/starter-kit'
import { afterEach, describe, it, expect } from 'vitest'
import {
  computeWikilinkRanges,
  detectAutocomplete,
  makeWikilinkPlugin,
  wikilinkNodeView,
  wikilinkPluginKey,
  type WikilinkFile,
} from './wikilinkPlugin'
import { desktopMarkdownExtensions } from './extensions'
import { codeBlock, codeMarkText, doc, paragraph, schema } from './testDocs'
import { REF_SELECTED, refChipClass } from '../ui/refChip'

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

describe('the wikilink pill is the reference chip', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const chipClasses = (missing: boolean) => refChipClass(missing).split(' ')
  const glyphOf = (pill: Element) => pill.querySelector('svg')?.getAttribute('class') ?? ''

  it('draws a resolved [[link]] with the file title, its kind glyph and an atom the click handler opens', () => {
    const files = new Map<string, WikilinkFile>([['a', { path: 'notes/a.md', title: 'Alpha' }]])
    const view = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc: doc(paragraph('see [[a]] and [[gone]]')), plugins: [makeWikilinkPlugin(() => files, () => {})] }),
    })
    cleanups.push(() => view.destroy())
    const [resolved, missing] = [...view.dom.querySelectorAll<HTMLElement>('.dohc-wikilink-pill')]

    expect(resolved.textContent).toBe('Alpha')
    expect(resolved.getAttribute('data-wikilink-target')).toBe('a')
    expect(resolved.contentEditable).toBe('false')
    expect(resolved.title).toBe('notes/a.md')
    expect(resolved.hasAttribute('data-missing')).toBe(false)
    expect(resolved.classList).toContain('border-line')
    for (const token of chipClasses(false)) expect(resolved.classList).toContain(token)
    expect(glyphOf(resolved)).toContain('lucide-file-text')

    // A missing target reads as its path, dashed, and still as a page.
    expect(missing.textContent).toBe('gone')
    expect(missing.getAttribute('data-missing')).toBe('true')
    for (const token of chipClasses(true)) expect(missing.classList).toContain(token)
    expect(glyphOf(missing)).toContain('lucide-file-text')
  })

  it('draws the wikilink node with its label and target kind, and shows keyboard node selection', () => {
    const view = wikilinkNodeView(schema.nodes.wikilink.create({ target: 'data/funnel.csv', label: 'Funnel' }))
    const pill = view.dom as HTMLElement

    expect(pill.className).toContain('dohc-wikilink-pill')
    expect(pill.textContent).toBe('Funnel')
    expect(pill.getAttribute('data-dohc-wikilink')).toBe('data/funnel.csv')
    expect(pill.getAttribute('data-dohc-wikilink-label')).toBe('Funnel')
    expect(pill.getAttribute('data-wikilink-target')).toBe('data/funnel.csv')
    expect(pill.contentEditable).toBe('false')
    expect(pill.hasAttribute('data-missing')).toBe(false)
    expect(glyphOf(pill)).toContain('lucide-file-spreadsheet')

    view.selectNode?.()
    expect(pill.classList).toContain(REF_SELECTED)
    view.deselectNode?.()
    expect(pill.classList).not.toContain(REF_SELECTED)

    const unlabeled = wikilinkNodeView(schema.nodes.wikilink.create({ target: 'notes/roads' })).dom as HTMLElement
    expect(unlabeled.textContent).toBe('notes/roads')
    expect(unlabeled.hasAttribute('data-dohc-wikilink-label')).toBe(false)
    expect(glyphOf(unlabeled)).toContain('lucide-file-text')
  })

  it('is the view the desktop editor gives a parsed [[link]], while getHTML keeps the projection form', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit.configure({ trailingNode: false }), ...desktopMarkdownExtensions, Markdown],
      content: 'See [[notes/roads|Roads]].',
      contentType: 'markdown',
    })
    cleanups.push(() => editor.destroy())
    const pill = editor.view.dom.querySelector('.dohc-wikilink-pill[data-dohc-wikilink="notes/roads"]')
    expect(pill?.textContent).toBe('Roads')
    expect(pill?.querySelector('svg')).not.toBeNull()
    expect(editor.getHTML()).toContain('<span class="dohc-wikilink-pill" contenteditable="false" data-wikilink-target="notes/roads" data-dohc-wikilink="notes/roads" data-dohc-wikilink-label="Roads">Roads</span>')
  })
})
