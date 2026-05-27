import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import {
  parseInlineAtoms,
  parseInlineAtomsFromMarkdown,
} from '../lib/inlineAtom'
import { isQueryFenceLanguage, QUERY_FENCE_RE } from '../lib/dslparse'
import { Extension, type Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extensions/placeholder'
import { TrailingNode } from '@tiptap/extensions/trailing-node'
import {
  Collaboration,
  isChangeOrigin,
} from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { common, createLowlight } from 'lowlight'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Awareness } from 'y-protocols/awareness'
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
import { dohcMarkdownExtensions } from '../editor-v2/dohc-markdown-extensions'
import {
  createDohcAwareness,
  createDohcHocuspocusProvider,
  encodeDohcHocuspocusDocumentName,
  fetchHocuspocusDocumentState,
  fetchHocuspocusCapabilities,
  resolveHocuspocusUrl,
  startHocuspocusTokenRefresh,
} from '../editor-v2/hocuspocusProvider'
import { encodeDohcYDocUpdate, markdownToYDoc } from '../editor-v2/import-export'
import { canEditDohcEditor } from '../editor-v2/editorReadiness'
import {
  hasIndexeddbYDocState,
  markIndexeddbYDocState,
} from '../editor-v2/indexeddbState'
import { useActiveWorkspaceId } from '../lib/active-workspace'

// Global event name that any UI affordance can dispatch to ask AtomShell to
// open the ASCII sketcher modal. The slash menu's "ASCII sketch" item and
// the command palette's "Insert ASCII sketch" entry both fire this.
export const OPEN_SKETCH_EVENT = 'dohc:open-sketch'

export type SlashCommandId =
  | 'ascii-sketch'
  | 'wikilink'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bulleted-list'
  | 'numbered-list'
  | 'quote'
  | 'code-block'
  | 'divider'
  | 'table'
  | 'query-block'

export type SlashCommandItem = {
  id: SlashCommandId
  label: string
  hint: string
  glyph: string
  aliases: string[]
}

type SlashCommandState =
  | { open: false }
  | {
      open: true
      from: number
      to: number
      query: string
      selected: number
      x: number
      y: number
    }

const CLOSED_SLASH_COMMAND_STATE: SlashCommandState = { open: false }
const LOCAL_SYNC_FALLBACK_MS = 2500
const COLLAB_BOOTSTRAP_TIMEOUT_MS = 5000
const REMOTE_SYNC_STALL_MS = 12000
const lowlight = createLowlight(common)
const COLLABORATOR_COLORS = [
  '#1a73e8',
  '#188038',
  '#d93025',
  '#9334e6',
  '#e8710a',
  '#00796b',
  '#c5221f',
] as const

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'ascii-sketch',
    label: 'ASCII sketch',
    hint: 'Draw a native text sketch',
    glyph: 'A',
    aliases: ['ascii', 'art', 'diagram', 'draw', 'sketch'],
  },
  {
    id: 'wikilink',
    label: 'Link',
    hint: 'Link another page',
    glyph: '[[',
    aliases: ['link', 'page', 'wiki', 'wikilink'],
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    hint: 'Large section heading',
    glyph: 'H1',
    aliases: ['h1', 'heading', 'title'],
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    hint: 'Medium section heading',
    glyph: 'H2',
    aliases: ['h2', 'subheading', 'subtitle'],
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    hint: 'Small section heading',
    glyph: 'H3',
    aliases: ['h3', 'heading', 'subheading'],
  },
  {
    id: 'bulleted-list',
    label: 'Bulleted list',
    hint: 'Start a simple list',
    glyph: '-',
    aliases: ['bullet', 'bulleted', 'list', 'ul'],
  },
  {
    id: 'numbered-list',
    label: 'Numbered list',
    hint: 'Start an ordered list',
    glyph: '1.',
    aliases: ['number', 'numbered', 'ordered', 'ol'],
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Call out a thought',
    glyph: '>',
    aliases: ['blockquote', 'quote'],
  },
  {
    id: 'code-block',
    label: 'Code block',
    hint: 'Write code or raw text',
    glyph: '</>',
    aliases: ['code', 'fence', 'pre'],
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Separate sections',
    glyph: '—',
    aliases: ['divider', 'line', 'rule', 'separator', 'hr'],
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Insert a simple grid',
    glyph: '▦',
    aliases: ['table', 'grid', 'rows', 'columns'],
  },
  {
    id: 'query-block',
    label: 'Query block',
    hint: 'Embed a dohc query',
    glyph: '{}',
    aliases: ['data', 'database', 'live', 'query'],
  },
]

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((command) => {
    if (command.label.toLowerCase().includes(normalized)) return true
    return command.aliases.some((alias) => alias.includes(normalized))
  })
}

export function findSlashCommandMatch(
  textBeforeCursor: string,
): { slashOffset: number; query: string } | null {
  const match = /(?:^|\s)\/([A-Za-z0-9_-]{0,40})$/.exec(textBeforeCursor)
  if (!match) return null
  const matchedText = match[0] ?? ''
  const slashOffset = match.index + matchedText.lastIndexOf('/')
  return { slashOffset, query: match[1]?.toLowerCase() ?? '' }
}

export type AtomEditorHandle = {
  insertCodeBlock: (language: string, content: string) => void
  replaceCodeBlockAt: (pos: number, content: string, language?: string) => void
}

type Props = {
  value: string
  onChange: (next: string) => void
  onPreviewChange?: (next: string) => void
  autoFocus?: boolean
  // sharing-v1 — when set, this atom is opened via a share grant:
  // formulas resolve through evalFormulasShared (scoped to the
  // shared set in the OWNER's workspace), and the own-workspace
  // live-total + query-block resolvers are disabled (v1).
  shareId?: Id<'atomShares'>
  // Dev/isolated surfaces can render the editor without authenticated
  // Convex-backed live-total/formula/query resolvers.
  disableReactiveResolvers?: boolean
  // sharing-v1 — view-only shared atom: Tiptap is read-only.
  readOnly?: boolean
  frontmatter?: Record<string, unknown>
  collab?: {
    workspaceId: string
    atomId: string
    userId?: string | null
    userName?: string | null
  }
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
// with a marker class so CSS can strip the Tiptap code-block chrome and
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

function syncYMapFromRecord(
  map: Y.Map<unknown>,
  values: Record<string, unknown>,
  previousValues: Record<string, unknown> | null,
): void {
  map.doc?.transact(() => {
    for (const key of Object.keys(previousValues ?? {})) {
      if (
        !Object.hasOwn(values, key) &&
        yMapValueEquals(map.get(key), previousValues?.[key])
      ) {
        map.delete(key)
      }
    }
    for (const [key, value] of Object.entries(values)) {
      const previousValue = previousValues?.[key]
      if (previousValues && yMapValueEquals(value, previousValue)) continue
      if (!yMapValueEquals(map.get(key), value)) map.set(key, value)
    }
  })
}

function yMapValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => yMapValueEquals(item, right[index]))
  }

  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && yMapValueEquals(left[key], right[key]),
    )
  }

  return false
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type DocDescendantNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  textContent: string
  nodeSize: number
}

