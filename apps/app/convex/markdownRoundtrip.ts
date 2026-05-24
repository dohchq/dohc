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
import type { Root } from 'mdast'

// Single shared processor instance. unified() is internally cached
// once compiled with .freeze(), so reuse is safe + cheaper than
// constructing per-call.
const _markdownProcessor = unified()
  .use(remarkParse)
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
  // unified().parse returns Node; we cast to Root since remark-parse
  // always produces a Root at the top.
  return _markdownProcessor.parse(md) as Root
}

/** Serialize an mdast tree back to markdown. PURE. */
export function serializeMdastToMarkdown(tree: Root): string {
  return _markdownProcessor.stringify(tree)
}

/** Convenience: round-trip a markdown string through parse +
 *  serialize. Used by the DECIDER test to assert byte-stability on
 *  the fixture set; also used at runtime if a caller wants to
 *  canonicalize markdown (e.g. before computing baseBodyHash, so a
 *  whitespace-different input doesn't trip the CAS unnecessarily). */
export function roundtripMarkdown(md: string): string {
  return serializeMdastToMarkdown(parseMarkdownToMdast(md))
}
