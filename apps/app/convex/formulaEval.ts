// atom-address-v1 §3 Track-1 Phase 3 (3A) — the SINGLE-PASS formula
// evaluator. Generalizes the resolveMany path (§3): scan the
// workspace's atoms ONCE + the atomIds index ONCE, build an in-memory
// store, then evaluate ALL (≤64, deduped) `{= … }` formulas against
// it purely. NO per-formula DB read (Codex design #2). Owner-scoped,
// bounded, fail-soft, never-throws — the resolveLiveTotal contract.
//
// `evaluateFormula` is PURE/total (the unit-tested core, like
// resolveLiveTotal / decideAtomIdAction / computeAtomRanges). The
// Convex query is the thin IO shell.
//
// PHASE-3 RESOLUTION DECISIONS — surfaced for the Phase-3 dual review
// (not silently guessed; same discipline as Phase-1/2). §3/§4 fix
// the fail-soft posture but leave per-fn semantics to "eval"; these
// are the minimal faithful readings of §2's examples:
//  1. PER-FN KEY-ARITY: sum/avg/min/max/latest — the LAST address
//     segment is the value-atom KEY; the preceding segments are the
//     fileId glob. `count` — the WHOLE address is the fileId glob
//     (no value key; §2 example `count(projects.* status=active)`).
//     bare address (no fn) — fileId = all but last seg, key = last.
//     An EMPTY fileId glob (e.g. `sum(billable)`) matches ALL files
//     (the design's "no fileid scope = all").
//  2. GLOB: a `*` segment matches exactly ONE id segment (not `**`);
//     `pre*` matches startsWith(pre); seg count must match the
//     fileId's (empty pattern is the only all-match). Dated ids
//     sort lexically so prefix-glob = the §2.2 date window.
//  3. `latest` = the value from the lexicographically-GREATEST
//     matched fileId (dated logs sort chronologically).
//  4. PREDICATE: `= / ==` → string-equal OR numeric-equal;
//     `!=` → negation; `> < >= <=` → numeric only (non-numeric ⇒
//     the file fails). A file passes if ANY of its value-atoms for
//     that key satisfies (generous; documented).
//  5. EMPTY RESULT: `count` ⇒ 0 (a real answer — resolveLiveTotal
//     precedent); every other fn / bare ⇒ null ⇒ editor renders `—`
//     (a misleading authoritative 0 is worse — Phase-4 Codex-HIGH).
//  6. BARE ADDRESS names ONE value: exactly 1 match ⇒ that value
//     (type preserved); 0 or >1 ⇒ null (ambiguity is honest `—`).
//  7. Only NUMBER-typed values aggregate (FROZEN: `{k:"6"}` is a
//     string, never coerced — no invented numeric truth).
// Reviewers: bless or correct any of the seven.

import { query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import {
  parseFormulaFromSrc,
  parseInlineAtomsFromMarkdown,
  type InlineAtom,
} from './inlineAtom'
import { isNonDataAtom, extractFrontmatterId } from './atomId'
import { resolveShareAccess } from './atomShares'

// Same bound + posture as liveTotals.NOTE_SCAN_CAP: a wrong
// authoritative-looking number is worse than `—` — over the cap we
// fail-soft to null, never silently under-count.
const NOTE_SCAN_CAP = 5000
const MAX_FORMULAS = 64

type Formula = Extract<InlineAtom, { kind: 'formula' }>
export type FileRec = {
  fileId: string
  segs: string[]
  /** value-atom key → its values in this file (FROZEN-typed) */
  byKey: Map<string, Array<number | string | boolean>>
}
export type FormulaStore = { files: FileRec[] }
export type FormulaValue = number | string | null

const FORBIDDEN_KEY = new Set(['__proto__', 'prototype', 'constructor'])
const safeKey = (k: string) => k.length > 0 && !FORBIDDEN_KEY.has(k)

// segs of a concrete fileId vs a glob pattern. `*`→any one seg;
// `pre*`→startsWith(pre); else exact. Empty pattern ⇒ match all.
function fileMatches(pattern: string[], fileSegs: string[]): boolean {
  if (pattern.length === 0) return true
  if (pattern.length !== fileSegs.length) return false
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    const s = fileSegs[i]
    if (p === '*') continue
    if (p.endsWith('*')) {
      if (!s.startsWith(p.slice(0, -1))) return false
    } else if (p !== s) {
      return false
    }
  }
  return true
}

function numbers(vals: Array<number | string | boolean>): number[] {
  return vals.filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x),
  )
}

