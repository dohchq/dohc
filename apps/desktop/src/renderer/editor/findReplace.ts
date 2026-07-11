// In-document find & replace — Cmd/Ctrl+F opens a find bar, Cmd/Ctrl+H opens
// it with the replace row expanded. Search state (query, case sensitivity,
// active-match index, the replace row's open/value) lives entirely in a
// ProseMirror plugin, not React state: the plugin is the single source of
// truth, `FindReplaceBar.tsx` just renders whatever it reads off
// `findReplaceKey.getState(editor.state)` and dispatches meta transactions
// back in. That keeps MarkdownEditor.tsx's edit down to "register the
// extension, render the bar" — no new state/refs needed there.
//
// Matching is text-wide and mark-agnostic: `computeMatches` walks the doc's
// text nodes and merges any that are positionally CONTIGUOUS (next node's
// `pos` picks up exactly where the previous one's text ended) into one
// search string before running the query against it. Adjacent text nodes
// inside the same textblock are always contiguous regardless of the marks
// they carry, so `**bo**ld` (a bold "bo" + plain "ld") is searched as
// "bold" — a query for "old" correctly spans the mark boundary. A block
// boundary, or any non-text leaf (hardBreak, an inline atom, …) sitting
// between two text nodes, breaks contiguity and starts a new run, so a
// match never silently jumps across one. Code blocks are NOT excluded —
// find/replace is meant to reach fenced code same as prose.

import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { PMDocLike } from './inlineAtomPlugin'

export const findReplaceKey = new PluginKey<FindReplaceState>('dohc-find-replace')

export type FindMatch = { from: number; to: number }

export type FindReplaceState = {
  open: boolean
  replaceOpen: boolean
  query: string
  replacement: string
  caseSensitive: boolean
  matches: FindMatch[]
  /** Index into `matches`, or -1 when there are none. */
  activeIndex: number
}

export const CLOSED_FIND_REPLACE_STATE: FindReplaceState = {
  open: false,
  replaceOpen: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  matches: [],
  activeIndex: -1,
}

export type FindReplaceAction =
  | { type: 'open'; replace: boolean; query?: string }
  | { type: 'close' }
  | { type: 'setQuery'; query: string }
  | { type: 'setReplacement'; replacement: string }
  | { type: 'toggleCase' }
  | { type: 'toggleReplace' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'sync' }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** PURE: search the doc's text (all of it — prose and code blocks alike)
 *  for `query`, returning absolute-position match ranges in document
 *  order. Adjacent text nodes whose positions are contiguous are merged
 *  into one search run first, so a match can span node/mark boundaries
 *  within a textblock (`**bo**ld` searching "old") without spanning an
 *  actual block boundary or a non-text leaf. */
export function computeMatches(
  doc: PMDocLike,
  query: string,
  caseSensitive: boolean,
): FindMatch[] {
  if (!query) return []
  const matches: FindMatch[] = []
  const re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')

  let runText = ''
  let runStart = -1
  let expectedPos = -1

  const flush = () => {
    if (!runText) return
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(runText)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      matches.push({ from: runStart + m.index, to: runStart + m.index + m[0].length })
    }
    runText = ''
    runStart = -1
  }

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (pos !== expectedPos) {
      flush()
      runStart = pos
    }
    runText += node.text
    expectedPos = pos + node.text.length
  })
  flush()

  return matches
}

/** PURE: wrapping "next match" index. -1 (nothing active yet) starts at 0;
 *  0 matches always yields -1. */
export function nextMatchIndex(count: number, activeIndex: number): number {
  if (count === 0) return -1
  if (activeIndex < 0) return 0
  return (activeIndex + 1) % count
}

/** PURE: wrapping "previous match" index — from -1/nothing-active wraps to
 *  the LAST match, matching how Shift+Enter behaves before any match is
 *  selected. */
export function prevMatchIndex(count: number, activeIndex: number): number {
  if (count === 0) return -1
  if (activeIndex < 0) return count - 1
  return (activeIndex - 1 + count) % count
}

function recomputeMatches(state: FindReplaceState, doc: PMDocLike): FindReplaceState {
  const matches = computeMatches(doc, state.query, state.caseSensitive)
  return { ...state, matches, activeIndex: matches.length ? 0 : -1 }
}

/** PURE: the find/replace state machine. `doc` is only read for the cases
 *  that need to recompute matches (a query/case/open change, or a `sync`
 *  after the doc itself changed) — cheap to call unconditionally. */
