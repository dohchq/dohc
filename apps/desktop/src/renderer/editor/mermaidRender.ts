// Mermaid diagram rendering inside WYSIWYG code blocks — a ProseMirror
// decoration layer, deliberately NOT a schema/nodeView change. Mermaid
// fences are plain `codeBlock` nodes with `language: "mermaid"` (the same
// contract-locked schema every other fence uses — see schema-parity.test.ts
// and extensions.ts's queryBlock defer comment for why `dohc-query` is the
// only fence language that gets its own node). This plugin paints a
// rendered diagram widget BELOW the block without ever touching the node's
// markdown round-trip — the fence text stays the single source of truth.
//
// Mirrors the wikilink source/preview toggle (wikilinkPlugin.ts): while the
// cursor sits outside a mermaid block, the source collapses (CSS only) so
// the diagram reads as the primary content; moving the cursor in (clicking
// the diagram, or arrow-key navigation from a neighboring block) reveals
// the raw fence again for editing.

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

/** Inserted by the `/mermaid` slash command (slashCommands.tsx) as the
 *  starter fence body. */
export const MERMAID_STARTER_SNIPPET = 'graph TD;\n    A --> B;'

const MAX_MERMAID_CHARS = 10_000
const RENDER_DEBOUNCE_MS = 400

// ---------------------------------------------------------------------------
// Pure block detection — mirrors the local DocLike shapes in
// codeBlockChrome.tsx / calloutChrome.ts so this stays testable without a
// real ProseMirror/jsdom instance.

type DocDescendantNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  textContent: string
  nodeSize: number
}
type DocLike = {
  descendants: (cb: (node: DocDescendantNode, pos: number) => boolean | void) => void
}

function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === 'code_block' || node.type.name === 'codeBlock'
}

function normalizeLanguage(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export type MermaidBlock = {
  /** Doc position of the codeBlock's own start (before its content). */
  pos: number
  /** Doc position immediately after the block — where the preview widget
   *  attaches. */
  end: number
  /** The fence's plain-text source. */
  text: string
}

/** PURE: walk the doc, return every `codeBlock` with `language: "mermaid"`. */
export function computeMermaidBlocks(doc: DocLike): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  doc.descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return
    if (normalizeLanguage(node.attrs.language) !== 'mermaid') return false
    blocks.push({ pos, end: pos + node.nodeSize, text: node.textContent })
    return false // codeBlock content is plain text — nothing to descend into
  })
  return blocks
}

/** PURE: a mermaid block's source collapses whenever the cursor sits
 *  outside its range — block-granularity version of wikilinkPlugin's
 *  cursor-inside source/preview toggle. */
export function isMermaidBlockCollapsed(
  block: { pos: number; end: number },
  cursorPos: number,
): boolean {
  return cursorPos < block.pos || cursorPos > block.end
}

/** A mermaid block paired with a STABLE widget id. The id — not the doc
 *  position — is what the decoration key, the widget DOM (`data-mermaid-id`)
 *  and the render scheduler key are derived from, so a fence that merely
 *  shifts position (an edit above it) keeps its painted widget instead of
 *  having ProseMirror destroy and remint it. */
export type MermaidWidgetEntry = {
  id: string
  pos: number
  end: number
  text: string
}

/** PURE: reconcile the previous frame's widget entries against the freshly
 *  computed blocks, reusing an id whenever a block's (mapped) start position
 *  matches a previous entry. `mapPos` maps an OLD doc position into the new
 *  document (identity when the transaction didn't change the doc), so a fence
 *  pushed down by an edit above it still matches and keeps its identity. New
 *  fences get a fresh id via `nextId`; deleted fences simply drop out (the
 *  caller prunes their scheduler state). */
export function reconcileMermaidEntries(
  previous: readonly MermaidWidgetEntry[],
  blocks: readonly MermaidBlock[],
  mapPos: (pos: number) => number,
  nextId: () => string,
): MermaidWidgetEntry[] {
  const byMappedPos = new Map<number, MermaidWidgetEntry>()
  for (const entry of previous) {
    const mapped = mapPos(entry.pos)
    if (!byMappedPos.has(mapped)) byMappedPos.set(mapped, entry)
  }
  const used = new Set<MermaidWidgetEntry>()
  return blocks.map((block) => {
    const match = byMappedPos.get(block.pos)
    if (match && !used.has(match)) {
      used.add(match)
      return { id: match.id, pos: block.pos, end: block.end, text: block.text }
    }
    return { id: nextId(), pos: block.pos, end: block.end, text: block.text }
  })
}

