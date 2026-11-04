import { describe, expect, it, vi } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Plugin } from '@tiptap/pm/state'
import { Decoration, type DecorationSet } from '@tiptap/pm/view'
import { makeMermaidPreviewPlugin } from './mermaidRender'
import { codeBlock, doc, paragraph, randomEdit, seededRandom } from './testDocs'

const render = async () => ({ svg: '' })

// Each decoration's range and class; a preview's key holds its fence id, which
// depends on history, so only its position is compared.
function shown(state: EditorState, plugin: Plugin) {
  const { set } = plugin.getState(state) as { set: DecorationSet }
  return set
    .find()
    .map(({ from, to, spec }) => ({ from, to, preview: typeof spec.key === 'string' }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
}

function classes(state: EditorState, plugin: Plugin) {
  const { set } = plugin.getState(state) as { set: DecorationSet }
  // A node decoration keeps its attributes on its type.
  return set
    .find()
    .filter((decoration) => decoration.from !== decoration.to)
    .map((decoration) => ({
      from: decoration.from,
      className: (decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
    }))
    .sort((a, b) => a.from - b.from)
}

function expected(state: EditorState) {
  const plugin = makeMermaidPreviewPlugin(render)
  const fresh = EditorState.create({ doc: state.doc, selection: state.selection, plugins: [plugin] })
  return { shown: shown(fresh, plugin), classes: classes(fresh, plugin) }
}

function randomCursor(document: PMNode, random: () => number): TextSelection {
  const positions: number[] = []
  document.descendants((node, pos) => {
    if (!node.isTextblock) return true
    for (let offset = 0; offset <= node.content.size; offset += 1) positions.push(pos + 1 + offset)
    return false
  })
  return TextSelection.create(document, positions[Math.floor(random() * positions.length)]!)
}

describe('makeMermaidPreviewPlugin — edits', () => {
  it('matches a full rebuild after every edit and cursor move', () => {
    const random = seededRandom(2260)
    const plugin = makeMermaidPreviewPlugin(render)
    let state = EditorState.create({
      doc: doc(
        paragraph('lead'),
        codeBlock('graph TD;\n  A --> B;', 'mermaid'),
        paragraph('between'),
        codeBlock('const x = 1', 'typescript'),
        codeBlock('graph LR;', 'Mermaid'),
        paragraph('after'),
      ),
      plugins: [plugin],
    })
    for (let step = 0; step < 400; step += 1) {
      state = random() < 0.3
        ? state.apply(state.tr.setSelection(randomCursor(state.doc, random)))
        : state.apply(randomEdit(state, random, ['a', ' ', '\n', '-->']))
      const { shown: wanted, classes: wantedClasses } = expected(state)
      expect(shown(state, plugin), `step ${step}`).toEqual(wanted)
      expect(classes(state, plugin), `step ${step}`).toEqual(wantedClasses)
    }
  })

  it('makes no decoration again when typing or moving the cursor away from its diagrams', () => {
    const plugin = makeMermaidPreviewPlugin(render)
    const blocks = Array.from({ length: 2000 }, (_, index) => paragraph(`Paragraph ${index}`))
    let state = EditorState.create({
      doc: doc(codeBlock('graph TD;', 'mermaid'), ...blocks, codeBlock('graph LR;', 'mermaid')),
      plugins: [plugin],
    })
    let middle = 1
    for (let index = 0; index <= 1000; index += 1) middle += state.doc.child(index).nodeSize
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, middle)))
    const widget = vi.spyOn(Decoration, 'widget')
    const node = vi.spyOn(Decoration, 'node')
    try {
      state = state.apply(state.tr.insertText('x'))
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, middle + 3)))
      expect(widget).not.toHaveBeenCalled()
      expect(node).not.toHaveBeenCalled()
    } finally {
      widget.mockRestore()
      node.mockRestore()
    }
    expect(shown(state, plugin)).toEqual(expected(state).shown)
  })
})
