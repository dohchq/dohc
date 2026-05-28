// atom-address-v1 Track-1 Phase 1 — the rename-proof namespace.
// Design: docs/strategy/atom-address-v1.md (gate CLEARED v4 §1.1–1.4).
//
// Pure + dependency-free (same invariant as inlineAtom.ts): the
// normalization / frontmatter-id / decision logic is unit-tested in
// isolation; the thin `ctx.db` wrappers ride the existing on-write
// chokepoints (upsertAtomImpl / removeAtomImpl / atoms.move /
// trash.restoreRow), exactly like applyAtomCapture.
//
// IMPLEMENTATION NOTE — surfaced for the Phase-1 dual review (a
// design example vs grammar discrepancy found while building, not
// silently resolved):
//  • §1 grammar says every address `seg` is the FROZEN key ident
//    `[A-Za-z_][A-Za-z0-9_]*`, yet §1's own example file-id
//    `log.2025_07_14` has a DIGIT-LEADING segment, which that grammar
//    forbids. The file-id is a DISTINCT namespace from the value-atom
//    key (the key is only ever the LAST segment, consumed in Phase 2
//    and kept strictly frozen there). So a file-id segment here is
//    relaxed to `[a-z0-9_]+` (lowercased, digit-leading allowed) to
//    match the design's own dated-log example and intent. This does
//    not affect rename-proofing or determinism (both are about the
//    index, not the id's spelling). Reviewers: bless or correct.
//  • §1 prose writes `logs/… → log.…` (singular); the listed
//    normalization steps do NOT singularize. We follow the STEPS
//    (`logs.…`) — the prose `log.` is illustrative. Cosmetic only;
//    determinism/rename-proofing identical either way.

import type { MutationCtx } from './_generated/server'
import { parseInlineAtomsFromMarkdown } from './inlineAtom'

// ── §1.1 path → candidate file-id (the fixed normalization) ─────────
// lowercase · drop extension · per `/` segment · `[^a-z0-9_]→_` (this
// subsumes the date `-`→`_` rule) · collapse `_` · trim `_` · never
// empty. Deterministic and pure.
function normSeg(s: string): string {
  const x = s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return x === '' ? '_' : x
}

// D4.13 — extension-determined HTML rendering. Case-INSENSITIVE
// (mirrors normalizeFileId's case-insensitive extension strip), so
// `report.HTML` renders as a page exactly like `report.html`. One
// helper used by every render-decision site (AtomView, the /r
// route, the tree badge, isNonDataAtom) — they can never disagree.
export function isHtmlPath(path: string): boolean {
  return path.toLowerCase().endsWith('.html')
}

export function normalizeFileId(path: string): string {
  const noExt = path.replace(/\.[A-Za-z0-9]+$/, '')
  const segs = noExt
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(normSeg)
  return segs.length > 0 ? segs.join('.') : '_'
}

// ── frontmatter: BYTE-EXACT split / join (b1 strip-and-reattach) ────
// We never reparse/reserialize the YAML — splitFrontmatter captures
// the leading `---\n…\n---` block VERBATIM (incl. at most ONE
// trailing newline; any blank line after it stays in `rest`).
// join is pure concat, so prefix + rest is byte-identical to the
// original whenever `rest` is unchanged. This is what makes the
// editor's frontmatter round-trip provably lossless without a
// fragile custom rich-editor frontmatter node (Context7-confirmed:
// the previous editor had no remark-frontmatter; a custom node is a 5-part,
// byte-fragile effort).
const FM_PREFIX_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)?/

export function splitFrontmatter(body: string): {
  fm: string
  rest: string
} {
  const b = body ?? ''
  // ReDoS guard (Codex P4-fold; this fn is reused by b1 + digestBody
  // and runs per-keystroke on a user-controlled body): the ONLY
  // catastrophic input for FM_PREFIX_RE is a leading `---` with NO
  // closing fence anywhere — the lazy `[\s\S]*?` then explores the
  // whole string failing (quadratic on a long whitespace run; ~4s @
  // 40KB, empirically). If there is no `\n---` after the opener
  // there CAN be no frontmatter, so bail via a linear indexOf BEFORE
  // the regex — semantics-identical (the regex returns no-match too)
  // and byte-exactness-preserving. With ANY `\n---` present the lazy
  // quantifier stops at the FIRST one (fast), so the regex is safe.
  if (b.indexOf('\n---', 3) === -1) return { fm: '', rest: b }
  const m = FM_PREFIX_RE.exec(b)
  if (!m) return { fm: '', rest: b }
  return { fm: m[0], rest: b.slice(m[0].length) }
}