// ---------------------------------------------------------------------------
// Debounced render orchestration — separated from the ProseMirror/DOM
// wiring below so it's unit-testable with an injected fake render function
// and fake timers (mermaid itself can't run in jsdom).

export type MermaidRenderResult =
  | { status: 'pending' }
  | { status: 'rendered'; svg: string }
  | { status: 'error'; message: string }
  | { status: 'skipped' }

export type MermaidRenderFn = (id: string, source: string) => Promise<{ svg: string }>

/** Keyed by an opaque string (the plugin uses the block's doc position as a
 *  string) so concurrent blocks debounce independently. */
export class MermaidRenderScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSource = new Map<string, string>()
  private readonly generation = new Map<string, number>()

  constructor(
    private readonly render: MermaidRenderFn,
    private readonly onResult: (key: string, result: MermaidRenderResult) => void,
    private readonly debounceMs: number = RENDER_DEBOUNCE_MS,
    private readonly maxChars: number = MAX_MERMAID_CHARS,
  ) {}

  /** Schedule a debounced render for `key` if `source` changed since the
   *  last call — or unconditionally when `force` (a theme change
   *  invalidates every previously-rendered SVG's colors even though no
   *  fence text changed). */
  schedule(key: string, source: string, options: { force?: boolean } = {}): void {
    if (!options.force && this.lastSource.get(key) === source) return
    this.lastSource.set(key, source)

    const pending = this.timers.get(key)
    if (pending !== undefined) clearTimeout(pending)
    this.timers.delete(key)

    if (source.length > this.maxChars) {
      this.onResult(key, { status: 'skipped' })
      return
    }

    this.onResult(key, { status: 'pending' })
    const gen = (this.generation.get(key) ?? 0) + 1
    this.generation.set(key, gen)
    const timer = setTimeout(() => {
      void this.run(key, source, gen)
    }, this.debounceMs)
    this.timers.set(key, timer)
  }

  private async run(key: string, source: string, gen: number): Promise<void> {
    try {
      const { svg } = await this.render(`dohc-mermaid-${key}`, source)
      if (this.generation.get(key) !== gen) return // superseded by a newer edit
      this.onResult(key, { status: 'rendered', svg })
    } catch (error) {
      if (this.generation.get(key) !== gen) return // superseded — drop the stale error
      this.onResult(key, {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Drop all state for a key whose block no longer exists (deleted, or
   *  reminted under a different key). Cancels any in-flight debounce. */
  dispose(key: string): void {
    const pending = this.timers.get(key)
    if (pending !== undefined) clearTimeout(pending)
    this.timers.delete(key)
    this.lastSource.delete(key)
    this.generation.delete(key)
  }

  /** Drop scheduler state for every key NOT in `activeKeys` — i.e. fences
   *  deleted since the last sync — so timers/lastSource/generation don't leak
   *  across an editing session (previously they only cleared on editor
   *  destroy). */
  prune(activeKeys: ReadonlySet<string>): void {
    const keys = new Set<string>([
      ...this.timers.keys(),
      ...this.lastSource.keys(),
      ...this.generation.keys(),
    ])
    for (const key of keys) {
      if (!activeKeys.has(key)) this.dispose(key)
    }
  }

  disposeAll(): void {
    for (const key of [...this.timers.keys(), ...this.lastSource.keys()]) this.dispose(key)
  }
}

// ---------------------------------------------------------------------------
// The lazy mermaid module — heavy, so it's only imported on first use, and
// cached module-wide (one `mermaid` instance per renderer process).

type MermaidModule = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let mermaidModulePromise: Promise<MermaidModule> | null = null
let initializedThemeKey: string | null = null

/** Reads the same attribute theme.ts writes to <html data-theme>. */
function currentThemeName(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Map dohc's warm-paper/graphite CSS tokens onto mermaid's `base` theme
 *  variables so diagrams read as part of the document instead of a
 *  default-mermaid insert. Falls back to the light-mode literals if a
 *  custom property isn't resolvable (e.g. in a detached test DOM). */
function readThemeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    background: token('--dohc-bg', '#faf9f5'),
    primaryColor: token('--dohc-panel-2', '#ebe8e0'),
    primaryTextColor: token('--dohc-ink', '#1c1b18'),
    primaryBorderColor: token('--dohc-line', '#e4e1d8'),
    secondaryColor: token('--dohc-panel', '#f3f1ea'),
    tertiaryColor: token('--dohc-panel', '#f3f1ea'),
    lineColor: token('--dohc-muted', '#55524a'),
    textColor: token('--dohc-ink', '#1c1b18'),
  }
}

/** Lazy-load the mermaid package once per renderer process, then keep it
 *  (re-)initialized for the CURRENT theme — `initialize()` just replaces
 *  mermaidAPI's in-memory config, read fresh by the next `render()` call,
 *  so flipping themes is cheap. */
async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then(
      (mod) => (mod as { default?: MermaidModule }).default ?? (mod as unknown as MermaidModule),
    )
  }
  const mermaid = await mermaidModulePromise
  const themeKey = currentThemeName()
  if (initializedThemeKey !== themeKey) {
    mermaid.initialize({
      startOnLoad: false,
      // SECURITY: the fence body is untrusted document text. 'strict'
      // sanitizes labels (embedded HTML tags become literal text) and
      // disables click/script bindings on the rendered diagram — the SVG
      // mermaid.render() returns is safe to insert as-is. This module never
      // feeds raw fence text through innerHTML itself; only mermaid's own
      // sanitized SVG output is inserted (see applyMermaidResult below).
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: readThemeVariables(),
    })
    initializedThemeKey = themeKey
  }
  return mermaid
}

