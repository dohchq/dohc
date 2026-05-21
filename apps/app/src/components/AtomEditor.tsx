import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
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
import type { Id } from '../../convex/_generated/dataModel'

// Global event name that any UI affordance can dispatch to ask AtomShell to
// open the ASCII sketcher modal. The slash menu's "ASCII sketch" item and
// the command palette's "Insert ASCII sketch" entry both fire this.
export const OPEN_SKETCH_EVENT = 'vibeam:open-sketch'

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
const asciiBlockKey = new PluginKey('vibeam-ascii-block')

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
const queryBlockKey = new PluginKey('vibeam-query-block')
// atom-address-v1 §5.2 Phase-4 (4B-editor) — KILL THE SLOP BOX. The
// query block kept showing its DSL *source* (`vault.find(…)`) and no
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
const liveTotalKey = new PluginKey('vibeam-live-total')

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
const formulaKey = new PluginKey('vibeam-formula')
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
    'vibeam-atom-pill vibeam-atom-pill--' +
    args.kind +
    (args.isBroken ? ' vibeam-atom-pill--broken' : '')
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
 *                     vibeam-atom-hidden font-size:0.
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
        class: 'vibeam-atom-hidden',
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
}: CrepeEditorProps) {
  // D4.8b — autocomplete state from the wikilink plugin.
  const [acState, setAcState] = useState<AutocompleteState>({
    active: false,
  })
  const setAcStateRef = useRef(setAcState)
  useEffect(() => {
    setAcStateRef.current = setAcState
  }, [])
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
              .addGroup('vibeam', 'vibe')
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
        key: new PluginKey('vibeam-wikilink-click'),
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
        key: new PluginKey('vibeam-atom-pill-click'),
        props: {
          handleClick(view, _pos, event) {
            const t = event.target as HTMLElement | null
            const el = t?.closest('.vibeam-atom-pill') as HTMLElement | null
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
    if (readOnly) crepe.setReadonly(true)
    crepeRef.current = crepe
    return crepe
  })

  useEffect(() => {
    return () => {
      crepeRef.current = null
    }
  }, [crepeRef])

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
  },
  ref,
) {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

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
  const resolvedFormulasOwn = useQuery(
    api.formulaEval.evalFormulas,
    !shareId && formulaSrcs.length ? { srcs: formulaSrcs } : 'skip',
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
    !shareId && querySrcs.length ? { srcs: querySrcs } : 'skip',
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
        knownFilesRef={knownFilesRef}
        knownFilesArray={knownFiles ?? []}
        onOpenWikilinkRef={onOpenWikilinkRef}
        fileIdMapRef={fileIdMapRef}
        readOnly={!!readOnly}
      />
    </MilkdownProvider>
  )
})
