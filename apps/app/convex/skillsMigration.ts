import { internalMutation } from './_generated/server'
import { v } from 'convex/values'
import {
  splitFrontmatter,
  joinFrontmatter,
  countTypeLines,
  isLegacySkillPath,
  seedAtomIdIntoBody,
  reconcileAtomIdIndex,
} from './atomId'
import { deriveSearchFields } from './searchText'

// skills-commands-v1 §6.4 (Track-3 P2a) — the ONE migration mutation
// that collapses the §6 OR-compat term `isLegacySkillPath` into the
// type-frontmatter-only invariant. Runs ONCE per workspace at
// deploy time (operator-triggered via:
//   npx convex run internal.skillsMigration._migrateLegacyPaths '{"workspaceId":"..."}'
// ) — explicitly NOT auto-triggered on every chat turn (zero runtime
// cost on the hot path).
//
// SAFE-MIGRATION RULE: inject `type: skill` ONLY into legacy
// `skills/*.md` atoms with NO existing `type:` declaration in their
// frontmatter. Atoms that already declare a type (skill / html /
// plugin / anything) are NEVER re-typed — the user's existing
// frontmatter wins. This avoids the Codex round-2 FAIL-4 false-
// positive class (an atom at `skills/x.md` with `type: html`
// would be wrongly re-typed; here it is structurally protected).
//
// AUDIT TRAIL: every migrated row gets `migrationNotice:
// 'skills-v1'` (the per-file advisory column added to the atoms
// schema). The editor shows a calm inline notice until the user
// opens-and-saves (any user edit clears it) or moves the atom out
// of `skills/` (path change clears it). The user's intent — keep
// or move — is the dismissal signal.
//
// TRACK-1 INVARIANTS preserved: we write through `ctx.db.patch` on
// `body` only — `path` is unchanged so `atomIds.path` does NOT need
// reconciliation; the existing `id:` survives (the frontmatter
// `id:` field, if present, is untouched; `splitFrontmatter` keeps
// the rest of the frontmatter intact when we inject the new
// `type:` line). `source` is unchanged ⇒ a `source: 'user'` atom
// stays user-authored, preserving the existing user-overwrite
// guard for FUTURE agent writes (Codex round-3 fold).

export function injectTypeSkillIntoBody(body: string): {
  body: string
  changed: boolean
} {
  const { fm, rest } = splitFrontmatter(body ?? '')
  if (fm && countTypeLines(fm) > 0) {
    // Already has a `type:` declaration ⇒ NEVER overwrite. The
    // §6 unification still treats it correctly per its declared
    // type; the legacy-path OR-compat skip applied while waiting,
    // and now will continue to apply via this atom's own
    // frontmatter (or its path if no type is set elsewhere).
    return { body, changed: false }
  }
  if (!fm) {
    // No existing frontmatter — prepend a fresh block. The body
    // becomes `---\ntype: skill\n---\n<original body>`.
    return {
      body: `---\ntype: skill\n---\n${rest || body}`,
      changed: true,
    }
  }
  // Frontmatter exists but has NO `type:` line (e.g. only `id:` or
  // other fields). Insert `type: skill` right after the opening
  // `---` line, PRESERVING the matched opener's line ending so the
  // body's CR/CRLF/LF convention round-trips byte-identical
  // (round-1 P2a FAIL-2: a CRLF body became `---\ntype: skill\nid:
  // x\r\n---\r\n…` — mixed endings forever, broke the byte-exact
  // frontmatter invariant `splitFrontmatter` relies on).
  const openerMatch = fm.match(/^---([ \t]*\r?\n)/)
  if (!openerMatch) return { body, changed: false } // defensive
  const eol = openerMatch[1].endsWith('\r\n') ? '\r\n' : '\n'
  const opener = openerMatch[0]
  const newFm =
    `---${eol}type: skill${eol}` + fm.slice(opener.length)
  return { body: joinFrontmatter(newFm, rest), changed: true }
}

export const _migrateLegacyPaths = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (
    ctx,
    { workspaceId },
  ): Promise<{
    scanned: number
    migrated: number
    /** Atoms in `skills/*` whose frontmatter already declares ANY
     *  `type:` (incl. unknown values like `type: recipe`) — left
     *  untouched. The §6.4.5 cleanup (removing isLegacySkillPath
     *  from isNonDataAtom) MUST NOT ship until this is 0 OR every
     *  such atom is reviewed/moved/retyped by the user (round-1
     *  fold: FAIL-3 indep + FAIL-3/4 Codex). */
    skippedTyped: number
  }> => {
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    let scanned = 0
    let migrated = 0
    let skippedTyped = 0
    for (const r of rows) {
      if (!isLegacySkillPath(r.path)) continue
      scanned++
      const out = injectTypeSkillIntoBody(r.body)
      if (!out.changed) {
        // The atom has an EXISTING `type:` declaration — left as
        // the user authored it. If isLegacySkillPath is ever
        // cleaned out of isNonDataAtom while this row's type is
        // unknown/non-skill, it would become a data-capturable
        // atom. Count for the operator's safety check.
        const { fm } = splitFrontmatter(r.body ?? '')
        if (fm && countTypeLines(fm) > 0) skippedTyped++
        continue
      }
      // Track-1 write-chokepoint invariants (round-1 fold FAIL-1
      // both reviewers): a legacy `skills/*` row may pre-date Phase-1
      // and lack an `id:` AND an atomIds index row. The migration
      // MUST seed id + reconcile the rename-proof index so that
      // post-migration `{= …}` refs can resolve and `extractFronts
      // matterId` returns a stable id. seedAtomIdIntoBody is a
      // no-op when the body already has an id ⇒ safe to always run.
      const seeded = await seedAtomIdIntoBody(
        ctx,
        workspaceId,
        r.path,
        out.body,
      )
      await ctx.db.patch(r._id, {
        body: seeded,
        migrationNotice: 'skills-v1',
        updatedAt: Date.now(),
        ...deriveSearchFields(r.path, seeded),
      })
      await reconcileAtomIdIndex(ctx, workspaceId, r.path, seeded, {
        isRestore: false,
      })
      migrated++
    }
    return { scanned, migrated, skippedTyped }
  },
})

// Clear an atom's migrationNotice on user-edit or path-change. Used
// by upsertAtomImpl + atoms.move (Track-3 P2a — the user's edit IS
// the acknowledgment; the advisory disappears the moment they
// touch the file).
export const _clearMigrationNotice = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, { workspaceId, path }) => {
    const row = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .unique()
    if (!row) return
    if (row.migrationNotice == null) return
    await ctx.db.patch(row._id, { migrationNotice: undefined })
  },
})
