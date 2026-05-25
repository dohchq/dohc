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

export const DohcWikilink = Node.create({
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

export const DohcInlineAtom = Node.create({
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

export const DohcFormula = Node.create({
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

export const DohcQueryBlock = Node.create({
  name: 'queryBlock',
  priority: 1000,
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    return [{ tag: 'pre[data-dohc-query-block]' }]
  },

  renderHTML() {
    return ['pre', { 'data-dohc-query-block': 'true' }, ['code', 0]]
  },

  markdownTokenName: 'code',

  parseMarkdown: (token, helpers) => {
    if (token.lang !== 'dohc-query') return []
    return helpers.createNode(
      'queryBlock',
      {},
      token.text ? [helpers.createTextNode(token.text)] : [],
    )
  },

  renderMarkdown: (node, helpers) =>
    [
      '```dohc-query',
      textContent(node) || helpers.renderChildren(node.content || []),
      '```',
    ].join('\n'),
})

export const dohcMarkdownExtensions = [
  DohcWikilink,
  DohcInlineAtom,
  DohcFormula,
  DohcQueryBlock,
]
