import { Mark, Node, markInputRule } from '@tiptap/core'

function firstTokenMatch(src: string, pattern: RegExp): RegExpMatchArray | null {
  const match = src.match(pattern)
  return match?.index === 0 ? match : null
}

function firstUnescapedIndex(src: string, pattern: RegExp): number {
  const match = pattern.exec(src)
  if (!match || match.index < 0) return -1
  return match.index + (match[1]?.length ?? 0)
}

function textContent(node: { content?: Array<{ text?: string }> }): string {
  return node.content?.map((child) => child.text ?? '').join('') ?? ''
}

function queryFenceInfo(lang: unknown): { isQuery: boolean; info: string } {
  const normalized = String(lang ?? '').trim()
  const [language = '', ...infoParts] = normalized.split(/\s+/)
  return {
    isQuery:
      language.toLowerCase() === 'query' ||
      language.toLowerCase() === 'dohc-query',
    info: infoParts.join(' '),
  }
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

function splitWikilinkInner(inner: string): [string, string | null] {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '\\') {
      index += 1
      continue
    }
    if (inner[index] === '|') return [inner.slice(0, index), inner.slice(index + 1)]
  }
  return [inner, null]
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
  // the document's folder.
  if (forCheck.startsWith('/')) return ''
  // Reject parent traversal so a relative src can never climb out of the
  // document's folder (or the workspace root).
  if (/(^|\/)\.\.(\/|$)/.test(forCheck)) return ''
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
      return firstUnescapedIndex(src, /(^|[^\\])\[\[[^\]\n]+\]\]/)
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
    const target = node.attrs?.target ?? ''
    const label = node.attrs?.label
    return label ? `[[${target}|${label}]]` : `[[${target}]]`
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

const DohcFormula = Node.create({
  name: 'formula',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      expression: { default: '' },
      source: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-formula]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      { 'data-dohc-formula': node.attrs.expression },
      `{{${node.attrs.source || `formula:${node.attrs.expression ?? ''}`}}}`,
    ]
  },

  markdownTokenizer: {
    name: 'formula',
    level: 'inline',
    start: '{{formula:',
    tokenize(src) {
      const match = firstTokenMatch(src, /^\{\{formula:([^}]+)\}\}/)
      if (!match) return undefined
      const [raw, expression = ''] = match
      return {
        type: 'formula',
        raw,
        expression: expression.trim(),
        source: raw.slice(2, -2),
      }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('formula', {
      expression: token.expression,
      source: token.source,
    }),

  renderMarkdown: (node) =>
    `{{${node.attrs?.source || `formula:${node.attrs?.expression ?? ''}`}}}`,
})

const DohcQueryBlock = Node.create({
  name: 'queryBlock',
  priority: 1000,
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addAttributes() {
    return {
      info: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'pre[data-dohc-query-block]' }]
  },

  renderHTML() {
    return ['pre', { 'data-dohc-query-block': 'true' }, ['code', 0]]
  },

  markdownTokenName: 'code',

  parseMarkdown: (token, helpers) => {
    const fence = queryFenceInfo(token.lang)
    if (!fence.isQuery) return []
    return helpers.createNode(
      'queryBlock',
      { info: fence.info },
      token.text ? [helpers.createTextNode(token.text)] : [],
    )
  },

  renderMarkdown: (node, helpers) => {
    const info =
      typeof node.attrs?.info === 'string' && node.attrs.info.trim()
        ? ` ${node.attrs.info.trim()}`
        : ''
    return [
      `\`\`\`dohc-query${info}`,
      textContent(node) || helpers.renderChildren(node.content || []),
      '```',
    ].join('\n')
  },
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
      while (count < lines.length && CALLOUT_LINE_RE.test(lines[count] ?? '')) {
        count += 1
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
    const children = token.tokens?.length ? helpers.parseChildren(token.tokens) : []
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
    const blocks: string[] = []
    const content = node.content ?? []
    content.forEach((child, index) => {
      const rendered = helpers.renderChild
        ? helpers.renderChild(child, index)
        : helpers.renderChildren([child])
      const lines = rendered
        .split('\n')
        .map((line) => (line.trim() === '' ? prefix : `${prefix} ${line}`))
      blocks.push(lines.join('\n'))
    })
    const body = blocks.join(`\n${prefix}\n`)
    return body ? `${prefix} ${header}\n${body}` : `${prefix} ${header}`
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
      return { type: 'highlight', raw, tokens: helpers.inlineTokens(inner) }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.applyMark('highlight', helpers.parseInline(token.tokens ?? [])),

  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node.content ?? [])}==`,
})

export const dohcMarkdownExtensions = [
  DohcImage,
  DohcEscapedPunctuation,
  DohcWikilink,
  DohcInlineAtom,
  DohcFormula,
  DohcQueryBlock,
  DohcCallout,
  DohcHighlight,
]