export function findReplaceReducer(
  state: FindReplaceState,
  action: FindReplaceAction,
  doc: PMDocLike,
): FindReplaceState {
  switch (action.type) {
    case 'open': {
      const query = action.query !== undefined ? action.query : state.query
      return recomputeMatches(
        { ...state, open: true, replaceOpen: state.replaceOpen || action.replace, query },
        doc,
      )
    }
    case 'close':
      return { ...CLOSED_FIND_REPLACE_STATE }
    case 'setQuery':
      return recomputeMatches({ ...state, query: action.query }, doc)
    case 'toggleCase':
      return recomputeMatches({ ...state, caseSensitive: !state.caseSensitive }, doc)
    case 'setReplacement':
      return { ...state, replacement: action.replacement }
    case 'toggleReplace':
      return { ...state, replaceOpen: !state.replaceOpen }
    case 'next':
      return { ...state, activeIndex: nextMatchIndex(state.matches.length, state.activeIndex) }
    case 'prev':
      return { ...state, activeIndex: prevMatchIndex(state.matches.length, state.activeIndex) }
    case 'sync': {
      // The doc changed underneath an open search (typing, a paste, a
      // replace-active) — recompute, and keep the search progressing
      // forward: first try to hold the SAME match by its (now possibly
      // shifted) start position; if it's gone (e.g. it was just replaced),
      // advance to the nearest remaining match at or after where we were,
      // wrapping to the first only when nothing follows. This makes
      // repeated single "Replace" clicks walk down the document instead of
      // snapping back to the top.
      if (!state.query) return state
      const matches = computeMatches(doc, state.query, state.caseSensitive)
      const prevFrom = state.matches[state.activeIndex]?.from
      let activeIndex: number
      if (matches.length === 0) {
        activeIndex = -1
      } else if (prevFrom === undefined) {
        activeIndex = 0
      } else {
        const exact = matches.findIndex((m) => m.from === prevFrom)
        const forward = exact >= 0 ? exact : matches.findIndex((m) => m.from >= prevFrom)
        activeIndex = forward >= 0 ? forward : 0
      }
      return { ...state, matches, activeIndex }
    }
    default:
      return state
  }
}

/** Build a replace-active transaction. Returns null when there's no active
 *  match. Plain `Transaction#insertText` replacement — it inherits marks
 *  from the replaced range the way ProseMirror normally does for a typed
 *  replacement, and leaves everything outside [from,to) untouched. */
export function buildReplaceActiveTransaction(
  state: EditorState,
  find: Pick<FindReplaceState, 'matches' | 'activeIndex' | 'replacement'>,
): Transaction | null {
  const match = find.matches[find.activeIndex]
  if (!match) return null
  return state.tr.insertText(find.replacement, match.from, match.to)
}

/** Build a replace-all transaction. Applies back-to-front (highest
 *  position first) so each match's [from,to) — computed once against the
 *  ORIGINAL doc — is still valid in the transaction's doc-so-far when its
 *  turn comes, since only positions strictly after it have been edited. */
export function buildReplaceAllTransaction(
  state: EditorState,
  find: Pick<FindReplaceState, 'matches' | 'replacement'>,
): { tr: Transaction; count: number } {
  const tr = state.tr
  const ordered = [...find.matches].sort((a, b) => b.from - a.from)
  for (const match of ordered) {
    tr.insertText(find.replacement, match.from, match.to)
  }
  return { tr, count: find.matches.length }
}

function buildFindDecorations(state: EditorState): DecorationSet | undefined {
  const find = findReplaceKey.getState(state)
  if (!find || !find.open || find.matches.length === 0) return undefined
  const decorations = find.matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class:
        index === find.activeIndex
          ? 'dohc-find-match dohc-find-match--active'
          : 'dohc-find-match',
    }),
  )
  return DecorationSet.create(state.doc, decorations)
}

/** The ProseMirror plugin: owns FindReplaceState and renders match
 *  decorations. All mutation goes through `tr.setMeta(findReplaceKey,
 *  action)` — see `FindReplaceAction`. */
export function makeFindReplacePlugin() {
  return new Plugin<FindReplaceState>({
    key: findReplaceKey,
    state: {
      init: () => CLOSED_FIND_REPLACE_STATE,
      apply(tr, old) {
        const action = tr.getMeta(findReplaceKey) as FindReplaceAction | undefined
        if (action) return findReplaceReducer(old, action, tr.doc as unknown as PMDocLike)
        if (tr.docChanged && old.open && old.query) {
          return findReplaceReducer(old, { type: 'sync' }, tr.doc as unknown as PMDocLike)
        }
        return old
      },
    },
    props: {
      decorations(state) {
        return buildFindDecorations(state)
      },
    },
  })
}

function openFindReplace(editor: Editor, replace: boolean) {
  const { state } = editor
  const { from, to } = state.selection
  const selected = from === to ? '' : state.doc.textBetween(from, to, ' ')
  const tr = state.tr.setMeta(findReplaceKey, {
    type: 'open',
    replace,
    query: selected || undefined,
  } satisfies FindReplaceAction)
  editor.view.dispatch(tr)
}

/** The Tiptap extension: wires Cmd/Ctrl+F and Cmd/Ctrl+H, and registers
 *  the decoration plugin. A ready-made singleton (like `MARKDOWN_EXTENSION`
 *  next to it in MarkdownEditor.tsx) — stateless, safe to share across
 *  editor instances. */
export const findReplaceExtension = Extension.create({
  name: 'dohcFindReplace',
  addProseMirrorPlugins() {
    return [makeFindReplacePlugin()]
  },
  addKeyboardShortcuts() {
    return {
      'Mod-f': ({ editor }) => {
        openFindReplace(editor, false)
        return true
      },
      'Mod-h': ({ editor }) => {
        openFindReplace(editor, true)
        return true
      },
    }
  },
})
