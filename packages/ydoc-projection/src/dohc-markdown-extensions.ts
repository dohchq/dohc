import { Extension, Mark, Node, markInputRule } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { TaskItem } from '@tiptap/extension-list'

function firstTokenMatch(src: string, pattern: RegExp): RegExpMatchArray | null {
  const match = src.match(pattern)
  return match?.index === 0 ? match : null
}

function firstUnescapedIndex(src: string, pattern: RegExp): number {
  const match = pattern.exec(src)
  if (!match || match.index < 0) return -1
  return match.index + (match[1]?.length ?? 0)
}

function findClosingWikilink(src: string): number {
  for (let index = 2; index < src.length - 1; index += 1) {
    if (src[index] === '\\') {
      index += 1
      continue
    }
    if (src[index] === ']' && src[index + 1] === ']') return index
  }
  return -1
}

// A wikilink's `target`/`label` are delimited by `|` and closed by `]]`, so a
// value that itself contains `\`, `]`, or `|` must be backslash-escaped when
// serialized or it would re-parse as a truncated link (e.g. a mention labeled
// `Plan ]] Draft` would close the wikilink early). escape/unescape are inverses
// applied at renderMarkdown/parse time; the node attrs always hold the raw,
// human-readable value.
function escapeWikilinkPart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\]|])/g, '\\$1')
}

function unescapeWikilinkPart(value: string): string {
  return value.replace(/\\([\\\]|])/g, '$1')
}

function splitWikilinkInner(inner: string): [string, string | null] {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '\\') {
      index += 1
      continue
    }
    if (inner[index] === '|') {
      return [
        unescapeWikilinkPart(inner.slice(0, index)),
        unescapeWikilinkPart(inner.slice(index + 1)),
      ]
    }
  }
  return [unescapeWikilinkPart(inner), null]
}

function renderMarkdownImage(attrs: {
  alt?: unknown
  src?: unknown
  title?: unknown
}): string {
  const alt = escapeMarkdownLineBreaks(
    String(attrs.alt ?? '')
      .replaceAll('\\', '\\\\')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]'),
  )
  const sanitizedSrc = sanitizeImageSrc(String(attrs.src ?? ''))
  // A destination with spaces is only valid CommonMark inside angle
  // brackets — without them the src would not re-parse and the round-trip
  // would break. Line breaks are handled by escapeMarkdownLineBreaks (they
  // become a literal "\n" sequence), so only inline whitespace matters here.
  const src = /[ \t]/.test(sanitizedSrc)
    ? `<${escapeMarkdownLineBreaks(
        sanitizedSrc
          .replaceAll('\\', '\\\\')
          .replaceAll('<', '\\<')
          .replaceAll('>', '\\>'),
      )}>`
    : escapeMarkdownLineBreaks(
        sanitizedSrc
          .replaceAll('\\', '\\\\')
          .replaceAll('(', '\\(')
          .replaceAll(')', '\\)'),
      )
  const title = typeof attrs.title === 'string' && attrs.title.length > 0
    ? ` "${escapeMarkdownLineBreaks(
        attrs.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
      )}"`
    : ''
  return `![${alt}](${src}${title})`
}

function escapeMarkdownLineBreaks(value: string): string {
  return value
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
}

