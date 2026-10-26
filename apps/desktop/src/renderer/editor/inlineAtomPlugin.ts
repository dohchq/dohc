import { documentChange, isCodeBlock, isCodeMark } from "./pmHelpers";
// Inline-atom rendering — a ProseMirror decoration plugin.
//
// Deliberately a *decoration*, not a node/mark: the atom stays as
// literal text in the document model, so the editor never transforms
// it ("markdown stays the truth", UC-3). NOTE: this uses
// `Decoration.inline` over sub-ranges of text nodes — a different and
// offset-sensitive regime vs the ASCII-block plugin's node/widget
// decorations, which is why the range math is a separately unit-tested
// pure function (`computeAtomRanges`). Byte-level survival through
// Tiptap's markdown serializer is a distinct concern still tracked by
// the deferred Tiptap round-trip check.
//
// Additive + flag-gated per the locked re-foundation principle: off by
// default ⇒ no user-facing change until explicitly enabled.

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { parseInlineAtoms } from './inlineAtom'

export const inlineAtomKey = new PluginKey('dohc-inline-atom')

type AtomRange = {
  from: number
  to: number
  kind: 'value'
}

/** Pure: walk one textblock's text nodes, skip code, return atom ranges in
 *  absolute doc coordinates; `start` is where the block's content starts.
 *  Offsets map 1:1 because ProseMirror text node size === JS string length
 *  (UTF-16 units), same as the parser. */
function textblockAtomRanges(block: ProseMirrorNode, start: number): AtomRange[] {
  const ranges: AtomRange[] = []
  block.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if (node.marks.some(isCodeMark)) return
    for (const atom of parseInlineAtoms(node.text)) {
      ranges.push({ from: start + pos + atom.start, to: start + pos + atom.end, kind: atom.kind })
    }
  })
  return ranges
}

/** Pure: every atom range in the doc. */
export function computeAtomRanges(doc: ProseMirrorNode): AtomRange[] {
  const ranges: AtomRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    ranges.push(...textblockAtomRanges(node, pos + 1))
    return false
  })
  return ranges
}

function atomDecorations(ranges: AtomRange[]): Decoration[] {
  return ranges.map((r) =>
    Decoration.inline(r.from, r.to, {
      class: `dohc-atom dohc-atom-${r.kind}`,
    }),
  )
}

/** Build the plugin. Caller decides whether to register it (flag). */
export function makeInlineAtomPlugin() {
  return new Plugin({
    key: inlineAtomKey,
    state: {
      init(_, instance) {
        return DecorationSet.create(instance.doc, atomDecorations(computeAtomRanges(instance.doc)))
      },
      // Only the textblocks the transaction changed are parsed again; the
      // rest of the note's atoms move with the edit.
      apply(tr, old) {
        if (!tr.docChanged) return old
        const { textblocks, mapping } = documentChange(tr.before, tr.doc)
        const decorations = old.map(mapping, tr.doc)
        const first = textblocks[0]
        const last = textblocks.at(-1)
        if (!first || !last) return decorations
        return decorations
          .remove(decorations.find(first.pos + 1, last.pos + last.node.nodeSize - 1))
          .add(tr.doc, atomDecorations(textblocks.flatMap(({ node, pos }) => textblockAtomRanges(node, pos + 1))))
      },
    },
    props: {
      decorations(state) {
        return inlineAtomKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}