function predicatePasses(
  rec: FileRec,
  pred: { key: string; op: string; value: string } | null,
): boolean {
  if (!pred) return true
  if (!safeKey(pred.key)) return false
  const vals = rec.byKey.get(pred.key)
  if (!vals || vals.length === 0) return false
  const rhsNum = Number(pred.value)
  const rhsIsNum = pred.value.trim() !== '' && Number.isFinite(rhsNum)
  return vals.some((raw) => {
    const isNum = typeof raw === 'number' && Number.isFinite(raw)
    switch (pred.op) {
      case '=':
      case '==':
        return String(raw) === pred.value || (isNum && rhsIsNum && raw === rhsNum)
      case '!=':
        return !(
          String(raw) === pred.value || (isNum && rhsIsNum && raw === rhsNum)
        )
      case '>':
        return isNum && rhsIsNum && raw > rhsNum
      case '<':
        return isNum && rhsIsNum && raw < rhsNum
      case '>=':
        return isNum && rhsIsNum && raw >= rhsNum
      case '<=':
        return isNum && rhsIsNum && raw <= rhsNum
      default:
        return false
    }
  })
}

/**
 * PURE/total. Resolve one parsed formula against the in-memory store.
 * Fail-soft: anything unresolved ⇒ null (editor renders `—`), except
 * `count` ⇒ 0 (a real answer). Never throws.
 */
export function evaluateFormula(
  f: Formula,
  store: FormulaStore,
): FormulaValue {
  const segs = f.segments
  if (segs.length === 0) return f.fn === 'count' ? 0 : null

  // per-fn split of the address into (fileId glob, value key)
  let pattern: string[]
  let key: string | null
  if (f.fn === 'count') {
    pattern = segs
    key = null
  } else {
    // sum/avg/min/max/latest AND bare-address: last seg = key
    pattern = segs.slice(0, -1)
    key = segs[segs.length - 1]
    if (key === '*' || key.includes('*') || !safeKey(key)) return null
  }

  const matched = store.files.filter(
    (rec) => fileMatches(pattern, rec.segs) && predicatePasses(rec, f.predicate),
  )

  if (f.fn === 'count') return matched.length // 0 is a real answer

  // gather the key's values across matched files
  const vals: Array<number | string | boolean> = []
  for (const rec of matched) {
    const got = rec.byKey.get(key as string)
    if (got) for (const x of got) vals.push(x)
  }

  if (f.fn === null) {
    // bare address names ONE value
    return vals.length === 1
      ? (typeof vals[0] === 'boolean' ? String(vals[0]) : vals[0])
      : null
  }
  if (f.fn === 'latest') {
    if (matched.length === 0) return null
    // value from the lexicographically-greatest fileId
    let best = matched[0]
    for (const r of matched) if (r.fileId > best.fileId) best = r
    const got = best.byKey.get(key as string)
    if (!got || got.length === 0) return null
    const x = got[0]
    return typeof x === 'boolean' ? String(x) : x
  }
  const nums = numbers(vals)
  if (nums.length === 0) return null // never a misleading authoritative 0
  if (f.fn === 'sum') return nums.reduce((s, n) => s + n, 0)
  if (f.fn === 'avg') return nums.reduce((s, n) => s + n, 0) / nums.length
  if (f.fn === 'min') return Math.min(...nums)
  if (f.fn === 'max') return Math.max(...nums)
  return null
}

// Build the store ONCE (the single-pass gather). Authoritative fileId
// is the BOUND atomIds row for an atom's path (§1.3 — a collision /
// unindexed / legacy-no-id file is excluded, exactly as its refs
// render `—`; NOT the body frontmatter, which a contested dup could
// forge). Bounded: one atomIds collect (≤ #files) + one capped atom
// scan. Over the cap ⇒ null store ⇒ every formula fail-soft to `—`.
async function buildStore(
  ctx: QueryCtx,
  workspaceId: string,
  // sharing-v1 1a — when present, ONLY these fileIds enter the store.
  // Used to resolve a SHARED atom's formulas over the explicitly-
  // shared dependency set in the owner's workspace, so an unshared
  // ref (or an injected `{= sum(salary) }`) resolves to `—`, never
  // leaking the owner's other data.
  allowedFileIds?: Set<string>,
): Promise<FormulaStore | null> {
  // atomIds has no `by_workspace` index — query the by_workspace_fileId
  // COMPOUND index by its `workspaceId` PREFIX (Convex prefix scan):
  // all rows for this workspace, bounded by #files.
  const idRows = await ctx.db
    .query('atomIds')
    .withIndex('by_workspace_fileId', (q) => q.eq('workspaceId', workspaceId))
    .collect()
  const pathToFileId = new Map<string, string>()
  for (const r of idRows) {
    if (r.state === 'bound' && r.path) pathToFileId.set(r.path, r.fileId)
  }

  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(NOTE_SCAN_CAP + 1)
  if (atoms.length > NOTE_SCAN_CAP) return null // fail-soft (no under-count)

  const byFileId = new Map<string, FileRec>()
  for (const a of atoms) {
    if (isNonDataAtom(a.path, a.body ?? '')) continue // §6 unified (Track-3 P1)
    const fileId = pathToFileId.get(a.path)
    if (!fileId) continue // not an addressed file (§1.3)
    if (allowedFileIds && !allowedFileIds.has(fileId)) continue // shared-scope
    // D4.27 — DEFENSIVE: the index is a derived cache. Distrust it on
    // read — if the body's frontmatter id disagrees with the index's
    // bound fileId for this path, the index is stale/corrupt; skip
    // (fail-soft to `—`) rather than attribute this atom's values to
    // the wrong fileId. Mirrors htmlAtoms.getRenderable's id-match
    // belt. A legacy body with NO id is allowed (path binding is the
    // boundary); only a POSITIVE mismatch is rejected.
    const bodyId = extractFrontmatterId(a.body ?? '')
    if (bodyId !== null && bodyId !== fileId) continue
    let rec = byFileId.get(fileId)
    if (!rec) {
      rec = { fileId, segs: fileId.split('.'), byKey: new Map() }
      byFileId.set(fileId, rec)
    }
    for (const atom of parseInlineAtomsFromMarkdown(a.body ?? '')) {
      if (atom.kind !== 'value') continue
      const arr = rec.byKey.get(atom.key)
      if (arr) arr.push(atom.value)
      else rec.byKey.set(atom.key, [atom.value])
    }
  }
  return { files: [...byFileId.values()] }
}

