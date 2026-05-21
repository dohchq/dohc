// D4.8 (extended in D4.8b) — Wikilink rendering + autocomplete.
//
// Two coupled responsibilities in one plugin:
//
//   1. PILL RENDERING. Each `[[path]]` (or `\[\[path]]`) in the doc
//      gets visually REPLACED by a styled chip showing the linked
//      page's title with an icon prefix. The underlying text stays
//      as literal markdown (no schema change) so the rename
//      cascade in convex/{atoms,folders}.move continues to operate
//      on `[[path]]` and the file body roundtrips cleanly through
//      Crepe's markdown serializer.
//      Mechanism: emit a Decoration.widget at the start of the
//      range with the pill DOM, plus a Decoration.inline over the
//      full range with `class: dohc-wikilink-hidden` that
//      collapses the original text via `font-size:0`. The text is
//      still in the document for the cursor + serialization; it
//      just renders invisibly.
//
//   2. AUTOCOMPLETE STATE. When the user types `[[` and starts a
//      query before the closing `]]`, the plugin notifies a
//      callback with `{active, from, query}` describing the
//      incomplete wikilink. A parent React component subscribes
//      via the callback + renders a popover with filtered files.
//      Mouse / keyboard selection dispatches a transaction back
//      to the editor to replace the `[[query` with the chosen
//      path + close brackets.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { PMDocLike, PMNodeLike } from './inlineAtomPlugin'

export const wikilinkPluginKey = new PluginKey('dohc-wikilink')

export type WikilinkFile = {
  /** The vault path (e.g. `playground/a.md`). */
  path: string
  /** Display title — derived by api.atoms.list from frontmatter
   *  name/title or the body's first H1. May be null; fallbacks to
   *  the leaf of the path (e.g. `a`). */
  title?: string | null
  /** D4.8e — rename-proof fileId from frontmatter. Used by the
   *  formula plugin to resolve `{= id.key }` references to the
   *  file's current title. */
  fileId?: string | null
}

export type WikilinkRange = {
  from: number
  to: number
  /** The path text written between `[[` and `]]`, with `.md`
   *  stripped (matches the rename cascade's convention). */
  target: string
}

/** State surfaced to React for the autocomplete popover. `active:
 *  false` means no live `[[query` at the cursor. */
export type AutocompleteState =
  | { active: false }
  | {
      active: true
      /** Doc position of the opening `[` (the first char of `[[`
       *  or `\[\[`). The completion transaction replaces from
       *  this position through the current cursor. */
      from: number
      /** The query string (text between `[[` and the cursor). */
      query: string
    }

const WIKILINK_RE = /\\?\[\\?\[(!?)([^\]\n[]+)\\?\]\\?\]/g

function isCodeMark(m: { type: { name: string; spec?: { code?: boolean } } }) {
  return (
    m.type.name === 'inlineCode' ||
    m.type.name === 'code' ||
    m.type.spec?.code === true
  )
}
function isCodeBlock(node: PMNodeLike | null) {
  return (
    !!node &&
    (node.type.name === 'code_block' ||
      node.type.name === 'codeBlock' ||
      node.type.spec?.code === true)
  )
}

/** PURE: walk text nodes, return wikilink decoration ranges +
 *  resolved targets. Offsets are absolute doc coordinates. */
export function computeWikilinkRanges(doc: PMDocLike): WikilinkRange[] {
  const ranges: WikilinkRange[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if ((node.marks ?? []).some(isCodeMark)) return
    const text = node.text
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const raw = m[2]!
      const target = raw.replace(/\.md$/i, '')
      ranges.push({
        from: pos + m.index,
        to: pos + m.index + m[0].length,
        target,
      })
    }
  })
  return ranges
}

/** PURE: detect an incomplete wikilink at the cursor. Looks at the
 *  text in the current text node UP TO the selection start; if the
 *  trailing characters match `\?[\?[query` (no closing `]]`), we
 *  emit the autocomplete state. */
export function detectAutocomplete(
  doc: PMDocLike,
  cursorPos: number,
): AutocompleteState {
  let found: AutocompleteState = { active: false }
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const nodeStart = pos
    const nodeEnd = pos + node.text.length
    if (cursorPos < nodeStart || cursorPos > nodeEnd) return
    // Slice from node start up to cursor. Find the LAST `[[` (or
    // `\[\[`) in this slice without a closing `]]` between it and
    // the cursor.
    const before = node.text.slice(0, cursorPos - nodeStart)
    // Reject if the slice contains `]]` AFTER the opener — that
    // means the `[[` already closed (it's a complete wikilink).
    const re = /\\?\[\\?\[([^\]\n[]*)$/
    const m = re.exec(before)
    if (!m) return
    const opener = m[0].slice(0, m[0].length - m[1]!.length)
    found = {
      active: true,
      from: nodeStart + before.length - m[0].length,
      query: m[1] ?? '',
    }
    return false // stop descending
  })
  return found
}