function sanitizeImageSrc(src: string): string {
  const trimmed = src.trim()
  if (trimmed.length === 0) return ''
  // Strip control chars/whitespace before sniffing so obfuscated schemes
  // ("java\nscript:") can't slip a colon past the check.
  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '')
  const compactProtocol = /^[a-z][a-z\d+.-]*:/i.exec(compact)?.[0]
  if (compactProtocol) {
    const protocol = compactProtocol.slice(0, -1).toLowerCase()
    // Only remote http(s) images render; data:/javascript:/file:/every other
    // scheme is dropped.
    return protocol === 'http' || protocol === 'https' ? trimmed : ''
  }
  // Scheme-less: allow only a workspace-relative path. Backslashes are folded
  // to '/' for the checks so a Windows-style traversal can't sneak through,
  // but the ORIGINAL (lossless) src is what we return — agents edit the .md.
  const forCheck = compact.replace(/\\/g, '/')
  // Reject protocol-relative ("//host") and absolute ("/abs") — both escape
  // the document's folder and can never be a workspace-relative asset.
  if (forCheck.startsWith('/')) return ''
  // CONTRACT (kept in lockstep with apps/desktop/src/renderer/editor): forward-
  // slash parent traversal (`../foo`) is PRESERVED losslessly. Agents
  // legitimately author upward-relative asset links — the global-folder
  // attachment mode writes `../assets/x.png` so a nested doc can point at one
  // folder at the workspace root.
  //
  // This projection copy never paints to a screen, and the sanitizer's job is
  // the MARKDOWN (what round-trips into the .md), not what any surface may load.
  // Every surface that can actually FETCH the src gates it itself, and none of
  // them may fall back to the raw path:
  //   - the editor: imageSrc.ts serves a src over dohc-file:// only if it
  //     normalizes inside the workspace root, and emits NO src otherwise (a raw
  //     relative path would resolve against the app's own page);
  //   - the protocol layer: readWorkspaceAsset / the dohc-file handler re-check
  //     real-path containment;
  //   - exports: documentExport.ts drops any src that could climb out of the
  //     exported file's own folder (see its EXPORT IMAGE CONTRACT).
  //
  // A BACKSLASH-obfuscated `..\` is never legitimate authored markdown, so it
  // stays blocked here (backslashes are folded to '/' first).
  if (compact.includes('\\') && /(^|\/)\.\.(\/|$)/.test(forCheck)) return ''
  return trimmed
}

function escapedPunctuationValue(token: {
  content?: unknown
  text?: unknown
  markup?: unknown
  raw?: unknown
}): string {
  const content = token.content ?? token.text
  if (content != null) return String(content)
  return String(token.markup ?? token.raw ?? '').replace(/^\\/, '')
}

function imageAltText(token: {
  content?: unknown
  text?: unknown
  tokens?: Array<{ text?: unknown }>
}): string {
  if (Array.isArray(token.tokens)) {
    return token.tokens.map((child) => String(child.text ?? '')).join('')
  }
  return String(token.content ?? token.text ?? '')
}

function imageTokenAttr(
  token: unknown,
  name: string,
  fallback: unknown,
): string {
  const attrGet = (token as { attrGet?: (name: string) => unknown }).attrGet
  const value = typeof attrGet === 'function' ? attrGet(name) : fallback
  return String(value ?? '')
}

const DohcImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false
          return {
            src: sanitizeImageSrc(dom.getAttribute('src') || ''),
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || null,
          }
        },
      },
    ]
  },

  renderHTML({ node }) {
    const attrs: Record<string, string> = {
      src: sanitizeImageSrc(String(node.attrs.src ?? '')),
      alt: String(node.attrs.alt ?? ''),
    }
    if (typeof node.attrs.title === 'string' && node.attrs.title.length > 0) {
      attrs.title = node.attrs.title
    }
    return ['img', attrs]
  },

  markdownTokenName: 'image',

  parseMarkdown: (token, helpers) =>
    helpers.createNode('image', {
      src: sanitizeImageSrc(imageTokenAttr(token, 'src', token.href)),
      alt: imageAltText(token),
      title: imageTokenAttr(token, 'title', token.title) || null,
    }),

  renderMarkdown: (node) => renderMarkdownImage(node.attrs ?? {}),
})

const DohcEscapedPunctuation = Node.create({
  name: 'escapedPunctuation',
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      value: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-dohc-escaped-punctuation]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false
          const value = dom.getAttribute('data-dohc-escaped-punctuation')
          return value != null ? { value } : false
        },
      },
    ]
  },

  renderHTML({ node }) {
    return [
      'span',
      { 'data-dohc-escaped-punctuation': node.attrs.value },
      String(node.attrs.value ?? ''),
    ]
  },

  markdownTokenName: 'escape',

  parseMarkdown: (token, helpers) =>
    helpers.createNode('escapedPunctuation', {
      value: escapedPunctuationValue(token),
    }),

  renderMarkdown: (node) =>
    `\\${escapeMarkdownLineBreaks(String(node.attrs?.value ?? ''))}`,
})