type DocLike = {
  descendants: (
    cb: (node: DocDescendantNode, pos: number) => boolean | void,
  ) => void
}

function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === 'code_block' || node.type.name === 'codeBlock'
}

type CollaborationPresenceUser = {
  clientId: number
  color: string
  id: string
  initials: string
  isLocal: boolean
  name: string
}

type AwarenessPresenceApi = Awareness & {
  getStates: () => Map<number, Record<string, unknown>>
  off: (event: 'update' | 'change', listener: () => void) => void
  on: (event: 'update' | 'change', listener: () => void) => void
}

function hasAwarenessPresenceApi(
  awareness: Awareness,
): awareness is AwarenessPresenceApi {
  const candidate = awareness as Partial<AwarenessPresenceApi>
  return (
    typeof candidate.getStates === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.off === 'function'
  )
}

function cleanCollaboratorName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'You'
}

function collaboratorInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const initials =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
      : name.slice(0, 1)
  return initials.toUpperCase() || 'Y'
}

function collabColorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return COLLABORATOR_COLORS[hash % COLLABORATOR_COLORS.length]
}

function normalizeCollabColor(value: unknown, fallbackId = ''): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : collabColorForId(fallbackId || 'local')
}

function collabColorAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function readCollaborationPresence(
  awareness: AwarenessPresenceApi,
  localClientId: number,
): CollaborationPresenceUser[] {
  return Array.from(awareness.getStates().entries())
    .map(([clientId, state]) => {
      const user = isJsonRecord(state.user) ? state.user : null
      if (!user) return null

      const id =
        typeof user.id === 'string' && user.id.trim()
          ? user.id.trim()
          : `client-${clientId}`
      const name = cleanCollaboratorName(user.name)
      const color = normalizeCollabColor(user.color, id)
      return {
        clientId,
        color,
        id,
        initials: collaboratorInitials(name),
        isLocal: clientId === localClientId,
        name,
      }
    })
    .filter((user): user is CollaborationPresenceUser => user !== null)
    .sort((left, right) => {
      if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

function renderCollaborationCaret(user: Record<string, unknown>): HTMLElement {
  const name = cleanCollaboratorName(user.name)
  const id = typeof user.id === 'string' ? user.id : name
  const color = normalizeCollabColor(user.color, id)

  const caret = document.createElement('span')
  caret.className = 'dohc-collab-caret'
  caret.style.setProperty('--dohc-collab-color', color)
  caret.setAttribute('data-collaborator', name)

  const label = document.createElement('span')
  label.className = 'dohc-collab-label'
  label.textContent = name

  caret.append(label)
  return caret
}

function renderCollaborationSelection(user: Record<string, unknown>) {
  const name = cleanCollaboratorName(user.name)
  const id = typeof user.id === 'string' ? user.id : name
  const color = normalizeCollabColor(user.color, id)

  return {
    nodeName: 'span',
    class: 'dohc-collab-selection',
    style: `--dohc-collab-color: ${color}; background-color: ${collabColorAlpha(
      color,
      0.2,
    )}; border-bottom-color: ${color};`,
    'data-collaborator': name,
  }
}

function buildAsciiDecorations(
  doc: unknown,
  onClickRef: React.RefObject<
    ((pos: number, content: string, language: string) => void) | null
  >,
): DecorationSet {
  const decorations: Decoration[] = []
  ;(doc as DocLike).descendants((node, pos) => {
    if (isCodeBlockNode(node) && isAsciiSketchLanguage(node.attrs.language)) {
      const hasMetadata = hasAsciiSketchContentMetadata(node.textContent)
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `ascii-sketch-block${hasMetadata ? ' ascii-sketch-block-has-metadata' : ''}`,
        }),
      )
      if (hasMetadata) {
        const firstLineEnd = node.textContent.indexOf('\n')
        const metadataLength =
          firstLineEnd === -1 ? node.textContent.length : firstLineEnd + 1
        if (metadataLength > 0) {
          decorations.push(
            Decoration.inline(pos + 1, pos + 1 + metadataLength, {
              class: 'ascii-sketch-metadata-line',
            }),
          )
        }
      }
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

const slashCommandKey = new PluginKey('dohc-slash-command')
const blockControlsKey = new PluginKey('dohc-block-controls')

function makeSlashCommandPlugin({
  wrapperRef,
  stateRef,
  setState,
  runCommandRef,
}: {
  wrapperRef: React.RefObject<HTMLDivElement | null>
  stateRef: React.RefObject<SlashCommandState>
  setState: React.Dispatch<React.SetStateAction<SlashCommandState>>
  runCommandRef: React.RefObject<(id: SlashCommandId) => void>
}) {
  const close = () => setState(CLOSED_SLASH_COMMAND_STATE)

  const refresh = (view: EditorView) => {
    const next = readSlashCommandState(
      view,
      stateRef.current,
      wrapperRef.current,
    )
    setState(next)
  }

  return new Plugin({
    key: slashCommandKey,
    view(view) {
      refresh(view)
      return {
        update(nextView) {
          refresh(nextView)
        },
        destroy() {
          close()
        },
      }
    },
    props: {
      handleKeyDown(view, event) {
        const slashState = stateRef.current
        if (!slashState.open) return false

        const items = filterSlashCommands(slashState.query)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setState((current) =>
            current.open
              ? {
                  ...current,
                  selected: items.length
                    ? (current.selected + 1) % items.length
                    : 0,
                }
              : current,
          )
          return true
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setState((current) =>
            current.open
              ? {
                  ...current,
                  selected: items.length
                    ? (current.selected - 1 + items.length) % items.length
                    : 0,
                }
              : current,
          )
          return true
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
          const command = items[slashState.selected] ?? items[0]
          if (!command) return false
          event.preventDefault()
          runCommandRef.current(command.id)
          return true
        }

        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          view.focus()
          return true
        }

        return false
      },
    },
  })
}

function makeBlockControlsPlugin({
  onInsertRef,
  onSelectRef,
}: {
  onInsertRef: React.RefObject<(pos: number) => void>
  onSelectRef: React.RefObject<(pos: number) => void>
}) {
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(
          instance.doc,
          onInsertRef,
          onSelectRef,
        )
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc)
        return buildBlockControlDecorations(tr.doc, onInsertRef, onSelectRef)
      },
    },
    props: {
      decorations(state) {
        return blockControlsKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}

type TopLevelDocLike = {
  forEach: (
    cb: (
      node: {
        type: { name: string }
        attrs?: Record<string, unknown>
        nodeSize: number
      },
      offset: number,
      index: number,
    ) => void,
  ) => void
}

function buildBlockControlDecorations(
  doc: unknown,
  onInsertRef: React.RefObject<(pos: number) => void>,
  onSelectRef: React.RefObject<(pos: number) => void>,
): DecorationSet {
  const decorations: Decoration[] = []

  ;(doc as TopLevelDocLike).forEach((node, offset, index) => {
    const isAsciiCodeBlock =
      isCodeBlockNode(node) && isAsciiSketchLanguage(node.attrs?.language)
    if (!isBlockControlTarget(node.type.name) && !isAsciiCodeBlock) return

    const pos = offset
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'dohc-block-node',
        'data-dohc-block-index': String(index),
      }),
    )
    decorations.push(
      Decoration.widget(
        pos + 1,
        () => {
          const wrap = document.createElement('span')
          wrap.className = 'dohc-block-affordance'
          wrap.setAttribute('contenteditable', 'false')

          const plus = document.createElement('button')
          plus.type = 'button'
          plus.className = 'dohc-block-gutter-btn dohc-block-plus'
          plus.title = 'insert block'
          plus.setAttribute('aria-label', 'insert block')
          plus.addEventListener('mousedown', stopEditorMouseEvent)
          plus.addEventListener('click', (event) => {
            stopEditorMouseEvent(event)
            onInsertRef.current(pos)
          })

          const handle = document.createElement('button')
          handle.type = 'button'
          handle.className = 'dohc-block-gutter-btn dohc-block-handle'
          handle.title = 'select block'
          handle.setAttribute('aria-label', 'select block')
          handle.addEventListener('mousedown', stopEditorMouseEvent)
          handle.addEventListener('click', (event) => {
            stopEditorMouseEvent(event)
            onSelectRef.current(pos)
          })

          wrap.append(plus, handle)
          return wrap
        },
        { side: -1, key: `dohc-block-controls-${pos}` },
      ),
    )
  })

  return DecorationSet.create(doc as never, decorations)
}

