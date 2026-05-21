import { extractFrontmatterId } from './atomId'

// skills-commands-v1 §2-B / P4 — share = COPY (never a live link).
// The recipient gets BYTES; their vault writes a fresh atom under
// their own canonical id (Track-1 seeds a new fileId on first
// write). Provenance survives via an ADVISORY `source-share:
// <handle>/<sender-id>` line in the share text — purely
// informational; not a live reference; no cross-workspace
// resolution.
//
// P3+P4 fold (Codex F1, F4, F5):
//   F1: the id-line stripper now uses the SAME grammar as the
//       canonical `extractFrontmatterId` (atomId.ts:248) — bare /
//       single-quoted / double-quoted; any non-newline characters
//       including dots. Was incorrectly restricted to
//       [A-Za-z0-9_-] which missed valid ids like
//       `weekly-review.q3` (the design's own example).
//   F4: re-share idempotence — buildShareText now STRIPS any
//       prior `source-share:` lines before injecting a fresh one.
//       Re-sharing replaces provenance, never chains it; the
//       prior senders' identities are not carried through a
//       second re-share (a v2 design item: provenance chains
//       require a richer data model than a single line).
//   F5: the handle's `/` delimiter is the parse anchor in
//       `extractShareProvenance`. To prevent ambiguity from a
//       slash-bearing handle (defensive — WorkOS subjects today
//       are `user_<ULID>` with no slashes, but the contract is
//       implicit), we replace any `/` in the handle with `_`.

// Same grammar as extractFrontmatterId — bare / quoted / dotted.
// Anchored to a single line; whitespace tolerated at end-of-line.
const ID_LINE_RE =
  /^id:[ \t]*(?:"[^"\n\r]*"|'[^'\n\r]*'|[^\n\r]*?)[ \t]*$/
const SOURCE_SHARE_LINE_RE =
  /^source-share:[ \t]*(?:"[^"\n\r]*"|'[^'\n\r]*'|[^\n\r]*?)[ \t]*$/

/** Build the canonical "share text" for a skill atom.
 *
 * Inputs:
 *   - body:    the FULL atom body the sender sees in the editor
 *              (frontmatter + content).
 *   - handle:  the sender's stable identifier (workspaceId in v1
 *              — opaque WorkOS subject, no personal info leaked).
 *
 * Behavior:
 *   1. Extract the sender's current `id:` from frontmatter (if
 *      present); if absent, no source-share line is emitted (the
 *      atom was never bound to an id).
 *   2. STRIP the `id:` line from the frontmatter (recipient's
 *      Track-1 seeds a fresh id on first write — `decideAtomIdAction`
 *      under the no-frontmatter-id branch).
 *   3. INJECT `source-share: <handle>/<senderId>` into the
 *      frontmatter as the first NON-type line so the recipient's
 *      preview / UI can render provenance without parsing the body.
 *   4. Return the rebuilt body.
 *
 * Pure function. No I/O, no clipboard side effects. The UI calls
 * this then writes the result to navigator.clipboard.
 */
export function buildShareText(body: string, handle: string): string {
  // Match a leading YAML frontmatter block (--- … ---). Tolerates
  // trailing whitespace on the fence lines and either LF or CRLF
  // line endings (the rest of the codebase preserves LF; CRLF is
  // a defensive accept for pasted Windows content).
  const fmMatch = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!fmMatch) {
    // No frontmatter at all ⇒ nothing to strip; can't carry an
    // id. Return the body verbatim (the recipient's _upsertInternal
    // seeds a fresh id on save anyway). No source-share line —
    // we don't know the sender's id, so any handle/?? would be
    // misleading.
    return body
  }

  const fmBlock = fmMatch[1] // the frontmatter LINES, no fences
  const rest = body.slice(fmMatch[0].length) // everything after

  // P3+P4 fold (Codex F1): use the canonical extractor so dotted
  // / quoted ids are caught. extractFrontmatterId operates on the
  // FULL body (handles the `---` fences itself).
  const senderId = extractFrontmatterId(body)

  // Walk fm lines. STRIP:
  //   - any `id:` line (canonical grammar — bare/quoted/dotted)
  //   - any `source-share:` line (Codex fold F4 — re-share
  //     idempotence; replace, never chain).
  // Remember the position of the FIRST `type:` line so the new
  // source-share goes right after it (preserves
  // isSkillAtomBody's "type: is the first type line" grammar).
  const lines = fmBlock.split(/\r?\n/)
  let typeIdx = -1
  const cleaned: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (ID_LINE_RE.test(line)) continue // strip id line (F1)
    if (SOURCE_SHARE_LINE_RE.test(line)) continue // strip prior provenance (F4)
    if (/^type:/.test(line) && typeIdx === -1) {
      typeIdx = cleaned.length
    }
    cleaned.push(line)
  }

  // P3+P4 fold (Codex F5): defensively replace `/` in the handle
  // before emitting. WorkOS subjects today are `user_<ULID>`
  // (no slashes), but the contract is implicit; a future
  // slash-bearing handle would make extractShareProvenance
  // ambiguous (the regex anchors on the first `/`). Replace
  // with `_` — opaque, parseable, unambiguous.
  const safeHandle = handle.trim().replace(/\//g, '_')

  // Only inject source-share if we found an id AND the handle is
  // non-empty (defensive: don't emit `source-share: /<id>` with
  // a blank handle).
  if (senderId && safeHandle) {
    const shareLine = `source-share: ${safeHandle}/${senderId}`
    if (typeIdx >= 0) {
      // Insert right AFTER the type: line so the type predicate
      // (isSkillAtomBody) still sees it as the first type line.
      cleaned.splice(typeIdx + 1, 0, shareLine)
    } else {
      // No type line — prepend at the top.
      cleaned.unshift(shareLine)
    }
  }

  const newFm = cleaned.join('\n')
  return `---\n${newFm}\n---\n${rest.startsWith('\n') ? rest.slice(1) : rest}`
}

/** Detect whether a body's frontmatter already declares a
 *  `source-share:` line — used by the UI to render a "(received
 *  from …)" hint on the imported atom. Returns the handle/id pair
 *  when present; null otherwise. */
export function extractShareProvenance(
  body: string,
): { handle: string; senderId: string } | null {
  const fmMatch = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!fmMatch) return null
  const fm = fmMatch[1]
  // P3+P4 Codex fold F1: senderId grammar widened to match the
  // canonical extractFrontmatterId — any non-whitespace token
  // (dots, dashes, underscores all allowed). Anchored on the
  // `/` delimiter; the handle (LHS) excludes `/` (sanitized at
  // emission time per Codex fold F5).
  const m = fm.match(
    /^source-share:[ \t]*['"]?([^/'"\s][^'"/\n\r]*?)\/(\S+?)['"]?[ \t]*$/m,
  )
  if (!m) return null
  return { handle: m[1], senderId: m[2] }
}
