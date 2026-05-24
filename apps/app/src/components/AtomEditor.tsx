import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useConvex, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import {
  parseInlineAtoms,
  parseInlineAtomsFromMarkdown,
} from '../lib/inlineAtom'
import { QUERY_FENCE_RE } from '../lib/dslparse'
import { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx, prosePluginsCtx } from '@milkdown/kit/core'
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import {
  hasAsciiSketchContentMetadata,
  isAsciiSketchLanguage,
} from '../lib/asciiSketchMetadata'
import {
  inlineAtomsEnabled,
  makeInlineAtomPlugin,
  computeAtomRanges,
} from './inlineAtomPlugin'
import {
  makeWikilinkPlugin,
  type AutocompleteState,
  type WikilinkFile,
} from './wikilinkPlugin'
import { WikilinkPicker } from './WikilinkPicker'
import {
  useCollabSync,
  useCollabDocState,
  useCollabBootstrapMutation,
  useRemoteVersion,
  applyRemoteSteps,
  getVersion,
} from '@/lib/collab-sync'
import { sendableSteps } from 'prosemirror-collab'
// M1 step 3 sub-commit 3.2 — schema cache populated from the first
// mounted Crepe; useCollabSync's bootstrap reads it for snapshot
// deserialization. See lib/crepe-schema-cache.ts for the rationale.
import {
  captureSchemaFromEditor,
  getCachedSchema,
  subscribeSchema,
} from '@/lib/crepe-schema-cache'
import type { Schema } from '@milkdown/kit/prose/model'
import type { Id } from '../../convex/_generated/dataModel'

// Global event name that any UI affordance can dispatch to ask AtomShell to
// open the ASCII sketcher modal. The slash menu's "ASCII sketch" item and
// the command palette's "Insert ASCII sketch" entry both fire this.
export const OPEN_SKETCH_EVENT = 'dohc:open-sketch'

const ASCII_SKETCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`
// D4.8 — slash-menu icon for the /link command. lucide "link-2".
const WIKILINK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`

import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

export type AtomEditorHandle = {
  insertCodeBlock: (language: string, content: string) => void
  replaceCodeBlockAt: (pos: number, content: string, language?: string) => void
}

type Props = {
  value: string
  onChange: (next: string) => void
  autoFocus?: boolean
  // sharing-v1 — when set, this atom is opened via a share grant:
  // formulas resolve through evalFormulasShared (scoped to the
  // shared set in the OWNER's workspace), and the own-workspace
  // live-total + query-block resolvers are disabled (v1).
  shareId?: Id<'atomShares'>
  // sharing-v1 — view-only shared atom: Crepe is read-only.
  readOnly?: boolean
  // M1 step 2 (multiplayer-and-h-followups §8) — opt-in collab
  // mode. When set, the doc id (atom:<ws>:<atomId> or
  // share:<shareId>) is used to mount the prosemirror-sync
  // plugins via useCollabSync. UNSET by default — every existing
  // call site stays single-user. The wiring is staged behind this
  // flag so a regression is bounded to multiplayer callers only.
  //
  // V1 LIMITATION (documented for follow-up): when a snapshot
  // exists server-side, the editor briefly mounts with the local
  // `value` (markdown) before the first remote-pull rebases to
  // the server state. The window is one rebase cycle (< 1s with
  // a warm connection); acceptable for v1 since the first user
  // input also triggers a rebase. A future commit will bootstrap
  // the editor directly from the server snapshot (waits for
  // useCollabSync.bootstrap.ready before mounting Crepe).
  multiplayerDocId?: string
  /** Fired when the user clicks an `language: ascii` code block. The
   *  position is the doc offset of the node — pass it back to
   *  replaceCodeBlockAt on commit. */
  onAsciiBlockClick?: (pos: number, content: string, language: string) => void
  // D4.8 — wikilink rendering + click + autocomplete. `knownFiles`
  // is the live list of vault files (path + title) used for both
  // pill resolution and the autocomplete picker; `onOpenWikilink`
  // is called when the user clicks a wikilink pill.
  knownFiles?: ReadonlyArray<WikilinkFile>
  onOpenWikilink?: (target: string) => void
}

// A ProseMirror plugin that (1) decorates `language: ascii` code blocks
// with a marker class so CSS can strip the Crepe code-block chrome and
// (2) intercepts clicks on those blocks to fire a callback. The callback
// is held in a ref so callers can swap it without rebuilding the editor.
const asciiBlockKey = new PluginKey('dohc-ascii-block')

function makeAsciiBlockPlugin(
  onClickRef: React.RefObject<
    ((pos: number, content: string, language: string) => void) | null
  >,
) {
  return new Plugin({
    key: asciiBlockKey,
    state: {
      init(_, instance) {
        return buildAsciiDecorations(instance.doc, onClickRef)
      },
      apply(tr, old) {
        if (!tr.docChanged) return old
        return buildAsciiDecorations(tr.doc, onClickRef)
      },
    },
    props: {
      decorations(state) {
        return asciiBlockKey.getState(state) as DecorationSet | undefined
      },
      // No more whole-block click handler — the block now behaves like
      // text: clicks select, drags highlight, ⌘C copies. The user opens
      // the sketcher via a small "edit" button rendered as a widget
      // decoration next to the block (see buildAsciiDecorations).
    },
  })
}

type DocLike = {
  descendants: (
    cb: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string; nodeSize: number }, pos: number) => boolean | void,
  ) => void
}

function buildAsciiDecorations(
  doc: unknown,
  onClickRef: React.RefObject<
    ((pos: number, content: string, language: string) => void) | null
  >,
): DecorationSet {
  const decorations: Decoration[] = []
  ;(doc as DocLike).descendants((node, pos) => {
    if (
      node.type.name === 'code_block' &&
      isAsciiSketchLanguage(node.attrs.language)
    ) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `ascii-sketch-block${hasAsciiSketchContentMetadata(node.textContent) ? ' ascii-sketch-block-has-metadata' : ''}`,
        }),
      )
      // An "edit" button rendered as a zero-width widget right before the
      // block. CSS positions the button absolutely so it floats over the
      // block's top-left corner and only fades in on hover. We use side:-1
      // so the widget binds to the position of the block itself; the
      // closure captures `pos` and the current text/language so clicks
      // open the sketcher with the right content.
      const blockPos = pos
      const content = node.textContent
      const language = String(node.attrs.language ?? 'ascii')
      decorations.push(
        Decoration.widget(
          blockPos,
          () => {
            const wrap = document.createElement('span')
            wrap.className = 'ascii-sketch-edit-affordance'
            wrap.setAttribute('contenteditable', 'false')
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ascii-sketch-edit-btn'
            btn.title = 'edit sketch'
            btn.innerHTML =
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg><span>edit</span>'
            // Stop the editor from interpreting the mousedown as starting
            // a selection inside the block.
            btn.addEventListener('mousedown', (e) => {
              e.preventDefault()
              e.stopPropagation()
            })
            btn.addEventListener('click', (e) => {
              e.preventDefault()
              e.stopPropagation()
              onClickRef.current?.(blockPos, content, language)
            })
            wrap.appendChild(btn)
            return wrap
          },
          { side: -1, key: `ascii-edit-${blockPos}` },
        ),
      )
    }
  })
  return DecorationSet.create(doc as never, decorations)
}

// Humanize a query fence so the user sees WHAT it shows, not raw DSL.
// `entities.list("project", { "status": "in-progress" })`
//   → "project · status: in-progress"
// Defensive: any parse miss falls back to the first non-empty line.
export function humanizeQuery(src: string): string {
  // This runs in buildQueryDecorations on EVERY keystroke (the query
  // block is a live editable code_block — a user can paste a JWT /
  // base64 / minified line into it). Hard-cap the scanned text AND
  // bound every quantifier: the prior `([a-zA-Z_]+)\.([a-zA-Z_]+)`
  // backtracked O(n²) on a long no-dot word run (200k → ~20s editor
  // freeze; subagent). A real query is tens of chars — 600 is plenty.
  const text = (src ?? '').trim().slice(0, 600)
  const m = /([a-zA-Z_]{1,40})\.([a-zA-Z_]{1,40})\s*\(\s*"([^"]{1,120})"/.exec(
    text,
  )
  if (!m) {
    const first = text.split('\n').find((l) => l.trim())
    return first ? first.trim().slice(0, 80) : 'live data'
  }
  const resource = m[3]
  const filters: string[] = []
  const brace = /\{([^}]{0,400})\}/.exec(text.slice(m.index))
  if (brace) {
    const re = /"([^"]+)"\s*:\s*"?([^",}]+?)"?\s*(?:,|$)/g
    let f: RegExpExecArray | null
    while ((f = re.exec(brace[1])) !== null) {
      filters.push(`${f[1]}: ${f[2].trim()}`)
    }
  }
  return filters.length ? `${resource} · ${filters.join(' · ')}` : resource
}

