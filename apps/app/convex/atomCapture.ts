// R3 (design v4 §1/§2/§5) — the COMPLETE atom-write capture contract.
// `applyAtomCapture` is the ONE function EVERY atom-body writer calls
// (upsertAtomImpl insert+body-change, atoms.move, folders.moveImpl,
// trash.restoreRow, seed). It makes "an inline value never crosses a
// granted cross-desk window until the owner confirms it" STRUCTURAL —
// a byproduct of the write, not prompt-hope (closes C2 for atoms).
//
// Fail-closed by construction: a body that can't be parsed / is too
// big records the path-wide parse-fail SENTINEL (whole note withheld,
// honestly `blocked`) instead of silently recording nothing — the
// latter would be the C2-for-atoms leak. The sentinel is transient:
// the next clean-parsing write supersedes it and re-withholds per key.

import type { MutationCtx } from './_generated/server'
import {
  isSafeAtomPath,
  parseInlineAtomsFromMarkdownWithStatus,
  atomValueKeySeq,
  atomSeqEqual,
} from './inlineAtom'
import {
  recordAtomWriteCapture,
  clearAtomKeyCapture,
  recordAtomParseFailSentinel,
  clearAtomParseFailSentinel,
  clearCaptures,
} from './captures'
import { isNonDataAtom } from './atomId'

/**
 * Diff the PRIOR vs NEW note body and structurally withhold every
 * changed inline-value `(path,key)`. Called inside the writer's
 * transaction. Never throws into a write.
 *
 * `.context/_map.md` is a derived index (echoes other notes) — NEVER
 * a source of value atoms; excluded here AND in the gather via the SAME
 * `MAP_PATH` constant (no drift).
 *
 * Lifecycle (design v4 §5, Codex v3 HIGH reconciliation):
 *  • NEW body unparseable / too big ⇒ coalesce the parse-fail
 *    SENTINEL ⇒ whole note withheld + `blocked`. Return.
 *  • NEW body clean ⇒ delete any sentinel FIRST. If one was present,
 *    force "all current keys changed" so the fixed note is re-withheld
 *    per key (never a dark-hole — it is releasable via normal confirm).
 *  • Per key: an added / value-changed / value-type-changed /
 *    reordered / cardinality-changed occurrence sequence ⇒
 *    re-withhold (coalesced `auto`). A key that disappeared ⇒ clear
 *    its (path,key) rows (no value to project; a future re-add
 *    re-withholds fresh — M6-consistent).
 */
export async function applyAtomCapture(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  priorBody: string | null | undefined,
  newBody: string,
): Promise<void> {
  // §6 unified predicate (Track-3 P1 + r1-fold FAIL-1): a non-data
  // atom (MAP_PATH / html / skill / legacy-`skills/*`) never sources
  // values. CRITICAL: when transitioning data→non-data, CLEAR any
  // prior captures at this path. Otherwise a `data → non-data → data`
  // round-trip (set `{billable:1}` + confirm; flip to type:skill +
  // example `{billable:999}`; flip back to plain `{billable:999}`)
  // leaves the original CONFIRMED capture row stale — the new value
  // would cross a granted window with NO fresh consent edge. Clearing
  // on the transition re-asserts the withhold-by-default invariant.
  if (isNonDataAtom(path, newBody)) {
    await clearCaptures(ctx, workspaceId, 'atom', path)
    await clearAtomParseFailSentinel(ctx, workspaceId, path)
    return
  }
  // SYMMETRIC: a priorBody that was NON-data (html/skill) MUST be
  // treated as "no values previously here" so re-entering data
  // fully re-withholds every current key on the data side — instead
  // of `priorSeq == newSeq` short-circuiting to "no changes."
  const priorIsNonData =
    priorBody != null && isNonDataAtom(path, priorBody)
  // R3 §8 — a pre-existing NUL path (legacy/move/restore) fails CLOSED:
  // record NO capture (gather/report also skip it ⇒ its values never
  // cross), without blocking the move/restore of recoverable prose.
  if (!isSafeAtomPath(path)) return

  const parsedNew = parseInlineAtomsFromMarkdownWithStatus(newBody)
  if (!parsedNew.ok) {
    // FAIL CLOSED at write time: whole note withheld until it parses
    // clean and is re-confirmed. NEVER "record nothing" (= the leak).
    await recordAtomParseFailSentinel(ctx, workspaceId, path)
    return
  }

  // Clean parse ⇒ the sentinel (if any) is superseded FIRST. If one
  // was present, every current key is treated as changed so the
  // recovered note is re-withheld per (path,key) — releasable via
  // normal per-key confirm, never a permanent dark-hole.
  const hadSentinel = await clearAtomParseFailSentinel(ctx, workspaceId, path)

  const newSeq = atomValueKeySeq(parsedNew.atoms)
  let priorSeq = new Map<string, string[]>()
  // Track-3 P1 r1-fold FAIL-1: prior body was non-data (html/skill)
  // ⇒ treat as "no prior values" so every CURRENT key on the data
  // side is treated as changed and re-withheld (no stale-confirm
  // round trip via data→non-data→data).
  if (!hadSentinel && !priorIsNonData) {
    const parsedPrior = parseInlineAtomsFromMarkdownWithStatus(
      priorBody ?? '',
    )
    // prior unparseable ⇒ treat every NEW key as changed (safe: we
    // cannot prove the value is unchanged, so re-withhold).
    priorSeq = parsedPrior.ok ? atomValueKeySeq(parsedPrior.atoms) : new Map()
  }

  const keys = new Set<string>([...newSeq.keys(), ...priorSeq.keys()])
  for (const k of keys) {
    const a = newSeq.get(k)
    if (!a) {
      // key removed from the note ⇒ no value to project ⇒ clear it
      await clearAtomKeyCapture(ctx, workspaceId, path, k)
      continue
    }
    if (!atomSeqEqual(a, priorSeq.get(k))) {
      await recordAtomWriteCapture(ctx, workspaceId, path, k)
    }
  }
}