export function joinFrontmatter(fm: string, rest: string): string {
  return fm + rest
}

// html-atoms-v1 §6 — the SINGLE shared predicate: an html atom is a
// VISUAL VIEW, never a value-atom data source, so every value-atom
// scanner skips it. Frontmatter `type: html` (the existing
// action/html meta pattern). Reuses the AUDITED, Phase-4
// ReDoS-guarded `splitFrontmatter` (single source — no second
// frontmatter scan to ReDoS); the per-line anchored bounded test
// over the already-bounded `fm` is linear/catastrophe-free. v1
// assumes dohc writes clean frontmatter (`type: html`, optionally
// quoted) — a trailing `# comment` etc. is out of v1 scope (the
// parser is dependency-free; full YAML is overkill here).
const FM_TYPE_HTML_RE = /^type:[ \t]*['"]?html['"]?[ \t]*\r?$/m
// skills-commands-v1 §1.2 — same exact grammar for `type: skill`:
// line-anchored, case-sensitive lowercase, bare OR single-/double-
// quoted, optional surrounding spaces. NO trailing comments/arrays.
const FM_TYPE_SKILL_RE = /^type:[ \t]*['"]?skill['"]?[ \t]*\r?$/m

// Count `type:` line declarations in a frontmatter `fm` block. O(n)
// over the already-bounded `fm` (splitFrontmatter has the Phase-4
// indexOf guard at the body level). Track-3 §1.2 mandate: BOTH
// `isHtmlAtomBody` and `isSkillAtomBody` reject any frontmatter
// with `countTypeLines !== 1` — duplicate `type:` lines are
// structurally invalid (NOT first-line-wins; that ambiguity is
// brittle vs the design's strict-grammar commit).
const TYPE_LINE_RE = /^type:/gm
export function countTypeLines(fm: string): number {
  if (!fm) return 0
  let count = 0
  // Re-create local matcher each call (global regex state safety).
  const re = new RegExp(TYPE_LINE_RE.source, 'gm')
  while (re.exec(fm)) count++
  return count
}

export function isHtmlAtomBody(body: string): boolean {
  const { fm } = splitFrontmatter(body ?? '')
  if (!fm) return false
  if (countTypeLines(fm) !== 1) return false // §1.2 strict-reject
  return FM_TYPE_HTML_RE.test(fm)
}

// Display title for the tree/breadcrumb (moved here from atoms.ts so
// the share read path can reuse it without a circular import).
// Order: frontmatter name/title → first H1 → first non-empty line →
// null (caller falls back to the path leaf). HTML files always use
// their filename (return null).
export function deriveTitle(body: string, path?: string): string | null {
  const html = (path && isHtmlPath(path)) || isHtmlAtomBody(body)
  // A frontmatter `title:` (or `name:`) applies to ALL atoms, incl.
  // html — so an html page's title shows in the tree + above its
  // content (emoji-icons / D4.17 follow-up).
  const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(body)
  if (fmMatch && fmMatch[1]) {
    const fm = fmMatch[1]
    const named = /^name:\s*(.+)$/m.exec(fm) ?? /^title:\s*(.+)$/m.exec(fm)
    if (named && named[1]) {
      return named[1].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  // No content-parsing (H1/first-line) for html — its body is markup,
  // not prose. Fall back to the path leaf (handled by the caller).
  if (html) return null
  const stripped = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
  const h1 = /^#\s+(.+)$/m.exec(stripped)
  if (h1 && h1[1]) return h1[1].trim()
  const firstLine = stripped.split('\n').find((l) => l.trim().length > 0)
  if (firstLine) return firstLine.trim().slice(0, 80)
  return null
}

export function isSkillAtomBody(body: string): boolean {
  const { fm } = splitFrontmatter(body ?? '')
  if (!fm) return false
  if (countTypeLines(fm) !== 1) return false // §1.2 strict-reject
  return FM_TYPE_SKILL_RE.test(fm)
}

// Track-3 P2c fold (indep F3) — extractors for STRUCTURALLY-
// BOUNDED enum frontmatter fields exposed via read_atom's INERT
// preview (§3.1 design lines 467-481). NEVER user-authored prose;
// these are bool enums the model can use to truthfully describe
// the atom WITHOUT reading the body bytes.
//
// Grammar: `<key>: true` | `<key>: false` (case-sensitive lowercase
// bare; quoted variants accepted for parity with the type-line
// grammar). Default false when absent or malformed.
function extractBoolFmField(fm: string, key: string): boolean {
  const re = new RegExp(
    `^${key}:[ \\t]*['"]?(true|false)['"]?[ \\t]*\\r?$`,
    'm',
  )
  const m = fm.match(re)
  return m ? m[1] === 'true' : false
}

/** Skills MAY declare `command: true` to surface in the ⌘K
 *  palette as a fire-able entry. Default false. */
export function extractSkillCommandFlag(body: string): boolean {
  const { fm } = splitFrontmatter(body ?? '')
  if (!fm) return false
  return extractBoolFmField(fm, 'command')
}

// skills-commands-v1 §6.4 — TEMPORARY OR-compat term in
// `isNonDataAtom` for the v1 deploy window. Top-level `skills/`
// prefix: matches `skills/x.md` AND `skills/sub/x.md`; does NOT
// match `notes/skills/x.md`. Collapsed away by the P2 migration
// mutation that injects `type: skill` into every legacy
// `skills/*` atom (then this term is REMOVED in a one-line cleanup
// follow-up).
export function isLegacySkillPath(path: string): boolean {
  return path.startsWith('skills/')
}

// skills-commands-v1 §6.1 — the ONE unified predicate every
// value-atom scanner uses. EXACTLY mirrors the §6 audited skip:
// html (view, not a source — §6) OR skill (instructions, not a
// source — Track-3) OR legacy-skill-path (compat-window term,
// removed after P2 migration).
//
// Track-3 P1 RETROFITS this predicate at three `convex/windows.ts`
// sites (gather / withheld / availableKeys) that Track-2 P1a's §6
// audit silently MISSED — closing a real latent gap where a
// `type: html` atom's `{k:v}` could cross a granted window
// unreviewed. The unified predicate fixes html + extends to skill in
// one pass. Honest deploy note: "HTML and skill atoms are now
// treated as views/instructions, not data sources; inline `{k:v}`
// examples no longer capture or cross shared windows."
export function isNonDataAtom(path: string, body: string): boolean {
  return (
    // D4.13 — a `.html` path is a VIEW (extension-determined); its
    // `{k:v}` examples never capture or cross a shared window. The
    // `type: html` body check stays as a backward-compat fallback.
    isHtmlPath(path) ||
    isHtmlAtomBody(body) ||
    isSkillAtomBody(body) ||
    isLegacySkillPath(path)
  )
}

// Read the `id:` scalar out of the leading frontmatter block (quoted
// or bare). Returns null when there is no frontmatter or no non-empty
// id. Pure.
export function extractFrontmatterId(body: string): string | null {
  const { fm } = splitFrontmatter(body)
  if (!fm) return null
  const inner = fm
    .replace(/^---[ \t]*\r?\n/, '')
    .replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
  const m = /^id:[ \t]*(?:"([^"\n\r]*)"|'([^'\n\r]*)'|([^\n\r]*))[ \t]*$/m.exec(
    inner,
  )
  if (!m) return null
  const id = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  return id.length > 0 ? id : null
}

// emoji-icons — the page's chosen icon emoji from frontmatter `icon:`
// (null if absent). Mirrors extractFrontmatterId.
export function extractFrontmatterIcon(body: string): string | null {
  const { fm } = splitFrontmatter(body)
  if (!fm) return null
  const inner = fm
    .replace(/^---[ \t]*\r?\n/, '')
    .replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
  const m =
    /^icon:[ \t]*(?:"([^"\n\r]*)"|'([^'\n\r]*)'|([^\n\r]*))[ \t]*$/m.exec(inner)
  if (!m) return null
  const icon = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  return icon.length > 0 ? icon : null
}

// Inject `id: <id>` — ONLY ever called when extractFrontmatterId is
// null (§1.1 "the system never rewrites a non-empty id"). If a
// frontmatter block exists, the id becomes its first field (all other
// bytes preserved); else a minimal block is prepended. Pure.
export function injectFrontmatterId(body: string, id: string): string {
  const { fm, rest } = splitFrontmatter(body ?? '')
  if (!fm) return `---\nid: ${id}\n---\n${body ?? ''}`
  const openMatch = /^---[ \t]*\r?\n/.exec(fm)
  const open = openMatch ? openMatch[0] : '---\n'
  const after = fm.slice(open.length)
  return `${open}id: ${id}\n${after}${rest}`
}

// D4.29 — Convex-side title injector (the client uses js-yaml's
// applyFrontmatter; Convex has no YAML lib, so this is a careful
// regex sibling). Sets the `title:` line (after `id:` if present),
// replacing any existing one. Quotes the value when it could break a
// YAML bare scalar. Pure. Used by the legacy body-H1 → title:
// migration.
export function injectFrontmatterTitle(body: string, title: string): string {
  const needsQuote = /[:#]|^\s|\s$|^['"[\]{>|]/.test(title)
  const safe = needsQuote
    ? '"' + title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : title
  const { fm, rest } = splitFrontmatter(body ?? '')
  if (!fm) return `---\ntitle: ${safe}\n---\n${body ?? ''}`
  const openMatch = /^---[ \t]*\r?\n/.exec(fm)
  const open = openMatch ? openMatch[0] : '---\n'
  const closeMatch = /\r?\n---[ \t]*(?:\r?\n)?$/.exec(fm)
  const close = closeMatch ? closeMatch[0] : '\n---\n'
  const inner = fm.slice(open.length, fm.length - close.length)
  const lines = inner
    .split('\n')
    .filter((l) => l.length > 0 && !/^title:/i.test(l.trim()))
  const idIdx = lines.findIndex((l) => /^id:/.test(l.trim()))
  if (idIdx >= 0) lines.splice(idIdx + 1, 0, `title: ${safe}`)
  else lines.push(`title: ${safe}`)
  return `${open}${lines.join('\n')}${close}${rest}`
}

// emoji-icons — set (or clear, when icon is null/empty) the frontmatter
// `icon:` field. Placed after `title:` (or `id:`), preserving the rest.
// Mirrors injectFrontmatterTitle (line-based, no yaml dep).
export function setFrontmatterIcon(body: string, icon: string | null): string {
  const clean = (icon ?? '').trim()
  const { fm, rest } = splitFrontmatter(body ?? '')
  if (!fm) {
    return clean ? `---\nicon: ${clean}\n---\n${body ?? ''}` : (body ?? '')
  }
  const openMatch = /^---[ \t]*\r?\n/.exec(fm)
  const open = openMatch ? openMatch[0] : '---\n'
  const closeMatch = /\r?\n---[ \t]*(?:\r?\n)?$/.exec(fm)
  const close = closeMatch ? closeMatch[0] : '\n---\n'
  const inner = fm.slice(open.length, fm.length - close.length)
  const lines = inner
    .split('\n')
    .filter((l) => l.length > 0 && !/^icon:/i.test(l.trim()))
  if (clean) {
    const titleIdx = lines.findIndex((l) => /^title:/i.test(l.trim()))
    const idIdx = lines.findIndex((l) => /^id:/i.test(l.trim()))
    const at =
      titleIdx >= 0 ? titleIdx + 1 : idIdx >= 0 ? idIdx + 1 : lines.length
    lines.splice(at, 0, `icon: ${clean}`)
  }
  if (lines.length === 0) return rest // frontmatter became empty
  return `${open}${lines.join('\n')}${close}${rest}`
}

/** PURE — for the legacy migration: pull the leading `# H1` out of
 *  post-frontmatter content. Returns the heading text + the content
 *  with that heading line (and one trailing blank line) removed, or
 *  null when the content doesn't start with `# `. */
export function extractLeadingH1(rest: string): {
  title: string
  bodyWithoutH1: string
} | null {
  const m = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(rest)
  if (!m || m.index !== 0) return null
  const title = (m[1] ?? '').trim()
  if (!title) return null
  // drop the heading line + at most one immediately-following blank line
  const after = rest.slice(m[0].length).replace(/^\r?\n/, '')
  return { title, bodyWithoutH1: after }
}

// ── §1.3 the decision table (PURE — the unit-tested core) ───────────
export type AtomIdRowState = 'bound' | 'released'
export type AtomIdAction =
  | { kind: 'insert' }
  | { kind: 'noop' }
  | { kind: 'rename' }
  | { kind: 'resurrect' }
  | { kind: 'collision'; reason: 'copy' | 'released' }

export function decideAtomIdAction(input: {
  row: { state: AtomIdRowState; path: string | null } | null
  thisPath: string
  /** an atom still lives at row.path (≠ thisPath) — copy vs rename */
  oldPathLive: boolean
  /** the write is a trash-restore (the only legal resurrection) */
  isRestore: boolean
}): AtomIdAction {
  const { row, thisPath, oldPathLive, isRestore } = input
  if (!row) return { kind: 'insert' }
  if (row.state === 'bound') {
    if (row.path === thisPath) return { kind: 'noop' }
    // bound elsewhere: old path still live ⇒ COPY/hand-dup (loud, no
    // rebind, no inherit); old path gone ⇒ RENAME (rebind).
    return oldPathLive
      ? { kind: 'collision', reason: 'copy' }
      : { kind: 'rename' }
  }
  // released (tombstoned): ONLY a trash-restore may resurrect; any
  // ordinary write reusing a dead id is a collision (never inherits
  // the dead id's references — silent-hijack-NEVER).
  return isRestore
    ? { kind: 'resurrect' }
    : { kind: 'collision', reason: 'released' }
}

// ── thin IO: seeding (pre-write) ────────────────────────────────────
// Returns the body to actually persist. If it already carries an id,
// returned unchanged (never rewrite a non-empty id — a colliding
// hand-authored id is handled loudly at reconcile, NOT silently
// re-seeded). Else a free id is claimed: `cand`, then `cand_2`,
// `cand_3`… Determinism: the on-write hook runs in atom-creation
// order and the chosen id is then frozen into the body's
// frontmatter, so replay/re-import (which carry the frozen id) never
// re-seed (§1.2; _creationTime is immutable & implicitly orders every
// index — Context7-confirmed).
export async function seedAtomIdIntoBody(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  body: string,
): Promise<string> {
  if (extractFrontmatterId(body) !== null) return body
  // The incoming body has NO id. If this exact path is ALREADY a
  // bound, addressed file (its atomIds row exists), the writer simply
  // dropped the frontmatter (agent rewrite, fat-finger) — RE-INJECT
  // its own existing id, never mint a new one. This keeps a file's
  // address stable across an accidental frontmatter strip (the whole
  // point of rename-proofing must not be defeated by a lossy save).
  // `.collect()` + pick (NOT `.unique()`): reconcile maintains ≤1
  // bound row per (ws,path), but a non-throwing read is the robust
  // choice — a legacy/partial double-row must degrade, never crash
  // the write (Codex P1-build). by_workspace_path only ever matches
  // BOUND rows (released rows have path:null), so this is the
  // file's own current binding.
  const ownRows = await ctx.db
    .query('atomIds')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .collect()
  const own = ownRows.find((r) => r.state === 'bound')
  if (own) {
    return injectFrontmatterId(body, own.fileId)
  }
  const cand = normalizeFileId(path)
  let id = cand
  let n = 2
  // bound OR released both count as "taken" — a released id is never
  // silently reused (§1.2).
  while (
    (await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) =>
        q.eq('workspaceId', workspaceId).eq('fileId', id),
      )
      .unique()) !== null
  ) {
    id = `${cand}_${n++}`
  }
  return injectFrontmatterId(body, id)
}