// Mirror of the ascii-block plugin for `language: query`: tame the
// glaring Crepe code-block chrome and prepend a calm human caption so
// a query reads as an intentional "live data" element, not scary DSL
// (impressions #17). The raw query stays an editable code block —
// markdown is still the truth; a power user edits it directly.
const queryBlockKey = new PluginKey('dohc-query-block')
// atom-address-v1 §5.2 Phase-4 (4B-editor) — KILL THE SLOP BOX. The
// query block kept showing its DSL *source* (`docs.find(…)`) and no
// data. Now the evaluated RESULT renders right after it (reactive via
// evalQueryBlocks; the literal DSL stays the editable source/truth —
// manifesto locked-#1, mirrors the Phase-3 formula widget). The
// server already fail-soft'd: `value:null` ⇒ an error (raw message
// NEVER on the wire) ⇒ a calm `—`; a string ⇒ render it (incl.
// legit `_(no match)_` / truncation — those are results, not errors).
// Result is rendered as SAFE preformatted text (textContent, no
// innerHTML/XSS; ascii heatmaps render correctly; rich-markdown
// rendering is a noted polish follow-up, not slop).
type QueryResultMap = Map<string, { value: string | null }>

function buildQueryDecorations(
  doc: unknown,
  map: QueryResultMap,
): DecorationSet {
  const decorations: Decoration[] = []
  ;(doc as DocLike).descendants((node, pos) => {
    if (
      node.type.name === 'code_block' &&
      String(node.attrs.language ?? '')
        .trim()
        .toLowerCase() === 'query'
    ) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'query-atom-block',
        }),
      )
      const label = humanizeQuery(node.textContent)
      decorations.push(
        Decoration.widget(
          pos,
          () => {
            const wrap = document.createElement('div')
            wrap.className = 'query-atom-caption'
            wrap.setAttribute('contenteditable', 'false')
            wrap.innerHTML =
              '<span class="query-atom-dot"></span><span class="query-atom-live">live</span>'
            const t = document.createElement('span')
            t.className = 'query-atom-label'
            t.textContent = label
            wrap.appendChild(t)
            return wrap
          },
          { side: -1, key: `query-cap-${pos}-${label}` },
        ),
      )
      // the RESULT — verbatim code-fence text is the key (code is not
      // markdown-escaped, so doc text === markdown fence === server
      // src; no Phase-3-style escape mismatch).
      const src = node.textContent.trim()
      const entry = map.get(src)
      if (entry !== undefined) {
        const v = entry.value
        const state = v === null ? 'E' : String(v.length)
        decorations.push(
          Decoration.widget(
            pos + node.nodeSize,
            () => {
              const el = document.createElement('div')
              el.setAttribute('contenteditable', 'false')
              if (v === null) {
                el.className = 'query-atom-empty'
                el.textContent = '—'
                el.title = "couldn't run this query — edit it above"
              } else {
                el.className = 'query-atom-result'
                el.textContent = v // SAFE: text only, no innerHTML
              }
              return el
            },
            { side: 1, key: `qr-${pos}-${src}-${state}` },
          ),
        )
      }
    }
  })
  return DecorationSet.create(doc as never, decorations)
}