const DohcWikilink = Node.create({
  name: 'wikilink',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-wikilink]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      {
        class: 'dohc-wikilink-pill',
        contenteditable: 'false',
        'data-wikilink-target': node.attrs.target,
        'data-dohc-wikilink': node.attrs.target,
        'data-dohc-wikilink-label': node.attrs.label,
      },
      node.attrs.label || node.attrs.target,
    ]
  },

  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start(src) {
      // Inner run allows escaped chars (`\]`, `\|`, `\\`) so a wikilink whose
      // label contains an escaped delimiter is still detected mid-line; the
      // authoritative bounds come from findClosingWikilink in tokenize.
      return firstUnescapedIndex(src, /(^|[^\\])\[\[(?:\\.|[^\]\n\\])+\]\]/)
    },
    tokenize(src) {
      if (!src.startsWith('[[')) return undefined
      const closingIndex = findClosingWikilink(src)
      if (closingIndex === -1) return undefined
      const raw = src.slice(0, closingIndex + 2)
      const [target, label] = splitWikilinkInner(raw.slice(2, -2))
      return { type: 'wikilink', raw, target, label }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('wikilink', {
      target: token.target,
      label: token.label ?? null,
    }),

  renderMarkdown: (node) => {
    const target = escapeWikilinkPart(String(node.attrs?.target ?? ''))
    const label = node.attrs?.label
    return label
      ? `[[${target}|${escapeWikilinkPart(String(label))}]]`
      : `[[${target}]]`
  },
})

const DohcInlineAtom = Node.create({
  name: 'inlineAtom',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      atomId: { default: '' },
      params: { default: '' },
      source: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-inline-atom]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      {
        'data-dohc-inline-atom': node.attrs.atomId,
        'data-dohc-inline-atom-params': node.attrs.params,
      },
      `{{${node.attrs.source || `atom:${node.attrs.atomId ?? ''}`}}}`,
    ]
  },

  markdownTokenizer: {
    name: 'inlineAtom',
    level: 'inline',
    start: '{{atom:',
    tokenize(src) {
      const match = firstTokenMatch(src, /^\{\{atom:([^}\s]+)([^}]*)\}\}/)
      if (!match) return undefined
      const [raw, atomId = '', params = ''] = match
      return {
        type: 'inlineAtom',
        raw,
        atomId,
        params: params.trim(),
        source: raw.slice(2, -2),
      }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('inlineAtom', {
      atomId: token.atomId,
      params: token.params,
      source: token.source,
    }),

  renderMarkdown: (node) =>
    `{{${node.attrs?.source || `atom:${node.attrs?.atomId ?? ''}`}}}`,
})

// Obsidian callout syntax: a blockquote whose first line is `[!type]` with an
// optional fold flag (`-` folded, `+` open) and an optional title, e.g.
// `> [!note]- My title`. Unknown callout types are preserved verbatim (styled
// like a note but keeping the original type string) so nothing is ever dropped.
const DEFAULT_CALLOUT_TYPE = 'note'
const CALLOUT_HEADER_RE = /^\[!([^\]\n]+)\]([+-]?)[ \t]*(.*)$/
const CALLOUT_LINE_RE = /^ {0,3}>/

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^ {0,3}> ?/, '')
}

function normalizeCalloutFold(value: unknown): '' | '-' | '+' {
  return value === '-' || value === '+' ? value : ''
}

function calloutTitleForMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function findClosingHighlight(src: string): number {
  for (let index = 2; index < src.length - 1; index += 1) {
    if (src[index] === '\\') {
      index += 1
      continue
    }
    if (src[index] === '=' && src[index + 1] === '=') return index
  }
  return -1
}

// EVERY `=` inside highlighted text is backslash-escaped so the inline
// tokenizer's `\`-skipping in findClosingHighlight never mistakes it for a
// closing delimiter. Escaping only runs of `==` is not enough: a single `=`
// sitting next to the closing `==` (e.g. the highlight body `a=`) would
// serialize to `==a===`, whose first `==` scanned from the left closes the mark
// one char early. The base markdown manager renders a mark's inner text
// verbatim (only its opening/closing `==` delimiters come from renderMarkdown),
// so this escaping has to be applied to the highlight-marked text nodes before
// serialization — see escapeHighlightMarkdown below. Each `\=` round-trips back
// through the base `escape` token (an escapedPunctuation node whose
// renderMarkdown re-emits `\=`), so once escaped the text carries no bare `=`.
function escapeHighlightBody(body: string): string {
  return body.replace(/=/g, '\\=')
}

