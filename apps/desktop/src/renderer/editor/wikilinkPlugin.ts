import { cursorText } from "./cursorText";
import { makeTriggerPlugin } from "./triggerPlugin";
import { isCodeBlock, isCodeMark } from "./pmHelpers";
// D4.8 (extended in D4.8b) — Wikilink rendering + autocomplete.
//
// Two coupled responsibilities in one plugin:
//
//   1. Pill RENDERING. Each `[[path]]` (or `\[\[path]]`) in the doc
//      gets visually replaced by a styled chip showing the linked
//      page's title with an icon prefix. The underlying text stays
//      as literal markdown (no schema change) so a path rename can
//      rewrite `[[path]]` directly in the file body and the body
//      roundtrips cleanly through Tiptap's markdown serializer.
//      Mechanism: emit a Decoration.widget at the start of the
//      range with the pill DOM, plus a Decoration.inline over the
//      full range with `class: dohc-wikilink-hidden` that
//      collapses the original text via `font-size:0`. The text is
//      still in the document for the cursor + serialization; it
//      just renders invisibly.
//
//   2. Autocomplete STATE. When the user types `[[` and starts a
//      query before the closing `]]`, the plugin notifies a
//      callback with `{active, from, query}` describing the
//      incomplete wikilink. A parent React component subscribes
//      via the callback + renders a popover with filtered files.
//      Mouse / keyboard selection dispatches a transaction back
//      to the editor to replace the `[[query` with the chosen
//      path + close brackets.

import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'
import { PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type NodeView } from '@tiptap/pm/view'
import { FILE_KIND_RECORDS, fileKindForPath, type FileKindRecord } from '@dohc/workspace-contracts/kinds'
import { REF_SELECTED } from '../ui/refChip'
import { refElement } from '../ui/refElement'

export const wikilinkPluginKey = new PluginKey<WikilinkState>('dohc-wikilink')

export type WikilinkFile = {
  /** The vault path (e.g. `playground/a.md`). */
  path: string
  /** Display title — derived by api.atoms.list from frontmatter
   *  name/title or the body's first H1. May be null; fallbacks to
   *  the leaf of the path (e.g. `a`). */
  title?: string | null
  /** D4.8e — rename-proof fileId from frontmatter. Consumers use it to
   *  keep references stable when the file path changes. */
  fileId?: string | null
}

type WikilinkRange = {
  from: number
  to: number
  /** The path text written between `[[` and `]]`, with `.md`
   *  stripped (matches the rename cascade's convention). */
  target: string
}

type WikilinkPreview = WikilinkRange & {
  display: string
  /** The file the target resolves to, or null when it resolves to none. */
  path: string | null
  source: boolean
}

