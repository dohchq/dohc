# v2 Schema Specification

**Date:** 2026-05-25
**Status:** Phase 1.1 schema contract
**Schema version:** `1`
**Decision:** Tiptap OSS-only remains the default. Lexical remains the escape hatch if this schema cannot be implemented without paid/pro/private Tiptap packages or hidden non-markdown state.

## Source Links

- Tiptap Markdown basic usage: <https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage>
- Tiptap custom Markdown extension guide: <https://tiptap.dev/docs/editor/markdown/guides>
- Tiptap Markdown API types: <https://tiptap.dev/docs/editor/markdown/api/types>
- Tiptap Collaboration extension: <https://tiptap.dev/docs/editor/extensions/functionality/collaboration>
- Yjs Tiptap binding overview: <https://docs.yjs.dev/ecosystem/editor-bindings/tiptap2>
- Y.XmlFragment API: <https://beta.yjs.dev/docs/api/shared-types/y.xmlfragment>

## Canonical Y.Doc Shape

Every editable markdown atom has one canonical Y.Doc keyed by existing rename-proof `fileId`.

| Field | Yjs type | Owner | Purpose |
|---|---|---|---|
| `body` | `Y.XmlFragment` | Tiptap collaboration extension | Editable document body. This is the only field Tiptap mutates directly. |
| `frontmatter` | `Y.Map` | dohc metadata adapter | Structured metadata formerly embedded in YAML frontmatter: `id`, `type`, `title`, `icon`, provenance, and future schema flags. |
| `meta` | `Y.Map` | dohc system code | System metadata: `schemaVersion`, `lastEditedByUserId`, `lastEditedAt`, projection hashes, and migration markers. |

Tiptap's Collaboration extension can bind to a raw Yjs fragment. v2 uses that shape explicitly: the editor binds to `doc.getXmlFragment('body')`, while dohc owns `frontmatter` and `meta`.

## Document Identity

- Room/document name: existing `fileId` from `atomIds`.
- Path remains mutable metadata outside the Y.Doc.
- Wikilinks render human-readable paths/titles but resolve through existing rename-proof ID machinery.
- First open of an unmigrated atom imports current `atoms.body` into this Y.Doc shape.

## Construct Table

| Construct | Canonical owner | Yjs field | Editable body node | Markdown strategy | Phase 1 scope |
|---|---|---:|---:|---|---|
| `paragraph` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `heading` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `bulletList` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `orderedList` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `listItem` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `codeBlock` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `blockquote` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `horizontalRule` | Tiptap node | `body` | yes | CommonMark parse/render | required |
| `table` | Tiptap node | `body` | yes | GFM parse/render | required |
| `wikilink` | Tiptap node | `body` | yes | custom extension | required |
| `inlineAtom` | Tiptap node | `body` | yes | custom extension | required |
| `formula` | Tiptap node | `body` | yes | custom extension | required |
| `queryBlock` | Tiptap node | `body` | yes | custom extension | required |
| `callout` | Tiptap node | `body` | yes | custom extension | required |
| `highlight` | Tiptap mark | `body` | yes | custom extension | required |
| `math` | Tiptap node/text syntax | `body` | yes | passthrough | preserve as text in Phase 1 |
| `htmlAtom` | raw atom body mode | `meta` | no | raw HTML atom mode | separate mode |
| `frontmatter` | `Y.Map` | `frontmatter` | no | frontmatter map projection | required |

### Obsidian callouts and highlights

`callout` follows the Obsidian dialect so files stay portable: a blockquote
whose first line is `[!type]`, optionally followed by a fold flag (`-` folded,
`+` explicitly open) and a title — e.g. `> [!note]- My title`. Core types
(`note`, `tip`, `info`, `warning`, `danger`, `quote`) get themed styling;
**unknown types are preserved verbatim** (styled like a note but keeping the
original type string) so nothing is dropped. Plain blockquotes with no `[!type]`
first line stay ordinary blockquotes (the tokenizer is block-level and only
claims the block when the header line matches). Titles containing `]` survive
because the type is captured up to the first `]`. The node stores
`{ calloutType, title, fold }` and renders exactly the Obsidian form.

