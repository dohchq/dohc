import { Node } from '@tiptap/core'

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
  const src = escapeMarkdownLineBreaks(
    sanitizeImageSrc(String(attrs.src ?? ''))
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

export const dohcMarkdownExtensions = [
  DohcImage,
  DohcEscapedPunctuation,
  DohcWikilink,
  DohcInlineAtom,
  DohcFormula,
  DohcQueryBlock,
]