/** The production `MermaidRenderFn` — tests inject a fake instead (mermaid
 *  can't render in jsdom) or mock the `mermaid` import directly. */
export async function renderMermaidDiagram(id: string, source: string): Promise<{ svg: string }> {
  const mermaid = await loadMermaid()
  return mermaid.render(id, source)
}

// ---------------------------------------------------------------------------
// ProseMirror wiring — decorations + the async render/DOM sync loop.

function stopEditorMouseEvent(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
}

/** Click-on-diagram (or programmatic) entry point back into the source —
 *  mirrors the wikilink pill's "click to edit" affordance. */
function focusMermaidSource(view: EditorView, blockPos: number): void {
  const target = Math.min(blockPos + 1, view.state.doc.content.size)
  const $pos = view.state.doc.resolve(target)
  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView())
  view.focus()
}

function buildMermaidPreviewWidget(id: string): (view: EditorView) => HTMLElement {
  return (view) => {
    const container = document.createElement('div')
    container.className = 'dohc-mermaid-preview'
    container.setAttribute('contenteditable', 'false')
    // Stable per-block id, NOT the doc position: the widget DOM outlives
    // position shifts, so a position baked in here would go stale.
    container.dataset.mermaidId = id

    const canvas = document.createElement('div')
    canvas.className = 'dohc-mermaid-preview-canvas'
    canvas.setAttribute('aria-hidden', 'true')

    const status = document.createElement('div')
    status.className = 'dohc-mermaid-preview-status'
    status.hidden = true

    container.addEventListener('mousedown', stopEditorMouseEvent)
    container.addEventListener('click', (event) => {
      stopEditorMouseEvent(event)
      // Resolve the fence's CURRENT position from plugin state at click time —
      // this widget DOM survives edits above it, so a captured pos is stale.
      const entry = mermaidPreviewKey.getState(view.state)?.entries.find((e) => e.id === id)
      if (entry) focusMermaidSource(view, entry.pos)
    })

    container.append(canvas, status)
    return container
  }
}

