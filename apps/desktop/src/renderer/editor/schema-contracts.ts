export const DOHC_V2_SCHEMA_VERSION = 1

export const DOHC_V2_YDOC_FIELDS = ['body', 'frontmatter', 'meta'] as const

export type DohcV2YDocField = (typeof DOHC_V2_YDOC_FIELDS)[number]

export type DohcV2ConstructName =
  | 'paragraph'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'listItem'
  | 'codeBlock'
  | 'blockquote'
  | 'horizontalRule'
  | 'table'
  | 'image'
  | 'escapedPunctuation'
  | 'wikilink'
  | 'inlineAtom'
  | 'callout'
  | 'highlight'
  | 'mathInline'
  | 'mathBlock'
  | 'htmlAtom'
  | 'frontmatter'

export type DohcV2CanonicalOwner =
  | 'tiptap-node'
  | 'tiptap-mark'
  | 'y-map'
  | 'raw-atom-body'

export type DohcV2MarkdownStrategy =
  | 'commonmark'
  | 'gfm'
  | 'custom-extension'
  | 'passthrough'
  | 'frontmatter-map'
  | 'raw-html-atom'

export type DohcV2ConstructKind =
  | 'block'
  | 'inline'
  | 'mark'
  | 'metadata'
  | 'special-document'

export interface DohcV2MarkdownContract {
  readonly parse: DohcV2MarkdownStrategy
  readonly render: DohcV2MarkdownStrategy
  readonly lossless: boolean
  readonly fixtureRequired: boolean
}

export interface DohcV2ConstructSpec {
  readonly name: DohcV2ConstructName
  readonly kind: DohcV2ConstructKind
  readonly canonical: DohcV2CanonicalOwner
  readonly yjsField: DohcV2YDocField
  readonly editableBodyNode: boolean
  readonly markdown: DohcV2MarkdownContract
  readonly requiresPaidTiptap: false
  readonly phase1Scope: 'required' | 'preserve-as-text' | 'separate-mode'
  readonly note: string
}

export interface DohcV2MarkdownParseContext<Token = unknown> {
  readonly token: Token
  readonly source: string
  readonly schemaVersion: typeof DOHC_V2_SCHEMA_VERSION
}

export interface DohcV2MarkdownRenderContext<Node = unknown> {
  readonly node: Node
  readonly schemaVersion: typeof DOHC_V2_SCHEMA_VERSION
}

export interface DohcV2MarkdownExtensionContract<Node = unknown, Token = unknown> {
  readonly construct: DohcV2ConstructName
  parseMarkdown(ctx: DohcV2MarkdownParseContext<Token>): Node | null
  renderMarkdown(ctx: DohcV2MarkdownRenderContext<Node>): string
}

export const FIRST_CLASS_V2_CONSTRUCTS = [
  'wikilink',
  'inlineAtom',
] as const satisfies readonly DohcV2ConstructName[]

export const DOHC_V2_CONSTRUCTS = [
  {
    name: 'paragraph',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Default prose block in the editable Y.XmlFragment.',
  },
  {
    name: 'heading',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'ATX headings define titles only when frontmatter title is absent.',
  },
  {
    name: 'bulletList',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Nested list support is required for existing notes.',
  },
  {
    name: 'orderedList',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Ordered list numbering may normalize, but semantic order must survive.',
  },
  {
    name: 'listItem',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'List item is explicit because nested constructs depend on it.',
  },
  {
    name: 'codeBlock',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Code content is inert for wikilinks, inline atoms, and captures.',
  },
  {
    name: 'blockquote',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Preserves quoted prose in existing markdown notes.',
  },
  {
    name: 'horizontalRule',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Simple separator with deterministic markdown output.',
  },
  {
    name: 'table',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'gfm',
      render: 'gfm',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'GFM table semantics must survive, including per-column alignment (the `align` cell attr round-trips losslessly to/from the `:---`/`:---:`/`---:` delimiter row); only cell padding whitespace normalizes.',
  },
  {
    name: 'image',
    kind: 'inline',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'CommonMark images must not degrade to alt text during rich markdown round-trips.',
  },
  {
    name: 'escapedPunctuation',
    kind: 'inline',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'commonmark',
      render: 'commonmark',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Backslash-escaped punctuation is represented explicitly so source meaning survives the editor model.',
  },
  {
    name: 'wikilink',
    kind: 'inline',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Rename-proof navigation surface backed by existing atomId semantics.',
  },
  {
    name: 'inlineAtom',
    kind: 'inline',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'AI-native inline data reference; parser must preserve capture security semantics.',
  },
  {
    name: 'callout',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Obsidian callouts (with `-`/`+` fold syntax) round-trip as a block; unknown types are preserved verbatim.',
  },
  {
    name: 'highlight',
    kind: 'mark',
    canonical: 'tiptap-mark',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Obsidian `==highlight==` mark parsed by a custom inline tokenizer; no attributes.',
  },
  {
    name: 'mathInline',
    kind: 'inline',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Obsidian/Pandoc `$...$` TeX atom; flanking rules keep prose dollars literal. KaTeX render is desktop-only.',
  },
  {
    name: 'mathBlock',
    kind: 'block',
    canonical: 'tiptap-node',
    yjsField: 'body',
    editableBodyNode: true,
    markdown: {
      parse: 'custom-extension',
      render: 'custom-extension',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Obsidian `$$...$$` display-math block atom (single- or multi-line); stores the raw TeX for a byte-identical round-trip.',
  },
  {
    name: 'htmlAtom',
    kind: 'special-document',
    canonical: 'raw-atom-body',
    yjsField: 'meta',
    editableBodyNode: false,
    markdown: {
      parse: 'raw-html-atom',
      render: 'raw-html-atom',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'separate-mode',
    note: 'HTML atoms bypass markdown editing and remain a separate sanitized document mode.',
  },
  {
    name: 'frontmatter',
    kind: 'metadata',
    canonical: 'y-map',
    yjsField: 'frontmatter',
    editableBodyNode: false,
    markdown: {
      parse: 'frontmatter-map',
      render: 'frontmatter-map',
      lossless: true,
      fixtureRequired: true,
    },
    requiresPaidTiptap: false,
    phase1Scope: 'required',
    note: 'Identity, type, title, icon, and provenance are structured metadata, not body nodes.',
  },
] as const satisfies readonly DohcV2ConstructSpec[]

const REQUIRED_CONSTRUCTS: readonly DohcV2ConstructName[] = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'table',
  'image',
  'escapedPunctuation',
  'wikilink',
  'inlineAtom',
  'callout',
  'highlight',
  'mathInline',
  'mathBlock',
  'htmlAtom',
  'frontmatter',
]

export function assertDohcV2SchemaCompleteness(
  constructs: readonly DohcV2ConstructSpec[] = DOHC_V2_CONSTRUCTS,
): void {
  const names = new Set(constructs.map((construct) => construct.name))
  for (const required of REQUIRED_CONSTRUCTS) {
    if (!names.has(required)) {
      throw new Error(`Missing dohc v2 construct: ${required}`)
    }
  }

  for (const construct of constructs) {
    if (construct.requiresPaidTiptap) {
      throw new Error(`Paid Tiptap dependency is not allowed: ${construct.name}`)
    }
    if (
      construct.canonical !== 'raw-atom-body' &&
      !DOHC_V2_YDOC_FIELDS.includes(construct.yjsField)
    ) {
      throw new Error(`Invalid Y.Doc field for ${construct.name}`)
    }
    if (construct.markdown.fixtureRequired && !construct.markdown.lossless) {
      throw new Error(`Required fixture cannot be lossy: ${construct.name}`)
    }
  }
}
