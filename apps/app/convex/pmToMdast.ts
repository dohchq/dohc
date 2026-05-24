// M1 step 3 sub-commit 3.6.1 (multiplayer-and-h-followups §8 +
// codex 4th-pass consult) — PM JSON → mdast walker. The
// structural traversal the server-side projection writer owns;
// remark-stringify (from sub-commit 3.1) owns markdown escaping
// + emission.
//
// Crepe's PM schema is commonmark + GFM (verified via grep on
// node_modules/@milkdown/preset-commonmark and gfm). We map each
// PM node type to its mdast equivalent. Unknown nodes throw
// UnknownPmNodeError — codex 4th-pass concern #2: fail loud +
// freeze projection rather than emit lossy markdown.
//
// dohc-specific content (inline atoms {key: value}, formulas
// {= ... }, wikilinks [[path]], query/ascii/html code fences)
// are TEXT-LEVEL in the markdown source — they ride through as
// plain text inside paragraph nodes, just like the editor sees
// them. The decoration plugins re-apply on the markdown side
// when the projection lands.

import type {
  Root as MdRoot,
  RootContent,
  BlockContent,
  PhrasingContent,
  ListItem,
  Table,
  TableRow,
  TableCell,
} from 'mdast'

export class UnknownPmNodeError extends Error {
  constructor(public nodeType: string) {
    super(`Unknown PM node type: ${nodeType}. Refusing to emit lossy markdown.`)
    this.name = 'UnknownPmNodeError'
  }
}

// PM JSON node shape (minimal; we only read what we need).
export type PmNode = {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: PmNode[]
}

/** Walk a PM doc JSON and produce an mdast Root. Throws
 *  UnknownPmNodeError on any node type we don't recognize —
 *  caller (the projection writer) catches this and freezes the
 *  collab session via collabDocs.frozen=true. */
export function pmDocToMdast(pmDoc: PmNode): MdRoot {
  if (pmDoc.type !== 'doc') {
    throw new UnknownPmNodeError(pmDoc.type)
  }
  const children = (pmDoc.content ?? []).map((c) => convertBlock(c))
  return { type: 'root', children: children as RootContent[] }
}

function convertBlock(node: PmNode): BlockContent | RootContent {
  switch (node.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        children: convertInlineChildren(node.content ?? []),
      }
    case 'heading': {
      const level = (node.attrs?.level as 1 | 2 | 3 | 4 | 5 | 6) ?? 1
      return {
        type: 'heading',
        depth: level,
        children: convertInlineChildren(node.content ?? []),
      }
    }
    case 'code_block': {
      const lang = (node.attrs?.language as string | null) ?? null
      const text = collectText(node)
      return {
        type: 'code',
        lang: lang || null,
        meta: null,
        value: text,
      }
    }
    case 'blockquote':
      return {
        type: 'blockquote',
        children: (node.content ?? []).map(
          (c) => convertBlock(c) as BlockContent,
        ),
      }
    case 'bullet_list':
      return {
        type: 'list',
        ordered: false,
        spread: false,
        children: (node.content ?? []).map((c) => convertListItem(c)),
      }
    case 'ordered_list':
      return {
        type: 'list',
        ordered: true,
        start: (node.attrs?.order as number | undefined) ?? 1,
        spread: false,
        children: (node.content ?? []).map((c) => convertListItem(c)),
      }
    case 'hr':
    case 'horizontal_rule':
    case 'thematic_break':
      return { type: 'thematicBreak' }
    case 'image': {
      const src = (node.attrs?.src as string | undefined) ?? ''
      const alt = (node.attrs?.alt as string | undefined) ?? null
      const title = (node.attrs?.title as string | undefined) ?? null
      return { type: 'image', url: src, alt, title }
    }
    case 'image-block': {
      // Codex 6th-pass BLOCKER #3: Milkdown @milkdown/components
      // ImageBlock — Crepe Default feature (enabled by default).
      // Was missing → normal Crepe content with a block image
      // would freeze projection on every flush.
      // attrs: { src, caption, ratio }
      const src = (node.attrs?.src as string | undefined) ?? ''
      const alt = (node.attrs?.caption as string | undefined) ?? null
      return { type: 'image', url: src, alt, title: null }
    }
    case 'math_block': {
      // M1 step 3.8.1.6 — codex 7th-pass [P1] #3 FAIL-LOUD.
      //
      // The 3.9.5 fix #3 added support that emitted math_block
      // as fenced `math` code blocks. That looked like it
      // round-tripped, but: parsing the fenced math block back
      // through remark (no remark-math plugin) produces a plain
      // `code` mdast node with lang='math', NOT a math_block PM
      // node. The bootstrap PM↔body binding check (3.9.5 fix #1)
      // then rejects the doc as pm-body-mismatch because the
      // server's canonical-roundtripped body doesn't match the
      // client's PM JSON.
      //
      // Net: math atoms could never bootstrap into multiplayer
      // anyway. The "support" was lossy AND functionally broken.
      // Fail loud instead: pmToMdast throws → projection
      // serialize-failed → atom freezes; bootstrap returns
      // pm-body-mismatch → client shows BootstrapErrorOverlay.
      // Honest signal that math content needs proper remark-math
      // wiring before multiplayer can handle it.
      throw new UnknownPmNodeError(node.type)
    }
    case 'table':
      return convertTable(node)
    case 'html':
      return {
        type: 'html',
        value: (node.text as string | undefined) ?? collectText(node),
      }
    default:
      throw new UnknownPmNodeError(node.type)
  }
}