/** Build the pill widget DOM for a wikilink range. */
function makePillElement(
  target: string,
  display: string,
  resolved: boolean,
): HTMLElement {
  const span = document.createElement('span')
  span.className =
    'dohc-wikilink-pill' + (resolved ? '' : ' dohc-wikilink-pill--broken')
  span.setAttribute('data-wikilink-target', target)
  // The pill is NOT editable. PM treats contentEditable=false as
  // an atom — clicks land on the widget itself; cursor skips past.
  span.contentEditable = 'false'

  const icon = document.createElement('span')
  icon.className = 'dohc-wikilink-pill__icon'
  icon.setAttribute('aria-hidden', 'true')
  // lucide arrow-up-right
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>'
  span.appendChild(icon)

  const label = document.createElement('span')
  label.className = 'dohc-wikilink-pill__label'
  label.textContent = display
  span.appendChild(label)
  return span
}

/** Resolve display title from the known-files map. Falls back to
 *  the leaf segment of the path (e.g. `playground/a` → `a`). */
function displayFor(
  target: string,
  knownFiles: ReadonlyMap<string, WikilinkFile>,
): { display: string; resolved: boolean } {
  const file =
    knownFiles.get(target) ??
    knownFiles.get(`${target}.md`) ??
    null
  if (file) {
    const t = (file.title ?? '').trim()
    if (t) return { display: t, resolved: true }
    // No title — fall back to leaf of the path.
    const leaf = file.path.replace(/\.md$/i, '').split('/').pop() ?? file.path
    return { display: leaf, resolved: true }
  }
  // Broken — display the bare path; the dashed style signals brokenness.
  return { display: target, resolved: false }
}

function buildWikilinkDecorations(
  doc: unknown,
  knownFiles: ReadonlyMap<string, WikilinkFile>,
  cursorPos: number,
): DecorationSet {
  const ranges = computeWikilinkRanges(doc as PMDocLike)
  const decorations: Decoration[] = []
  for (const r of ranges) {
    // D4.8c — Obsidian-style live preview toggle. When the cursor
    // is INSIDE the wikilink range, render it as SOURCE (the raw
    // [[path]] text styled lightly) so the user can see + edit
    // the link in place. When the cursor is OUTSIDE, render the
    // pill (preview mode). Without this toggle, the cursor was
    // invisible whenever it landed inside the hidden-text region.
    const cursorInside = cursorPos >= r.from && cursorPos <= r.to
    if (cursorInside) {
      decorations.push(
        Decoration.inline(r.from, r.to, {
          class: 'dohc-wikilink-source',
          'data-wikilink-target': r.target,
        } as Record<string, string>),
      )
      continue
    }
    // Preview mode — widget + hide.
    const { display, resolved } = displayFor(r.target, knownFiles)
    decorations.push(
      Decoration.widget(
        r.from,
        () => makePillElement(r.target, display, resolved),
        // side:-1 places the widget BEFORE the underlying text so
        // clicks land on the widget, not on the hidden text behind.
        { side: -1, ignoreSelection: true },
      ),
    )
    decorations.push(
      Decoration.inline(r.from, r.to, {
        class: 'dohc-wikilink-hidden',
        'data-wikilink-source': r.target,
      } as Record<string, string>),
    )
  }
  return DecorationSet.create(doc as never, decorations)
}

/** Build the plugin.
 *  - getKnownFiles: callback for the resolver (live).
 *  - onAutocompleteChange: called whenever the autocomplete state
 *    changes (used by the parent React component to render the
 *    popover). */
export function makeWikilinkPlugin(
  getKnownFiles: () => ReadonlyMap<string, WikilinkFile>,
  onAutocompleteChange: (s: AutocompleteState) => void,
) {
  let last: AutocompleteState = { active: false }
  function notify(next: AutocompleteState) {
    if (next.active && last.active) {
      if (next.from === last.from && next.query === last.query) return
    } else if (!next.active && !last.active) {
      return
    }
    last = next
    onAutocompleteChange(next)
  }
  return new Plugin({
    key: wikilinkPluginKey,
    state: {
      init(_, instance) {
        return buildWikilinkDecorations(
          instance.doc,
          getKnownFiles(),
          instance.selection.from,
        )
      },
      apply(tr, old, _oldState, newState) {
        // D4.8c — rebuild on EITHER doc changes (new wikilinks
        // appeared) OR selection changes (cursor moved into/out
        // of an existing wikilink range — toggle source/preview).
        if (!tr.docChanged && !tr.selectionSet) return old
        return buildWikilinkDecorations(
          newState.doc,
          getKnownFiles(),
          newState.selection.from,
        )
      },
    },
    props: {
      decorations(state) {
        return wikilinkPluginKey.getState(state) as
          | DecorationSet
          | undefined
      },
    },
    // We watch state in `view.update` rather than `apply` so we
    // also catch selection-only changes (the cursor moving over an
    // existing `[[query`).
    view(view) {
      function recompute() {
        const state = view.state
        const s = detectAutocomplete(
          state.doc as unknown as PMDocLike,
          state.selection.from,
        )
        notify(s)
      }
      recompute()
      return {
        update(v) {
          recompute()
        },
        destroy() {
          // Tell the React listener to dismiss when the editor unmounts.
          notify({ active: false })
        },
      }
    },
  })
}