type WikilinkState = {
  ranges: WikilinkRange[]
  previews: WikilinkPreview[]
  decorations: DecorationSet
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

// Exported so other trigger surfaces (e.g. mentionTrigger.ts's `@`
// autocomplete) can reuse the same "don't fire inside code" rules
// without re-deriving them.

/** Pure: walk text nodes, return wikilink decoration ranges +
 *  resolved targets. Offsets are absolute doc coordinates. */
export function computeWikilinkRanges(doc: ProseMirrorNode): WikilinkRange[] {
  const ranges: WikilinkRange[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if (node.marks.some(isCodeMark)) return
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

/** Pure: detect an incomplete wikilink at the cursor. Looks at the
 *  text in the current text node UP TO the selection start; if the
 *  trailing characters match `\?[\?[query` (no closing `]]`), we
 *  emit the autocomplete state. */
export function detectAutocomplete(
  doc: ProseMirrorNode,
  cursorPos: number,
  position?: ResolvedPos,
): AutocompleteState {
  const run = cursorText(doc, cursorPos, position)
  if (!run) return { active: false }
  const before = run.text
  // Reject if the slice contains `]]` After the opener — that
  // means the `[[` already closed (it's a complete wikilink).
  const re = /\\?\[\\?\[([^\]\n[]*)$/
  const m = re.exec(before)
  if (!m) return { active: false }
  return {
    active: true,
    from: run.from + before.length - m[0].length,
    query: m[1] ?? '',
  }
}

/** A target names a page unless its extension names another kind: the
 *  link picker writes Markdown paths without `.md`. */
function linkKind(target: string): FileKindRecord {
  const kind = fileKindForPath(target)
  return kind === FILE_KIND_RECORDS.binary ? FILE_KIND_RECORDS.markdown : kind
}

/** The editor's wikilink pill: the reference chip (ui/refElement.ts) as an
 *  atom. ProseMirror treats contentEditable=false as one, so a click lands
 *  on the pill and the cursor steps past it. `data-wikilink-target` is what
 *  the editor's click handler opens. `path` is the resolved file, when the
 *  caller resolved one. */
export function wikilinkPill(
  target: string,
  display: string,
  link: { path: string | null; missing: boolean },
): HTMLElement {
  const pill = refElement({
    path: link.path ?? target,
    title: display,
    kind: link.path ? undefined : linkKind(target),
    missing: link.missing,
    opens: true,
  })
  pill.classList.add('dohc-wikilink-pill')
  pill.setAttribute('data-wikilink-target', target)
  pill.contentEditable = 'false'
  return pill
}

/** The `wikilink` node's view: the same pill, named by the node's label.
 *  The node is not resolved against the workspace, so it never shows as
 *  missing. Keyboard selection of the node shows the chip's selected fill. */
export function wikilinkNodeView(node: ProseMirrorNode): NodeView {
  const target = String(node.attrs.target ?? '')
  const label = node.attrs.label ? String(node.attrs.label) : null
  const dom = wikilinkPill(target, label || target, { path: null, missing: false })
  dom.setAttribute('data-dohc-wikilink', target)
  if (label) dom.setAttribute('data-dohc-wikilink-label', label)
  return {
    dom,
    selectNode: () => dom.classList.add(REF_SELECTED),
    deselectNode: () => dom.classList.remove(REF_SELECTED),
  }
}

/** Resolve display title from the known-files map. Falls back to
 *  the leaf segment of the path (e.g. `playground/a` → `a`). */
function displayFor(
  target: string,
  knownFiles: ReadonlyMap<string, WikilinkFile>,
): { display: string; path: string | null } {
  const file =
    knownFiles.get(target) ??
    knownFiles.get(`${target}.md`) ??
    null
  if (file) {
    const t = (file.title ?? '').trim()
    if (t) return { display: t, path: file.path }
    // No title — fall back to leaf of the path.
    const leaf = file.path.replace(/\.(md|markdown)$/i, '').split('/').pop() ?? file.path
    return { display: leaf, path: file.path }
  }
  // Broken — display the bare path; the dashed style signals brokenness.
  return { display: target, path: null }
}

function buildWikilinkDecorations(
  doc: ProseMirrorNode,
  previews: readonly WikilinkPreview[],
): DecorationSet {
  const decorations: Decoration[] = []
  for (const [index, r] of previews.entries()) {
    // D4.8c — Obsidian-style live preview toggle. When the cursor
    // is inside the wikilink range, render it as SOURCE (the raw
    // [[path]] text styled lightly) so the user can see + edit
    // the link in place. When the cursor is outside, render the
    // pill (preview mode). Without this toggle, the cursor was
    // invisible whenever it landed inside the hidden-text region.
    if (r.source) {
      decorations.push(
        Decoration.inline(r.from, r.to, {
          class: 'dohc-wikilink-source',
          'data-wikilink-target': r.target,
        } as Record<string, string>),
      )
      continue
    }
    // Preview mode — widget + hide.
    decorations.push(
      Decoration.widget(
        r.from,
        () => wikilinkPill(r.target, r.display, { path: r.path, missing: r.path === null }),
        // side:-1 places the widget before the underlying text so
        // clicks land on the widget, not on the hidden text behind.
        { side: -1, ignoreSelection: true, key: JSON.stringify([index, r.target, r.display, r.path]) },
      ),
    )
    decorations.push(
      Decoration.inline(r.from, r.to, {
        class: 'dohc-wikilink-hidden',
        'data-wikilink-source': r.target,
      } as Record<string, string>),
    )
  }
  return DecorationSet.create(doc, decorations)
}

function wikilinkState(
  doc: ProseMirrorNode,
  ranges: WikilinkRange[],
  knownFiles: ReadonlyMap<string, WikilinkFile>,
  cursorPos: number,
  previous?: WikilinkState,
): WikilinkState {
  // Callers may mutate a map or its file entries in place. Compare the rendered
  // values, not map identity, so a transaction can still refresh link titles.
  const previews = ranges.map((range) => ({
    ...range,
    ...displayFor(range.target, knownFiles),
    source: cursorPos >= range.from && cursorPos <= range.to,
  }))
  if (previous && ranges === previous.ranges && previews.every((preview, index) => {
    const old = previous.previews[index]
    return old.source === preview.source && old.display === preview.display && old.path === preview.path
  })) return previous
  return { ranges, previews, decorations: buildWikilinkDecorations(doc, previews) }
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
  return makeTriggerPlugin({
    key: wikilinkPluginKey,
    state: {
      init(_, instance) {
        return wikilinkState(
          instance.doc,
          computeWikilinkRanges(instance.doc),
          getKnownFiles(),
          instance.selection.from,
        )
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged && !tr.selectionSet) return old
        return wikilinkState(
          newState.doc,
          tr.docChanged ? computeWikilinkRanges(newState.doc) : old.ranges,
          getKnownFiles(),
          newState.selection.from,
          tr.docChanged ? undefined : old,
        )
      },
    },
    props: {
      decorations(state) {
        return wikilinkPluginKey.getState(state)?.decorations
      },
    },
    // We watch state in `view.update` rather than `apply` so we
    // also catch selection-only changes (the cursor moving over an
    // existing `[[query`).

  }, detectAutocomplete, onAutocompleteChange)
}
