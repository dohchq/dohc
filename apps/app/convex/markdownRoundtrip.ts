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
import remarkMath from 'remark-math'
import type { Root } from 'mdast'

// M1 step 3.9.16 — WIKILINK ROUND-TRIP via sentinel pre/post-
// processing. Closes plan §3 M1 hard-blocker (round-trip
// idempotency across the corpus).
//
// 3.9.20 — codex 22nd-pass [P2] hardening: handle raw BEL chars
// in user content. Without the BEL_SAFE layer below, a user
// who typed BEL+"W:foo"+BEL into their markdown would silently
// have it rewritten to [[foo]] on round-trip. Pathological but
// observable.
//
// Two-layer escape:
//   USER_BEL_SAFE = BEL+"BEL"+BEL — escapes raw BEL in user
//     content BEFORE the wikilink encode below.
//   WIKI sentinel = BEL+"W:target"+BEL — encodes [[target]].
// Decode runs in inverse order: wikilinks first (so any BEL
// inside the sentinel is OUR sentinel, not user content),
// then BEL_SAFE back to raw BEL.
//
// BEL (U+0007) is the sentinel character: never appears in
// normal markdown, remark-parse passes it through as plain
// text, remark-stringify doesn't escape it.
const BEL = String.fromCharCode(7)
const BS = String.fromCharCode(8)
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g
const WIKI_OPEN = `${BEL}W:`
const WIKI_CLOSE = BEL
const WIKI_SENTINEL_RE = new RegExp(`${BEL}W:([^\\n]+?)${BEL}`, 'g')
// 3.9.20 — escape uses BS (U+0008) as delimiter so it can't
// collide with the BEL-delimited wikilink sentinel. User
// content containing raw BS is vanishingly rare (control
// character; not produced by any keyboard or editor).
const USER_BEL_SAFE = `${BS}BEL${BS}`
const USER_BEL_SAFE_RE = new RegExp(`${BS}BEL${BS}`, 'g')
const RAW_BEL_RE = new RegExp(BEL, 'g')

function encodeWikilinks(md: string): string {
  // 3.9.20 — escape raw BEL in user content first so it can't
  // collide with our wikilink sentinel below. The regex matches
  // BARE BEL chars; the BEL_SAFE replacement uses 3 BEL chars
  // bracketed by "BEL", which doesn't itself trigger another
  // BEL_SAFE substitution because the inner BEL is part of the
  // escape sequence.
  const safe = md.replace(RAW_BEL_RE, USER_BEL_SAFE)
  return safe.replace(
    WIKI_RE,
    (_m, target) => `${WIKI_OPEN}${target}${WIKI_CLOSE}`,
  )
}

// 3.9.23 — also recognize remark's bracket-escape form so the
// PM→mdast serialization path produces the same canonical
// output as the markdown→remark→stringify path.
//
// Why: pmDocToMdast (collab projection serializer) walks PM
// JSON and emits text nodes containing literal `[[foo]]`
// (Crepe doesn't have a custom wikilink node type). remark-
// stringify escapes `[` as `\[` because brackets are link
// syntax → output is `\[\[foo]]`. The BEL-sentinel encode
// only runs on the markdown→remark side, so the PM→remark
// side never inserts sentinels. Without this extra pattern,
// the two canonical forms diverge and bootstrap pm-body-
// mismatch fires on every atom with a wikilink — including
// atoms that have NO real divergence.
const WIKI_ESCAPED_BRACKETS_RE = /\\\[\\\[([^\[\]\n]+)]]/g

function decodeWikilinks(md: string): string {
  // Restore wikilinks BEFORE BEL_SAFE so the sentinel BEL chars
  // are consumed by the wikilink replace, not the BEL_SAFE
  // replace.
  const fromSentinels = md.replace(
    WIKI_SENTINEL_RE,
    (_m, target) => `[[${target}]]`,
  )
  // 3.9.23 — fold remark's escape form back to bare brackets.
  // Idempotent: if input has bare `[[foo]]`, regex doesn't match.
  const fromEscape = fromSentinels.replace(
    WIKI_ESCAPED_BRACKETS_RE,
    (_m, target) => `[[${target}]]`,
  )
  return fromEscape.replace(USER_BEL_SAFE_RE, BEL)
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
  // M1 step 3.9.17 — remark-math: parses $...$ (inline) and
  // $$...$$ (block) into mdast inlineMath/math nodes. Used by
  // pmToMdast to round-trip Crepe Latex content losslessly.
  // 3.8.1.6 made math nodes fail-loud (throw → freeze the
  // multiplayer session); 3.9.17 restores proper support.
  .use(remarkMath)
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