// ── thin IO: reconcile the index (post-write, same txn) ─────────────
// Decidable from row.state + (old path live?) + isRestore alone — no
// event-order/cron dependence (Convex mutations are atomic+OCC —
// Context7-confirmed). A `collision` NEVER touches this path's
// index ⇒ the dup's `{=…}` refs fail-soft to `—` (honest "this is
// unresolved", never a silent hijack). Returns the action taken so
// callers/tests can assert it.
export async function reconcileAtomIdIndex(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  body: string,
  opts: { isRestore: boolean },
): Promise<AtomIdAction> {
  const fileId = extractFrontmatterId(body)
  if (fileId === null) return { kind: 'noop' } // unaddressable; nothing to index
  // D4.26 — `.collect()`+pick, NOT `.unique()`: a duplicate
  // (ws,fileId) row is index corruption; a non-throwing read must
  // DEGRADE (never crash the user's save). Mirrors the seed path's
  // discipline. Prefer the bound row; else the first.
  const rows = await ctx.db
    .query('atomIds')
    .withIndex('by_workspace_fileId', (q) =>
      q.eq('workspaceId', workspaceId).eq('fileId', fileId),
    )
    .collect()
  const row = rows.find((r) => r.state === 'bound') ?? rows[0] ?? null

  let oldPathLive = false
  if (row && row.state === 'bound' && row.path && row.path !== path) {
    // `.first()` (existence only) — a double atom-row must not throw.
    oldPathLive =
      (await ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', workspaceId).eq('path', row.path as string),
        )
        .first()) !== null
  }

  const action = decideAtomIdAction({
    row: row ? { state: row.state, path: row.path } : null,
    thisPath: path,
    oldPathLive,
    isRestore: opts.isRestore,
  })

  switch (action.kind) {
    case 'insert':
      await ctx.db.insert('atomIds', {
        workspaceId,
        fileId,
        path,
        state: 'bound',
      })
      break
    case 'rename':
    case 'resurrect':
      if (row) await ctx.db.patch(row._id, { path, state: 'bound' })
      break
    case 'collision':
      // Surfaced, NOT silent, NOT rebound (§1.3). Phase-1-adequate
      // surfacing: leave this path unindexed so its refs render the
      // honest `—`; the richer one-time inline advisory rides the
      // advisory surface in a later track (design §1.4 — deferred,
      // noted).
      console.warn(
        `[atomId] duplicate-id collision (${action.reason}) for fileId="${fileId}" at path="${path}" — not rebound; refs render "—" until disambiguated`,
      )
      break
    case 'noop':
      break
  }

  // Codex P1-build dispositive fix — a file's id can legitimately
  // CHANGE (the user hand-edits `id:` via the b2 source view; an
  // agent rewrites it). We just bound `fileId`→`path`; any OTHER row
  // still `bound` to this SAME path under a DIFFERENT fileId is now
  // stale.
  // D4.24 — DELETE it (was: tombstone to state:'released'). A
  // tombstone permanently blocked reusing the old id, so typing an
  // id, away, then BACK to it left a dead `released` row that the
  // body could never rebind — surfacing as a phantom collision.
  // Deleting frees the id (consistent with D4.14 delete-releases-id
  // + the user's reusable-id choice). The old id's refs fail-soft
  // to "—" until something rebinds it. Only runs when we actually
  // (re)bound this path — never on collision/noop.
  if (
    action.kind === 'insert' ||
    action.kind === 'rename' ||
    action.kind === 'resurrect'
  ) {
    const atPath = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .collect()
    const stale = atPath.filter(
      (r) => r.fileId !== fileId && r.state === 'bound',
    )
    if (stale.length > 0) {
      // D4.25 — the old id is being abandoned (the user changed the
      // `id:`). Only scan for inbound refs when there's actually a
      // stale row (so a normal save pays nothing). Tombstone the old
      // id if a formula concretely names it (else free it) — same
      // silent-hijack guard as delete.
      const concreteRefs = await collectConcreteRefs(
        ctx,
        workspaceId,
        new Set([path]),
      )
      for (const r of stale) {
        if (concreteRefs.has(r.fileId)) {
          await ctx.db.patch(r._id, { state: 'released', path: null })
        } else {
          await ctx.db.delete(r._id)
        }
      }
    }
  }
  return action
}

