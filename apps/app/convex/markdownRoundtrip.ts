// M1 step 3 sub-commit 1 (multiplayer-and-h-followups §8) — the
// markdown ↔ ProseMirror JSON helpers used by the collab projection
// (server-side serializer) and the bootstrap (client-side parser).
//
// This module is the DECIDER for the architecture's Step 1a: prove
// that remark-parse + remark-stringify can be imported + exercised
// in Convex's V8 sandbox. Bundling-level proof requires a Convex
// dev deploy + invoking the internalQuery in `_runRemarkRoundtrip`
// below; Vitest + convex-test cover the import-path + roundtrip
// correctness in Node, which catches API regressions.
//
// The helpers are PURE (no IO, no Convex ctx) so they're usable
// from anywhere — client React code, server internalMutations, and
// Vitest tests share the same implementation.

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'

// M1 step 3.9.16 — WIKILINK ROUND-TRIP via sentinel pre/post-
// processing. Closes plan §3 M1 hard-blocker (round-trip
// idempotency across the corpus).
//
// Why pre/post-process instead of a remark plugin:
// remark-parse interprets `[[` as nested link syntax — by
// the time a parse-phase plugin runs, the markdown has
// already been tokenized into linkReference + text nodes,
// not a clean text node containing `[[target]]`. A from-
// markdown extension would solve this properly but adds
// significant complexity. Pre/post-process is ~15 lines
// and totally robust.
//
// Sentinel: U+0007 (bell). Picked because:
//   · Never appears in user markdown (control character)
//   · remark-parse passes it through as plain text
//   · remark-stringify doesn't escape it
// The token shape `W:target` is bracketed by
// bells; the target carries no bells (we strip them
// defensively below).
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g
const WIKI_OPEN = 'W:'
const WIKI_CLOSE = ''
const WIKI_SENTINEL_RE = /W:([^\n]+)/g

function encodeWikilinks(md: string): string {
  return md.replace(WIKI_RE, (_m, target) => {
    // Strip any bells in the target (paranoid; users can't type
    // them but a roundtrip-of-a-roundtrip shouldn't double-encode)
    const clean = String(target).replace(//g, '')
    return `${WIKI_OPEN}${clean}${WIKI_CLOSE}`
  })
}

function decodeWikilinks(md: string): string {
  return md.replace(WIKI_SENTINEL_RE, (_m, target) => `[[${target}]]`)
}

// Single shared processor instance. unified() is internally cached
// once compiled with .freeze(), so reuse is safe + cheaper than
// constructing per-call.
//
// remark-gfm extension is mandatory for Crepe content: tables,
// strikethrough (~delete~), task lists. Without it,
// mdast-util-to-markdown throws "Cannot handle unknown node
// `delete`/`table`" on serialize.
const _markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    // Match Milkdown/Crepe's serializer output as closely as possible.
    // These options align with mdast-util-to-markdown defaults that
    // Crepe expects on roundtrip.
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fence: '`',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
    tightDefinitions: true,
  })
  .freeze()

/** Parse a markdown string into an mdast tree. PURE. */
export function parseMarkdownToMdast(md: string): Root {
  // 3.9.16 — encode wikilinks BEFORE parse so remark doesn't
  // interpret `[[` as nested link syntax. decodeWikilinks
  // swaps them back at stringify time.
  return _markdownProcessor.parse(encodeWikilinks(md)) as Root
}

/** Serialize an mdast tree back to markdown. PURE. */
export function serializeMdastToMarkdown(tree: Root): string {
  return decodeWikilinks(_markdownProcessor.stringify(tree))
}

/** Convenience: round-trip a markdown string through parse +
 *  serialize. Used by the DECIDER test to assert byte-stability on
 *  the fixture set; also used at runtime if a caller wants to
 *  canonicalize markdown (e.g. before computing baseBodyHash, so a
 *  whitespace-different input doesn't trip the CAS unnecessarily). */
export function roundtripMarkdown(md: string): string {
  return serializeMdastToMarkdown(parseMarkdownToMdast(md))
}