function buildMermaidDecorationSet(
  doc: unknown,
  entries: readonly MermaidWidgetEntry[],
  cursorPos: number,
): DecorationSet {
  const decorations: Decoration[] = []
  for (const entry of entries) {
    const collapsed = isMermaidBlockCollapsed(entry, cursorPos)
    decorations.push(
      Decoration.node(entry.pos, entry.end, {
        class: collapsed ? 'dohc-mermaid-block dohc-mermaid-collapsed' : 'dohc-mermaid-block',
      }),
    )
    decorations.push(
      Decoration.widget(entry.end, buildMermaidPreviewWidget(entry.id), {
        // side:0 — sorts before codeBlockChrome's side:1 continuation "+"
        // button at the same position, so the diagram reads above it.
        side: 0,
        // Keyed by the STABLE widget id (not the doc position): ProseMirror's
        // widget equality is key-based, so an edit above the fence maps the
        // decoration to its new position while PM preserves the painted DOM
        // instead of destroying it and building an empty canvas.
        key: `mermaid-preview-${entry.id}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    )
  }
  return DecorationSet.create(doc as never, decorations)
}

function applyMermaidResult(container: HTMLElement, result: MermaidRenderResult): void {
  const canvas = container.querySelector<HTMLElement>('.dohc-mermaid-preview-canvas')
  const status = container.querySelector<HTMLElement>('.dohc-mermaid-preview-status')
  if (!canvas || !status) return

  if (result.status === 'pending') {
    // Keep whatever is already painted (last good render, or nothing yet)
    // — no flicker while the debounce/render round-trip is in flight.
    return
  }
  container.classList.remove('dohc-mermaid-preview--error', 'dohc-mermaid-preview--skipped')
  if (result.status === 'rendered') {
    // `svg` is mermaid's OWN sanitized output (securityLevel: 'strict'),
    // never the raw fence text — see loadMermaid()'s security comment.
    canvas.innerHTML = result.svg
    status.hidden = true
    status.textContent = ''
    return
  }
  if (result.status === 'error') {
    container.classList.add('dohc-mermaid-preview--error')
    status.hidden = false
    status.textContent = `Diagram error: ${result.message}`
    return
  }
  // 'skipped'
  container.classList.add('dohc-mermaid-preview--skipped')
  status.hidden = false
  status.textContent = 'Diagram too large to preview (10,000+ characters).'
}

type MermaidPluginState = {
  /** Monotonic counter for minting fresh widget ids across the plugin's life. */
  seq: number
  entries: MermaidWidgetEntry[]
  set: DecorationSet
}

const mermaidPreviewKey = new PluginKey<MermaidPluginState>('dohc-mermaid-preview')

export function makeMermaidPreviewPlugin(render: MermaidRenderFn = renderMermaidDiagram) {
  return new Plugin<MermaidPluginState>({
    key: mermaidPreviewKey,
    state: {
      init(_, instance) {
        let seq = 0
        const entries = computeMermaidBlocks(instance.doc as unknown as DocLike).map((block) => ({
          id: `m${seq++}`,
          pos: block.pos,
          end: block.end,
          text: block.text,
        }))
        return {
          seq,
          entries,
          set: buildMermaidDecorationSet(instance.doc, entries, instance.selection.from),
        }
      },
      apply(tr, old, _oldState, newState) {
        // Rebuild on doc changes (source edited) OR selection changes (the
        // cursor moved into/out of a block — toggle collapse), same trigger
        // pair as wikilinkPlugin's source/preview toggle.
        if (!tr.docChanged && !tr.selectionSet) return old
        const blocks = computeMermaidBlocks(newState.doc as unknown as DocLike)
        let seq = old.seq
        // Map each previous fence's position through the transaction so a fence
        // shifted by an edit above it keeps its stable id (and painted widget)
        // rather than being reminted under a new position-derived key.
        const mapPos = tr.docChanged
          ? (pos: number) => tr.mapping.map(pos)
          : (pos: number) => pos
        const entries = reconcileMermaidEntries(old.entries, blocks, mapPos, () => `m${seq++}`)
        return {
          seq,
          entries,
          set: buildMermaidDecorationSet(newState.doc, entries, newState.selection.from),
        }
      },
    },
    props: {
      decorations(state) {
        return mermaidPreviewKey.getState(state)?.set
      },
    },
    view(editorView) {
      const scheduler = new MermaidRenderScheduler(render, (key, result) => {
        const container = editorView.dom.querySelector<HTMLElement>(
          `.dohc-mermaid-preview[data-mermaid-id="${key}"]`,
        )
        if (container) applyMermaidResult(container, result)
      })

      function syncBlocks(view: EditorView, options: { force?: boolean } = {}): void {
        const entries = mermaidPreviewKey.getState(view.state)?.entries ?? []
        const activeIds = new Set<string>()
        for (const entry of entries) {
          activeIds.add(entry.id)
          scheduler.schedule(entry.id, entry.text, options)
        }
        // Prune scheduler state for fences deleted since the last sync so
        // timers/lastSource/generation don't accumulate across the session.
        scheduler.prune(activeIds)
      }

      let lastThemeKey = currentThemeName()
      // Theme flips happen via a plain attribute write on <html> (theme.ts),
      // not a ProseMirror transaction — a MutationObserver is the only way
      // to notice one and re-render every visible diagram's colors.
      const observer = new MutationObserver(() => {
        const themeKey = currentThemeName()
        if (themeKey === lastThemeKey) return
        lastThemeKey = themeKey
        syncBlocks(editorView, { force: true })
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })

      syncBlocks(editorView)

      return {
        update: (view) => syncBlocks(view),
        destroy() {
          observer.disconnect()
          scheduler.disposeAll()
        },
      }
    },
  })
}