// ── D4.25 — tombstone-while-referenced (silent-hijack fix) ──────────
// When an id is abandoned (file deleted, or `id:` hand-edited), we
// must decide: FREE it (delete the row → reusable, no `_2`) or
// TOMBSTONE it (state:'released' → blocks silent reuse). The hazard
// is a stale formula like `{= clients.acme.owed }` silently re-
// resolving to a NEW file that reclaims `clients.acme`. So:
//   - if some OTHER atom's formula CONCRETELY names this exact
//     fileId (a non-glob, exact-segment address) → TOMBSTONE
//     (the reference would hijack on reuse; instead it renders `—`).
//   - otherwise → FREE (delete). `*`-glob / all-match aggregates
//     re-include whatever files exist (a recreate rejoins correctly,
//     even when suffixed), so they are NOT hijack risks.

/** PURE — the exact fileId a formula CONCRETELY names, or null if it
 *  uses a `*` glob / empty (all-match) address (no specific-id
 *  hijack risk). Mirrors evaluateFormula's key-arity split:
 *  `count` → whole address is the file glob; everything else → the
 *  last segment is the value KEY, the rest is the file glob. */
export function formulaConcreteFileId(f: {
  fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'latest' | null
  segments: string[]
}): string | null {
  const segs = f.segments
  if (segs.length === 0) return null
  const glob = f.fn === 'count' ? segs : segs.slice(0, -1)
  if (glob.length === 0) return null // empty = match-all aggregate
  if (glob.some((s) => s.includes('*'))) return null // pattern, not concrete
  return glob.join('.')
}