function isBlockControlTarget(nodeName: string): boolean {
  return [
    'paragraph',
    'heading',
    'blockquote',
    'queryBlock',
  ].includes(nodeName)
}

function stopEditorMouseEvent(event: Event) {
  event.preventDefault()
  event.stopPropagation()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = globalThis.setTimeout(() => {
      reject(new Error('Timed out waiting for collaboration bootstrap'))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) globalThis.clearTimeout(timeout)
  })
}

function isEditableEditor(editor: Editor | null | undefined): boolean {
  if (!editor) return false
  if ((editor as { isEditable?: boolean }).isEditable === false) return false
  if ((editor.view as { editable?: boolean }).editable === false) return false
  return true
}

function readSlashCommandState(
  view: EditorView,
  previous: SlashCommandState,
  wrapper: HTMLDivElement | null,
): SlashCommandState {
  if ((view as { editable?: boolean }).editable === false) {
    return CLOSED_SLASH_COMMAND_STATE
  }

  const state = view.state as EditorState
  const { selection } = state
  if (!selection.empty) return CLOSED_SLASH_COMMAND_STATE

  const $from = selection.$from
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) {
    return CLOSED_SLASH_COMMAND_STATE
  }

  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset)
  const match = findSlashCommandMatch(textBeforeCursor)
  if (!match) return CLOSED_SLASH_COMMAND_STATE

  const blockStart = $from.start()
  const from = blockStart + match.slashOffset
  const to = selection.from
  const items = filterSlashCommands(match.query)
  const selected = previous.open
    ? Math.min(previous.selected, Math.max(items.length - 1, 0))
    : 0

  let x = 0
  let y = 0
  try {
    const coords = view.coordsAtPos(from)
    const wrapperRect = wrapper?.getBoundingClientRect()
    x = Math.max(0, coords.left - (wrapperRect?.left ?? 0))
    y = Math.max(0, coords.bottom - (wrapperRect?.top ?? 0) + 6)
  } catch {
    x = 0
    y = 28
  }

  return {
    open: true,
    from,
    to,
    query: match.query,
    selected,
    x,
    y,
  }
}

