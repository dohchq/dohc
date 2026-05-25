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

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { parseInlineAtoms } from '../lib/inlineAtom'

// Flag lives in the central scaffold; re-exported so existing importers
// (AtomEditor) keep working unchanged.
export { inlineAtomsEnabled } from '../lib/featureFlags'

export const inlineAtomKey = new PluginKey('dohc-inline-atom')

// Minimal structural shapes so the range logic is testable without a
// real ProseMirror/jsdom instance.
export type PMMarkLike = { type: { name: string; spec?: { code?: boolean } } }
export type PMNodeLike = {
  isText?: boolean
  text?: string | null
  marks?: ReadonlyArray<PMMarkLike>
  type: { name: string; spec?: { code?: boolean } }
}
export type PMDocLike = {
  descendants: (
    cb: (
      node: PMNodeLike,
      pos: number,
      parent: PMNodeLike | null,
    ) => boolean | void,
  ) => void
}

export type AtomRange = {
  from: number
  to: number
  kind: 'value' | 'liveTotal' | 'formula'
}

/** A node is "code" (verbatim) if it is a code block or carries an
 *  inline-code mark. Tiptap's inline-code mark is `inlineCode`
 *  (NOT `code`); CommonMark presets may use `code`; some define
 *  `spec.code`. Check all three so atoms are never decorated inside
 *  code. */
function isCodeMark(m: PMMarkLike): boolean {
  return (
    m.type.name === 'inlineCode' ||
    m.type.name === 'code' ||
    m.type.spec?.code === true
  )
}
function isCodeBlock(node: PMNodeLike | null): boolean {
  return (
    !!node &&
    (node.type.name === 'code_block' ||
      node.type.name === 'codeBlock' ||
      node.type.spec?.code === true)
  )
}

/** PURE: walk text nodes, skip code, return atom decoration ranges in
 *  absolute doc coordinates. Offsets map 1:1 because ProseMirror text
 *  node size === JS string length (UTF-16 units), same as the parser. */
export function computeAtomRanges(doc: PMDocLike): AtomRange[] {
  const ranges: AtomRange[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if ((node.marks ?? []).some(isCodeMark)) return
    for (const atom of parseInlineAtoms(node.text)) {
      // atom-address-v1 Phase 3: `{= … }` formulas now ALSO get a
      // range — the token is styled (dohc-atom-formula) and the
      // formula widget anchors its computed value at `to`. v0 inputs
      // contain no `{= }`, so every v0 decoration is byte-identical
      // (Phase 2's parse-only `continue` is intentionally removed
      // here — this is the documented Phase-2→3 contract change).
      ranges.push({ from: pos + atom.start, to: pos + atom.end, kind: atom.kind })
    }
  })
  return ranges
}

function buildAtomDecorations(doc: unknown): DecorationSet {
  const decorations = computeAtomRanges(doc as PMDocLike).map((r) =>
    Decoration.inline(r.from, r.to, {
      class: `dohc-atom dohc-atom-${r.kind}`,
    }),
  )
  return DecorationSet.create(doc as never, decorations)
}

/** Build the plugin. Caller decides whether to register it (flag). */
export function makeInlineAtomPlugin() {
  return new Plugin({
    key: inlineAtomKey,
    state: {
      init(_, instance) {
        return buildAtomDecorations(instance.doc)
      },
      apply(tr, old) {
        if (!tr.docChanged) return old
        return buildAtomDecorations(tr.doc)
      },
    },
    props: {
      decorations(state) {
        return inlineAtomKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}