function hasHighlightMark(node: JSONContent): boolean {
  return (node.marks ?? []).some((mark) => mark.type === 'highlight')
}

// Escape literal `==` inside every highlight-marked text node so a highlight
// applied over text containing `==` (only reachable via the toggle command,
// which wraps an arbitrary selection) serializes to an unambiguous, losslessly
// reversible `==a\=\=b==` instead of the ambiguous `==a==b==`. Returns a fresh
// tree; the input JSON is not mutated.
export function escapeHighlightMarkdown(node: JSONContent): JSONContent {
  const next: JSONContent = { ...node }
  if (typeof node.text === 'string' && hasHighlightMark(node)) {
    next.text = escapeHighlightBody(node.text)
  }
  if (Array.isArray(node.content)) {
    next.content = node.content.map(escapeHighlightMarkdown)
  }
  return next
}

// A `\=` inside a highlight must round-trip as a literal `=` in a plain text
// node — NOT as an escapedPunctuation atom, because the base manager closes and
// reopens marks around every inline atom, which would split the `==...==` span.
// We therefore decode `\=` to this private-use placeholder before tokenizing
// (so marked sees ordinary text, and no bare `==` can re-fire the highlight
// rule), then restore it to `=` in the parsed text nodes.
const HIGHLIGHT_EQUALS_PLACEHOLDER = '\uE010'

function restoreHighlightPlaceholders(nodes: JSONContent[]): JSONContent[] {
  return nodes.map((node) => {
    const next: JSONContent = { ...node }
    if (typeof node.text === 'string' && node.text.includes(HIGHLIGHT_EQUALS_PLACEHOLDER)) {
      next.text = node.text.split(HIGHLIGHT_EQUALS_PLACEHOLDER).join('=')
    }
    if (Array.isArray(node.content)) {
      next.content = restoreHighlightPlaceholders(node.content)
    }
    return next
  })
}

// Inline (non-block) node types this pipeline can emit. Loose inline children
// under a `block+` callout (e.g. a callout nested in a tight list item, where
// marked yields inline text tokens instead of a paragraph) must be wrapped in a
// paragraph or the projection drops them.
const INLINE_CALLOUT_CHILD_TYPES = new Set([
  'text',
  'hardBreak',
  'image',
  'escapedPunctuation',
  'wikilink',
  'inlineAtom',
])

type CalloutParseHelpers = {
  createNode: (
    type: string,
    attrs?: Record<string, unknown>,
    content?: JSONContent[],
  ) => JSONContent
}

function wrapLooseCalloutChildren(
  children: JSONContent[],
  helpers: CalloutParseHelpers,
): JSONContent[] {
  const result: JSONContent[] = []
  let run: JSONContent[] = []
  const flush = () => {
    if (run.length > 0) {
      result.push(helpers.createNode('paragraph', {}, run))
      run = []
    }
  }
  for (const child of children) {
    if (typeof child?.type === 'string' && INLINE_CALLOUT_CHILD_TYPES.has(child.type)) {
      run.push(child)
    } else {
      flush()
      result.push(child)
    }
  }
  flush()
  return result
}

// A line that begins a new block construct, so it must NOT be absorbed as a
// blockquote-style lazy-continuation line of the callout's trailing paragraph.
const CALLOUT_LAZY_BREAK_RE =
  /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:```|~~~)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|<[a-zA-Z!/])/

// A code fence opener (```/~~~, up to 3 leading spaces, optional info string).
// Returns the fence run so the closer can be length/char-matched.
function calloutFenceOpener(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  return match ? (match[1] ?? null) : null
}

// A fence closer: same character as the opener, at least as long, nothing but
// trailing whitespace after it.
function isCalloutFenceCloser(line: string, opener: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  if (!match) return false
  const fence = match[1] ?? ''
  return fence[0] === opener[0] && fence.length >= opener.length
}

