// Syntax highlighting inside WYSIWYG code blocks — a ProseMirror decoration
// plugin, deliberately not a schema/nodeView change. The `codeBlock` schema
// is contract-locked across the desktop and workspace-api packages (see
// schema-parity.test.ts); a decoration layer paints `hljs-*` classes over the
// existing text without touching the node's markdown round-trip.
//
// Only the languages offered by the code-block language <select> (see
// CODE_LANGUAGE_OPTIONS in codeBlockChrome.tsx) are registered, keeping the
// lowlight/highlight.js grammar bundle small. `tsx`/`jsx` intentionally reuse
// the typescript/javascript grammars — there is no meaningfully different
// highlight.js grammar for the JSX variants.

import type { LanguageFn } from 'highlight.js'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const codeHighlightKey = new PluginKey('dohc-code-highlight')

// Keys mirror CODE_LANGUAGE_OPTIONS' `value`s exactly (minus "" / Plain
// text), so the plugin can key straight off the codeBlock's `language`
// attribute with no extra mapping step.
const REGISTERED_GRAMMARS: Readonly<Record<string, LanguageFn>> = {
  typescript,
  tsx: typescript,
  javascript,
  jsx: javascript,
  python,
  bash,
  json,
  markdown,
  html: xml,
  css,
  sql,
  yaml,
  go,
  rust,
}

const lowlight = createLowlight(REGISTERED_GRAMMARS)

// Skip huge blocks — lowlight is a full tokenizer pass, not worth paying for
// on pathological documents (and the editor already caps other expensive
// per-doc work at similar sizes).
const MAX_HIGHLIGHT_CHARS = 20_000

function isHighlightableLanguage(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTERED_GRAMMARS, language)
}

// Minimal structural shape of the hast tree lowlight returns — narrow enough
// to avoid pulling in `@types/hast` directly, wide enough for hljs output
// (which only ever emits `root` > `element`/`text`).
type HastNode = {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

export type HighlightSpan = { start: number; end: number; className: string }

function classNameOf(node: HastNode): string | null {
  const className = node.properties?.className
  if (!Array.isArray(className) || className.length === 0) return null
  const names = className.filter((name): name is string => typeof name === 'string')
  return names.length > 0 ? names.join(' ') : null
}

// Walk the hast tree, emitting one span per element covering its full text
// range with just that element's own class — nested elements (e.g. a
// hljs-doctag inside a hljs-comment) naturally produce overlapping spans,
// which `Decoration.inline` supports directly.
function collectSpans(nodes: HastNode[], offset: number, spans: HighlightSpan[]): number {
  let pos = offset
  for (const node of nodes) {
    if (node.type === 'text') {
      pos += (node.value ?? '').length
      continue
    }
    const start = pos
    pos = collectSpans(node.children ?? [], pos, spans)
    const className = classNameOf(node)
    if (className && pos > start) spans.push({ start, end: pos, className })
  }
  return pos
}

/** PURE: tokenize `text` as `language` and return highlight spans relative
 *  to the start of `text`. Returns `[]` for unregistered languages or if
 *  hljs itself throws (malformed input should never crash the editor). */
export function highlightSpans(language: string, text: string): HighlightSpan[] {
  if (!isHighlightableLanguage(language) || text.length === 0) return []
  try {
    const tree = lowlight.highlight(language, text) as unknown as { children: HastNode[] }
    const spans: HighlightSpan[] = []
    collectSpans(tree.children, 0, spans)
    return spans
  } catch {
    return []
  }
}

// Minimal structural shapes so the walk is testable without a real
// ProseMirror/jsdom instance — same pattern as inlineAtomPlugin.ts.
export type PMNodeLike = {
  type: { name: string }
  attrs?: Record<string, unknown>
  textContent: string
}
export type PMDocLike = {
  descendants: (cb: (node: PMNodeLike, pos: number) => boolean | void) => void
}

function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === 'code_block' || node.type.name === 'codeBlock'
}

function normalizeLanguage(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export type CodeHighlightRange = { from: number; to: number; className: string }

/** PURE: walk the doc, resolve each codeBlock's spans (via `cache` when the
 *  node object is unchanged — ProseMirror nodes are immutable, so a cache
 *  hit means both identity and content are unchanged) and return absolute
 *  doc-coordinate ranges. */
export function computeCodeHighlightRanges(
  doc: PMDocLike,
  cache: WeakMap<PMNodeLike, HighlightSpan[]>,
): CodeHighlightRange[] {
  const ranges: CodeHighlightRange[] = []
  doc.descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return
    const language = normalizeLanguage(node.attrs?.language)
    if (!isHighlightableLanguage(language)) return false
    const text = node.textContent
    if (text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) return false

    let spans = cache.get(node)
    if (!spans) {
      spans = highlightSpans(language, text)
      cache.set(node, spans)
    }

    const blockStart = pos + 1
    for (const span of spans) {
      if (span.end <= span.start) continue
      ranges.push({ from: blockStart + span.start, to: blockStart + span.end, className: span.className })
    }
    return false // codeBlock content is plain text — nothing more to descend into
  })
  return ranges
}

function buildHighlightDecorations(doc: unknown, cache: WeakMap<PMNodeLike, HighlightSpan[]>): DecorationSet {
  const decorations = computeCodeHighlightRanges(doc as PMDocLike, cache).map((range) =>
    Decoration.inline(range.from, range.to, { class: range.className }),
  )
  return DecorationSet.create(doc as never, decorations)
}

/** Build the plugin. A fresh WeakMap per instance caches lowlight's (fairly
 *  expensive) tokenizer pass per codeBlock node object — since codeBlock
 *  nodes are immutable, editing one block or changing its language produces
 *  a new node object for that block only, so unaffected blocks reuse their
 *  cached spans on every doc change instead of re-tokenizing. */
export function makeCodeHighlightPlugin() {
  const cache = new WeakMap<PMNodeLike, HighlightSpan[]>()
  return new Plugin({
    key: codeHighlightKey,
    state: {
      init(_, instance) {
        return buildHighlightDecorations(instance.doc, cache)
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc)
        return buildHighlightDecorations(tr.doc, cache)
      },
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state) as DecorationSet | undefined
      },
    },
  })
}