function convertListItem(node: PmNode): ListItem {
  // Milkdown commonmark uses 'list_item' for both regular AND
  // task-list items. The GFM task-list-item preset PATCHES the
  // same schema with `attrs.checked` (codex 5th-pass concern #3:
  // I was previously dropping it). Surface as mdast listItem.checked
  // so remark-gfm emits `- [ ]` / `- [x]` on serialize.
  if (node.type !== 'list_item') {
    throw new UnknownPmNodeError(node.type)
  }
  const checkedAttr = node.attrs?.checked
  // Milkdown stores `checked` as boolean OR null (untouched). Only
  // emit listItem.checked when it's been explicitly set, so a
  // plain bullet list doesn't become a task list on roundtrip.
  const checked =
    typeof checkedAttr === 'boolean'
      ? checkedAttr
      : checkedAttr === 'true'
        ? true
        : checkedAttr === 'false'
          ? false
          : null
  return {
    type: 'listItem',
    spread: false,
    checked,
    children: (node.content ?? []).map(
      (c) => convertBlock(c) as BlockContent,
    ),
  }
}

function convertTable(node: PmNode): Table {
  // mdast Table: { type: 'table', align?, children: TableRow[] }
  const rows = (node.content ?? []).map((r) => convertTableRow(r))
  return {
    type: 'table',
    align: [], // PM doesn't carry per-column alignment by default
    children: rows,
  }
}

function convertTableRow(node: PmNode): TableRow {
  // Codex 6th-pass BLOCKER #3: Milkdown @milkdown/components
  // TableBlock distinguishes 'table_row' (data rows) from
  // 'table_header_row' (the header). Was previously only
  // accepting 'table_row' → real tables with a header would
  // freeze the projection. Accept both; mdast's tableRow doesn't
  // need to distinguish (mdast Table marks the FIRST row as
  // header via convention).
  if (node.type !== 'table_row' && node.type !== 'table_header_row') {
    throw new UnknownPmNodeError(node.type)
  }
  const cells = (node.content ?? []).map((c) => convertTableCell(c))
  return { type: 'tableRow', children: cells }
}

function convertTableCell(node: PmNode): TableCell {
  if (node.type !== 'table_cell' && node.type !== 'table_header') {
    throw new UnknownPmNodeError(node.type)
  }
  // Cells contain block-level content; mdast's TableCell expects
  // PhrasingContent. Flatten via collectInline.
  return {
    type: 'tableCell',
    children: convertInlineChildren(node.content ?? []),
  }
}