// Humanize a query fence so the user sees WHAT it shows, not raw DSL.
// `entities.list("project", { "status": "in-progress" })`
//   → "project · status: in-progress"
// Defensive: any parse miss falls back to the first non-empty line.
export function humanizeQuery(src: string): string | null {
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
    return first ? first.trim().slice(0, 80) : null
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
// glaring Tiptap code-block chrome and prepend a calm human caption so
// a query reads as an intentional live query element, not scary DSL
// (impressions #17). The raw query stays an editable code block —
// markdown is still the truth; a power user edits it directly.
const queryBlockKey = new PluginKey('dohc-query-block')
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
    const isCodeQueryBlock =
      isCodeBlockNode(node) && isQueryFenceLanguage(node.attrs.language)
    const isDohcQueryBlock = node.type.name === 'queryBlock'
    if (isCodeQueryBlock || isDohcQueryBlock) {
      const src = node.textContent.trim()
      const label = humanizeQuery(src)
      if (!src || !label) return
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'query-atom-block',
        }),
      )
      decorations.push(
        Decoration.widget(
          pos,
          () => {
            const wrap = document.createElement('div')
            wrap.className = 'query-atom-caption'
            wrap.setAttribute('contenteditable', 'false')
            wrap.innerHTML =
              '<span class="query-atom-dot"></span><span class="query-atom-live">query</span>'
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

const codeLanguageKey = new PluginKey('dohc-code-language')
const codeBlockContinuationKey = new PluginKey('dohc-code-block-continuation')

const CODE_LANGUAGE_OPTIONS = [
  { value: '', label: 'Plain text' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'tsx', label: 'TSX' },
  { value: 'jsx', label: 'JSX' },
  { value: 'python', label: 'Python' },
  { value: 'bash', label: 'Shell' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'yaml', label: 'YAML' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
] as const

function cleanCodeLanguage(value: string): string {
  return (value.trim().match(/^[A-Za-z0-9_+#.-]{0,48}/)?.[0] ?? '').slice(
    0,
    48,
  )
}

function insertParagraphAfterBlock(view: EditorView, blockPos: number): boolean {
  if (view.editable === false) return false

  const { state } = view
  const node = state.doc.nodeAt(blockPos)
  const paragraphType = state.schema.nodes.paragraph
  if (!node || !paragraphType) return false

  const insertPos = blockPos + node.nodeSize
  const $insert = state.doc.resolve(insertPos)
  let tr = state.tr

  if (
    !(
      $insert.nodeAfter?.type === paragraphType &&
      $insert.nodeAfter.content.size === 0
    )
  ) {
    if (
      !$insert.parent.canReplaceWith(
        $insert.index(),
        $insert.index(),
        paragraphType,
      )
    ) {
      return false
    }
    tr = tr.insert(insertPos, paragraphType.create())
  }

  const selectionPos = Math.min(insertPos + 1, tr.doc.content.size)
  tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos)).scrollIntoView()
  view.dispatch(tr)
  view.focus()
  return true
}

function codeBlockAtSelection(state: EditorState): {
  node: DocDescendantNode
  pos: number
} | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (!isCodeBlockNode(node)) continue
    return { node: node as unknown as DocDescendantNode, pos: $from.before(depth) }
  }
  return null
}

function isSelectionAtEndOfCodeBlock(state: EditorState): boolean {
  if (!state.selection.empty) return false
  const block = codeBlockAtSelection(state)
  if (!block) return false
  return state.selection.$from.parentOffset >= block.node.textContent.length
}

function buildCodeLanguageDecorations(doc: unknown): DecorationSet {
  const decorations: Decoration[] = []

  ;(doc as DocLike).descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return
    if (isAsciiSketchLanguage(node.attrs.language)) return
    if (isQueryFenceLanguage(node.attrs.language)) return

    const language = cleanCodeLanguage(String(node.attrs.language ?? ''))
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'dohc-code-block',
      }),
    )
    decorations.push(
      Decoration.widget(
        pos,
        (view, getPos) => {
          const toolbar = document.createElement('div')
          toolbar.className = 'dohc-code-block-toolbar'
          toolbar.setAttribute('contenteditable', 'false')

          const left = document.createElement('div')
          left.className = 'dohc-code-block-toolbar-left'

          const dot = document.createElement('span')
          dot.className = 'dohc-code-block-dot'
          dot.setAttribute('aria-hidden', 'true')

          const select = document.createElement('select')
          select.className = 'dohc-code-language-select'
          select.setAttribute('aria-label', 'code language')
          select.disabled = view.editable === false

          const hasKnownLanguage = CODE_LANGUAGE_OPTIONS.some(
            (option) => option.value === language,
          )
          const options = hasKnownLanguage
            ? CODE_LANGUAGE_OPTIONS
            : [{ value: language, label: language }, ...CODE_LANGUAGE_OPTIONS]
          for (const option of options) {
            const el = document.createElement('option')
            el.value = option.value
            el.textContent = option.label
            select.appendChild(el)
          }
          select.value = language

          const commit = () => {
            const blockPos = getPos()
            if (blockPos === undefined) return
            const current = view.state.doc.nodeAt(blockPos)
            if (!current || !isCodeBlockNode(current)) return

            const nextLanguage = cleanCodeLanguage(select.value)
            const currentLanguage = cleanCodeLanguage(
              String(current.attrs.language ?? ''),
            )
            select.value = nextLanguage
            if (nextLanguage === currentLanguage) return

            view.dispatch(
              view.state.tr
                .setNodeMarkup(blockPos, undefined, {
                  ...current.attrs,
                  language: nextLanguage,
                })
                .scrollIntoView(),
            )
          }

          select.addEventListener('mousedown', (event) =>
            event.stopPropagation(),
          )
          select.addEventListener('click', (event) => event.stopPropagation())
          select.addEventListener('keydown', (event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              select.value = language
              view.focus()
            }
          })
          select.addEventListener('change', commit)

          const copy = document.createElement('button')
          copy.type = 'button'
          copy.className = 'dohc-code-copy-btn'
          copy.setAttribute('aria-label', 'copy code')
          copy.textContent = 'copy'
          copy.addEventListener('mousedown', stopEditorMouseEvent)
          copy.addEventListener('click', (event) => {
            stopEditorMouseEvent(event)
            const write = navigator.clipboard?.writeText(node.textContent)
            if (!write) return
            void write.then(() => {
              copy.textContent = 'copied'
              window.setTimeout(() => {
                copy.textContent = 'copy'
              }, 1200)
            })
          })

          left.append(dot, select)
          toolbar.append(left, copy)
          return toolbar
        },
        {
          side: -1,
          key: `code-lang-${pos}-${language}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    )
    decorations.push(
      Decoration.widget(
        pos + node.nodeSize,
        (view) => {
          const wrap = document.createElement('div')
          wrap.className = 'dohc-code-block-continuation'
          wrap.setAttribute('contenteditable', 'false')

          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dohc-code-block-continue-btn'
          button.setAttribute('aria-label', 'add paragraph below code block')
          button.disabled = view.editable === false
          button.textContent = '+'
          button.addEventListener('mousedown', stopEditorMouseEvent)
          button.addEventListener('click', (event) => {
            stopEditorMouseEvent(event)
            insertParagraphAfterBlock(view, pos)
          })

          wrap.append(button)
          return wrap
        },
        {
          side: 1,
          key: `code-continue-${pos}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    )
  })

  return DecorationSet.create(doc as never, decorations)
}

