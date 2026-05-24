// M1 step 3 sub-commit 3.6.2 (multiplayer-and-h-followups §8 +
// codex 4th-pass concern #1) — the end-to-end PM snapshot →
// markdown body serializer the collab projection writer calls.
//
// Combines three primitives:
//   1. splitFrontmatter (existing in atomId.ts) — peel off the
//      atom's frontmatter from existing.body so we preserve it
//   2. pmDocToMdast (sub-commit 3.6.1) — walk the PM snapshot
//      into an mdast tree
//   3. serializeMdastToMarkdown (sub-commit 3.1) — emit markdown
//      via remark-stringify (+ remark-gfm for tables/strikes)
//
// FRONTMATTER PRESERVATION (codex 4th-pass concern #1):
// Crepe only sees the post-frontmatter `rest` (verified in
// AtomView.tsx — defaultValue is splitFrontmatter(body).rest).
// So Crepe's PM doc represents ONLY rest. The server projection
// must split fm + rest from existing.body, replace rest with
// the serialized PM markdown, then join fm + new-rest. Without
// this, the user's `title`, `icon`, `type`, custom frontmatter
// keys would be silently lost on every projection.
//
// seedAtomIdIntoBody (in atomWriter.ts via upsertAtomImpl
// mirror) only protects the `id:` key — it adds id if missing
// but doesn't preserve other keys. That's why we have to do
// the fm split EXPLICITLY here.

import {
  pmDocToMdast,
  UnknownPmNodeError,
  type PmNode,
} from './pmToMdast'
import { serializeMdastToMarkdown } from './markdownRoundtrip'
import { splitFrontmatter, joinFrontmatter } from './atomId'

export type ProjectionSerializeResult =
  | {
      ok: true
      /** The full markdown body to write (fm + serialized rest). */
      newBody: string
      /** Just the serialized rest (frontmatter-free) — useful for
       *  debug + computing hash of body parts independently. */
      newRest: string
    }
  | {
      ok: false
      reason: 'unknown-pm-node' | 'invalid-pm-json' | 'serialize-failed'
      detail: string
    }

/** Serialize a PM snapshot JSON string into a markdown body that
 *  preserves the existing atom's frontmatter. Pure — no IO. The
 *  projection writer calls this; on ok:false the writer freezes
 *  the collab session via collabDocs.frozen=true (codex 4th-pass
 *  concern #2: fail loud, don't emit lossy markdown). */
export function serializeSnapshotToProjectedBody(
  snapshotContent: string,
  existingBody: string,
): ProjectionSerializeResult {
  // Parse the PM JSON. snapshotContent is what prosemirror-sync's
  // onSnapshot hands us — a JSON-stringified PM doc node.
  let pmDoc: PmNode
  try {
    const parsed = JSON.parse(snapshotContent)
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        reason: 'invalid-pm-json',
        detail: 'snapshot content is not a JSON object',
      }
    }
    pmDoc = parsed as PmNode
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid-pm-json',
      detail: e instanceof Error ? e.message : String(e),
    }
  }

  // Walk PM → mdast. UnknownPmNodeError surfaces as ok:false; the
  // projection writer translates that into a collab freeze.
  let mdast
  try {
    mdast = pmDocToMdast(pmDoc)
  } catch (e) {
    if (e instanceof UnknownPmNodeError) {
      return {
        ok: false,
        reason: 'unknown-pm-node',
        detail: e.message,
      }
    }
    throw e
  }

  // mdast → markdown via remark-stringify. Throws are highly
  // unlikely after a clean walk, but catch defensively — a
  // remark internal bug shouldn't crash the whole projection
  // cycle.
  let newRest: string
  try {
    newRest = serializeMdastToMarkdown(mdast)
  } catch (e) {
    return {
      ok: false,
      reason: 'serialize-failed',
      detail: e instanceof Error ? e.message : String(e),
    }
  }

  // Frontmatter preservation. splitFrontmatter is ReDoS-safe
  // (audited in atomId.ts:78). The fm string carries its OWN
  // trailing whitespace (`\n---\n` or similar), so we just
  // concat directly.
  const { fm } = splitFrontmatter(existingBody)
  const newBody = joinFrontmatter(fm, newRest)

  return { ok: true, newBody, newRest }
}