/**
 * Batched, owner-scoped, single-pass resolve of every `{= … }` in a
 * document — ONE reactive query for the editor (Phase 3B). Input =
 * the parser-CANONICAL `src` of each formula (the post-`=` expr,
 * already unescaped). This is the escape-invariant key both the
 * query side (from the markdown `value`) and the widget side (from
 * the unescaped ProseMirror doc text) derive via the SAME frozen
 * parser — fixing the Phase-3 dual-review BLOCKER where a raw-token
 * key mismatched after Crepe re-escaped `_`/`*`. Deduped, ≤64.
 * Unknown / malformed ⇒ value:null. Never throws.
 */
export const evalFormulas = query({
  // Phase B (org-plan §5 — NON-DEFAULTABLE surface). Currently OPTIONAL
  // for back-compat; Phase B.3 tightens to REQUIRED once URL routing
  // (Phase D) lands. Defaulting to personal in an org context would
  // silently evaluate org formulas against personal data.
  args: {
    srcs: v.array(v.string()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { srcs, activeWorkspaceId },
  ): Promise<Array<{ src: string; value: FormulaValue }>> => {
    const viewer = await requireWorkspace(ctx, activeWorkspaceId)
    const uniq = Array.from(new Set(srcs)).slice(0, MAX_FORMULAS)
    // Return an ARRAY, NOT an object keyed by `src` (Codex P3-fold
    // FAIL): a canonical src is attacker/author-influenceable — as an
    // object KEY it (a) pollutes the prototype (`__proto__`) and (b)
    // a `_`-leading src (`_map.x`) violates Convex's object-field
    // rule and would throw the WHOLE query (every formula in the doc
    // dead, never-throws broken). `src` as an array VALUE is safe;
    // the client builds a pollution-proof Map for lookup.
    const out: Array<{ src: string; value: FormulaValue }> = []
    if (uniq.length === 0) return out

    const store = await buildStore(ctx, viewer)
    for (const src of uniq) {
      let value: FormulaValue = null
      if (store) {
        const f = parseFormulaFromSrc(src)
        if (f && f.kind === 'formula') value = evaluateFormula(f, store)
      }
      out.push({ src, value })
    }
    return out
  },
})

// sharing-v1 1a — resolve a SHARED atom's formulas. SECURITY: the
// store is built in the OWNER's workspace but SCOPED to the set of
// fileIds the owner shared with THIS viewer (access.sharedFileIds).
// So a formula referencing an unshared owner file — or a malicious
// edit-grantee's injected `{= sum(salary) }` — resolves to `—`, never
// leaking the owner's other data. Absence of a grant ⇒ empty result.
export const evalFormulasShared = query({
  args: { shareId: v.id('atomShares'), srcs: v.array(v.string()) },
  handler: async (
    ctx,
    { shareId, srcs },
  ): Promise<Array<{ src: string; value: FormulaValue }>> => {
    const access = await resolveShareAccess(ctx, shareId)
    const uniq = Array.from(new Set(srcs)).slice(0, MAX_FORMULAS)
    const out: Array<{ src: string; value: FormulaValue }> = []
    if (!access || uniq.length === 0) {
      // DENY / nothing to do — every formula fails soft to null.
      for (const src of uniq) out.push({ src, value: null })
      return out
    }
    const store = await buildStore(
      ctx,
      access.ownerWorkspaceId,
      access.sharedFileIds,
    )
    for (const src of uniq) {
      let value: FormulaValue = null
      if (store) {
        const f = parseFormulaFromSrc(src)
        if (f && f.kind === 'formula') value = evaluateFormula(f, store)
      }
      out.push({ src, value })
    }
    return out
  },
})