`highlight` is the Obsidian/extended-CommonMark `==text==` mark, parsed by a
custom inline tokenizer (the base parser has no `==` rule). Flanking non-space
characters are required so stray `=` and `a == b` never fire, and nested marks
like `**==x==**` round-trip.

## First-Class AI-Native Constructs

These constructs must be first-class, not opaque text:

- `wikilink`
- `inlineAtom`
- `formula`
- `queryBlock`

Why: dohc's AI agent must edit intent, references, and semantic blocks without guessing punctuation offsets in raw markdown. Each one needs deterministic markdown parse/render behavior and a stable internal representation.

## Extension Contract Rules

Every custom construct must eventually implement the same conceptual contract:

```ts
interface DohcV2MarkdownExtensionContract<Node = unknown, Token = unknown> {
  readonly construct: DohcV2ConstructName
  parseMarkdown(ctx: DohcV2MarkdownParseContext<Token>): Node | null
  renderMarkdown(ctx: DohcV2MarkdownRenderContext<Node>): string
}
```

Rules:

1. `parseMarkdown` must not inspect editor DOM.
2. `renderMarkdown` must be deterministic for the same node input.
3. Code blocks are inert for `wikilink`, `inlineAtom`, `formula`, and capture parsing.
4. Custom syntax must be covered by `tests/fixtures/markdown-corpus/`.
5. If a construct cannot round-trip through markdown, it is not allowed in Phase 1 editable body.

## Frontmatter Rules

Frontmatter is structured metadata in `Y.Map`, not a Tiptap body node.

Projection back to markdown renders YAML frontmatter from `frontmatter` before the body. Import from legacy markdown parses frontmatter first, removes it from body markdown, and stores keys in the map.

Load-bearing keys:

- `id`
- `type`
- `title`
- `icon`
- `source-share`
- future migration flags

## HTML Atom Rules

HTML atoms remain a separate document mode in Phase 1.

Reasons:

- Current HTML atoms bypass Crepe entirely.
- Sanitization and formula substitution happen in server/iframe code.
- Forcing raw HTML into the normal markdown editor would weaken the security boundary and muddy the schema.

Phase 1 can still represent an HTML atom's metadata in `frontmatter`/`meta`, but its body stays raw HTML until a later explicit product decision.

## Projection Rules

`atoms.body` is a derived cache.

Allowed writers:

- Hocuspocus projection worker after Y.Doc changes.
- Import/rebuild/admin tooling.
- Initial migration from legacy markdown into Y.Doc.

Forbidden writers:

- Normal editor keystrokes.
- Agent edit tools that directly patch markdown.
- Suggestions accepted by patching raw `atoms.body`.

Projection output must include:

- `schemaVersion`
- `bodyProjectionHash`
- `projectionUpdatedAt`
- `ydocStateVector` or equivalent state identity

## Schema Versioning

`meta.schemaVersion` starts at `1`.

Rules:

1. Never silently drop unknown node types.
2. Any schema bump needs a migration document and a fixture before implementation.
3. Import/export tools must print schema version and projection hash.
4. Hocuspocus must refuse writes if it cannot load or migrate the schema safely.

## Stop/Go Gates

Phase 1.1 passes only if:

- `apps/app/src/editor-v2/schema-contracts.ts` compiles.
- `apps/app/src/editor-v2/schema-contracts.test.ts` passes.
- Every required construct appears in the spec and contract table.
- No construct requires paid/pro/private Tiptap features.
- Frontmatter is explicitly outside the editable body fragment.

Stop and switch to the Lexical escape-hatch discussion if:

- Tiptap OSS Markdown cannot represent a required construct with deterministic parse/render behavior.
- A required construct needs a paid Tiptap feature.
- A construct requires hidden rich state that markdown export cannot preserve.
- The schema would make AI edits less semantic than the current markdown baseline.