/** Scan the workspace's atoms (except `excludePaths`) and collect the
 *  set of fileIds CONCRETELY named by any formula — the set whose
 *  members must be tombstoned (not freed) on delete/id-change. */
export async function collectConcreteRefs(
  ctx: MutationCtx,
  workspaceId: string,
  excludePaths: Set<string>,
): Promise<Set<string>> {
  const refs = new Set<string>()
  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect()
  for (const a of atoms) {
    if (excludePaths.has(a.path)) continue
    for (const atom of parseInlineAtomsFromMarkdown(a.body ?? '')) {
      if (atom.kind !== 'formula') continue
      const fid = formulaConcreteFileId(atom)
      if (fid) refs.add(fid)
    }
  }
  return refs
}

// ── thin IO: release-or-tombstone the id on delete ──────────────────
// Only act on the row this path actually OWNS (bound to exactly this
// path). A deleted dup that never owned the id must not kill the
// legit owner's binding. `concreteRefs` is the pre-collected set
// (one scan, reused across a bulk folder delete).
export async function releaseAtomIdOnDelete(
  ctx: MutationCtx,
  workspaceId: string,
  body: string,
  deletedPath: string,
  concreteRefs: Set<string>,
): Promise<void> {
  const fileId = extractFrontmatterId(body)
  if (fileId === null) return
  // D4.26 — `.collect()`+pick (not `.unique()`): degrade on a
  // corrupt double-row instead of throwing + blocking the delete.
  const rows = await ctx.db
    .query('atomIds')
    .withIndex('by_workspace_fileId', (q) =>
      q.eq('workspaceId', workspaceId).eq('fileId', fileId),
    )
    .collect()
  const row =
    rows.find((r) => r.state === 'bound' && r.path === deletedPath) ?? null
  if (row) {
    if (concreteRefs.has(fileId)) {
      // referenced → tombstone (refs render `—`, never hijack)
      await ctx.db.patch(row._id, { state: 'released', path: null })
    } else {
      // unreferenced → free the id for reuse
      await ctx.db.delete(row._id)
    }
  }
}