function makeCodeBlockChromePlugin() {
  return new Plugin({
    key: codeLanguageKey,
    state: {
      init(_, instance) {
        return buildCodeLanguageDecorations(instance.doc)
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc)
        return buildCodeLanguageDecorations(tr.doc)
      },
    },
    props: {
      decorations(state) {
        return codeLanguageKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}

function makeCodeBlockContinuationPlugin() {
  return new Plugin({
    key: codeBlockContinuationKey,
    props: {
      handleKeyDown(view, event) {
        const block = codeBlockAtSelection(view.state)
        if (!block) return false

        const explicitExit =
          event.key === 'Enter' && (event.metaKey || event.ctrlKey)
        const arrowExit =
          event.key === 'ArrowDown' && isSelectionAtEndOfCodeBlock(view.state)
        if (!explicitExit && !arrowExit) return false

        event.preventDefault()
        return insertParagraphAfterBlock(view, block.pos)
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

type TiptapEditorProps = {
  defaultValue: string
  onChangeRef: React.RefObject<(next: string) => void>
  onPreviewChangeRef: React.RefObject<((next: string) => void) | null>
  autoFocus: boolean
  editorRef: React.RefObject<Editor | null>
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
  collab?: Props['collab']
  fetchCollabToken: (workspaceId: string) => Promise<string>
  readOnly?: boolean
  frontmatter?: Props['frontmatter']
}

type SlashCommandChain = {
  focus: () => SlashCommandChain
  deleteRange: (range: { from: number; to: number }) => SlashCommandChain
  insertContent: (content: string) => SlashCommandChain
  setTextSelection: (position: number) => SlashCommandChain
  setParagraph: () => SlashCommandChain
  toggleHeading: (attrs: { level: 1 | 2 | 3 }) => SlashCommandChain
  toggleBulletList: () => SlashCommandChain
  toggleOrderedList: () => SlashCommandChain
  toggleBlockquote: () => SlashCommandChain
  setCodeBlock: (attrs?: { language: string }) => SlashCommandChain
  setHorizontalRule: () => SlashCommandChain
  insertTable: (attrs?: {
    rows?: number
    cols?: number
    withHeaderRow?: boolean
  }) => SlashCommandChain
  run: () => boolean
}

function SlashCommandMenu({
  state,
  onSelect,
  onHover,
}: {
  state: SlashCommandState
  onSelect: (id: SlashCommandId) => void
  onHover: (index: number) => void
}) {
  if (!state.open) return null
  const items = filterSlashCommands(state.query)

  return (
    <div
      className="dohc-slash-menu"
      style={{ left: state.x, top: state.y }}
      role="listbox"
      aria-label="slash commands"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length ? (
        items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === state.selected}
            className={`dohc-slash-menu__item${
              index === state.selected ? ' is-selected' : ''
            }`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(item.id)}
          >
            <span className="dohc-slash-menu__glyph">{item.glyph}</span>
            <span className="dohc-slash-menu__copy">
              <span className="dohc-slash-menu__label">{item.label}</span>
              <span className="dohc-slash-menu__hint">{item.hint}</span>
            </span>
          </button>
        ))
      ) : (
        <div className="dohc-slash-menu__empty">No commands</div>
      )}
    </div>
  )
}

function TiptapAtomEditor({
  defaultValue,
  onChangeRef,
  onPreviewChangeRef,
  autoFocus,
  editorRef,
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
  collab,
  fetchCollabToken,
  readOnly,
  frontmatter,
}: TiptapEditorProps) {
  // D4.8b — autocomplete state from the wikilink plugin.
  const [acState, setAcState] = useState<AutocompleteState>({
    active: false,
  })
  const editorWrapRef = useRef<HTMLDivElement | null>(null)
  const [slashState, setSlashState] = useState<SlashCommandState>(
    CLOSED_SLASH_COMMAND_STATE,
  )
  const slashStateRef = useRef<SlashCommandState>(slashState)
  const slashCommandRunnerRef = useRef<(id: SlashCommandId) => void>(() => {})
  const blockInsertRef = useRef<(pos: number) => void>(() => {})
  const blockSelectRef = useRef<(pos: number) => void>(() => {})
  useEffect(() => {
    slashStateRef.current = slashState
  }, [slashState])
  const setAcStateRef = useRef(setAcState)
  useEffect(() => {
    setAcStateRef.current = setAcState
  }, [])

  const documentName = useMemo(
    () =>
      collab
        ? encodeDohcHocuspocusDocumentName({
            workspaceId: collab.workspaceId,
            atomId: collab.atomId,
          })
        : null,
    [collab?.workspaceId, collab?.atomId],
  )
  const hocuspocusUrl = useMemo(
    () =>
      documentName
        ? resolveHocuspocusUrl({
            envUrl: import.meta.env.VITE_HOCUSPOCUS_URL,
          })
        : null,
    [documentName],
  )
  const collaborationRequested = !!documentName && !!hocuspocusUrl
  const collaborationRequired = !!documentName
  const [collabBootstrap, setCollabBootstrap] = useState<
    'pending' | 'server' | 'client' | 'unavailable'
  >('pending')
  const [clientSeededDocumentName, setClientSeededDocumentName] = useState<
    string | null
  >(null)
  const collaborationPending =
    collaborationRequested &&
    (collabBootstrap === 'pending' ||
      (collabBootstrap === 'client' && clientSeededDocumentName !== documentName))
  const collaborationEnabled =
    collaborationRequested &&
    (collabBootstrap === 'server' ||
      (collabBootstrap === 'client' && clientSeededDocumentName === documentName))
  const ydoc = useMemo(() => new Y.Doc(), [documentName])
  const [localSync, setLocalSync] = useState<{
    documentName: string | null
    collaborationEnabled: boolean
    ready: boolean
    hasCache: boolean
  }>({
    documentName: null,
    collaborationEnabled: false,
    ready: true,
    hasCache: false,
  })
  const [remoteSync, setRemoteSync] = useState<{
    documentName: string | null
    ready: boolean
  }>({ documentName: null, ready: true })
  const [syncError, setSyncError] = useState<string | null>(null)
  const lastMarkdownRef = useRef<string | null>(null)
  const lastSyncedFrontmatterRef = useRef<Record<string, unknown> | null>(null)
  const fetchTokenRef = useRef(fetchCollabToken)
  const localReady =
    !collaborationEnabled ||
    (localSync.documentName === documentName &&
      localSync.collaborationEnabled === collaborationEnabled &&
      localSync.ready)
  const remoteReady =
    !collaborationEnabled ||
    (remoteSync.documentName === documentName && remoteSync.ready)
  const hasLocalCache =
    collaborationEnabled &&
    localSync.documentName === documentName &&
    localSync.collaborationEnabled === collaborationEnabled &&
    localSync.hasCache
  const frontmatterSnapshot = useMemo(
    () => (frontmatter ? JSON.stringify(frontmatter) : null),
    [frontmatter],
  )
  const canWriteYDocMetadata =
    collaborationEnabled &&
    !readOnly &&
    localReady &&
    !syncError &&
    (remoteReady || hasLocalCache)
  const awarenessUser = useMemo(
    () =>
      collab
        ? {
            id: collab.userId?.trim() || collab.workspaceId,
            name: cleanCollaboratorName(collab.userName),
            color: collab.userId?.trim()
              ? collabColorForId(collab.userId.trim())
              : '#4f46e5',
          }
        : null,
    [collab?.userId, collab?.userName, collab?.workspaceId],
  )
  const awareness = useMemo(
    () =>
      collaborationEnabled && awarenessUser
        ? createDohcAwareness(ydoc, {
            publish: !readOnly,
            user: awarenessUser,
          })
        : null,
    [awarenessUser, collaborationEnabled, readOnly, ydoc],
  )
  const caretProvider = useMemo(
    () => (awareness ? { awareness } : null),
    [awareness],
  )
  const [presenceUsers, setPresenceUsers] = useState<CollaborationPresenceUser[]>(
    [],
  )
  useEffect(() => {
    if (!collaborationEnabled || !awareness || !hasAwarenessPresenceApi(awareness)) {
      setPresenceUsers([])
      return
    }

    const updatePresence = () => {
      setPresenceUsers(readCollaborationPresence(awareness, ydoc.clientID))
    }

    updatePresence()
    awareness.on('update', updatePresence)
    awareness.on('change', updatePresence)
    return () => {
      awareness.off('update', updatePresence)
      awareness.off('change', updatePresence)
    }
  }, [awareness, collaborationEnabled, ydoc])
  useEffect(() => {
    fetchTokenRef.current = fetchCollabToken
  }, [fetchCollabToken])

  useEffect(() => {
    return () => ydoc.destroy()
  }, [ydoc])

  useEffect(() => {
    setLocalSync({
      documentName,
      collaborationEnabled,
      ready: !collaborationEnabled,
      hasCache: false,
    })
    setRemoteSync({ documentName, ready: !collaborationEnabled })
    setSyncError(null)
    lastSyncedFrontmatterRef.current = null
  }, [collaborationEnabled, documentName])

  useEffect(() => {
    if (!collaborationRequested || !hocuspocusUrl || !documentName) {
      setCollabBootstrap('unavailable')
      return
    }

    let cancelled = false
    setCollabBootstrap('pending')
    withTimeout(
      fetchHocuspocusCapabilities(hocuspocusUrl).then(async (capabilities) => {
        if (capabilities.atomBootstrap) return 'server' as const
        const state = await fetchHocuspocusDocumentState(
          hocuspocusUrl,
          documentName,
        )
        return state.exists ? ('server' as const) : ('client' as const)
      }),
      COLLAB_BOOTSTRAP_TIMEOUT_MS,
    )
      .then((bootstrap) => {
        if (!cancelled) setCollabBootstrap(bootstrap)
      })
      .catch(() => {
        if (!cancelled) setCollabBootstrap('unavailable')
      })

    return () => {
      cancelled = true
    }
  }, [collaborationRequested, documentName, hocuspocusUrl])

  useEffect(() => {
    if (collabBootstrap !== 'client' || !documentName) {
      setClientSeededDocumentName((current) =>
        current === null ? current : null,
      )
      return
    }
    if (clientSeededDocumentName === documentName) return

    const source = markdownToYDoc(defaultValue)
    Y.applyUpdate(ydoc, encodeDohcYDocUpdate(source))
    source.destroy()
    setClientSeededDocumentName(documentName)
  }, [collabBootstrap, clientSeededDocumentName, defaultValue, documentName, ydoc])

  useEffect(() => {
    if (!collaborationEnabled || !documentName) return

    let cancelled = false
    let persistence: IndexeddbPersistence | null = null
    const fallbackTimer = globalThis.setTimeout(() => {
      if (cancelled) return
      setLocalSync((current) =>
        current.documentName === documentName &&
        current.collaborationEnabled === collaborationEnabled &&
        !current.ready
          ? {
              documentName,
              collaborationEnabled,
              ready: true,
              hasCache: false,
            }
          : current,
      )
    }, LOCAL_SYNC_FALLBACK_MS)

    if (readOnly) {
      globalThis.clearTimeout(fallbackTimer)
      setLocalSync({
        documentName,
        collaborationEnabled,
        ready: true,
        hasCache: false,
      })
      return () => {
        cancelled = true
      }
    }

    setLocalSync({
      documentName,
      collaborationEnabled,
      ready: false,
      hasCache: false,
    })
    void hasIndexeddbYDocState(documentName)
      .catch(() => false)
      .then((hasCache) => {
        if (cancelled) return
        persistence = new IndexeddbPersistence(documentName, ydoc)
        const markSynced = () => {
          globalThis.clearTimeout(fallbackTimer)
          setLocalSync({
            documentName,
            collaborationEnabled,
            ready: true,
            hasCache,
          })
        }
        persistence.on('synced', markSynced)
        void persistence.whenSynced.then(markSynced)
      })

    return () => {
      cancelled = true
      globalThis.clearTimeout(fallbackTimer)
      void persistence?.destroy()
    }
  }, [collaborationEnabled, documentName, readOnly, ydoc])

  useEffect(() => {
    if (
      !collaborationEnabled ||
      !localReady ||
      !documentName ||
      !hocuspocusUrl ||
      !collab
    )
      return
    const provider = createDohcHocuspocusProvider({
      url: hocuspocusUrl,
      documentName,
      ydoc,
      token: () => fetchTokenRef.current(collab.workspaceId),
      awareness,
      onAuthenticated: () => setSyncError(null),
      onAuthenticationFailed: ({ reason }) => setSyncError(reason),
      onSynced: ({ state }) => {
        setRemoteSync({ documentName, ready: state })
        if (state) {
          setSyncError(null)
          markIndexeddbYDocState(documentName)
          setLocalSync((current) =>
            current.documentName === documentName
              ? { ...current, hasCache: true }
              : current,
          )
        }
      },
      onStatus: ({ status }) => {
        if (status === 'disconnected') {
          setRemoteSync({ documentName, ready: false })
        }
      },
    })
    const stopRefresh = startHocuspocusTokenRefresh(provider)
    return () => {
      stopRefresh()
      provider.destroy()
    }
  }, [
    collaborationEnabled,
    localReady,
    documentName,
    hocuspocusUrl,
    ydoc,
    collab?.workspaceId,
    awareness,
  ])

  useEffect(() => {
    if (
      !collaborationEnabled ||
      !localReady ||
      !documentName ||
      remoteReady ||
      hasLocalCache ||
      syncError
    ) {
      return
    }

    const timer = globalThis.setTimeout(() => {
      setSyncError('Sync unavailable')
    }, REMOTE_SYNC_STALL_MS)

    return () => globalThis.clearTimeout(timer)
  }, [
    collaborationEnabled,
    documentName,
    hasLocalCache,
    localReady,
    remoteReady,
    syncError,
  ])

  useEffect(() => {
    if (!canWriteYDocMetadata || !frontmatterSnapshot) return

    try {
      syncYMapFromRecord(
        ydoc.getMap('frontmatter'),
        JSON.parse(frontmatterSnapshot) as Record<string, unknown>,
        lastSyncedFrontmatterRef.current,
      )
      lastSyncedFrontmatterRef.current = JSON.parse(
        frontmatterSnapshot,
      ) as Record<string, unknown>
    } catch {
      /* malformed metadata cannot be represented as canonical Y.Map values */
    }
  }, [canWriteYDocMetadata, frontmatterSnapshot, ydoc])

  const dohcPlugins = useMemo(
    () =>
      Extension.create({
        name: 'dohcDecorations',
        addProseMirrorPlugins() {
          const wikilinkPlugin = makeWikilinkPlugin(
            () => knownFilesRef.current,
            (s) => setAcStateRef.current(s),
          )
          const wikilinkClickPlugin = new Plugin({
            key: new PluginKey('dohc-wikilink-click'),
            props: {
              handleClick(_view, _pos, event) {
                const t = event.target as HTMLElement | null
                const el = t?.closest(
                  '[data-wikilink-target], [data-dohc-wikilink]',
                ) as HTMLElement | null
                if (!el) return false
                const target =
                  el.getAttribute('data-wikilink-target') ??
                  el.getAttribute('data-dohc-wikilink')
                if (!target) return false
                event.preventDefault()
                onOpenWikilinkRef.current?.(target)
                return true
              },
            },
          })
          const atomPillClickPlugin = new Plugin({
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
            makeAsciiBlockPlugin(onAsciiClickRef),
            makeSlashCommandPlugin({
              wrapperRef: editorWrapRef,
              stateRef: slashStateRef,
              setState: setSlashState,
              runCommandRef: slashCommandRunnerRef,
            }),
            makeBlockControlsPlugin({
              onInsertRef: blockInsertRef,
              onSelectRef: blockSelectRef,
            }),
            wikilinkPlugin,
            wikilinkClickPlugin,
            atomPillClickPlugin,
            makeQueryBlockPlugin(queryResultsRef),
            makeCodeBlockChromePlugin(),
            makeCodeBlockContinuationPlugin(),
          ]
          if (inlineAtomsEnabled()) {
            extra.push(
              makeInlineAtomPlugin(),
              makeAtomPillPlugin(formulaRef, liveTotalsRef, fileIdMapRef),
            )
          }
          return extra
        },
      }),
    [
      fileIdMapRef,
      formulaRef,
      knownFilesRef,
      liveTotalsRef,
      onAsciiClickRef,
      onOpenWikilinkRef,
      queryResultsRef,
    ],
  )

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: false,
        undoRedo: collaborationEnabled ? false : undefined,
        trailingNode: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: null,
      }),
      ...dohcMarkdownExtensions,
      TableKit,
      Markdown.configure({ indentation: { style: 'space', size: 2 } }),
      Placeholder.configure({
        includeChildren: true,
        showOnlyCurrent: false,
        placeholder: ({ node }) => {
          if (node.type.name === 'tableCell' || node.type.name === 'tableHeader')
            return ''
          if (node.type.name === 'heading') return 'Heading'
          return "Type '/' for commands"
        },
      }),
      ...(collaborationRequired
        ? []
        : [
            TrailingNode.configure({
              node: 'paragraph',
              notAfter: ['paragraph'],
            }),
          ]),
      ...(collaborationEnabled
        ? [Collaboration.configure({ document: ydoc, field: 'body' })]
        : []),
      ...(collaborationEnabled && caretProvider && awarenessUser && !readOnly
        ? [
            CollaborationCaret.configure({
              provider: caretProvider,
              user: awarenessUser,
              render: renderCollaborationCaret,
              selectionRender: renderCollaborationSelection,
            }),
          ]
        : []),
      dohcPlugins,
    ],
    [
      awarenessUser,
      caretProvider,
      collaborationEnabled,
      collaborationRequired,
      dohcPlugins,
      readOnly,
      ydoc,
    ],
  )

  const editor = useEditor(
    {
      extensions,
      content: collaborationEnabled ? undefined : defaultValue,
      contentType: collaborationEnabled ? undefined : 'markdown',
      editorProps: {
        attributes: {
          class: 'dohc-notion-editor',
        },
      },
      editable: canEditDohcEditor({
        readOnly,
        collaborationRequired,
        collaborationEnabled,
        collaborationPending,
        localReady,
        remoteReady,
        hasLocalCache,
        syncError,
      }),
      immediatelyRender: false,
      onUpdate({ editor, transaction }) {
        const markdown = editor.getMarkdown()
        if (markdown === lastMarkdownRef.current) return
        lastMarkdownRef.current = markdown
        if (collaborationEnabled && isChangeOrigin(transaction)) {
          onPreviewChangeRef.current?.(markdown)
          return
        }
        onChangeRef.current(markdown)
      },
    },
    [extensions, collaborationEnabled, documentName],
  )

  const openSlashMenuAtPosition = useCallback(
    (pos: number) => {
      const view = editor?.view
      if (!view) return

      let x = 0
      let y = 28
      try {
        const coords = view.coordsAtPos(pos)
        const wrapperRect = editorWrapRef.current?.getBoundingClientRect()
        x = Math.max(0, coords.left - (wrapperRect?.left ?? 0))
        y = Math.max(0, coords.bottom - (wrapperRect?.top ?? 0) + 6)
      } catch {
        /* jsdom and offscreen editors cannot always resolve coordinates */
      }

      setSlashState({
        open: true,
        from: pos,
        to: pos,
        query: '',
        selected: 0,
        x,
        y,
      })
    },
    [editor],
  )

  const insertBlockAfter = useCallback(
    (pos: number) => {
      const view = editor?.view
      if (!view || !isEditableEditor(editor)) return

      const { state } = view
      const node = state.doc.nodeAt(pos)
      const paragraph = state.schema.nodes.paragraph
      if (!node || !paragraph) return

      const canReuseEmptyParagraph =
        node.type.name === 'paragraph' && node.textContent.length === 0
      const selectionPos = canReuseEmptyParagraph
        ? pos + 1
        : pos + node.nodeSize + 1
      const tr = canReuseEmptyParagraph
        ? state.tr
        : state.tr.insert(pos + node.nodeSize, paragraph.create())
      tr
        .setSelection(TextSelection.near(tr.doc.resolve(selectionPos)))
        .scrollIntoView()
      view.dispatch(tr)
      view.focus()
      openSlashMenuAtPosition(selectionPos)
    },
    [editor, openSlashMenuAtPosition],
  )

  const selectBlock = useCallback(
    (pos: number) => {
      const view = editor?.view
      if (!view) return
      const node = view.state.doc.nodeAt(pos)
      if (!node) return
      view.dispatch(
        view.state.tr
          .setSelection(NodeSelection.create(view.state.doc, pos))
          .scrollIntoView(),
      )
      view.focus()
    },
    [editor],
  )

  useEffect(() => {
    blockInsertRef.current = insertBlockAfter
    blockSelectRef.current = selectBlock
  }, [insertBlockAfter, selectBlock])

  const runSlashCommand = useCallback(
    (id: SlashCommandId) => {
      const state = slashStateRef.current
      if (!state.open || !editor) return
      if (!isEditableEditor(editor)) return

      const range = { from: state.from, to: state.to }
      const chain = editor
        .chain()
        .focus()
        .deleteRange(range) as unknown as SlashCommandChain
      setSlashState(CLOSED_SLASH_COMMAND_STATE)

      switch (id) {
        case 'ascii-sketch':
          chain.run()
          window.dispatchEvent(new CustomEvent(OPEN_SKETCH_EVENT))
          return
        case 'wikilink':
          chain.insertContent('[[]]').setTextSelection(state.from + 2).run()
          return
        case 'heading-1':
          chain.toggleHeading({ level: 1 }).run()
          return
        case 'heading-2':
          chain.toggleHeading({ level: 2 }).run()
          return
        case 'heading-3':
          chain.toggleHeading({ level: 3 }).run()
          return
        case 'bulleted-list':
          chain.toggleBulletList().run()
          return
        case 'numbered-list':
          chain.toggleOrderedList().run()
          return
        case 'quote':
          chain.toggleBlockquote().run()
          return
        case 'code-block':
          chain.setCodeBlock({ language: '' }).run()
          return
        case 'divider':
          chain.setHorizontalRule().run()
          return
        case 'table':
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          return
        case 'query-block':
          chain
            .setCodeBlock({ language: 'query' })
            .insertContent('entities.list("project")')
            .run()
          return
      }
    },
    [editor],
  )

  useEffect(() => {
    slashCommandRunnerRef.current = runSlashCommand
  }, [runSlashCommand])

  useEffect(() => {
    editorRef.current = editor
    return () => {
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [editor, editorRef])

  const editable = canEditDohcEditor({
    readOnly,
    collaborationRequired,
    collaborationEnabled,
    collaborationPending,
    localReady,
    remoteReady,
    hasLocalCache,
    syncError,
  })
  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!autoFocus || !editor) return
    const id = requestAnimationFrame(() => {
      editor.commands.focus('end')
    })
    return () => cancelAnimationFrame(id)
  }, [autoFocus, editor])

  // Resolved live-totals changed (reactive query) → ask the plugin to
  // rebuild its value widgets from the fresh ref via a no-op meta
  // transaction. Best-effort: harmless if the editor isn't ready.
  useEffect(() => {
    try {
      const view = editor?.view
      view?.dispatch(view.state.tr.setMeta(liveTotalKey, true))
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [liveTotalsTick, editor])

  // Parallel refresh for resolved formulas (same no-op meta-tr
  // mechanism; distinct key so it never disturbs the live-total set).
  useEffect(() => {
    try {
      const view = editor?.view
      view?.dispatch(view.state.tr.setMeta(formulaKey, true))
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [formulaTick, editor])

  // Parallel refresh for resolved query-block results (§5.2 4B).
  useEffect(() => {
    try {
      const view = editor?.view
      view?.dispatch(view.state.tr.setMeta(queryBlockKey, true))
    } catch {
      /* editor not mounted yet — init() already reads the ref */
    }
  }, [queryTick, editor])

  // D4.8b — viewRef gives the picker access to coordsAtPos + dispatch.
  const pickerView = editor
    ? (editor.view as Parameters<typeof WikilinkPicker>[0]['view'])
    : null
  const pickerState: Parameters<typeof WikilinkPicker>[0]['state'] =
    acState.active
      ? { open: true, from: acState.from, query: acState.query }
      : { open: false }
  return (
    <div className="dohc-tiptap-editor" ref={editorWrapRef}>
      {collaborationRequired &&
        (collaborationPending ||
          !hocuspocusUrl ||
          collabBootstrap === 'unavailable' ||
          (collaborationEnabled &&
            (!localReady || syncError || (!remoteReady && !hasLocalCache)))) && (
          <div className="dohc-editor-sync-state" role="status">
            {syncError || !hocuspocusUrl || collabBootstrap === 'unavailable'
              ? 'Sync unavailable'
              : 'Syncing…'}
          </div>
        )}
      {collaborationEnabled && (
        <div className="dohc-editor-presence" role="status" aria-live="polite">
          <span className="dohc-editor-presence-dot" aria-hidden="true" />
          <span className="dohc-editor-presence-text">Synced</span>
          {presenceUsers.length > 0 && (
            <div
              className="dohc-collab-avatars"
              aria-label="Collaborators in this document"
            >
              {presenceUsers.slice(0, 5).map((user) => (
                <span
                  key={user.clientId}
                  className={`dohc-collab-avatar${
                    user.isLocal ? ' is-local' : ''
                  }`}
                  style={{ '--dohc-collab-color': user.color } as React.CSSProperties}
                  title={`${user.name}${user.isLocal ? ' (you)' : ''}`}
                  aria-label={`${user.name}${user.isLocal ? ' (you)' : ''}`}
                >
                  {user.initials}
                </span>
              ))}
              {presenceUsers.length > 5 && (
                <span className="dohc-collab-avatar is-count">
                  +{presenceUsers.length - 5}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <EditorContent editor={editor} />
      <SlashCommandMenu
        state={slashState}
        onSelect={runSlashCommand}
        onHover={(index) =>
          setSlashState((current) =>
            current.open ? { ...current, selected: index } : current,
          )
        }
      />
      <WikilinkPicker
        state={pickerState}
        files={knownFilesArray}
        view={pickerView}
        onDismiss={() => setAcState({ active: false })}
      />
    </div>
  )
}

export const AtomEditor = forwardRef<AtomEditorHandle, Props>(function AtomEditor(
  {
    value,
    onChange,
    onPreviewChange,
    autoFocus,
    onAsciiBlockClick,
    knownFiles,
    onOpenWikilink,
    shareId,
    disableReactiveResolvers,
    readOnly,
    frontmatter,
    collab,
  },
  ref,
) {
  const activeWorkspaceId = useActiveWorkspaceId()
  const getCollabToken = useAction(api.auth.getCollabToken)
  const fetchCollabToken = useMemo(
    () => async (workspaceId: string) =>
      await getCollabToken({ workspaceId }),
    [getCollabToken],
  )
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const onPreviewChangeRef = useRef<((next: string) => void) | null>(
    onPreviewChange ?? null,
  )
  useEffect(() => {
    onPreviewChangeRef.current = onPreviewChange ?? null
  }, [onPreviewChange])

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

  const editorRef = useRef<Editor | null>(null)

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
    !disableReactiveResolvers && !shareId && liveIdents.length
      ? { identifiers: liveIdents }
      : 'skip',
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
    // SAME key the widget derives from the doc span, so Tiptap's
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
    !disableReactiveResolvers && !shareId && formulaSrcs.length
      ? { srcs: formulaSrcs, activeWorkspaceId }
      : 'skip',
  )
  const resolvedFormulasShared = useQuery(
    api.formulaEval.evalFormulasShared,
    !disableReactiveResolvers && shareId && formulaSrcs.length
      ? { shareId, srcs: formulaSrcs }
      : 'skip',
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
    !disableReactiveResolvers && !shareId && querySrcs.length
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
        const editor = editorRef.current
        if (!editor || !isEditableEditor(editor)) return
        const view = editor.view
        const { state } = view
        const codeBlockType =
          state.schema.nodes.codeBlock ?? state.schema.nodes.code_block
        const paragraphType = state.schema.nodes.paragraph
        if (!codeBlockType) return
        const textNode = content ? state.schema.text(content) : null
        const node = codeBlockType.create(
          { language },
          textNode ? [textNode] : undefined,
        )

        if (
          paragraphType &&
          isAsciiSketchLanguage(language) &&
          state.selection.empty &&
          state.selection.$from.parent.isTextblock &&
          state.selection.$from.parent.textContent.trim() === ''
        ) {
          const blockStart = state.selection.$from.before()
          const blockEnd = state.selection.$from.after()
          const afterSketchPos = blockStart + node.nodeSize
          let tr = state.tr.replaceWith(blockStart, blockEnd, node)
          tr = tr.insert(afterSketchPos, paragraphType.create())
          tr = tr
            .setSelection(TextSelection.create(tr.doc, afterSketchPos + 1))
            .scrollIntoView()
          view.dispatch(tr)
          view.focus()
          return
        }

        const tr = state.tr.replaceSelectionWith(node).scrollIntoView()
        view.dispatch(tr)
        view.focus()
      },
      replaceCodeBlockAt(pos: number, content: string, language?: string) {
        const editor = editorRef.current
        if (!editor || !isEditableEditor(editor)) return
        const view = editor.view
        const { state } = view
        const node = state.doc.nodeAt(pos)
        if (
          !node ||
          (node.type.name !== 'code_block' && node.type.name !== 'codeBlock')
        )
          return
        const codeBlockType =
          state.schema.nodes.codeBlock ?? state.schema.nodes.code_block
        if (!codeBlockType) return
        const textNode = content ? state.schema.text(content) : null
        const next = codeBlockType.create(
          language ? { ...node.attrs, language } : node.attrs,
          textNode ? [textNode] : undefined,
        )
        const tr = state.tr
          .replaceWith(pos, pos + node.nodeSize, next)
          .scrollIntoView()
        view.dispatch(tr)
      },
    }),
    [],
  )

  return (
    <TiptapAtomEditor
      defaultValue={value}
      onChangeRef={onChangeRef}
      onPreviewChangeRef={onPreviewChangeRef}
      autoFocus={!!autoFocus}
      editorRef={editorRef}
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
      collab={collab}
      fetchCollabToken={fetchCollabToken}
      readOnly={!!readOnly}
      frontmatter={frontmatter}
    />
  )
})