/** Convert a list of inline-level PM nodes to mdast phrasing content. */
function convertInlineChildren(nodes: PmNode[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  for (const node of nodes) {
    out.push(...convertInline(node))
  }
  return out
}

function convertInline(node: PmNode): PhrasingContent[] {
  switch (node.type) {
    case 'text':
      return [wrapMarks(node.text ?? '', node.marks ?? [])]
    case 'hardbreak':
    case 'hard_break':
      // Milkdown uses 'hardbreak' (single word); commonmark/
      // typescript-mdast often uses 'hard_break'. Accept both.
      // Codex 5th-pass concern #3: I had only the underscored
      // form, missing real Milkdown output.
      return [{ type: 'break' }]
    case 'image': {
      const src = (node.attrs?.src as string | undefined) ?? ''
      const alt = (node.attrs?.alt as string | undefined) ?? null
      const title = (node.attrs?.title as string | undefined) ?? null
      return [{ type: 'image', url: src, alt, title }]
    }
    case 'math_inline':
      // M1 step 3.8.1.6 — codex 7th-pass [P1] #3 FAIL-LOUD.
      // See math_block above for the full rationale. The 3.9.5
      // partial fix here (emit as inline code with $…$) changed
      // math SEMANTICS into code FORMATTING; round-tripping
      // produced inline-code, not math_inline. Bootstrap PM↔body
      // binding then rejected the doc. Fail loud is the honest
      // signal until lossless remark-math support is wired.
      throw new UnknownPmNodeError(node.type)
    default:
      // Crepe sometimes wraps inline content (e.g. when the editor
      // structurally nests a paragraph inside a table cell). Recurse
      // through .content if present; throw if we hit a true unknown.
      if (node.content && node.content.length > 0) {
        return convertInlineChildren(node.content)
      }
      throw new UnknownPmNodeError(node.type)
  }
}

/** Build a mdast text/emphasis/strong/code/link/delete chain from
 *  raw text + PM mark stack. Marks compose; we wrap from innermost
 *  to outermost. */
function wrapMarks(
  text: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }>,
): PhrasingContent {
  let node: PhrasingContent = { type: 'text', value: text }
  for (const mark of marks) {
    switch (mark.type) {
      case 'em':
      case 'italic':
        node = { type: 'emphasis', children: [node] } as PhrasingContent
        break
      case 'strong':
      case 'bold':
        node = { type: 'strong', children: [node] } as PhrasingContent
        break
      case 'code':
        // Inline code can't wrap other marks structurally — drop to
        // plain text content. (mdast InlineCode takes a string value
        // directly, no children.)
        node = { type: 'inlineCode', value: textValueOf(node) }
        break
      case 'link': {
        const href = (mark.attrs?.href as string | undefined) ?? ''
        const title = (mark.attrs?.title as string | undefined) ?? null
        node = {
          type: 'link',
          url: href,
          title,
          children: [node],
        } as PhrasingContent
        break
      }
      case 'strike_through':
      case 'strikethrough':
      case 'delete':
        // Milkdown GFM names it 'strike_through' (underscore between
        // strike + through). Codex 5th-pass concern #3: I had only
        // 'strikethrough' + 'delete' — Crepe content with strike
        // would have frozen projection on every flush.
        node = { type: 'delete', children: [node] } as PhrasingContent
        break
      default:
        // Unknown mark — fail loud. Better than silently dropping
        // user formatting.
        throw new UnknownPmNodeError(`mark:${mark.type}`)
    }
  }
  return node
}

/** Extract the text value from a phrasing-content node (used when
 *  collapsing into inlineCode, which can't hold children). */
function textValueOf(node: PhrasingContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'inlineCode') return node.value
  if ('children' in node && Array.isArray((node as { children?: unknown[] }).children)) {
    return ((node as { children: PhrasingContent[] }).children ?? [])
      .map(textValueOf)
      .join('')
  }
  return ''
}

/** Collect raw text content from a PM subtree (used for code blocks
 *  + html nodes where we want the literal string contents). */
function collectText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (!node.content) return ''
  return node.content.map(collectText).join('')
}