function makeQueryBlockPlugin(mapRef: React.RefObject<QueryResultMap>) {
  return new Plugin({
    key: queryBlockKey,
    state: {
      init(_, instance) {
        return buildQueryDecorations(instance.doc, mapRef.current ?? new Map())
      },
      apply(tr, old) {
        if (!tr.docChanged && !tr.getMeta(queryBlockKey)) return old
        return buildQueryDecorations(tr.doc, mapRef.current ?? new Map())
      },
    },
    props: {
      decorations(state) {
        return queryBlockKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}

// "Live total" {identifier} tokens are the doc's mdx-like cross-file
// imports: a NAMED projection computed across the user's whole vault
// (defined via define_rollup). The markdown keeps the literal token
// forever (UC-3 — the source stays the truth); the EDITOR renders the
// resolved value beside it so the dashboard is visibly CONNECTED to
// the other files and updates live as their {key:n} atoms change.
// Resolution is async+reactive, fed from React via a ref + a refresh
// meta (mirrors the ascii plugin's ref pattern). Reuses the
// unit-tested computeAtomRanges for the ranges (no parallel walk);
// the identifier is read back from the doc text (token = {ident}).
const liveTotalKey = new PluginKey('dohc-live-total')

// D4.8h — liveTotal handling folded into the unified
// makeAtomPillPlugin below; liveTotalKey is retained because the
// meta-tick mechanism (`tr.setMeta(liveTotalKey, true)`) is still
// dispatched from the live-totals refresh effect to force a
// decoration rebuild when computed values change.

// atom-address-v1 §3 Phase 3 (3B) — the formula value widget. An
// EXACT parallel of the live-total mechanism above (own PluginKey,
// own ref/tick, own builder) so the shipped live-total path is
// untouched (zero regression). Renders evalFormulas' computed value
// AFTER the verbatim `{= … }` token (UC-3: the token is the eternal
// source, never rewritten — this is a view-only widget). A malformed
// /half-typed `{= sum(lo` is not a formula atom ⇒ no range ⇒ no
// chip ⇒ calm plain source (§3 NIT #5, for free via the parser).
const formulaKey = new PluginKey('dohc-formula')
// A Map (NOT a plain object) — `src` keys are author-influenceable;
// a Map.get lookup is prototype-pollution-proof (Codex P3-fold).
type FormulaMap = Map<string, { value: number | string | null }>

/** Resolve a formula's dotted address to {file, key-suffix}. Tries
 *  the longest prefix as a fileId first (so `projects.acme.billable`
 *  prefers `projects.acme` as the file over `projects`). Returns
 *  null if no prefix matches a known file. */
function resolveFormulaAddress(
  segments: string[],
  fileIdMap: ReadonlyMap<string, { path: string; title?: string | null }>,
): { file: { path: string; title?: string | null }; keySuffix: string } | null {
  for (let i = segments.length; i > 0; i--) {
    const candidate = segments.slice(0, i).join('.')
    const file = fileIdMap.get(candidate)
    if (file) {
      return { file, keySuffix: segments.slice(i).join('.') }
    }
  }
  return null
}

function formatFormulaValue(
  v: number | string | null | undefined,
): { text: string; broken: boolean } {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return { text: String(Math.round(v * 100) / 100), broken: false }
  }
  if (typeof v === 'string' && v.length > 0) return { text: v, broken: false }
  return { text: '—', broken: true }
}

/** D4.8h — unified atom pill DOM. Used by all three `{}` kinds
 *  (value / liveTotal / formula). The pill is minimal: just the
 *  rendered value, with the source as a hover tooltip. Click +
 *  keyboard nav into the range expand it back to source for
 *  editing. */
function makeAtomPillElement(args: {
  valueText: string
  isBroken: boolean
  kind: 'value' | 'liveTotal' | 'formula'
  rawSource: string
  fromPos: number
}): HTMLElement {
  const el = document.createElement('span')
  el.setAttribute('contenteditable', 'false')
  el.className =
    'dohc-atom-pill dohc-atom-pill--' +
    args.kind +
    (args.isBroken ? ' dohc-atom-pill--broken' : '')
  el.title = args.rawSource
  el.setAttribute('data-atom-pos', String(args.fromPos))
  el.textContent = args.valueText
  return el
}

/** D4.8h → D4.10 — moved to convex/inlineAtom.ts as
 *  `formatValueAtomText` so the editor pill AND the server-side
 *  HTML substitution share one impl. Local thin wrapper kept for
 *  the existing call site. */
function formatValueAtom(
  v: string | number | boolean,
  valueType: string,
): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(Math.round(v * 100) / 100)
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (valueType === 'date' && typeof v === 'string') return v
  return String(v)
}

/** D4.8h — unified pill builder for ALL `{}` atoms. Each kind has
 *  its own value source (typed for value, lookup for liveTotal,
 *  computed for formula) but the visual pattern is the same:
 *    cursor INSIDE  → source visible + value chip at r.to for
 *                     non-value kinds.
 *    cursor OUTSIDE → pill at r.from + source hidden via
 *                     dohc-atom-hidden font-size:0.
 *  Replaces the old formula-only buildFormulaDecorations + the
 *  liveTotalPlugin (folded in here). */
function buildAtomPillDecorations(
  doc: unknown,
  formulaMap: FormulaMap,
  liveTotalMap: Record<string, number | null>,
  fileIdMap: ReadonlyMap<string, { path: string; title?: string | null }>,
  cursorPos: number,
): DecorationSet {
  // Future hook — keep the param around so callers don't have to
  // change when we surface the resolved title in pill tooltips.
  void fileIdMap

  const d = doc as { textBetween: (from: number, to: number) => string }
  const decorations: Decoration[] = []
  for (const r of computeAtomRanges(doc as never)) {
    const parsed = parseInlineAtoms(d.textBetween(r.from, r.to))[0]
    if (!parsed) continue
    const cursorInside = cursorPos >= r.from && cursorPos <= r.to

    // Resolve display text + broken-state + whether the value is
    // known yet (skips pill render if not).
    let pillText = ''
    let isBroken = false
    let hasResolvedValue = true
    let rawSource = d.textBetween(r.from, r.to)
    if (parsed.kind === 'value') {
      pillText = formatValueAtom(parsed.value, parsed.valueType)
    } else if (parsed.kind === 'liveTotal') {
      const ident = d.textBetween(r.from + 1, r.to - 1).trim()
      rawSource = `{${ident}}`
      if (!ident || !(ident in liveTotalMap)) {
        hasResolvedValue = false
      } else {
        const v = liveTotalMap[ident]
        if (typeof v === 'number' && Number.isFinite(v)) {
          pillText = String(Math.round(v * 100) / 100)
        } else {
          pillText = '—'
          isBroken = true
        }
      }
    } else {
      // formula
      const fa = parsed
      rawSource = `{= ${fa.src} }`
      const entry = formulaMap.get(fa.src)
      if (entry === undefined) {
        hasResolvedValue = false
      } else {
        const r2 = formatFormulaValue(entry.value)
        pillText = r2.text
        isBroken = r2.broken
      }
    }

    if (cursorInside) {
      // SOURCE MODE — value-kind atoms need no chip (the value IS
      // the source). Non-value kinds get the live-total chip
      // appended after the source so the user can edit + see the
      // computed value side by side.
      if (parsed.kind === 'value' || !hasResolvedValue) continue
      const text = pillText
      const broken = isBroken
      const src = rawSource
      decorations.push(
        Decoration.widget(
          r.to,
          () => {
            const el = document.createElement('span')
            el.setAttribute('contenteditable', 'false')
            el.className = broken ? 'live-total-empty' : 'live-total-value'
            el.title = src
            el.textContent = text
            return el
          },
          { side: 1, key: `vc-${r.to}-${parsed.kind}-${text}` },
        ),
      )
      continue
    }

    // PREVIEW MODE — pill + hide. Skip if value not yet resolved
    // (let the existing inlineAtom inline-decoration styling
    // show the raw token so the user isn't staring at an empty
    // pill).
    if (!hasResolvedValue) continue
    decorations.push(
      Decoration.widget(
        r.from,
        () =>
          makeAtomPillElement({
            valueText: pillText,
            isBroken,
            kind: parsed.kind,
            rawSource,
            fromPos: r.from,
          }),
        {
          side: -1,
          ignoreSelection: true,
          key: `pill-${r.from}-${parsed.kind}-${pillText}`,
        },
      ),
    )
    decorations.push(
      Decoration.inline(r.from, r.to, {
        class: 'dohc-atom-hidden',
      }),
    )
  }
  return DecorationSet.create(doc as never, decorations)
}

/** D4.8h — unified atom-pill plugin. Replaces the old separate
 *  formula + liveTotal plugins (folded into one). All `{}` atoms
 *  get the same source/preview toggle: cursor outside renders
 *  a pill; cursor inside renders raw source + (for liveTotal +
 *  formula) a value chip after the source. Value-kind atoms
 *  need no chip (the value IS the source). */
function makeAtomPillPlugin(
  formulaMapRef: React.RefObject<FormulaMap>,
  liveTotalMapRef: React.RefObject<Record<string, number | null>>,
  fileIdMapRef: React.RefObject<
    ReadonlyMap<string, { path: string; title?: string | null }>
  >,
) {
  return new Plugin({
    key: formulaKey,
    state: {
      init(_, instance) {
        return buildAtomPillDecorations(
          instance.doc,
          formulaMapRef.current ?? new Map(),
          liveTotalMapRef.current ?? {},
          fileIdMapRef.current ?? new Map(),
          instance.selection.from,
        )
      },
      apply(tr, old, _oldState, newState) {
        // Rebuild on doc change, meta tick (value updates from
        // either map's reactive refresh), OR selection change
        // (cursor in/out toggles preview/source mode).
        if (
          !tr.docChanged &&
          !tr.getMeta(formulaKey) &&
          !tr.getMeta(liveTotalKey) &&
          !tr.selectionSet
        )
          return old
        return buildAtomPillDecorations(
          newState.doc,
          formulaMapRef.current ?? new Map(),
          liveTotalMapRef.current ?? {},
          fileIdMapRef.current ?? new Map(),
          newState.selection.from,
        )
      },
    },
    props: {
      decorations(state) {
        return formulaKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}

type CrepeEditorProps = {
  defaultValue: string
  onChangeRef: React.RefObject<(next: string) => void>
  autoFocus: boolean
  crepeRef: React.RefObject<Crepe | null>
  onAsciiClickRef: React.RefObject<
    ((pos: number, content: string, language: string) => void) | null
  >
  liveTotalsRef: React.RefObject<Record<string, number | null>>
  liveTotalsTick: number
  formulaRef: React.RefObject<FormulaMap>
  formulaTick: number
  queryResultsRef: React.RefObject<QueryResultMap>
  queryTick: number
  // D4.8 — wikilink plugin coordination refs + the file list for
  // the autocomplete picker (live, so the picker re-filters as
  // the user types).
  knownFilesRef: React.RefObject<ReadonlyMap<string, WikilinkFile>>
  knownFilesArray: ReadonlyArray<WikilinkFile>
  onOpenWikilinkRef: React.RefObject<((target: string) => void) | null>
  // D4.8e — fileId → file map for the formula plugin's preview-mode
  // title resolution.
  fileIdMapRef: React.RefObject<
    ReadonlyMap<string, { path: string; title?: string | null }>
  >
  readOnly?: boolean
  // M1 step 2 — multiplayer collab opt-in. When set, useCollabSync
  // resolves the schema + bootstraps the snapshot + returns the two
  // plugins (prosemirror-collab + sync bridge). Plugins are folded
  // into prosePluginsCtx alongside the existing inline-atom set.
  // UNSET ⇒ single-user editor, byte-identical to pre-M1 behavior.
  multiplayerDocId?: string
}

function CrepeEditor({
  defaultValue,
  onChangeRef,
  autoFocus,
  crepeRef,
  onAsciiClickRef,
  liveTotalsRef,
  liveTotalsTick,
  formulaRef,
  formulaTick,
  queryResultsRef,
  queryTick,
  knownFilesRef,
  knownFilesArray,
  onOpenWikilinkRef,
  fileIdMapRef,
  readOnly,
  multiplayerDocId,
}: CrepeEditorProps) {
  // D4.8b — autocomplete state from the wikilink plugin.
  const [acState, setAcState] = useState<AutocompleteState>({
    active: false,
  })
  const setAcStateRef = useRef(setAcState)
  useEffect(() => {
    setAcStateRef.current = setAcState
  }, [])

  // M1 step 2 — collab plugins (off by default). Schema is null
  // until Crepe mounts (the bootstrap returns 'ready' without one
  // when disabled). When `multiplayerDocId` is set, the hook
  // bootstraps the snapshot + builds the prosemirror-collab +
  // sync-bridge plugins; we capture them in a ref so the
  // useEditor closure (which runs once at mount) can pick them
  // up. V1 limitation: closure-once means the plugins must be
  // ready before mount, OR they get attached late and lose their
  // chance to gate the first user edits. We currently START the
  // editor without waiting (defaultValue mode); when the bootstrap
  // resolves AFTER mount, the plugins are still added (via the
  // ctx.update path below) but the local clock is already past
  // version 0. The remote-pull effect rebases on first divergence,
  // converging to server state in one cycle. The follow-up commit
  // hardens this with a loading gate.
  // M1 step 3.2 + 3.6.5 codex BLOCKER #4 — pull schema via
  // subscribeSchema (NOT polling getCachedSchema on every render).
  //
  // Why subscribe: captureSchemaFromEditor fires its subscribers
  // after the editor mounts. Polling via "re-check on every
  // render" only worked if SOMETHING ELSE re-rendered the
  // component after schema capture. The first multiplayer mount
  // had no such trigger → bootstrap/collab stayed unarmed until
  // an unrelated state change (a Convex query update, a parent
  // re-render, a user keystroke). subscribeSchema forces the
  // re-render via setState — guaranteed.
  const [cachedSchema, setCachedSchema] = useState<Schema | null>(
    () => getCachedSchema(),
  )
  useEffect(() => {
    // Fires sync if cache already warm; otherwise queues + fires
    // on captureSchemaFromEditor.
    const unsub = subscribeSchema((s) => setCachedSchema(s))
    return unsub
  }, [])
  // M1 step 3.8.1.7 — codex 8th-pass [P1] #1 GATE.
  //
  // useCollabSync was previously enabled as soon as multiplayer
  // was on. On a fresh doc it would fetch snapshot → null →
  // build plugins at startVersion=0. The bootstrap mutation
  // (sub-3.5) then created snapshot at v=1. By the time the
  // plugins installed, their local version (0) was behind the
  // server (1). First submitSteps would race-needs-rebase; remote-
  // pull would receive a snapshot and try to apply it via
  // receiveTransaction — which is designed for steps, not full
  // snapshots. The user's editor state could end up in an
  // inconsistent place.
  //
  // FIX: gate useCollabSync.enabled on bootstrapState.phase ===
  // 'ok'. The chain becomes:
  //
  //   1. Crepe mounts with markdown body (single-user mode)
  //   2. PM JSON extraction effect captures pmJsonStr
  //   3. useCollabBootstrapMutation fires — server creates
  //      collabDocs row + writes snapshot at v=1
  //   4. bootstrapState.phase = 'ok'
  //   5. useCollabSync NOW enabled → fetches snapshot v=1 →
  //      builds plugins with startVersion=1
  //   6. Late-install effect installs plugins
  //   7. Crepe becomes writable (3.8.1.7 read-only effect below)
  //
  // collabSync is referenced BEFORE bootstrapState — declared
  // first, but with the gate referencing bootstrapState below.
  // We forward-declare here by deferring to the actual hook
  // call AFTER bootstrap mutation runs. Order is preserved.
  const activeWorkspaceIdForBootstrap = useActiveWorkspaceId()
  const [pmJsonStr, setPmJsonStr] = useState<string | null>(null)
  const bootstrapState = useCollabBootstrapMutation({
    docId: multiplayerDocId ?? null,
    body: multiplayerDocId ? defaultValue : null,
    pmJsonStr,
    activeWorkspaceId: activeWorkspaceIdForBootstrap,
    enabled: !!multiplayerDocId,
  })
  const collabSync = useCollabSync({
    docId: multiplayerDocId ?? null,
    schema: cachedSchema,
    // 3.8.1.7 [P1] #1: don't fetch snapshot / build plugins
    // until bootstrap mutation succeeded. Otherwise plugins
    // start at the pre-bootstrap version and race-rebase on
    // first edit.
    enabled: !!multiplayerDocId && bootstrapState.phase === 'ok',
  })
  // The ref the editor closure reads when building its plugin
  // list. Captured because useEditor runs once; this lets the
  // collab plugins arrive via the React render cycle.
  const collabPluginsRef = useRef<typeof collabSync.plugins>(null)
  collabPluginsRef.current = collabSync.plugins
  // Subscribe to the live server version. When it bumps, the
  // effect below fetches the new steps + applies them.
  const remoteVersion = useRemoteVersion(multiplayerDocId ?? null)

  const { get } = useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue,
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: {
          // Extend the slash menu with an "ASCII sketch" item under a custom
          // group. We clear the "/" trigger first so it doesn't end up in
          // the document, then fire a global event the AtomShell listens
          // for to open the sketcher modal.
          buildMenu: (builder) => {
            builder
              .addGroup('dohc', 'dohc')
              .addItem('ascii-sketch', {
                label: 'ASCII sketch',
                icon: ASCII_SKETCH_ICON_SVG,
                onRun: (ctx) => {
                  const commands = ctx.get(commandsCtx)
                  commands.call(clearTextInCurrentBlockCommand.key)
                  window.dispatchEvent(new CustomEvent(OPEN_SKETCH_EVENT))
                },
              })
              .addItem('wikilink', {
                // D4.8 — /link command. Insert `[[]]` at the cursor
                // with caret positioned between the brackets so the
                // user can immediately start typing the target path.
                label: 'Link',
                icon: WIKILINK_ICON_SVG,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onRun: (ctx: any) => {
                  const commands = ctx.get(commandsCtx)
                  commands.call(clearTextInCurrentBlockCommand.key)
                  const view = ctx.get(editorViewCtx)
                  const { from } = view.state.selection
                  const tr = view.state.tr.insertText('[[]]', from, from)
                  // Place caret between the `[[` and `]]`.
                  tr.setSelection(
                    TextSelection.near(tr.doc.resolve(from + 2)),
                  )
                  view.dispatch(tr)
                  view.focus()
                },
              })
          },
        },
      },
    })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (markdown !== prev) onChangeRef.current(markdown)
      })
    })
    crepe.editor.config((ctx) => {
      const plugin = makeAsciiBlockPlugin(onAsciiClickRef)
      const wikilinkPlugin = makeWikilinkPlugin(
        () => knownFilesRef.current,
        (s) => setAcStateRef.current(s),
      )
      // D4.8 — DOM-level click handler. Decorations carry the
      // resolved target in `data-wikilink-target`; closest()
      // climbs from the click target up to the decoration's span.
      const wikilinkClickPlugin = new Plugin({
        key: new PluginKey('dohc-wikilink-click'),
        props: {
          handleClick(view, _pos, event) {
            const t = event.target as HTMLElement | null
            const el = t?.closest('[data-wikilink-target]') as
              | HTMLElement
              | null
            if (!el) return false
            const target = el.getAttribute('data-wikilink-target')
            if (!target) return false
            event.preventDefault()
            onOpenWikilinkRef.current?.(target)
            return true
          },
        },
      })
      // D4.8h — clicks on ANY atom pill (value/liveTotal/formula)
      // expand to source. The pill has contenteditable=false so PM
      // doesn't move the cursor on click; this handler reads the
      // pill's start position from `data-atom-pos` and explicitly
      // sets the selection just inside the range, triggering the
      // source-mode re-render via the selection-aware apply().
      const formulaClickPlugin = new Plugin({
        key: new PluginKey('dohc-atom-pill-click'),
        props: {
          handleClick(view, _pos, event) {
            const t = event.target as HTMLElement | null
            const el = t?.closest('.dohc-atom-pill') as HTMLElement | null
            if (!el) return false
            const posAttr = el.getAttribute('data-atom-pos')
            if (!posAttr) return false
            const pos = parseInt(posAttr, 10)
            if (!Number.isFinite(pos)) return false
            event.preventDefault()
            const tr = view.state.tr.setSelection(
              TextSelection.near(view.state.doc.resolve(pos + 1)),
            )
            view.dispatch(tr)
            view.focus()
            return true
          },
        },
      })
      const extra = [
        plugin,
        wikilinkPlugin,
        wikilinkClickPlugin,
        formulaClickPlugin,
        makeQueryBlockPlugin(queryResultsRef),
      ]
      // M1 step 3.8.1.4 — DO NOT install collab plugins at closure
      // time. The bootstrap mutation needs PM JSON extracted FROM
      // Crepe, which by definition isn't available until Crepe
      // mounts (this very closure runs). So bootstrap can never
      // complete before mount. The late-install useEffect below
      // installs them after both useCollabSync.plugins resolves
      // AND useCollabBootstrapMutation.phase === 'ok'. The
      // closure-time path was a pre-3.8.1.4 optimization that
      // bypassed the new mutation gate; removing it is the safe
      // serialization.
      void collabPluginsRef.current
      // Phase 1b: inline-atom rendering, additive + flag-gated. The
      // live-total value chip only ANNOTATES a styled {identifier}
      // token — without that decoration it's an orphan number, so it
      // rides the SAME kill-switch (never a chip with no token).
      if (inlineAtomsEnabled()) {
        extra.push(
          makeInlineAtomPlugin(),
          // D4.8h — single unified atom-pill plugin handles all 3
          // kinds (value / liveTotal / formula). Replaces the
          // older separate liveTotal + formula plugins.
          makeAtomPillPlugin(formulaRef, liveTotalsRef, fileIdMapRef),
        )
      }
      ctx.update(prosePluginsCtx, (plugins) => [...plugins, ...extra])
    })
    // sharing-v1 — view-only shared atom: make Crepe non-editable.
    // readOnly is fixed for this editor instance (the shared viewer
    // mounts fresh per atom), so setting it once at creation is
    // sufficient. The markdownUpdated listener still won't fire from
    // the user since editing is disabled.
    // M1 step 3.8.1.8 — codex 9th-pass [P1] #1: Crepe defaults
    // to editable=true. The async setReadonly effect below
    // doesn't run until after React commits — that leaves a
    // one-frame window where the editor is mounted + writable
    // before the effect locks it down. User input or paste in
    // that frame is untracked (collab plugins not installed
    // yet). Fix: set readonly SYNCHRONOUSLY at construction
    // for multiplayer. The unlock effect handles the
    // transition back to writable once collab is installed.
    if (readOnly || multiplayerDocId) crepe.setReadonly(true)
    crepeRef.current = crepe
    return crepe
  })

  useEffect(() => {
    return () => {
      crepeRef.current = null
    }
  }, [crepeRef])

  // M1 step 3.8.1.8 — collabInstalled is the AUTHORITATIVE
  // signal that the collab plugins are actually mounted in
  // prosePluginsCtx. Codex 9th-pass [P1] #2: gating on
  // `collabSync.plugins !== null` was a proxy for "plugins
  // available" but did NOT guarantee they had been folded into
  // the editor's plugin list. The remote-pull effect could
  // then call getVersion(view.state) before the collab plugin
  // existed → throws (prosemirror-collab's getVersion assumes
  // the plugin is installed). Same risk for the setReadonly
  // unlock: editor becomes writable before edits would be
  // tracked.
  //
  // M1 step 3.8.1.9 — codex 10th-pass [P2] #1: track the docId
  // installation belongs to, not just a boolean. If a parent
  // ever swaps multiplayerDocId in-place (no re-key) the old
  // installation would still register as "true" while the new
  // doc's plugins aren't installed yet. Storing the installed
  // docId + comparing to current makes the check correct under
  // that scenario.
  //
  // Set inside the late-install effect AFTER ctx.update
  // succeeds. Reset to null when docId changes / disables.
  const [collabInstalledFor, setCollabInstalledFor] = useState<
    string | null
  >(null)
  const collabInstalled =
    !!multiplayerDocId && collabInstalledFor === multiplayerDocId

  // M1 step 3.8.1.7 — codex 8th-pass [P1] #2 GATE.
  //
  // Before this gate, the editor was writable from the moment
  // Crepe mounted. That created a ~500ms window between mount
  // and bootstrap mutation completing where the user could type;
  // those edits landed in PM state but weren't tracked by
  // prosemirror-collab (plugins not installed yet). The first
  // remote-pull after install would rebase past them — silent
  // data loss.
  //
  // FIX: Crepe is read-only until BOTH bootstrap mutation
  // returns phase:'ok' AND collab plugins are installed. We
  // detect "installed" indirectly: when collabSync.plugins is
  // non-null (useCollabSync is now gated on phase==='ok' too,
  // so plugins arriving means bootstrap succeeded AND snapshot
  // was fetched). The readOnly prop (single-user shared-atom
  // view-only mode) still wins.
  //
  // Single-user (multiplayerDocId unset): no gate; Crepe is
  // writable from mount, same as pre-3.8.1.7.
  useEffect(() => {
    const crepe = crepeRef.current
    if (!crepe) return
    if (readOnly) {
      crepe.setReadonly(true)
      return
    }
    if (!multiplayerDocId) {
      crepe.setReadonly(false)
      return
    }
    // Multiplayer: writable only after bootstrap + plugins
    // ACTUALLY installed. 3.8.1.8: gate on collabInstalled
    // (set true by the late-install effect after ctx.update
    // succeeds), not on collabSync.plugins !== null which is
    // a weaker signal that only means "plugins available".
    const collabReady = bootstrapState.phase === 'ok' && collabInstalled
    crepe.setReadonly(!collabReady)
  }, [readOnly, multiplayerDocId, bootstrapState.phase, collabInstalled])

  // M1 step 3 sub-commit 3.2 — populate the global schema cache
  // from the first mounted Crepe. Runs on every mount; idempotent
  // (only the first call does work). Subsequent useCollabSync
  // calls read the cached schema synchronously to deserialize a
  // server snapshot into a PM Node. Live editors pay zero cost
  // after the first mount.
  //
  // We use useEffect (not the useEditor closure) because
  // useEditor's closure runs synchronously before Crepe.create()
  // finishes; the schema isn't available until create()
  // completes. The effect fires after the render cycle the
  // useEditor mount triggers, which is after Crepe is ready.
  useEffect(() => {
    const crepe = crepeRef.current
    if (!crepe) return
    try {
      captureSchemaFromEditor(crepe.editor)
    } catch {
      // captureSchemaFromEditor swallows subscriber errors itself;
      // a throw here would mean editor.action threw, which only
      // happens if Crepe isn't actually mounted yet. The next
      // render's effect retries; eventually we get the schema.
    }
  })

  // M1 step 3.8.1.4 — capture PM JSON from the freshly-mounted
  // Crepe so the bootstrap mutation has something to send. Crepe
  // parses `defaultValue` (markdown) into a PM doc during create();
  // we extract via editorViewCtx and stringify.
  //
  // Gated by multiplayerDocId so single-user mounts pay zero cost
  // (no extraction, no JSON serialization). The state setter is
  // idempotent — re-extracting the same JSON sets the same string,
  // and React bails out (Object.is on strings). useEffect with no
  // dep array runs on every render but the body short-circuits
  // once pmJsonStr is populated.
  useEffect(() => {
    if (!multiplayerDocId) return
    if (pmJsonStr !== null) return
    const crepe = crepeRef.current
    if (!crepe) return
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        if (!view) return
        const json = view.state.doc.toJSON()
        // Stringify here so the hook's idempotency key (which
        // compares by reference for objects) gets a stable string.
        setPmJsonStr(JSON.stringify(json))
      })
    } catch {
      // editor.action throws if Crepe hasn't finished create() yet.
      // Next render's effect retries; this is the same dance
      // captureSchemaFromEditor does above.
    }
  })

  // M1 step 2 — late install of collab plugins. If useCollabSync's
  // bootstrap resolves AFTER the editor mounts, the plugins
  // weren't in extra at mount time; fold them in now via the same
  // prosePluginsCtx update path the inline-atom + wikilink
  // plugins use at boot. Idempotent because Milkdown's plugin
  // matching is by instance and we only ever pass the same array
  // (collab-sync's pluginsRef stays stable per docId).
  //
  // M1 step 3.8.1.4 — ALSO gate on bootstrap mutation phase==='ok'.
  // Installing collab plugins before the mutation creates the
  // collabDocs row would let submitSteps write deltas the
  // projection writer can't bind to (no baseline). The result:
  // server steps accumulate; atoms.body never updates; the user
  // thinks they're collaborating but they're silently desynced.
  // Gate prevents that.
  //
  // M1 step 3.8.1.8 — sets collabInstalled=true on success.
  // Resets to false when docId changes.
  useEffect(() => {
    if (!multiplayerDocId) {
      setCollabInstalledFor(null)
      return
    }
    // 3.8.1.9: doc switched in-place without re-key. Clear the
    // stale installation marker so the new doc gets its own
    // install pass.
    if (collabInstalledFor !== null && collabInstalledFor !== multiplayerDocId) {
      setCollabInstalledFor(null)
      return
    }
    if (!collabSync.plugins) return
    if (bootstrapState.phase !== 'ok') return
    const crepe = crepeRef.current
    if (!crepe) return
    let installed = false
    crepe.editor.action((ctx) => {
      ctx.update(prosePluginsCtx, (current) => {
        // Skip if already in (handles the closure-time install
        // path; idempotent on rerender).
        const setHas = new Set(current)
        const toAdd = collabSync.plugins!.filter((p) => !setHas.has(p))
        if (toAdd.length === 0) {
          // Plugins were already installed (idempotent re-run).
          installed = true
          return current
        }
        installed = true
        return [...current, ...toAdd]
      })
    })
    if (installed) setCollabInstalledFor(multiplayerDocId)
    // No cleanup: collab plugins live for the editor's lifetime.
    // Switching docs unmounts the whole CrepeEditor (parent
    // re-keys on path change).
  }, [
    multiplayerDocId,
    collabSync.plugins,
    bootstrapState.phase,
    collabInstalledFor,
  ])

  // M1 step 2 — remote-pull loop. Convex's useQuery on
  // latestVersion is the network heartbeat: when another tab/peer
  // submits steps, the server version bumps, our component re-
  // renders, this effect runs. We compare against the editor's
  // local version (read from the collab plugin via getVersion)
  // and fetch + apply any missing steps via receiveTransaction.
  //
  // ORDER MATTERS: the fetch is deferred to a microtask so we
  // never dispatch into the editor inside a render. ProseMirror
  // disallows reentrant dispatches; a sync apply during render
  // would corrupt state.
  const convex = useConvex()
  useEffect(() => {
    if (!multiplayerDocId) return
    // M1 step 3.8.1.8 — codex 9th-pass [P1] #2 GATE.
    // getVersion(view.state) throws if the prosemirror-collab
    // plugin isn't installed. The remote-pull effect fires
    // when remoteVersion bumps; if bootstrap-mutation just
    // wrote snapshot v=1, remoteVersion fires to 1 BEFORE
    // the late-install effect finishes installing plugins.
    // Calling getVersion in that window crashes the effect.
    // Gate on the same collabInstalled signal the unlock
    // effect uses.
    if (!collabInstalled) return
    if (remoteVersion === undefined) return
    const crepe = crepeRef.current
    if (!crepe) return
    let cancelled = false
    void (async () => {
      // Read the local version from the collab plugin state
      // (inside an action so we get the live EditorView ref).
      let localVersion = -1
      let view: import('@milkdown/kit/prose/view').EditorView | null = null
      crepe.editor.action((ctx) => {
        view = ctx.get(editorViewCtx)
        localVersion = getVersion(view.state)
      })
      if (cancelled || !view || localVersion === -1) return
      if (remoteVersion <= localVersion) return
      // Behind — fetch the gap.
      try {
        const result = await convex.query(api.prosemirror.getSteps, {
          id: multiplayerDocId,
          version: localVersion,
        })
        if (cancelled) return
        if (result.steps.length === 0) return
        applyRemoteSteps({
          view,
          rawSteps: result.steps,
          clientIds: result.clientIds,
        })
      } catch {
        // Auth revocation or transient outage: leave the editor
        // alone. The next bump (from the still-subscribed
        // useQuery) will retry. User keeps editing locally; any
        // pending local steps live in the collab plugin state
        // and will eventually rebase against server.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [multiplayerDocId, remoteVersion, convex, collabInstalled])

  useEffect(() => {
    if (!autoFocus) return
    const id = requestAnimationFrame(() => {
      const editor = get()
      if (!editor) return
      const root = (editor as unknown as { root?: HTMLElement }).root
      const focusable = root?.querySelector<HTMLElement>('.ProseMirror')
      focusable?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [autoFocus, get])

  // Resolved live-totals changed (reactive query) → ask the plugin to
  // rebuild its value widgets from the fresh ref via a no-op meta
  // transaction. Best-effort: harmless if the editor isn't ready.
  useEffect(() => {
    try {
      crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.setMeta(liveTotalKey, true))
      })
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [liveTotalsTick, crepeRef])

  // Parallel refresh for resolved formulas (same no-op meta-tr
  // mechanism; distinct key so it never disturbs the live-total set).
  useEffect(() => {
    try {
      crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.setMeta(formulaKey, true))
      })
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [formulaTick, crepeRef])

  // Parallel refresh for resolved query-block results (§5.2 4B).
  useEffect(() => {
    try {
      crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.setMeta(queryBlockKey, true))
      })
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [queryTick, crepeRef])

  // D4.8b — viewRef gives the picker access to coordsAtPos +
  // dispatch. useEditor().get() returns the editor instance; we
  // hop through to the underlying ProseMirror view via the milkdown
  // ctx. Computed lazily on each render so it stays current.
  const pickerView = (() => {
    try {
      const editor = get()
      if (!editor) return null
      let view: unknown = null
      editor.action((ctx) => {
        view = ctx.get(editorViewCtx)
      })
      return view as Parameters<typeof WikilinkPicker>[0]['view']
    } catch {
      return null
    }
  })()
  const pickerState: Parameters<typeof WikilinkPicker>[0]['state'] =
    acState.active
      ? { open: true, from: acState.from, query: acState.query }
      : { open: false }

  // M1 step 3.8.1.4 — BOOTSTRAP ERROR OVERLAY. When the bootstrap
  // mutation fails for a non-frozen reason, the editor can't
  // safely sync — collab plugins were never installed (gated
  // above), so any keystroke would land in PM state with no
  // delta-submission machinery wired up. The user would type into
  // a doc that silently isn't collaborating; their work would be
  // lost on close.
  //
  // The right UX: tell them, then give them a way out. Most
  // failures (body-changed especially) recover automatically after
  // a reload — the new mount sees the fresh body, Crepe re-parses,
  // bootstrap fires with the new hash. Auto-reload after 4s so
  // they're not stuck; immediate reload button for impatience.
  //
  // 'frozen' is NOT handled here — the outer AtomEditor's frozen
  // banner (driven by useCollabDocState) catches up within one
  // Convex tick. Returning null on frozen creates a brief blank
  // window (≈100ms) before the outer banner mounts; acceptable.
  if (multiplayerDocId && bootstrapState.phase === 'error') {
    return (
      <BootstrapErrorOverlay
        reason={bootstrapState.reason}
        message={bootstrapState.message}
      />
    )
  }
  if (multiplayerDocId && bootstrapState.phase === 'frozen') {
    // Frozen banner lives at the outer AtomEditor level. Render
    // nothing here so the editor doesn't briefly appear before
    // the outer overlay catches up via useCollabDocState.
    return null
  }

  return (
    <>
      <Milkdown />
      <WikilinkPicker
        state={pickerState}
        files={knownFilesArray}
        view={pickerView}
        onDismiss={() => setAcState({ active: false })}
      />
    </>
  )
}

// M1 step 3.8.1.4 — bootstrap-mutation failure overlay. Covers
// every non-frozen error reason from bootstrapSnapshotFromAtomBody:
// body-changed, invalid-pm-json, atom-not-found, pm-body-mismatch,
// and the catch-all 'network' (auth revocation, transient outage,
// throw). The copy is reason-specific so the user understands
// what's happening; the recovery in all cases is the same:
// reload.
//
// Auto-reload after 4s — long enough for the user to read the
// message, short enough that an idle reader doesn't get stuck.
function BootstrapErrorOverlay({
  reason,
  message,
}: {
  reason:
    | 'body-changed'
    | 'invalid-pm-json'
    | 'atom-not-found'
    | 'pm-body-mismatch'
    | 'network'
  message?: string
}) {
  useEffect(() => {
    const t = setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload()
    }, 4000)
    return () => clearTimeout(t)
  }, [])
  const title = (() => {
    switch (reason) {
      case 'body-changed':
        return 'The document changed while you were opening it.'
      case 'atom-not-found':
        return 'This document is no longer available.'
      case 'pm-body-mismatch':
      case 'invalid-pm-json':
        return 'Editor state could not be synced.'
      case 'network':
      default:
        return "Couldn't connect to the collaboration server."
    }
  })()
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="collab-bootstrap-error"
      role="alert"
    >
      <div className="text-[15px] font-medium text-ink-strong">{title}</div>
      <div className="text-[13px] text-ink-dim">
        Reloading to recover. If this keeps happening, try again in a moment.
      </div>
      {message ? (
        <div className="max-w-md text-[11px] text-ink-dim opacity-70">
          {message}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-2 rounded-md bg-ink-strong px-3.5 py-1.5 text-[13px] font-medium text-surface hover:opacity-90"
      >
        Reload now
      </button>
    </div>
  )
}

export const AtomEditor = forwardRef<AtomEditorHandle, Props>(function AtomEditor(
  {
    value,
    onChange,
    autoFocus,
    onAsciiBlockClick,
    knownFiles,
    onOpenWikilink,
    shareId,
    readOnly,
    multiplayerDocId,
  },
  ref,
) {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // M1 step 3.8.1.1 — subscribe to collab-doc state so the frozen
  // signal (3.7 case A; both sides changed unilaterally) can
  // surface to the user. The query is `skip`-gated by docId
  // presence, so single-user mounts (multiplayerDocId === undefined)
  // genuinely don't subscribe — zero Convex cost, zero re-render.
  //
  // The needsRebootstrap signal (3.7 case B; auto-rebuild path)
  // is also exposed via this hook but consumed in sub-commit
  // 3.8.1.2 (which adds the actual tear-down + re-bootstrap loop).
  // Today's commit only handles frozen + the render shape.
  const activeWorkspaceIdForCollab = useActiveWorkspaceId()
  const collabDocState = useCollabDocState(
    multiplayerDocId ?? null,
    activeWorkspaceIdForCollab,
  )

  // Stash the ASCII-click handler in a ref so the ProseMirror plugin (built
  // once at editor creation) always sees the latest callback without
  // rebuilding the editor.
  const onAsciiClickRef = useRef<
    ((pos: number, content: string, language: string) => void) | null
  >(onAsciiBlockClick ?? null)
  useEffect(() => {
    onAsciiClickRef.current = onAsciiBlockClick ?? null
  }, [onAsciiBlockClick])

  // D4.8 — refs for the wikilink plugin's resolution + click. The
  // plugin reads `knownFilesRef.current` on every doc change; the
  // root-level click handler reads `onOpenWikilinkRef.current`.
  // Same ref-stash pattern as the ASCII click — the editor is
  // built once but the callbacks can change.
  const knownFilesRef = useRef<ReadonlyMap<string, WikilinkFile>>(
    new Map(),
  )
  // D4.8e — fileId → file map derived from the same knownFiles
  // list, indexed by fileId (only for files that have one). The
  // formula plugin uses this to resolve `{= id.key }` references
  // to the file's current title (so renames update the rendered
  // pill without touching the markdown source).
  const fileIdMapRef = useRef<
    ReadonlyMap<string, { path: string; title?: string | null }>
  >(new Map())
  useEffect(() => {
    const m = new Map<string, WikilinkFile>()
    const byId = new Map<string, { path: string; title?: string | null }>()
    for (const f of knownFiles ?? []) {
      m.set(f.path, f)
      if (f.fileId) byId.set(f.fileId, { path: f.path, title: f.title })
    }
    knownFilesRef.current = m
    fileIdMapRef.current = byId
  }, [knownFiles])
  const onOpenWikilinkRef = useRef<((target: string) => void) | null>(
    onOpenWikilink ?? null,
  )
  useEffect(() => {
    onOpenWikilinkRef.current = onOpenWikilink ?? null
  }, [onOpenWikilink])

  const crepeRef = useRef<Crepe | null>(null)

  // The doc's {identifier} live-totals → one reactive batched query
  // so the editor renders their computed values inline (the doc is
  // genuinely connected to the user's other files; values update as
  // the underlying {key:n} atoms change — that's the whole point).
  // Use the PROSE-ONLY markdown parser (the SAME one the server's
  // resolveLiveTotalValue scans atoms with, and consistent with the
  // plugin's code-aware computeAtomRanges walk): a `{ident}` inside a
  // code fence is NOT a live total, so it must not consume the 64-id
  // cap and crowd out real tokens (Codex R-build FAIL). Query list and
  // rendered set now derive from the same code-skipping definition.
  const liveIdents = useMemo(() => {
    const ids = parseInlineAtomsFromMarkdown(value)
      .filter((a) => a.kind === 'liveTotal')
      .map((a) => a.key)
    return Array.from(new Set(ids)).slice(0, 64)
  }, [value])
  const resolved = useQuery(
    api.liveTotals.resolveMany,
    // sharing-v1 — live totals are own-workspace; disabled in a
    // shared atom (v1) to avoid any cross-workspace resolution.
    !shareId && liveIdents.length ? { identifiers: liveIdents } : 'skip',
  )
  const liveTotalsRef = useRef<Record<string, number | null>>({})
  const [liveTotalsTick, setLiveTotalsTick] = useState(0)
  useEffect(() => {
    liveTotalsRef.current = resolved ?? {}
    setLiveTotalsTick((t) => t + 1)
  }, [resolved])

  // atom-address-v1 §3 (3B) — the doc's `{= … }` formulas → ONE
  // reactive single-pass query (evalFormulas). SAME prose-only parser
  // (code-fenced formulas excluded, deduped, ≤64) so the queried set
  // == the rendered set, exactly mirroring the live-total wiring.
  const formulaSrcs = useMemo(() => {
    // key by the parser-CANONICAL `.src` (already unescaped) — the
    // SAME key the widget derives from the doc span, so Crepe's
    // markdown escaping of `_`/`*` can never desync them (BLOCKER).
    const ss = parseInlineAtomsFromMarkdown(value)
      .filter((a) => a.kind === 'formula')
      .map((a) => (a as { src: string }).src)
    return Array.from(new Set(ss)).slice(0, 64)
  }, [value])
  // sharing-v1 — own-workspace resolution for my own atoms; SCOPED
  // resolution (evalFormulasShared) for a shared atom. Exactly one is
  // ever active; the other is 'skip'.
  // org-plan §5 — non-defaultable: must pass activeWorkspaceId so the
  // formula resolves against the workspace the user is *viewing*, not
  // their personal default.
  const activeWorkspaceId = useActiveWorkspaceId()
  const resolvedFormulasOwn = useQuery(
    api.formulaEval.evalFormulas,
    !shareId && formulaSrcs.length
      ? { srcs: formulaSrcs, activeWorkspaceId }
      : 'skip',
  )
  const resolvedFormulasShared = useQuery(
    api.formulaEval.evalFormulasShared,
    shareId && formulaSrcs.length ? { shareId, srcs: formulaSrcs } : 'skip',
  )
  const resolvedFormulas = shareId ? resolvedFormulasShared : resolvedFormulasOwn
  const formulaRef = useRef<FormulaMap>(new Map())
  const [formulaTick, setFormulaTick] = useState(0)
  useEffect(() => {
    formulaRef.current = new Map(
      (resolvedFormulas ?? []).map((e) => [e.src, { value: e.value }]),
    )
    setFormulaTick((t) => t + 1)
  }, [resolvedFormulas])

  // atom-address-v1 §5.2 (4B) — the doc's ```query fences → ONE
  // reactive batched query (evalQueryBlocks). Code is verbatim (no
  // markdown escaping inside a fence) so the trimmed fence text is
  // exactly the server src AND the doc node text — no Phase-3-style
  // escape mismatch. Deduped, ≤64. Same Map (NOT object) pattern.
  const querySrcs = useMemo(() => {
    const out: string[] = []
    QUERY_FENCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = QUERY_FENCE_RE.exec(value)) !== null) {
      const s = (m[2] ?? '').trim()
      if (s) out.push(s)
    }
    return Array.from(new Set(out)).slice(0, 64)
  }, [value])
  const resolvedQueries = useQuery(
    api.queries.evalQueryBlocks,
    // sharing-v1 — query blocks read the own-workspace vault; disabled
    // in a shared atom (v1) — they'd otherwise resolve in the viewer's
    // workspace, not the owner's, and scoping them is a later task.
    // org-plan §5 non-defaultable: activeWorkspaceId routes the query
    // through the workspace the user is viewing.
    !shareId && querySrcs.length
      ? { srcs: querySrcs, activeWorkspaceId }
      : 'skip',
  )
  const queryResultsRef = useRef<QueryResultMap>(new Map())
  const [queryTick, setQueryTick] = useState(0)
  useEffect(() => {
    queryResultsRef.current = new Map(
      (resolvedQueries ?? []).map((e) => [e.src, { value: e.value }]),
    )
    setQueryTick((t) => t + 1)
  }, [resolvedQueries])

  useImperativeHandle(
    ref,
    () => ({
      insertCodeBlock(language: string, content: string) {
        const crepe = crepeRef.current
        if (!crepe) return
        // M1 step 3.8.1.8 — codex 9th-pass [P2] #5: imperative
        // dispatch bypasses ProseMirror's editable=false DOM
        // gate. If a parent calls this during the multiplayer
        // bootstrap read-only window, the edit lands untracked.
        // Crepe exposes `readonly` as a getter; honor it.
        if (crepe.readonly) return
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { state } = view
          const codeBlockType = state.schema.nodes.code_block
          if (!codeBlockType) return
          const textNode = content ? state.schema.text(content) : null
          const node = codeBlockType.create(
            { language },
            textNode ? [textNode] : undefined,
          )
          const tr = state.tr.replaceSelectionWith(node).scrollIntoView()
          view.dispatch(tr)
          view.focus()
        })
      },
      replaceCodeBlockAt(pos: number, content: string, language?: string) {
        const crepe = crepeRef.current
        if (!crepe) return
        // 3.8.1.8 — same gate as insertCodeBlock above.
        if (crepe.readonly) return
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { state } = view
          const node = state.doc.nodeAt(pos)
          if (!node || node.type.name !== 'code_block') return
          const codeBlockType = state.schema.nodes.code_block
          const textNode = content ? state.schema.text(content) : null
          const next = codeBlockType.create(
            language ? { ...node.attrs, language } : node.attrs,
            textNode ? [textNode] : undefined,
          )
          const tr = state.tr
            .replaceWith(pos, pos + node.nodeSize, next)
            .scrollIntoView()
          view.dispatch(tr)
        })
      },
    }),
    [],
  )

  // M1 step 3.8.1.2 — REBOOTSTRAP AUTO-RELOAD. When the conflict
  // resolver (3.7 case B) flags needsRebootstrap=true (OOB write
  // while PM had no unprojected edits), the user hasn't lost
  // any unsubmitted work — PM is at the same state the server
  // last projected. The cleanest UX: show a brief "Updating..."
  // overlay + auto-reload after 1.5s. Reload triggers a fresh
  // AtomEditor mount → fresh useCollabSync → bootstrap mutation
  // fires → server's rebootstrap branch (3.8.0) clears the flag
  // + adopts the new body as baseline.
  //
  // Why auto-reload (not manual): needsRebootstrap stays sticky
  // until bootstrap runs. If the user ignores a manual banner,
  // the next projection just re-fires the signal. Auto-reload
  // breaks the loop within bounded latency. The brief warning
  // exists for context, not for action.
  //
  // Gated by multiplayerDocId so single-user mounts never trigger.
  //
  // M1 step 3.8.1.3 — frozen DOMINATES needsRebootstrap on the
  // client too (mirror of 3.9.5 fix #4's server-side invariant).
  // If both flags are simultaneously true (rare — case B fires,
  // then a later freeze branch like serialize-failed or
  // atom-deleted fires before client rebootstraps), the
  // rebootstrap-induced reload would loop because the next mount's
  // bootstrap would return reason:'frozen' (not running the
  // rebootstrap clear), and needsRebootstrap would still be true →
  // overlay fires again → reload again. The fix: skip the
  // rebootstrap overlay entirely if frozen is also set. Frozen
  // banner takes over; user sees the real terminal state.
  //
  // M1 step 3.8.1.5 — PENDING-STEPS GATE (codex 7th-pass [P1] #2
  // CLIENT MIRROR). Server case B can race: needsRebootstrap=true
  // gets set based on a stale snapshot view of PM. If the user
  // has unsubmitted local edits (sendableSteps non-empty) or an
  // in-flight submit, the auto-reload would nuke them. Server-side
  // 3.8.1.5 defers case B when latestVersion > snapshotVersion;
  // this client mirror is the second line of defense. If pending
  // steps exist, don't fire reload. The collab plugin keeps
  // submitting; once they ack (remoteVersion bumps via
  // useRemoteVersion below), the effect re-runs with sendableSteps
  // clear, and the reload proceeds.
  //
  // Trade-off: a user typing offline with needsRebootstrap=true
  // sees the overlay indefinitely (steps never submit, reload
  // never fires). v1 acceptable; future work adds a "save your
  // work" escape hatch with copy-to-clipboard.
  const remoteVersionForReload = useRemoteVersion(multiplayerDocId ?? null)
  useEffect(() => {
    if (!multiplayerDocId) return
    if (!collabDocState || collabDocState === null) return
    if (!('exists' in collabDocState) || !collabDocState.exists) return
    if (collabDocState.frozen) return // frozen dominates
    if (!collabDocState.needsRebootstrap) return
    // 3.8.1.5 — peek inside the editor's collab plugin state for
    // pending steps. If Crepe isn't mounted yet, no pending steps
    // possible — proceed. If editor.action throws (mount-in-flight),
    // defer to the next render's effect.
    const crepe = crepeRef.current
    if (crepe) {
      try {
        let pending = false
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          if (!view) return
          const sendable = sendableSteps(view.state)
          if (sendable && sendable.steps.length > 0) pending = true
        })
        if (pending) {
          // Don't auto-reload; the next remoteVersion bump (which
          // includes the ack of OUR submit) re-runs this effect.
          return
        }
      } catch {
        // Editor mid-mount; next render's effect retries.
        return
      }
    }
    // Auto-reload after a brief delay so the overlay text is
    // visible. window.location.reload() drops us out of this
    // React tree entirely.
    const t = setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload()
    }, 1500)
    return () => clearTimeout(t)
  }, [
    multiplayerDocId,
    collabDocState,
    // 3.8.1.5 — remoteVersion is the heartbeat that lets the
    // effect re-run after our pending steps ack (server received,
    // version bumped). Without it, the gate above would stick on
    // "pending" until something else triggers a re-render.
    remoteVersionForReload,
  ])

  if (
    multiplayerDocId &&
    collabDocState &&
    collabDocState !== null &&
    'exists' in collabDocState &&
    collabDocState.exists &&
    !collabDocState.frozen && // 3.8.1.3 — frozen dominates
    collabDocState.needsRebootstrap
  ) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="collab-rebootstrap-overlay"
        role="status"
        aria-live="polite"
      >
        <div className="text-[15px] font-medium text-ink-strong">
          Updating to latest content…
        </div>
        <div className="text-[12px] text-ink-dim">
          The document was changed elsewhere while you were idle.
          Reconnecting now.
        </div>
      </div>
    )
  }

  // M1 step 3.8.1.1 — FROZEN BANNER. When the conflict resolver
  // (3.7 case A) flags frozen=true, replace the editor with a
  // reload prompt. User CAN'T continue editing the stale collab
  // session — must reload to bootstrap fresh. Gated by
  // multiplayerDocId so single-user editors never see this path.
  if (
    multiplayerDocId &&
    collabDocState &&
    collabDocState !== null &&
    'exists' in collabDocState &&
    collabDocState.exists &&
    collabDocState.frozen
  ) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="collab-frozen-banner"
        role="alert"
      >
        <div className="text-[15px] font-medium text-ink-strong">
          This document was changed outside of your collaborative session.
        </div>
        <div className="text-[13px] text-ink-dim">
          To continue editing, reload to sync with the latest content.
          Your unsaved changes in this session will be lost.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-md bg-ink-strong px-3.5 py-1.5 text-[13px] font-medium text-surface hover:opacity-90"
        >
          Reload
        </button>
      </div>
    )
  }

  return (
    <MilkdownProvider>
      <CrepeEditor
        defaultValue={value}
        onChangeRef={onChangeRef}
        autoFocus={!!autoFocus}
        crepeRef={crepeRef}
        onAsciiClickRef={onAsciiClickRef}
        liveTotalsRef={liveTotalsRef}
        liveTotalsTick={liveTotalsTick}
        formulaRef={formulaRef}
        formulaTick={formulaTick}
        queryResultsRef={queryResultsRef}
        queryTick={queryTick}
        multiplayerDocId={multiplayerDocId}
        knownFilesRef={knownFilesRef}
        knownFilesArray={knownFiles ?? []}
        onOpenWikilinkRef={onOpenWikilinkRef}
        fileIdMapRef={fileIdMapRef}
        readOnly={!!readOnly}
      />
    </MilkdownProvider>
  )
})