const DohcCallout = Node.create({
  name: 'callout',
  priority: 1000,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      calloutType: { default: DEFAULT_CALLOUT_TYPE },
      title: { default: '' },
      fold: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-dohc-callout]' }]
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        class: 'dohc-callout',
        'data-dohc-callout': '',
        'data-callout-type': String(node.attrs.calloutType ?? DEFAULT_CALLOUT_TYPE),
        'data-fold': normalizeCalloutFold(node.attrs.fold),
        'data-callout-title': String(node.attrs.title ?? ''),
      },
      ['div', { class: 'dohc-callout-body' }, 0],
    ]
  },

  // Block-level tokenizer so plain blockquotes (no `[!type]` first line) fall
  // through to the built-in blockquote tokenizer untouched — we only claim the
  // block when the header line matches, otherwise we return undefined.
  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start(src) {
      const match = /(?:^|\n)( {0,3}>\s?\[!)/.exec(src)
      if (!match) return -1
      return match.index === 0 ? 0 : match.index + 1
    },
    tokenize(src, _tokens, helpers) {
      const lines = src.split('\n')
      let count = 0
      // Track whether an open PARAGRAPH is currently continuable, so we only
      // absorb blockquote-style lazy-continuation lines (mirroring CommonMark).
      // A blank inner line, a heading/list/hr/html/nested-quote, or a fenced
      // code block all close the paragraph — only then must an unquoted line NOT
      // be pulled in. Tracking just "was the last line blank" wrongly absorbed
      // text after a fence/heading whose (non-blank) line left no paragraph open.
      let paragraphOpen = false
      // Non-null while inside a `>`-quoted fenced code block (holds the opener
      // run) so its content lines aren't mistaken for paragraph text.
      let openFence: string | null = null
      const applyInnerLine = (inner: string) => {
        if (openFence !== null) {
          if (isCalloutFenceCloser(inner, openFence)) openFence = null
          paragraphOpen = false
          return
        }
        const opener = calloutFenceOpener(inner)
        if (opener !== null) {
          openFence = opener
          paragraphOpen = false
        } else if (inner.trim() === '' || CALLOUT_LAZY_BREAK_RE.test(inner)) {
          paragraphOpen = false
        } else {
          paragraphOpen = true
        }
      }
      while (count < lines.length) {
        const line = lines[count] ?? ''
        if (CALLOUT_LINE_RE.test(line)) {
          if (count === 0) {
            // The header line reads as paragraph text (a directly following
            // unquoted line still lazily continues it, as before).
            paragraphOpen = true
          } else {
            applyInnerLine(stripBlockquotePrefix(line))
          }
          count += 1
          continue
        }
        if (
          count > 0 &&
          paragraphOpen &&
          line.trim() !== '' &&
          !CALLOUT_LAZY_BREAK_RE.test(line)
        ) {
          // Lazy continuation of the open paragraph — it stays open.
          count += 1
          continue
        }
        break
      }
      if (count === 0) return undefined
      const consumed = lines.slice(0, count)
      const inner = consumed.map(stripBlockquotePrefix)
      const header = CALLOUT_HEADER_RE.exec(inner[0] ?? '')
      if (!header) return undefined
      const [, calloutType = '', fold = '', title = ''] = header
      const body = inner.slice(1).join('\n')
      return {
        type: 'callout',
        raw: consumed.join('\n'),
        calloutType: calloutType.trim() || DEFAULT_CALLOUT_TYPE,
        fold: normalizeCalloutFold(fold),
        title: title.trim(),
        tokens: body.trim() ? helpers.blockTokens(body) : [],
      }
    },
  },

  parseMarkdown: (token, helpers) => {
    const parsed = token.tokens?.length ? helpers.parseChildren(token.tokens) : []
    const children = wrapLooseCalloutChildren(parsed, helpers)
    return helpers.createNode(
      'callout',
      {
        calloutType: token.calloutType ?? DEFAULT_CALLOUT_TYPE,
        title: token.title ?? '',
        fold: normalizeCalloutFold(token.fold),
      },
      children.length > 0 ? children : [helpers.createNode('paragraph', {}, [])],
    )
  },

  renderMarkdown: (node, helpers) => {
    const calloutType = String(node.attrs?.calloutType ?? DEFAULT_CALLOUT_TYPE)
    const fold = normalizeCalloutFold(node.attrs?.fold)
    const title = calloutTitleForMarkdown(node.attrs?.title)
    const header = `[!${calloutType}]${fold}${title ? ` ${title}` : ''}`
    const prefix = '>'
    const content = node.content ?? []
    const rendered = content.map((child, index) =>
      helpers.renderChild
        ? helpers.renderChild(child, index)
        : helpers.renderChildren([child]),
    )
    // A callout whose only content is an empty paragraph (e.g. a title-only
    // callout) has no body: emit just the header instead of a stray `>` line.
    if (!rendered.some((block) => block.trim() !== '')) {
      return `${prefix} ${header}`
    }
    const blocks = rendered.map((block) =>
      block
        .split('\n')
        .map((line) => (line.trim() === '' ? prefix : `${prefix} ${line}`))
        .join('\n'),
    )
    return `${prefix} ${header}\n${blocks.join(`\n${prefix}\n`)}`
  },
})

// Obsidian/extended-CommonMark `==highlight==`. The base parser has no `==`
// rule, so we register a custom inline tokenizer (mirroring the wikilink hook)
// that requires flanking non-space characters so stray `=` and `a == b` never
// fire, and round-trips nested marks like `**==x==**`.
const DohcHighlight = Mark.create({
  name: 'highlight',

  parseHTML() {
    return [{ tag: 'mark' }, { tag: 'span[data-dohc-highlight]' }]
  },

  renderHTML() {
    return ['mark', { class: 'dohc-highlight', 'data-dohc-highlight': '' }, 0]
  },

  addInputRules() {
    return [
      markInputRule({
        find: /(?:^|\s)(==(?!\s)((?:[^=]+))==)$/,
        type: this.type,
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name),
    }
  },

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start(src) {
      return firstUnescapedIndex(src, /(^|[^\\=])==(?!\s)(?!=)/)
    },
    tokenize(src, _tokens, helpers) {
      if (!src.startsWith('==')) return undefined
      if (src.length < 5) return undefined
      if (/\s/.test(src[2] ?? '')) return undefined
      const closing = findClosingHighlight(src)
      if (closing === -1) return undefined
      if (/\s/.test(src[closing - 1] ?? '')) return undefined
      const raw = src.slice(0, closing + 2)
      const inner = raw.slice(2, -2)
      if (!inner) return undefined
      const decoded = inner.replace(/\\=/g, HIGHLIGHT_EQUALS_PLACEHOLDER)
      return { type: 'highlight', raw, tokens: helpers.inlineTokens(decoded) }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.applyMark(
      'highlight',
      restoreHighlightPlaceholders(helpers.parseInline(token.tokens ?? [])),
    ),

  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node.content ?? [])}==`,
})

// Obsidian/Pandoc TeX math. Inline `$...$` and block `$$...$$` (single- or
// multi-line). Both are atom nodes carrying the raw TeX in a `tex` attr; the
// original `$`/`$$` delimiters are re-emitted verbatim so the round-trip is
// byte-identical. Rendering the TeX to KaTeX is a desktop-only concern
// (mathRender.ts) — these nodes stay pure so the projection package, which
// never paints a screen, has no KaTeX dependency.
//
// Inline flanking rules mirror Pandoc's `tex_math_dollars` so ordinary prose
// with dollar signs never turns into math:
//   - the opening `$` must be followed by a non-space, non-`$` character,
//   - the closing `$` must be preceded by a non-space character,
//   - the closing `$` must NOT be immediately followed by a digit.
// So `$5 and $6` and `a $ b` never fire, while `$x$` does. A backslash-escaped
// `\$` is left to the base `escape` token (an escapedPunctuation node), so it
// stays a literal dollar and never opens or closes math — findClosingInlineMath
// skips `\`-escaped characters for the same reason.
function findClosingInlineMath(src: string): number {
  for (let index = 1; index < src.length; index += 1) {
    if (src[index] === '\\') {
      index += 1
      continue
    }
    if (src[index] === '$') return index
  }
  return -1
}

const DohcMathInline = Node.create({
  name: 'mathInline',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-math-inline]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      { class: 'dohc-math dohc-math-inline', 'data-dohc-math-inline': '' },
      `$${String(node.attrs.tex ?? '')}$`,
    ]
  },

  markdownTokenizer: {
    name: 'mathInline',
    level: 'inline',
    start(src) {
      // Opening `$` must not be preceded by `\` (escaped) or another `$` (that
      // is block/display `$$`), and must be followed by a non-space, non-`$`.
      return firstUnescapedIndex(src, /(^|[^\\$])\$(?=[^\s$])/)
    },
    tokenize(src) {
      if (!src.startsWith('$')) return undefined
      const opening = src[1] ?? ''
      // Opening `$` must be followed by a non-space, non-`$` char (a leading
      // `$$` is block/display math, handled by the block tokenizer).
      if (opening === '' || opening === '$' || /\s/.test(opening)) return undefined
      const closing = findClosingInlineMath(src)
      if (closing === -1) return undefined
      // Closing `$` preceded by non-space, and not immediately followed by a
      // digit — so `$20 and $30` stays literal.
      if (/\s/.test(src[closing - 1] ?? '')) return undefined
      if (/\d/.test(src[closing + 1] ?? '')) return undefined
      const raw = src.slice(0, closing + 1)
      const tex = raw.slice(1, -1)
      if (!tex) return undefined
      return { type: 'mathInline', raw, tex }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathInline', { tex: token.tex }),

  renderMarkdown: (node) => `$${String(node.attrs?.tex ?? '')}$`,
})

const DohcMathBlock = Node.create({
  name: 'mathBlock',
  priority: 1000,
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-dohc-math-block]' }]
  },

  renderHTML({ node }) {
    return [
      'div',
      { class: 'dohc-math dohc-math-block', 'data-dohc-math-block': '' },
      `$$${String(node.attrs.tex ?? '')}$$`,
    ]
  },

  // Block-level tokenizer so a standalone `$$...$$` (single- or multi-line) is
  // its own block. The `tex` attr stores the EXACT text between the delimiters
  // — including any surrounding newlines — so `$$\nx\n$$` and `$$x$$` each
  // re-serialize byte-for-byte.
  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block',
    start(src) {
      const match = /(?:^|\n)(\$\$)/.exec(src)
      if (!match) return -1
      return match.index === 0 ? 0 : match.index + 1
    },
    tokenize(src) {
      if (!src.startsWith('$$')) return undefined
      const closing = src.indexOf('$$', 2)
      if (closing === -1) return undefined
      // The closing `$$` must end its line (or the document), so a mid-line
      // `$$x$$ trailing` is left as literal text instead of being sliced into
      // a stray block that would not round-trip.
      const afterClosing = src[closing + 2] ?? '\n'
      if (afterClosing !== '\n') return undefined
      const raw = src.slice(0, closing + 2)
      const tex = src.slice(2, closing)
      return { type: 'mathBlock', raw, tex }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathBlock', { tex: token.tex }),

  renderMarkdown: (node) => `$$${String(node.attrs?.tex ?? '')}$$`,
})

// Row height is editor layout metadata. It lives on the canonical Y.Doc so a
// resized table remains stable across collaborative edits and reloads; GFM
// export intentionally omits it because markdown tables have no row-height
// syntax. HTML import/export keeps the metadata through data-row-height.
export const DohcTableRowHeight = Extension.create({
  name: 'dohcTableRowHeight',

  addGlobalAttributes() {
    return [
      {
        types: ['tableRow'],
        attributes: {
          height: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute('data-row-height') ?? element.style.height
              const height = Number.parseFloat(raw)
              return Number.isFinite(height) && height > 0 ? Math.round(height) : null
            },
            renderHTML: (attributes) => {
              const height = Number(attributes.height)
              if (!Number.isFinite(height) || height <= 0) return {}
              const rounded = Math.round(height)
              return {
                'data-row-height': String(rounded),
                style: `height: ${rounded}px`,
              }
            },
          },
        },
      },
    ]
  },
})

// A bare TaskItem takes `paragraph+`, which makes an indented list under a
// checkbox schema-invalid — the Y.Doc conversion then drops the whole task
// list (#700). `nested: true` widens it to `paragraph block*`. Every dohc
// schema registers THIS extension so the editor and the conversions agree.
export const DohcTaskItem = TaskItem.configure({ nested: true })

export const dohcMarkdownExtensions = [
  DohcImage,
  DohcEscapedPunctuation,
  DohcWikilink,
  DohcInlineAtom,
  DohcCallout,
  DohcHighlight,
  DohcMathInline,
  DohcMathBlock,
  DohcTableRowHeight,
]
